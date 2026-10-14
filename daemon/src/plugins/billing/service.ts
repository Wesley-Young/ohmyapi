import { type Disposable, serviceToken } from '@fraqjs/kernel';
import { and, desc, eq, inArray } from 'drizzle-orm';

import type { DatabaseConfig } from '../../config.ts';
import { GatewayError, requestErrorMessage } from '../../core/errors.ts';
import { type EventLogger, errorDetails, formatEvent, safeErrorMessage } from '../../core/logging.ts';
import { formatMoney } from '../../core/money.ts';
import type { Database } from '../database/client.ts';
import { requestAttempts, requests, requestUsage } from '../database/schema/index.ts';
import type { PricingService } from '../pricing/service.ts';
import { lockWallet, postLedgerEntry } from '../wallet/ledger.ts';
import { reservationAmount } from './admission.ts';
import { reportedCacheReadTokens } from './cache-usage.ts';
import { estimateReservation } from './estimation.ts';
import { BillingOwnership } from './ownership.ts';
import {
  type BillingOutcome,
  type BillingSummary,
  inflightStatuses,
  isClosed,
  lockRequest,
  markNeedsReview,
  transition,
  writeUsage,
} from './requests.ts';
import { type ExecutionRoute, lockAdmission, lockExecutionRoute, type ReservationInput } from './reservation.ts';
import { searchRequest } from './search.ts';
import { type PricedUsage, priceRequestUsage, releaseRequest, settleRequest } from './settlement.ts';

/**
 * 请求计费的运行时流程：预占 → 转发 → 检查点 → 收尾结算。
 * 收尾失败的请求留在内存中定期重试，多次失败后转入人工核对；启动和定时任务会恢复中断的请求。
 */
export class BillingService implements Disposable {
  static readonly token = serviceToken<BillingService>('ohmyapi/billing');
  private readonly db: Database;
  private readonly pricing: PricingService;
  private readonly logger: EventLogger;
  private readonly ownership: BillingOwnership;
  private ticking = false;
  private readonly active = new Set<string>();
  private readonly pending = new Map<string, BillingSummary>();
  private readonly failures = new Map<string, number>();
  constructor(deps: { db: Database; pricing: PricingService; logger: EventLogger }) {
    this.db = deps.db;
    this.pricing = deps.pricing;
    this.logger = deps.logger;
    this.ownership = new BillingOwnership({
      logger: deps.logger,
      stats: () => ({ activeRequests: this.active.size, pendingRetries: this.pending.size }),
    });
  }

  private logOutcome(outcome: BillingOutcome | undefined) {
    if (!outcome || outcome.status === 'settling' || outcome.status === 'rejected') return;
    const r = outcome.request;
    this.logger[
      outcome.errorCode === 'billing_processing_failed' ? 'error' : outcome.status === 'needs_review' ? 'warn' : 'info'
    ](
      formatEvent('计费状态变更', {
        requestId: r.id,
        userId: r.userId,
        channelId: r.channelId,
        status: outcome.status,
        errorCode: outcome.errorCode ?? r.errorCode ?? undefined,
        reservedAmount: formatMoney(r.reservedMicros),
        heldAmount: formatMoney(outcome.status === 'needs_review' ? r.heldMicros : 0n),
        chargedAmount: outcome.chargedMicros === undefined ? undefined : formatMoney(outcome.chargedMicros),
        currency: this.pricing.currency,
        usageFinal: outcome.usageFinal ?? r.usageFinal,
        usageEstimate: r.usageEstimate,
        blockSettlement: outcome.blockSettlement,
      }),
    );
  }

  assertReady() {
    this.ownership.assertReady();
  }

  onLeaseLost(handler: () => void) {
    this.ownership.onLost(handler);
  }

  /** 获取计费所有权并恢复上次运行遗留的请求；任一步失败都放弃所有权。 */
  async start(config: DatabaseConfig) {
    try {
      await this.ownership.acquire(config);
      await this.recover(true);
    } catch (error) {
      await this.ownership.abandon();
      throw new Error(
        error instanceof Error && error.message.startsWith('Another ohmyapi')
          ? error.message
          : 'Unable to initialize billing ownership and recovery',
        { cause: error },
      );
    }
  }

  dispose() {
    return this.ownership.dispose();
  }

  async reserve(input: ReservationInput) {
    this.assertReady();
    const history = await this.db
      .select({ outputTokens: requestUsage.outputTokens })
      .from(requests)
      .innerJoin(requestUsage, eq(requestUsage.requestId, requests.id))
      .where(
        and(
          eq(requests.userId, input.userId),
          eq(requests.channelId, input.channelId),
          eq(requests.modelId, input.modelId),
          eq(requests.endpoint, input.endpoint),
          eq(requests.status, 'settled'),
          eq(requests.usageFinal, true),
        ),
      )
      .orderBy(desc(requests.receivedAt), desc(requests.id))
      .limit(100);
    const estimate = estimateReservation(
      input.body,
      input.endpoint,
      input.outputLimit,
      history.map((r) => r.outputTokens),
    );
    const search = searchRequest(input.body, input.endpoint);
    const amount = reservationAmount(input.price, estimate.inputTokens, estimate.outputTokens, search);
    this.active.add(input.requestId);
    try {
      await this.db.transaction(async (tx) => {
        const user = await lockAdmission(tx, input);
        const r = await lockRequest(tx, input.requestId);
        if (r?.status !== 'received' || r.userId !== user.id) throw new Error('Request admission state changed');
        const wallet = await lockWallet(tx, user.id);
        if (!wallet) throw new Error('Wallet missing');
        if (wallet.balanceMicros < 0n || wallet.balanceMicros - wallet.reservedMicros < amount)
          throw new GatewayError(
            402,
            'insufficient_balance',
            'Available balance is insufficient for this request reservation',
          );
        const snapshot = {
          multiplier: formatMoney(input.price.multiplierMicros),
          multiplierSource: input.price.multiplierSource,
          pricingMode: input.price.pricingMode,
          routing: input.price.routing,
          receivedAt: input.price.receivedAt.toISOString(),
          currency: this.pricing.currency,
          billed: false,
        };
        await tx
          .update(requests)
          .set({
            billingEnabled: true,
            status: 'reserved',
            ownerId: this.ownership.ownerId,
            heartbeatAt: new Date(),
            modelId: input.modelId,
            channelId: input.channelId,
            reservedMicros: amount,
            heldMicros: amount,
            pricingSnapshot: snapshot,
            reservationSnapshot: {
              pricing: this.pricing.snapshot(input.price),
              inputTokenLimit: input.inputLimit,
              outputTokenLimit: input.outputLimit,
              estimate,
              search,
              amount: formatMoney(amount),
              strategy: 'request_content_recent_output',
            },
          })
          .where(eq(requests.id, r.id));
        if (amount > 0n)
          await postLedgerEntry(tx, wallet, {
            requestId: r.id,
            kind: 'reserve',
            idempotencyKey: `reserve:${r.id}`,
            balanceDeltaMicros: 0n,
            reservedDeltaMicros: amount,
            reason: '预占',
            metadata: {
              pricing: snapshot,
              estimate,
              inputTokenLimit: input.inputLimit,
              outputTokenLimit: input.outputLimit,
            },
          });
      });
    } catch (error) {
      this.active.delete(input.requestId);
      throw error;
    }
    return { amount, estimate };
  }

  async forwarding(id: string, attemptId: string, route: ExecutionRoute) {
    this.assertReady();
    await this.db.transaction(async (tx) => {
      await lockExecutionRoute(tx, route);
      const [r] = await tx
        .update(requests)
        .set({ status: 'forwarding', heartbeatAt: new Date() })
        .where(and(eq(requests.id, id), eq(requests.ownerId, this.ownership.ownerId), eq(requests.status, 'reserved')))
        .returning({ id: requests.id });
      if (!r) throw new Error('Request reservation lost');
      const [attempt] = await tx
        .update(requestAttempts)
        .set({ status: 'forwarding', dispatchedAt: new Date() })
        .where(
          and(
            eq(requestAttempts.id, attemptId),
            eq(requestAttempts.requestId, id),
            eq(requestAttempts.status, 'prepared'),
          ),
        )
        .returning({ id: requestAttempts.id });
      if (!attempt) throw new Error('Request attempt state changed');
    });
  }

  async checkpoint(id: string, summary: BillingSummary) {
    this.assertReady();
    await this.db.transaction(async (tx) => {
      const r = await lockRequest(tx, id);
      if (
        !r ||
        r.ownerId !== this.ownership.ownerId ||
        r.status !== 'forwarding' ||
        (r.usageFinal && !summary.usageFinal && !summary.blockSettlement)
      )
        return;
      if (summary.usage) await writeUsage(tx, id, summary.usage);
      await tx
        .update(requests)
        .set({
          usageFinal: summary.blockSettlement ? false : summary.usageFinal || r.usageFinal,
          usageEstimate: null,
          errorCode: summary.blockSettlement ? (summary.errorCode ?? 'invalid_usage') : undefined,
          errorMessage: summary.errorMessage,
          heartbeatAt: new Date(),
          httpStatus: summary.httpStatus ?? r.httpStatus,
          upstreamRequestId: summary.upstreamRequestId ?? r.upstreamRequestId,
        })
        .where(eq(requests.id, id));
    });
  }

  async finish(id: string, summary: BillingSummary) {
    this.assertReady();
    try {
      const outcome = await this.db.transaction<BillingOutcome | undefined>(async (tx) => {
        const r = await lockRequest(tx, id);
        if (!r || isClosed(r.status)) return;
        if (r.billingEnabled && r.ownerId !== this.ownership.ownerId) return;
        if (summary.usage && (summary.usageFinal || !r.usageFinal)) await writeUsage(tx, id, summary.usage);
        const final = !summary.blockSettlement && ((summary.usageFinal && Boolean(summary.usage)) || r.usageFinal);
        const usageEstimate =
          summary.blockSettlement || final ? null : (summary.usage && summary.usageEstimate) || r.usageEstimate;
        const metadata = {
          httpStatus: summary.httpStatus ?? r.httpStatus,
          upstreamRequestId: summary.upstreamRequestId ?? r.upstreamRequestId,
          errorCode: summary.errorCode ?? null,
          errorMessage: summary.errorMessage ?? r.errorMessage,
          finishedAt: r.finishedAt ?? new Date(),
          usageFinal: final,
          usageEstimate,
          ttftMs: summary.ttftMs ?? r.ttftMs,
          outputTps: summary.outputTps ?? r.outputTps,
        };
        await tx.update(requests).set(metadata).where(eq(requests.id, id));
        if (!r.billingEnabled) return { ...(await transition(tx, r, 'rejected')), errorCode: summary.errorCode };
        if (final || usageEstimate) {
          return transition(tx, r, 'settling');
        } else if (summary.noExecution) {
          await releaseRequest(tx, { ...r, ...metadata }, undefined, '上游未执行，释放预占');
          return { request: { ...r, ...metadata }, status: 'released', chargedMicros: 0n };
        } else {
          return {
            ...(await markNeedsReview(tx, r, summary.errorCode ?? 'usage_not_final')),
            usageFinal: final,
            blockSettlement: summary.blockSettlement,
          };
        }
      });
      this.logOutcome(outcome);
      const settled = outcome?.status === 'settling' ? await this.settleStored(id) : undefined;
      const attempts = this.failures.get(id);
      if (attempts)
        this.logger.info(
          formatEvent('计费重试完成', {
            requestId: id,
            previousFailures: attempts,
            status: settled?.status ?? outcome?.status ?? 'unchanged',
            pendingRetries: Math.max(0, this.pending.size - 1),
          }),
        );
      this.pending.delete(id);
      this.failures.delete(id);
    } catch (error) {
      this.pending.set(id, summary);
      const failures = (this.failures.get(id) ?? 0) + 1;
      this.failures.set(id, failures);
      this.logger[failures >= 3 ? 'error' : 'warn'](
        formatEvent('计费处理失败', {
          requestId: id,
          attempt: failures,
          nextAction: failures >= 3 ? 'manual_review' : 'retry',
          pendingRetries: this.pending.size,
          ...errorDetails(error),
        }),
      );
      if (failures >= 3) {
        try {
          await this.reviewFailed(id, summary, error);
          this.pending.delete(id);
          this.failures.delete(id);
        } catch (reviewError) {
          this.logger.error(
            formatEvent('计费人工核对状态保存失败', {
              requestId: id,
              attempt: failures,
              pendingRetries: this.pending.size,
              ...errorDetails(reviewError),
            }),
          );
          // Keep evidence in memory until the database accepts it.
        }
      }
      throw error;
    } finally {
      this.active.delete(id);
    }
  }

  private async reviewFailed(id: string, summary?: BillingSummary, error?: unknown) {
    const outcome = await this.db.transaction<BillingOutcome | undefined>(async (tx) => {
      const r = await lockRequest(tx, id);
      if (!r?.billingEnabled || isClosed(r.status)) return;
      if (summary?.usage && (summary.usageFinal || !r.usageFinal)) await writeUsage(tx, id, summary.usage);
      const usageFinal = summary?.blockSettlement
        ? false
        : Boolean(summary?.usageFinal && summary.usage) || r.usageFinal;
      const outcome = await markNeedsReview(tx, r, 'billing_processing_failed', {
        errorMessage:
          [safeErrorMessage(error), summary?.errorMessage ?? r.errorMessage]
            .filter(Boolean)
            .join('\n')
            .slice(0, 4096) || requestErrorMessage('billing_processing_failed'),
        usageFinal,
        usageEstimate:
          summary?.blockSettlement || summary?.usageFinal || r.usageFinal
            ? null
            : (summary?.usage && summary.usageEstimate) || r.usageEstimate,
        httpStatus: summary?.httpStatus ?? r.httpStatus,
        upstreamRequestId: summary?.upstreamRequestId ?? r.upstreamRequestId,
        finishedAt: r.finishedAt ?? new Date(),
        ttftMs: summary?.ttftMs ?? r.ttftMs,
        outputTps: summary?.outputTps ?? r.outputTps,
      });
      return { ...outcome, usageFinal, blockSettlement: summary?.blockSettlement };
    });
    this.logOutcome(outcome);
    return outcome;
  }

  private async settleStored(id: string) {
    this.assertReady();
    const outcome = await this.db.transaction<BillingOutcome | undefined>(async (tx) => {
      const r = await lockRequest(tx, id);
      if (r?.status !== 'settling' || !r.billingEnabled || (!r.usageFinal && !r.usageEstimate)) return;
      const [usage] = await tx.select().from(requestUsage).where(eq(requestUsage.requestId, id));
      if (!usage) {
        return markNeedsReview(tx, r, 'usage_missing');
      }
      let priced: PricedUsage;
      if (!r.usageFinal && (r.subscriptionAccountId || reportedCacheReadTokens(r.endpoint, usage.rawUsage) === null)) {
        return markNeedsReview(tx, r, 'usage_not_final', {
          errorMessage: '上游最终用量或缓存用量未确认，停止自动估算扣费，请依据上游账单核对',
        });
      }
      try {
        priced = await priceRequestUsage(this.pricing, r, usage);
      } catch (error) {
        return markNeedsReview(tx, r, 'price_unconfigured', { errorMessage: safeErrorMessage(error) });
      }
      const snapshot = r.usageEstimate
        ? { ...priced, source: 'estimated_usage', usageEstimate: r.usageEstimate }
        : priced;
      await settleRequest(
        tx,
        r,
        BigInt(priced.totalMicros),
        snapshot,
        undefined,
        r.usageEstimate ? '断连估算结算' : '结算',
      );
      return { request: r, status: 'settled', chargedMicros: BigInt(priced.totalMicros) };
    });
    this.logOutcome(outcome);
    return outcome;
  }

  private async recover(startup = false) {
    this.assertReady();
    const rows = await this.db
      .select()
      .from(requests)
      .where(and(eq(requests.billingEnabled, true), inArray(requests.status, inflightStatuses)));
    const counts = { scanned: rows.length, processed: 0, settled: 0, released: 0, needsReview: 0, failed: 0 };
    for (const r of rows) {
      if (this.active.has(r.id) || this.pending.has(r.id)) continue;
      counts.processed++;
      let outcome: BillingOutcome | undefined;
      try {
        if (r.status === 'settling') {
          outcome = await this.settleStored(r.id);
        } else {
          outcome = await this.db.transaction<BillingOutcome | undefined>(async (tx) => {
            const current = await lockRequest(tx, r.id);
            if (
              !current ||
              !['reserved', 'forwarding'].includes(current.status) ||
              this.active.has(r.id) ||
              this.pending.has(r.id)
            )
              return;
            if (current.status === 'reserved') {
              await releaseRequest(tx, current, undefined, '服务恢复：转发前中断，释放预占');
              return { request: current, status: 'released', chargedMicros: 0n };
            } else if (current.usageFinal || current.usageEstimate) {
              return transition(tx, current, 'settling', {
                errorCode: current.errorCode ?? 'process_interrupted',
                finishedAt: new Date(),
              });
            } else {
              return markNeedsReview(tx, current, 'process_interrupted', { finishedAt: new Date() });
            }
          });
          this.logOutcome(outcome);
          outcome = (await this.settleStored(r.id)) ?? outcome;
        }
      } catch (error) {
        counts.failed++;
        this.logger.error(formatEvent('历史计费恢复失败', { requestId: r.id, ...errorDetails(error) }));
        // Isolate a failed bill; database-wide failures still propagate if this write fails.
        outcome = await this.reviewFailed(r.id, undefined, error);
      }
      if (outcome?.status === 'settled') counts.settled++;
      else if (outcome?.status === 'released') counts.released++;
      else if (outcome?.status === 'needs_review') counts.needsReview++;
    }
    if (startup || counts.processed)
      this.logger[counts.failed ? 'warn' : 'info'](
        formatEvent('计费恢复完成', {
          ownerId: this.ownership.ownerId,
          startup,
          ...counts,
          pendingRetries: this.pending.size,
        }),
      );
  }

  async tick() {
    if (!this.ownership.isHealthy || this.ticking) return;
    this.ticking = true;
    try {
      if (!(await this.ownership.check())) return;
      if (this.active.size)
        await this.db
          .update(requests)
          .set({ heartbeatAt: new Date() })
          .where(
            and(
              eq(requests.ownerId, this.ownership.ownerId),
              inArray(requests.id, [...this.active]),
              inArray(requests.status, inflightStatuses),
            ),
          );
      for (const [id, summary] of [...this.pending].slice(0, 50)) {
        try {
          await this.finish(id, summary);
        } catch {
          // finish 已记录失败次数、队列长度及安全错误字段。
        }
      }
      await this.recover();
    } catch (error) {
      this.logger.error(
        formatEvent('计费恢复任务失败', {
          activeRequests: this.active.size,
          pendingRetries: this.pending.size,
          ...errorDetails(error),
        }),
      );
    } finally {
      this.ticking = false;
    }
  }
}
