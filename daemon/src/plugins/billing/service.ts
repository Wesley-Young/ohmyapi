import { type Disposable, serviceToken } from '@fraqjs/kernel';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { GatewayError, requestErrorMessage } from '../../core/errors.ts';
import { type EventLogger, errorDetails, formatEvent, safeErrorMessage } from '../../core/logging.ts';
import { formatMoney } from '../../core/money.ts';
import type { Database } from '../database/client.ts';
import { requestAttempts, requests, requestUsage } from '../database/schema/index.ts';
import type { PricingService } from '../pricing/service.ts';
import { lockWallet, postLedgerEntry } from '../wallet/ledger.ts';
import { reservationAmount } from './admission.ts';
import { reportedCacheReadTokens } from './cache-usage.ts';
import { estimateReservation, minimumHistorySamples, type UsageSample } from './estimation.ts';
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

import { randomUUID } from 'node:crypto';

/** 收尾或恢复连续失败多少次后转入人工核对。 */
const reviewAfterFailures = 3;
/** 用量已经确认（最终或估算）的请求只是结算未完成，多半是数据库的暂时故障；按定时任务间隔约重试 5 分钟。 */
const settlementRetryFailures = 20;
/**
 * 进行中的请求由所属实例每个定时周期刷新心跳；心跳超过此时长未更新，视为所属进程已退出，由任一实例接管恢复。
 * 远大于定时任务间隔，数据库或事件循环的短暂延迟不会让仍在运行的请求被接管。
 */
const staleAfterSeconds = 120;

/** 所属进程已退出、需要恢复的计费请求。 */
const orphaned = () =>
  and(
    eq(requests.billingEnabled, true),
    inArray(requests.status, inflightStatuses),
    sql`(${requests.heartbeatAt} is null or ${requests.heartbeatAt} < now() - interval '${sql.raw(String(staleAfterSeconds))} seconds')`,
  );

/**
 * 请求计费的运行时流程：预占 → 转发 → 检查点 → 收尾结算。
 * 收尾失败的请求留在内存中定期重试，多次失败后转入人工核对；已确认用量的请求重试更久。
 * 每个实例以 ownerId 标记自己处理的请求并定期刷新心跳；启动和定时任务恢复心跳超时的请求，多个实例可以共用同一数据库。
 */
export class BillingService implements Disposable {
  static readonly token = serviceToken<BillingService>('ohmyapi/billing');
  readonly ownerId = randomUUID();
  private readonly db: Database;
  private readonly pricing: PricingService;
  private readonly logger: EventLogger;
  private tickTask?: Promise<void>;
  private stopped = false;
  private readonly active = new Set<string>();
  private readonly pending = new Map<string, BillingSummary>();
  private readonly failures = new Map<string, number>();
  constructor(deps: { db: Database; pricing: PricingService; logger: EventLogger }) {
    this.db = deps.db;
    this.pricing = deps.pricing;
    this.logger = deps.logger;
  }

  /** 由本实例处理中或等待重试的请求，恢复时跳过。 */
  private isLocal(id: string) {
    return this.active.has(id) || this.pending.has(id);
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

  /** 恢复心跳已超时的遗留请求。 */
  async start() {
    this.logger.info(formatEvent('计费服务启动', { ownerId: this.ownerId }));
    await this.recover(true);
  }

  /** 停止定时任务并等待进行中的一轮完成。 */
  async dispose() {
    this.stopped = true;
    await this.tickTask;
  }

  async reserve(input: ReservationInput) {
    const user = await this.usageHistory(input, true);
    const estimate = estimateReservation(
      input.body,
      input.endpoint,
      input.outputLimit,
      { user, model: user.length >= minimumHistorySamples ? [] : await this.usageHistory(input, false) },
      input.requestedModel,
    );
    const search = searchRequest(input.body, input.endpoint);
    const amount = reservationAmount(input.price, estimate, search);
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
            ownerId: this.ownerId,
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
              strategy: 'expected_usage_v2',
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

  /** 近期已按最终用量结算的请求；按用户时限定用户和入口渠道，否则包含该模型和端点的所有请求。 */
  private usageHistory(input: ReservationInput, byUser: boolean): Promise<UsageSample[]> {
    return this.db
      .select({
        outputTokens: requestUsage.outputTokens,
        cacheReadTokens: requestUsage.cacheReadTokens,
        cacheWriteTokens: requestUsage.cacheWriteTokens,
        contextTokens: requestUsage.contextTokens,
      })
      .from(requests)
      .innerJoin(requestUsage, eq(requestUsage.requestId, requests.id))
      .where(
        and(
          byUser ? eq(requests.userId, input.userId) : undefined,
          byUser ? eq(requests.channelId, input.channelId) : undefined,
          eq(requests.modelId, input.modelId),
          eq(requests.endpoint, input.endpoint),
          eq(requests.status, 'settled'),
          eq(requests.usageFinal, true),
        ),
      )
      .orderBy(desc(requests.receivedAt), desc(requests.id))
      .limit(100);
  }

  async forwarding(id: string, attemptId: string, route: ExecutionRoute) {
    await this.db.transaction(async (tx) => {
      await lockExecutionRoute(tx, route);
      const [r] = await tx
        .update(requests)
        .set({ status: 'forwarding', heartbeatAt: new Date() })
        .where(and(eq(requests.id, id), eq(requests.ownerId, this.ownerId), eq(requests.status, 'reserved')))
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
    await this.db.transaction(async (tx) => {
      const r = await lockRequest(tx, id);
      if (
        !r ||
        r.ownerId !== this.ownerId ||
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
    try {
      const outcome = await this.db.transaction<BillingOutcome | undefined>(async (tx) => {
        const r = await lockRequest(tx, id);
        if (!r || isClosed(r.status)) return;
        if (r.billingEnabled && r.ownerId !== this.ownerId) return;
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
      const settleable =
        !summary.blockSettlement && Boolean(summary.usage) && (summary.usageFinal || Boolean(summary.usageEstimate));
      const limit = settleable ? settlementRetryFailures : reviewAfterFailures;
      this.logger[failures >= limit ? 'error' : 'warn'](
        formatEvent('计费处理失败', {
          requestId: id,
          attempt: failures,
          nextAction: failures >= limit ? 'manual_review' : 'retry',
          pendingRetries: this.pending.size,
          ...errorDetails(error),
        }),
      );
      if (failures >= limit) {
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

  /**
   * 恢复心跳超时的请求：转发前中断的释放预占，已有最终或估算用量的结算，其余转入人工核对。
   * 每个请求在行锁内复查状态和心跳；本实例处理中或等待重试的请求不在此列。
   */
  private async recover(startup = false) {
    const rows = await this.db
      .select({
        id: requests.id,
        status: requests.status,
        usageFinal: requests.usageFinal,
        usageEstimate: requests.usageEstimate,
      })
      .from(requests)
      .where(orphaned());
    const counts = { scanned: rows.length, processed: 0, settled: 0, released: 0, needsReview: 0, failed: 0 };
    for (const r of rows) {
      if (this.isLocal(r.id)) continue;
      counts.processed++;
      let outcome: BillingOutcome | undefined;
      try {
        if (r.status === 'settling') {
          outcome = await this.settleStored(r.id);
        } else {
          outcome = await this.db.transaction<BillingOutcome | undefined>(async (tx) => {
            const [current] = await tx
              .select()
              .from(requests)
              .where(and(eq(requests.id, r.id), orphaned()))
              .for('update');
            if (!current || !['reserved', 'forwarding'].includes(current.status) || this.isLocal(r.id)) return;
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
        this.failures.delete(r.id);
      } catch (error) {
        counts.failed++;
        const failures = (this.failures.get(r.id) ?? 0) + 1;
        this.failures.set(r.id, failures);
        // 已有最终或估算用量的请求留在原状态，由后续的定时任务继续结算。
        const limit =
          r.status === 'settling' || r.usageFinal || r.usageEstimate ? settlementRetryFailures : reviewAfterFailures;
        this.logger.error(
          formatEvent('历史计费恢复失败', {
            requestId: r.id,
            attempt: failures,
            nextAction: failures >= limit ? 'manual_review' : 'retry',
            ...errorDetails(error),
          }),
        );
        if (failures >= limit) {
          // Isolate a failed bill; database-wide failures still propagate if this write fails.
          outcome = await this.reviewFailed(r.id, undefined, error);
          this.failures.delete(r.id);
        }
      }
      if (outcome?.status === 'settled') counts.settled++;
      else if (outcome?.status === 'released') counts.released++;
      else if (outcome?.status === 'needs_review') counts.needsReview++;
    }
    if (startup || counts.processed)
      this.logger[counts.failed ? 'warn' : 'info'](
        formatEvent('计费恢复完成', {
          ownerId: this.ownerId,
          startup,
          ...counts,
          pendingRetries: this.pending.size,
        }),
      );
  }

  /** 定时任务：刷新本实例请求的心跳，重试收尾失败的请求，恢复心跳超时的请求。 */
  tick() {
    if (this.stopped || this.tickTask) return this.tickTask;
    this.tickTask = this.runTick().finally(() => {
      this.tickTask = undefined;
    });
    return this.tickTask;
  }

  private async runTick() {
    try {
      const live = [...this.active, ...this.pending.keys()];
      if (live.length)
        await this.db
          .update(requests)
          .set({ heartbeatAt: new Date() })
          .where(
            and(
              eq(requests.ownerId, this.ownerId),
              inArray(requests.id, live),
              inArray(requests.status, inflightStatuses),
            ),
          );
      for (const [id, summary] of [...this.pending].slice(0, 50)) {
        if (this.stopped) return;
        try {
          await this.finish(id, summary);
        } catch {
          // finish 已记录失败次数、队列长度及安全错误字段。
        }
      }
      if (!this.stopped) await this.recover();
    } catch (error) {
      this.logger.error(
        formatEvent('计费恢复任务失败', {
          activeRequests: this.active.size,
          pendingRetries: this.pending.size,
          ...errorDetails(error),
        }),
      );
    }
  }
}
