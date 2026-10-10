import { type Disposable, serviceToken } from '@fraqjs/kernel';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { Client } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from '../../config.js';
import { type EventLogger, errorDetails, safeErrorMessage } from '../../logging.js';
import type { AuthService, Principal, Transaction } from '../auth/service.js';
import {
  adminAuditLogs,
  apiKeyChannels,
  apiKeyModelGrants,
  apiKeys,
  effectiveChannelModels as channelAvailableModels,
  effectiveChannelEndpoints as channelEndpoints,
  channels,
  models,
  requestAttempts,
  requests,
  requestUsage,
  userChannelGrants,
  users,
  walletLedger,
  wallets,
} from '../database/schema/index.js';
import { cacheReadForDisplay, reportedCacheReadTokens } from '../gateway/cache-usage.js';
import { GatewayError, requestErrorMessage } from '../gateway/errors.js';
import { lockExecutionRoute } from '../gateway/routing.js';
import type { Usage } from '../gateway/usage.js';
import { priceInput, searchCountInput, tokenInput } from '../pricing/rules.js';
import { type LockedPrice, type PricingService, publicPricingSnapshot } from '../pricing/service.js';
import { reservationAmount } from './admission.js';
import { formatMoney, parseMoney } from './conventions.js';
import { estimateReservation, type UsageEstimate } from './estimation.js';
import { searchRequest } from './search.js';

import { randomUUID } from 'node:crypto';

const requestId = z.uuid();
export const resolveBillInput = z.object({
  requestId,
  action: z.enum(['release', 'settle_usage', 'settle_amount']),
  reason: z.string().trim().min(1, '请填写核对依据').max(500),
  idempotencyKey: z.uuid(),
  amount: priceInput.optional(),
  usage: z
    .object({
      inputTokens: tokenInput,
      outputTokens: tokenInput,
      cacheReadTokens: tokenInput,
      cacheWriteTokens: tokenInput,
      webSearchCalls: searchCountInput.default('0'),
      webSearchPreviewCalls: searchCountInput.default('0'),
    })
    .optional(),
});
export const correctBillInput = z.object({
  requestId,
  amount: priceInput,
  reason: z.string().trim().min(1, '请填写修正依据').max(500),
  idempotencyKey: z.uuid(),
});
export const resolveZeroBillsInput = resolveBillInput.pick({ reason: true, idempotencyKey: true }).extend({
  requestIds: z
    .array(requestId)
    .min(1, '请先选择待核对请求')
    .max(100, '每批最多核对 100 个请求')
    .refine((ids) => new Set(ids).size === ids.length, '请求标识不能重复'),
});
type RequestRow = typeof requests.$inferSelect;
type BillingOutcome = {
  request: RequestRow;
  status: 'rejected' | 'released' | 'settling' | 'settled' | 'needs_review';
  errorCode?: string;
  chargedMicros?: bigint;
  usageFinal?: boolean;
  blockSettlement?: boolean;
};
export type BillingSummary = {
  usage?: Usage;
  usageFinal: boolean;
  usageEstimate?: UsageEstimate;
  blockSettlement?: boolean;
  httpStatus?: number;
  upstreamRequestId?: string;
  errorCode?: string;
  errorMessage?: string;
  noExecution: boolean;
};
const terminal = new Set(['settled', 'released', 'rejected', 'completed']);
const usageDto = (u: typeof requestUsage.$inferSelect) => ({
  inputTokens: u.inputTokens.toString(),
  outputTokens: u.outputTokens.toString(),
  cacheReadTokens: u.cacheReadTokens.toString(),
  cacheWriteTokens: u.cacheWriteTokens.toString(),
  contextTokens: u.contextTokens.toString(),
  webSearchCalls: u.webSearchCalls.toString(),
  webSearchPreviewCalls: u.webSearchPreviewCalls.toString(),
});
const bounds = (n: bigint) => {
  if (n < -9_223_372_036_854_775_808n || n > 9_223_372_036_854_775_807n) throw new Error('Wallet amount out of range');
  return n;
};

function canonical(value: unknown): string {
  const normalize = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(normalize)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, item]) => [k, normalize(item)]),
          )
        : v;
  return JSON.stringify(normalize(value));
}
export class BillingService implements Disposable {
  static readonly token = serviceToken<BillingService>('ohmyapi/billing');
  readonly ownerId = randomUUID();
  private readonly auth: AuthService;
  private readonly pricing: PricingService;
  private readonly logger: EventLogger;
  private lease?: Client;
  private healthy = false;
  private closing = false;
  private ticking = false;
  private lostHandler?: () => void;
  private readonly active = new Set<string>();
  private readonly pending = new Map<string, BillingSummary>();
  private readonly failures = new Map<string, number>();
  constructor(auth: AuthService, pricing: PricingService, logger: EventLogger) {
    this.auth = auth;
    this.pricing = pricing;
    this.logger = logger;
  }

  private logOutcome(outcome: BillingOutcome | undefined) {
    if (!outcome || outcome.status === 'settling' || outcome.status === 'rejected') return;
    const r = outcome.request;
    this.logger[
      outcome.errorCode === 'billing_processing_failed' ? 'error' : outcome.status === 'needs_review' ? 'warn' : 'info'
    ](
      `计费状态变更 ${JSON.stringify({
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
      })}`,
    );
  }

  assertReady() {
    if (!this.healthy) throw new GatewayError(503, 'billing_unavailable', 'Billing is unavailable');
  }

  onLeaseLost(handler: () => void) {
    this.lostHandler = handler;
  }

  async start(config: DatabaseConfig) {
    const lease = new Client({
      connectionString: config.connectionString,
      connectionTimeoutMillis: config.connectionTimeoutMillis,
      query_timeout: 5000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    });
    this.lease = lease;
    const lost = (error?: unknown) => {
      if (this.closing || !this.healthy) return;
      this.healthy = false;
      this.logger.error(
        `计费所有权连接中断，停止转发 ${JSON.stringify({
          ownerId: this.ownerId,
          activeRequests: this.active.size,
          pendingRetries: this.pending.size,
          ...(error === undefined ? {} : errorDetails(error)),
        })}`,
      );
      this.lostHandler?.();
    };
    lease.on('error', lost);
    lease.on('end', lost);
    try {
      await lease.connect();
      const { rows } = await lease.query<{ locked: boolean }>('select pg_try_advisory_lock(1330138459) as locked');
      if (!rows[0].locked) throw new Error('Another ohmyapi instance owns billing for this database');
      this.healthy = true;
      this.logger.info(`计费所有权已获取 ${JSON.stringify({ ownerId: this.ownerId })}`);
      await this.recover(true);
    } catch (error) {
      this.healthy = false;
      await lease.end().catch(() => {});
      this.lease = undefined;
      throw new Error(
        error instanceof Error && error.message.startsWith('Another ohmyapi')
          ? error.message
          : 'Unable to initialize billing ownership and recovery',
        { cause: error },
      );
    }
  }

  async dispose() {
    if (this.closing) return;
    this.closing = true;
    this.healthy = false;
    const lease = this.lease;
    this.lease = undefined;
    await lease?.end();
  }

  async reserve(input: {
    requestId: string;
    userId: string;
    keyId: string;
    modelId: string;
    channelId: string;
    executionChannel: typeof channels.$inferSelect;
    price: LockedPrice;
    inputLimit: number;
    outputLimit: number;
    body: Record<string, unknown>;
    endpoint: (typeof requests.$inferSelect)['endpoint'];
  }) {
    this.assertReady();
    const history = await this.auth.db
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
      await this.auth.db.transaction(async (tx) => {
        const [user] = await tx.select().from(users).where(eq(users.id, input.userId)).for('update');
        const [key] = await tx
          .select({ restricted: apiKeys.restrictModels })
          .from(apiKeys)
          .innerJoin(apiKeyChannels, eq(apiKeyChannels.apiKeyId, apiKeys.id))
          .where(
            and(
              eq(apiKeys.id, input.keyId),
              eq(apiKeys.userId, input.userId),
              eq(apiKeyChannels.channelId, input.channelId),
              isNull(apiKeys.revokedAt),
              isNull(apiKeys.deletedAt),
              or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
            ),
          );
        if (user?.status !== 'active' || user.deletedAt || !key)
          throw new GatewayError(401, 'invalid_api_key', 'Invalid or expired API Key');
        const [channel] = await tx
          .select({ id: channels.id, isPublic: channels.isPublic })
          .from(channels)
          .innerJoin(channelAvailableModels, eq(channelAvailableModels.channelId, channels.id))
          .innerJoin(models, eq(models.id, channelAvailableModels.modelId))
          .innerJoin(channelEndpoints, eq(channelEndpoints.channelId, channels.id))
          .where(
            and(
              eq(channels.id, input.channelId),
              eq(models.id, input.modelId),
              eq(channels.enabled, true),
              eq(models.enabled, true),
              isNull(channels.deletedAt),
              isNull(models.deletedAt),
              eq(channelEndpoints.endpoint, input.endpoint),
            ),
          )
          .for('share', { of: [channels, models] });
        if (!channel) throw new GatewayError(503, 'channel_unavailable', 'The API Key channel is unavailable');
        await lockExecutionRoute(tx, input);
        if (
          user.role !== 'admin' &&
          !channel.isPublic &&
          !(
            await tx
              .select()
              .from(userChannelGrants)
              .where(and(eq(userChannelGrants.userId, user.id), eq(userChannelGrants.channelId, input.channelId)))
          ).length
        )
          throw new GatewayError(403, 'channel_forbidden', 'Channel authorization was revoked');
        if (
          key.restricted &&
          !(
            await tx
              .select()
              .from(apiKeyModelGrants)
              .where(and(eq(apiKeyModelGrants.apiKeyId, input.keyId), eq(apiKeyModelGrants.modelId, input.modelId)))
          ).length
        )
          throw new GatewayError(403, 'model_forbidden', 'API Key does not authorize this model');
        const [r] = await tx.select().from(requests).where(eq(requests.id, input.requestId)).for('update');
        if (r?.status !== 'received' || r.userId !== user.id) throw new Error('Request admission state changed');
        const [wallet] = await tx.select().from(wallets).where(eq(wallets.userId, user.id)).for('update');
        if (!wallet) throw new Error('Wallet missing');
        if (wallet.balanceMicros < 0n || wallet.balanceMicros - wallet.reservedMicros < amount)
          throw new GatewayError(
            402,
            'insufficient_balance',
            'Available balance is insufficient for this request reservation',
          );
        const reserved = bounds(wallet.reservedMicros + amount);
        await tx.update(wallets).set({ reservedMicros: reserved }).where(eq(wallets.userId, user.id));
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
              strategy: 'request_content_recent_output',
            },
          })
          .where(eq(requests.id, r.id));
        if (amount > 0n)
          await tx.insert(walletLedger).values({
            userId: user.id,
            requestId: r.id,
            kind: 'reserve',
            idempotencyKey: `reserve:${r.id}`,
            balanceDeltaMicros: 0n,
            reservedDeltaMicros: amount,
            balanceAfterMicros: wallet.balanceMicros,
            reservedAfterMicros: reserved,
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

  async forwarding(id: string, attemptId: string, route: Parameters<typeof lockExecutionRoute>[1]) {
    this.assertReady();
    await this.auth.db.transaction(async (tx) => {
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

  private async writeUsage(tx: Transaction, id: string, usage: Usage) {
    await tx
      .insert(requestUsage)
      .values({ requestId: id, ...usage })
      .onConflictDoUpdate({ target: requestUsage.requestId, set: usage });
  }

  async checkpoint(id: string, summary: BillingSummary) {
    this.assertReady();
    await this.auth.db.transaction(async (tx) => {
      const [r] = await tx.select().from(requests).where(eq(requests.id, id)).for('update');
      if (
        !r ||
        r.ownerId !== this.ownerId ||
        r.status !== 'forwarding' ||
        (r.usageFinal && !summary.usageFinal && !summary.blockSettlement)
      )
        return;
      if (summary.usage) await this.writeUsage(tx, id, summary.usage);
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
      const outcome = await this.auth.db.transaction<BillingOutcome | undefined>(async (tx) => {
        const [r] = await tx.select().from(requests).where(eq(requests.id, id)).for('update');
        if (!r || terminal.has(r.status) || r.status === 'needs_review') return;
        if (r.billingEnabled && r.ownerId !== this.ownerId) return;
        if (summary.usage && (summary.usageFinal || !r.usageFinal)) await this.writeUsage(tx, id, summary.usage);
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
        };
        await tx.update(requests).set(metadata).where(eq(requests.id, id));
        if (!r.billingEnabled) {
          await tx.update(requests).set({ status: 'rejected' }).where(eq(requests.id, id));
          return { request: r, status: 'rejected', errorCode: summary.errorCode };
        }
        if (final || usageEstimate) {
          await tx.update(requests).set({ status: 'settling' }).where(eq(requests.id, id));
          return { request: r, status: 'settling' };
        } else if (summary.noExecution) {
          await this.release(tx, { ...r, ...metadata }, undefined, '上游未执行，释放预占');
          return { request: { ...r, ...metadata }, status: 'released', chargedMicros: 0n };
        } else {
          await tx
            .update(requests)
            .set({ status: 'needs_review', errorCode: summary.errorCode ?? 'usage_not_final' })
            .where(eq(requests.id, id));
          return {
            request: r,
            status: 'needs_review',
            errorCode: summary.errorCode ?? 'usage_not_final',
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
          `计费重试完成 ${JSON.stringify({
            requestId: id,
            previousFailures: attempts,
            status: settled?.status ?? outcome?.status ?? 'unchanged',
            pendingRetries: Math.max(0, this.pending.size - 1),
          })}`,
        );
      this.pending.delete(id);
      this.failures.delete(id);
    } catch (error) {
      this.pending.set(id, summary);
      const failures = (this.failures.get(id) ?? 0) + 1;
      this.failures.set(id, failures);
      this.logger[failures >= 3 ? 'error' : 'warn'](
        `计费处理失败 ${JSON.stringify({
          requestId: id,
          attempt: failures,
          nextAction: failures >= 3 ? 'manual_review' : 'retry',
          pendingRetries: this.pending.size,
          ...errorDetails(error),
        })}`,
      );
      if (failures >= 3) {
        try {
          await this.reviewFailed(id, summary, error);
          this.pending.delete(id);
          this.failures.delete(id);
        } catch (reviewError) {
          this.logger.error(
            `计费人工核对状态保存失败 ${JSON.stringify({
              requestId: id,
              attempt: failures,
              pendingRetries: this.pending.size,
              ...errorDetails(reviewError),
            })}`,
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
    const outcome = await this.auth.db.transaction<BillingOutcome | undefined>(async (tx) => {
      const [r] = await tx.select().from(requests).where(eq(requests.id, id)).for('update');
      if (!r?.billingEnabled || terminal.has(r.status) || r.status === 'needs_review') return;
      if (summary?.usage && (summary.usageFinal || !r.usageFinal)) await this.writeUsage(tx, id, summary.usage);
      await tx
        .update(requests)
        .set({
          status: 'needs_review',
          errorCode: 'billing_processing_failed',
          errorMessage:
            [safeErrorMessage(error), summary?.errorMessage ?? r.errorMessage]
              .filter(Boolean)
              .join('\n')
              .slice(0, 4096) || requestErrorMessage('billing_processing_failed'),
          usageFinal: summary?.blockSettlement ? false : Boolean(summary?.usageFinal && summary.usage) || r.usageFinal,
          usageEstimate:
            summary?.blockSettlement || summary?.usageFinal || r.usageFinal
              ? null
              : (summary?.usage && summary.usageEstimate) || r.usageEstimate,
          httpStatus: summary?.httpStatus ?? r.httpStatus,
          upstreamRequestId: summary?.upstreamRequestId ?? r.upstreamRequestId,
          finishedAt: r.finishedAt ?? new Date(),
        })
        .where(eq(requests.id, id));
      return {
        request: r,
        status: 'needs_review',
        errorCode: 'billing_processing_failed',
        usageFinal: summary?.blockSettlement ? false : Boolean(summary?.usageFinal && summary.usage) || r.usageFinal,
        blockSettlement: summary?.blockSettlement,
      };
    });
    this.logOutcome(outcome);
    return outcome;
  }

  private async pinned(r: RequestRow, usage: Usage) {
    const locked = this.pricing.restore(r.reservationSnapshot?.pricing, r.receivedAt);
    if (locked.modelId !== r.modelId) throw new Error('Price snapshot scope mismatch');
    return this.pricing.calculate(locked, usage);
  }

  private async release(tx: Transaction, r: RequestRow, actorId: string | undefined, reason: string) {
    const [wallet] = await tx.select().from(wallets).where(eq(wallets.userId, r.userId)).for('update');
    if (!wallet || wallet.reservedMicros < r.heldMicros) throw new Error('Wallet reservation mismatch');
    const reserved = wallet.reservedMicros - r.heldMicros;
    await tx.update(wallets).set({ reservedMicros: reserved }).where(eq(wallets.userId, r.userId));
    if (r.heldMicros > 0n)
      await tx.insert(walletLedger).values({
        userId: r.userId,
        requestId: r.id,
        kind: 'release',
        idempotencyKey: `release:${r.id}`,
        balanceDeltaMicros: 0n,
        reservedDeltaMicros: -r.heldMicros,
        balanceAfterMicros: wallet.balanceMicros,
        reservedAfterMicros: reserved,
        actorId,
        reason,
        metadata: { released: formatMoney(r.heldMicros), upstreamRequestId: r.upstreamRequestId },
      });
    await tx
      .update(requests)
      .set({ status: 'released', heldMicros: 0n, chargedMicros: 0n, finishedAt: new Date() })
      .where(eq(requests.id, r.id));
  }

  private async charge(
    tx: Transaction,
    r: RequestRow,
    amount: bigint,
    snapshot: Record<string, unknown>,
    actorId?: string,
    reason = '结算',
  ) {
    const [wallet] = await tx.select().from(wallets).where(eq(wallets.userId, r.userId)).for('update');
    if (!wallet || wallet.reservedMicros < r.heldMicros) throw new Error('Wallet reservation mismatch');
    const balance = bounds(wallet.balanceMicros - amount);
    const reserved = wallet.reservedMicros - r.heldMicros;
    await tx
      .update(wallets)
      .set({ balanceMicros: balance, reservedMicros: reserved })
      .where(eq(wallets.userId, r.userId));
    await tx.insert(walletLedger).values({
      userId: r.userId,
      requestId: r.id,
      kind: 'settlement',
      idempotencyKey: `settle:${r.id}`,
      balanceDeltaMicros: -amount,
      reservedDeltaMicros: -r.heldMicros,
      balanceAfterMicros: balance,
      reservedAfterMicros: reserved,
      actorId,
      reason,
      metadata: { pricing: snapshot, exceededReservation: amount > r.reservedMicros },
    });
    await tx
      .update(requests)
      .set({
        status: 'settled',
        heldMicros: 0n,
        chargedMicros: amount,
        quotedMicros: typeof snapshot.totalMicros === 'string' ? BigInt(snapshot.totalMicros) : r.quotedMicros,
        pricingSnapshot: { ...snapshot, billed: true },
        finishedAt: r.finishedAt ?? new Date(),
      })
      .where(eq(requests.id, r.id));
  }

  private async settleStored(id: string) {
    this.assertReady();
    const outcome = await this.auth.db.transaction<BillingOutcome | undefined>(async (tx) => {
      const [r] = await tx.select().from(requests).where(eq(requests.id, id)).for('update');
      if (r?.status !== 'settling' || !r.billingEnabled || (!r.usageFinal && !r.usageEstimate)) return;
      const [usage] = await tx.select().from(requestUsage).where(eq(requestUsage.requestId, id));
      if (!usage) {
        await tx
          .update(requests)
          .set({ status: 'needs_review', errorCode: 'usage_missing' })
          .where(eq(requests.id, id));
        return { request: r, status: 'needs_review', errorCode: 'usage_missing' };
      }
      let priced: Awaited<ReturnType<BillingService['pinned']>>;
      if (!r.usageFinal && (r.subscriptionAccountId || reportedCacheReadTokens(r.endpoint, usage.rawUsage) === null)) {
        await tx
          .update(requests)
          .set({
            status: 'needs_review',
            errorCode: 'usage_not_final',
            errorMessage: '上游最终用量或缓存用量未确认，停止自动估算扣费，请依据上游账单核对',
          })
          .where(eq(requests.id, id));
        return { request: r, status: 'needs_review', errorCode: 'usage_not_final' };
      }
      try {
        priced = await this.pinned(r, usage);
      } catch (error) {
        await tx
          .update(requests)
          .set({ status: 'needs_review', errorCode: 'price_unconfigured', errorMessage: safeErrorMessage(error) })
          .where(eq(requests.id, id));
        return { request: r, status: 'needs_review', errorCode: 'price_unconfigured' };
      }
      const snapshot = r.usageEstimate
        ? { ...priced, source: 'estimated_usage', usageEstimate: r.usageEstimate }
        : priced;
      await this.charge(
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
    const rows = await this.auth.db
      .select()
      .from(requests)
      .where(and(eq(requests.billingEnabled, true), inArray(requests.status, ['reserved', 'forwarding', 'settling'])));
    const counts = { scanned: rows.length, processed: 0, settled: 0, released: 0, needsReview: 0, failed: 0 };
    for (const r of rows) {
      if (this.active.has(r.id) || this.pending.has(r.id)) continue;
      counts.processed++;
      let outcome: BillingOutcome | undefined;
      try {
        if (r.status === 'settling') {
          outcome = await this.settleStored(r.id);
        } else {
          outcome = await this.auth.db.transaction<BillingOutcome | undefined>(async (tx) => {
            const [current] = await tx.select().from(requests).where(eq(requests.id, r.id)).for('update');
            if (
              !current ||
              !['reserved', 'forwarding'].includes(current.status) ||
              this.active.has(r.id) ||
              this.pending.has(r.id)
            )
              return;
            if (current.status === 'reserved') {
              await this.release(tx, current, undefined, '服务恢复：转发前中断，释放预占');
              return { request: current, status: 'released', chargedMicros: 0n };
            } else if (current.usageFinal || current.usageEstimate) {
              await tx
                .update(requests)
                .set({
                  status: 'settling',
                  errorCode: current.errorCode ?? 'process_interrupted',
                  finishedAt: new Date(),
                })
                .where(eq(requests.id, current.id));
              return { request: current, status: 'settling' };
            } else {
              await tx
                .update(requests)
                .set({ status: 'needs_review', errorCode: 'process_interrupted', finishedAt: new Date() })
                .where(eq(requests.id, current.id));
              return { request: current, status: 'needs_review', errorCode: 'process_interrupted' };
            }
          });
          this.logOutcome(outcome);
          outcome = (await this.settleStored(r.id)) ?? outcome;
        }
      } catch (error) {
        counts.failed++;
        this.logger.error(`历史计费恢复失败 ${JSON.stringify({ requestId: r.id, ...errorDetails(error) })}`);
        // Isolate a failed bill; database-wide failures still propagate if this write fails.
        outcome = await this.reviewFailed(r.id, undefined, error);
      }
      if (outcome?.status === 'settled') counts.settled++;
      else if (outcome?.status === 'released') counts.released++;
      else if (outcome?.status === 'needs_review') counts.needsReview++;
    }
    if (startup || counts.processed)
      this.logger[counts.failed ? 'warn' : 'info'](
        `计费恢复完成 ${JSON.stringify({
          ownerId: this.ownerId,
          startup,
          ...counts,
          pendingRetries: this.pending.size,
        })}`,
      );
  }

  async tick() {
    if (!this.healthy || this.ticking) return;
    this.ticking = true;
    try {
      try {
        await this.lease?.query('select 1');
      } catch (error) {
        this.healthy = false;
        this.lostHandler?.();
        this.logger.error(
          `计费所有权健康检查失败 ${JSON.stringify({
            ownerId: this.ownerId,
            activeRequests: this.active.size,
            pendingRetries: this.pending.size,
            ...errorDetails(error),
          })}`,
        );
        return;
      }
      if (this.active.size)
        await this.auth.db
          .update(requests)
          .set({ heartbeatAt: new Date() })
          .where(
            and(
              eq(requests.ownerId, this.ownerId),
              inArray(requests.id, [...this.active]),
              inArray(requests.status, ['reserved', 'forwarding', 'settling']),
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
        `计费恢复任务失败 ${JSON.stringify({
          activeRequests: this.active.size,
          pendingRetries: this.pending.size,
          ...errorDetails(error),
        })}`,
      );
    } finally {
      this.ticking = false;
    }
  }

  async detail(principal: Principal, id: string) {
    const [r] = await this.auth.db
      .select()
      .from(requests)
      .where(
        and(eq(requests.id, id), principal.user.role === 'admin' ? undefined : eq(requests.userId, principal.user.id)),
      );
    if (!r) throw new TRPCError({ code: 'NOT_FOUND', message: '请求不存在' });
    const [usage] = await this.auth.db.select().from(requestUsage).where(eq(requestUsage.requestId, id));
    const attempts =
      principal.user.role === 'admin'
        ? await this.auth.db
            .select()
            .from(requestAttempts)
            .where(eq(requestAttempts.requestId, id))
            .orderBy(requestAttempts.sequence)
        : [];
    const ledger = await this.auth.db
      .select({ entry: walletLedger, actor: users.username })
      .from(walletLedger)
      .leftJoin(users, eq(walletLedger.actorId, users.id))
      .where(eq(walletLedger.requestId, id))
      .orderBy(walletLedger.createdAt, walletLedger.id);
    let preview: Awaited<ReturnType<BillingService['pinned']>> | undefined;
    let previewError: string | undefined;
    const cacheRead = usage
      ? cacheReadForDisplay(r.endpoint, r.usageFinal, usage.rawUsage, usage.cacheReadTokens)
      : null;
    if (usage && cacheRead === null) previewError = '缓存用量未知，请依据上游账单核对，不能按零缓存计算费用';
    if (r.billingEnabled && usage && cacheRead !== null)
      try {
        preview = await this.pinned(r, usage);
      } catch {
        previewError = '保存的用量或价格不足以自动计算，请依据上游账单人工核对';
      }
    return {
      id: r.id,
      userId: r.userId,
      status: r.status,
      model: r.requestedModel,
      endpoint: r.endpoint,
      subscriptionAccountId: principal.user.role === 'admin' ? r.subscriptionAccountId : null,
      channelId: r.channelId,
      attempts: attempts.map((attempt) => ({
        ...attempt,
        startedAt: attempt.startedAt.toISOString(),
        dispatchedAt: attempt.dispatchedAt?.toISOString() ?? null,
        finishedAt: attempt.finishedAt?.toISOString() ?? null,
      })),
      billingEnabled: r.billingEnabled,
      usageFinal: r.usageFinal,
      usageEstimate: r.usageEstimate,
      reserved: formatMoney(r.reservedMicros),
      held: formatMoney(r.heldMicros),
      charged: r.chargedMicros === null ? null : formatMoney(r.chargedMicros),
      currency: this.pricing.currency,
      errorCode: r.errorCode,
      errorMessage:
        r.errorMessage ??
        requestErrorMessage(r.errorCode) ??
        (r.status === 'needs_review' ? '该历史请求未保存具体错误消息，请通过请求 ID 查询服务日志。' : null),
      httpStatus: r.httpStatus,
      upstreamRequestId: r.upstreamRequestId,
      pricing: principal.user.role === 'admin' ? r.pricingSnapshot : publicPricingSnapshot(r.pricingSnapshot),
      reservation:
        principal.user.role === 'admin' ? r.reservationSnapshot : publicPricingSnapshot(r.reservationSnapshot),
      usage: usage ? { ...usageDto(usage), cacheReadTokens: cacheRead } : null,
      preview: preview
        ? { ...preview, routing: principal.user.role === 'admin' ? preview.routing : undefined }
        : undefined,
      previewError,
      ledger: ledger.map(({ entry: e, actor }) => ({
        id: e.id,
        kind: e.kind,
        amount: formatMoney(e.balanceDeltaMicros),
        reservedAmount: formatMoney(e.reservedDeltaMicros),
        balanceAfter: formatMoney(e.balanceAfterMicros),
        reservedAfter: formatMoney(e.reservedAfterMicros),
        reason: e.reason,
        actor: actor ?? '系统',
        createdAt: e.createdAt.toISOString(),
        metadata: principal.user.role === 'admin' ? e.metadata : publicPricingSnapshot(e.metadata),
      })),
    };
  }

  async resolve(principal: Principal, input: z.infer<typeof resolveBillInput>) {
    this.assertReady();
    if (input.action === 'settle_usage' && !input.usage)
      throw new TRPCError({ code: 'BAD_REQUEST', message: '请填写确认后的用量' });
    if (input.action === 'settle_amount' && input.amount === undefined)
      throw new TRPCError({ code: 'BAD_REQUEST', message: '请填写确认后的费用' });
    return this.auth.authorized(principal, { admin: true }, (tx, actor) =>
      this.resolveInTransaction(tx, actor.id, input),
    );
  }

  async resolveZero(principal: Principal, input: z.infer<typeof resolveZeroBillsInput>) {
    this.assertReady();
    const ids = [...input.requestIds].sort();
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      // 按固定顺序锁定请求和钱包，整批结算在同一事务中完成。
      const rows = await tx.select().from(requests).where(inArray(requests.id, ids)).orderBy(requests.id).for('update');
      const userIds = [...new Set(rows.map((r) => r.userId))].sort();
      if (userIds.length)
        await tx.select().from(wallets).where(inArray(wallets.userId, userIds)).orderBy(wallets.userId).for('update');
      for (const id of ids)
        await this.resolveInTransaction(
          tx,
          actor.id,
          {
            requestId: id,
            action: 'settle_amount',
            amount: '0',
            reason: input.reason,
            idempotencyKey: input.idempotencyKey,
          },
          ids,
        );
      return { success: true, count: ids.length, userIds };
    });
  }

  private async resolveInTransaction(
    tx: Transaction,
    actorId: string,
    input: z.infer<typeof resolveBillInput>,
    batchRequestIds?: string[],
  ) {
    const key = `resolve:${input.requestId}:${input.idempotencyKey}`;
    const payload = {
      actorId,
      action: input.action,
      reason: input.reason,
      amount: input.action === 'settle_amount' ? formatMoney(parseMoney(input.amount as string)) : null,
      usage: input.action === 'settle_usage' ? input.usage : null,
      ...(batchRequestIds ? { batchRequestIds } : {}),
    };
    const [r] = await tx.select().from(requests).where(eq(requests.id, input.requestId)).for('update');
    if (!r) throw new TRPCError({ code: 'NOT_FOUND', message: '请求不存在' });
    if (r.resolutionKey === key) {
      if (canonical(r.resolutionPayload) !== canonical(payload))
        throw new TRPCError({ code: 'CONFLICT', message: '核对标识已用于不同内容' });
      return { success: true, userId: r.userId };
    }
    if (!r.billingEnabled || r.status !== 'needs_review')
      throw new TRPCError({ code: 'CONFLICT', message: `请求 ${r.id} 已发生状态变化，请刷新后重新选择待核对请求` });
    const [originalUsage] = await tx.select().from(requestUsage).where(eq(requestUsage.requestId, r.id));
    if (input.action === 'release') await this.release(tx, r, actorId, input.reason);
    else {
      let snapshot: Record<string, unknown>;
      let amount: bigint;
      if (input.action === 'settle_usage') {
        const given = input.usage as NonNullable<typeof input.usage>;
        const usage: Usage = {
          inputTokens: BigInt(given.inputTokens),
          outputTokens: BigInt(given.outputTokens),
          cacheReadTokens: BigInt(given.cacheReadTokens),
          cacheWriteTokens: BigInt(given.cacheWriteTokens),
          webSearchCalls: BigInt(given.webSearchCalls),
          webSearchPreviewCalls: BigInt(given.webSearchPreviewCalls),
          contextTokens: BigInt(given.inputTokens) + BigInt(given.cacheReadTokens) + BigInt(given.cacheWriteTokens),
          rawUsage: { ...originalUsage?.rawUsage, administratorConfirmed: given },
        };
        if (usage.contextTokens > 9_223_372_036_854_775_807n)
          throw new TRPCError({ code: 'BAD_REQUEST', message: '上下文用量超出范围' });
        try {
          snapshot = { ...(await this.pinned(r, usage)), source: 'administrator_usage', reason: input.reason };
        } catch {
          throw new TRPCError({ code: 'BAD_REQUEST', message: '保存的价格无法计算该用量，请核对价格或确认费用' });
        }
        amount = BigInt(snapshot.totalMicros as string);
        await this.writeUsage(tx, r.id, usage);
        await tx.update(requests).set({ usageFinal: true, usageEstimate: null }).where(eq(requests.id, r.id));
      } else {
        amount = parseMoney(input.amount as string);
        snapshot = {
          ...r.pricingSnapshot,
          total: formatMoney(amount),
          totalMicros: amount.toString(),
          source: 'administrator_amount',
          reason: input.reason,
          currency: this.pricing.currency,
        };
      }
      await this.charge(tx, r, amount, snapshot, actorId, input.reason);
    }
    await tx.update(requests).set({ resolutionKey: key, resolutionPayload: payload }).where(eq(requests.id, r.id));
    await tx.insert(adminAuditLogs).values({
      actorId,
      action: 'billing.resolve',
      targetType: 'request',
      targetId: r.id,
      metadata: {
        ...payload,
        idempotencyKey: input.idempotencyKey,
        observedUsage: originalUsage ? usageDto(originalUsage) : null,
        heldBefore: formatMoney(r.heldMicros),
      },
    });
    return { success: true, userId: r.userId };
  }

  async correct(principal: Principal, input: z.infer<typeof correctBillInput>) {
    this.assertReady();
    const target = parseMoney(input.amount);
    const key = `correct:${input.requestId}:${input.idempotencyKey}`;
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [r] = await tx.select().from(requests).where(eq(requests.id, input.requestId)).for('update');
      if (!r) throw new TRPCError({ code: 'NOT_FOUND', message: '请求不存在' });
      const [existing] = await tx.select().from(walletLedger).where(eq(walletLedger.idempotencyKey, key));
      if (existing) {
        if (
          existing.actorId !== actor.id ||
          existing.reason !== input.reason ||
          existing.metadata.targetCharged !== formatMoney(target)
        )
          throw new TRPCError({ code: 'CONFLICT', message: '修正标识已用于不同内容' });
        return { success: true, userId: r.userId };
      }
      if (!r.billingEnabled || r.status !== 'settled' || r.chargedMicros === null)
        throw new TRPCError({ code: 'CONFLICT', message: '仅对已结算计费请求追加修正' });
      const delta = r.chargedMicros - target;
      if (delta === 0n) throw new TRPCError({ code: 'BAD_REQUEST', message: '费用没有变化' });
      const [wallet] = await tx.select().from(wallets).where(eq(wallets.userId, r.userId)).for('update');
      if (!wallet) throw new Error('Wallet missing');
      const balance = bounds(wallet.balanceMicros + delta);
      await tx.update(wallets).set({ balanceMicros: balance }).where(eq(wallets.userId, r.userId));
      const [entry] = await tx
        .insert(walletLedger)
        .values({
          userId: r.userId,
          requestId: r.id,
          kind: 'correction',
          idempotencyKey: key,
          balanceDeltaMicros: delta,
          reservedDeltaMicros: 0n,
          balanceAfterMicros: balance,
          reservedAfterMicros: wallet.reservedMicros,
          actorId: actor.id,
          reason: input.reason,
          metadata: { previousCharged: formatMoney(r.chargedMicros), targetCharged: formatMoney(target) },
        })
        .returning({ id: walletLedger.id });
      await tx.update(requests).set({ chargedMicros: target }).where(eq(requests.id, r.id));
      await tx.insert(adminAuditLogs).values({
        actorId: actor.id,
        action: 'billing.correct',
        targetType: 'request',
        targetId: r.id,
        metadata: {
          ledgerId: entry.id,
          previousCharged: formatMoney(r.chargedMicros),
          targetCharged: formatMoney(target),
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        },
      });
      return { success: true, userId: r.userId };
    });
  }

  async reconcile(userId: string) {
    return this.auth.db.transaction(
      async (tx) => {
        const [wallet] = await tx.select().from(wallets).where(eq(wallets.userId, userId));
        if (!wallet) throw new TRPCError({ code: 'NOT_FOUND', message: '钱包不存在' });
        const [ledger] = await tx
          .select({
            balance: sql<string>`coalesce(sum(${walletLedger.balanceDeltaMicros}), 0)::text`,
            reserved: sql<string>`coalesce(sum(${walletLedger.reservedDeltaMicros}), 0)::text`,
          })
          .from(walletLedger)
          .where(eq(walletLedger.userId, userId));
        const [holds] = await tx
          .select({ total: sql<string>`coalesce(sum(${requests.heldMicros}), 0)::text` })
          .from(requests)
          .where(eq(requests.userId, userId));
        return {
          consistent:
            wallet.balanceMicros === BigInt(ledger.balance) &&
            wallet.reservedMicros === BigInt(ledger.reserved) &&
            wallet.reservedMicros === BigInt(holds.total),
          balance: formatMoney(wallet.balanceMicros),
          ledgerBalance: formatMoney(BigInt(ledger.balance)),
          reserved: formatMoney(wallet.reservedMicros),
          ledgerReserved: formatMoney(BigInt(ledger.reserved)),
          requestHeld: formatMoney(BigInt(holds.total)),
          currency: this.pricing.currency,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}
