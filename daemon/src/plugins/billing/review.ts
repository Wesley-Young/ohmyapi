import { serviceToken } from '@fraqjs/kernel';
import { eq, inArray } from 'drizzle-orm';

import { AppError } from '../../core/errors.js';
import { formatMoney, parseMoney } from '../../core/money.js';
import { recordAudit } from '../auth/audit.js';
import type { AuthService, Principal } from '../auth/service.js';
import type { Transaction } from '../database/client.js';
import { requests, requestUsage, walletLedger, wallets } from '../database/schema/index.js';
import type { Usage } from '../gateway/usage.js';
import type { PricingService } from '../pricing/service.js';
import { lockWallet, postLedgerEntry } from '../wallet/ledger.js';
import { lockRequest, usageDto, writeUsage } from './requests.js';
import type { CorrectBillInput, ResolveBillInput, ResolveZeroBillsInput } from './schemas.js';
import type { BillingService } from './service.js';
import { priceRequestUsage, releaseRequest, settleRequest } from './settlement.js';

/** 稳定序列化，用于比较幂等提交的内容是否一致。 */
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

/** 管理员核对：处理待核对请求，并对已结算的费用追加修正。所有操作幂等并留有审计记录。 */
export class BillingReviewService {
  static readonly token = serviceToken<BillingReviewService>('ohmyapi/billing-review');
  private readonly auth: AuthService;
  private readonly pricing: PricingService;
  private readonly billing: BillingService;
  constructor(deps: { auth: AuthService; pricing: PricingService; billing: BillingService }) {
    this.auth = deps.auth;
    this.pricing = deps.pricing;
    this.billing = deps.billing;
  }

  async resolve(principal: Principal, input: ResolveBillInput) {
    this.billing.assertReady();
    if (input.action === 'settle_usage' && !input.usage) throw new AppError('bad_request', '请填写确认后的用量');
    if (input.action === 'settle_amount' && input.amount === undefined)
      throw new AppError('bad_request', '请填写确认后的费用');
    return this.auth.authorized(principal, { admin: true }, (tx, actor) =>
      this.resolveInTransaction(tx, actor.id, input),
    );
  }

  async resolveZero(principal: Principal, input: ResolveZeroBillsInput) {
    this.billing.assertReady();
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
    input: ResolveBillInput,
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
    const r = await lockRequest(tx, input.requestId);
    if (!r) throw new AppError('not_found', '请求不存在');
    if (r.resolutionKey === key) {
      if (canonical(r.resolutionPayload) !== canonical(payload))
        throw new AppError('conflict', '核对标识已用于不同内容');
      return { success: true, userId: r.userId };
    }
    if (!r.billingEnabled || r.status !== 'needs_review')
      throw new AppError('conflict', `请求 ${r.id} 已发生状态变化，请刷新后重新选择待核对请求`);
    const [originalUsage] = await tx.select().from(requestUsage).where(eq(requestUsage.requestId, r.id));
    if (input.action === 'release') await releaseRequest(tx, r, actorId, input.reason);
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
        if (usage.contextTokens > 9_223_372_036_854_775_807n) throw new AppError('bad_request', '上下文用量超出范围');
        try {
          snapshot = {
            ...(await priceRequestUsage(this.pricing, r, usage)),
            source: 'administrator_usage',
            reason: input.reason,
          };
        } catch {
          throw new AppError('bad_request', '保存的价格无法计算该用量，请核对价格或确认费用');
        }
        amount = BigInt(snapshot.totalMicros as string);
        await writeUsage(tx, r.id, usage);
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
      await settleRequest(tx, r, amount, snapshot, actorId, input.reason);
    }
    await tx.update(requests).set({ resolutionKey: key, resolutionPayload: payload }).where(eq(requests.id, r.id));
    await recordAudit(tx, {
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

  async correct(principal: Principal, input: CorrectBillInput) {
    this.billing.assertReady();
    const target = parseMoney(input.amount);
    const key = `correct:${input.requestId}:${input.idempotencyKey}`;
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const r = await lockRequest(tx, input.requestId);
      if (!r) throw new AppError('not_found', '请求不存在');
      const [existing] = await tx.select().from(walletLedger).where(eq(walletLedger.idempotencyKey, key));
      if (existing) {
        if (
          existing.actorId !== actor.id ||
          existing.reason !== input.reason ||
          existing.metadata.targetCharged !== formatMoney(target)
        )
          throw new AppError('conflict', '修正标识已用于不同内容');
        return { success: true, userId: r.userId };
      }
      if (!r.billingEnabled || r.status !== 'settled' || r.chargedMicros === null)
        throw new AppError('conflict', '仅对已结算计费请求追加修正');
      const delta = r.chargedMicros - target;
      if (delta === 0n) throw new AppError('bad_request', '费用没有变化');
      const wallet = await lockWallet(tx, r.userId);
      if (!wallet) throw new Error('Wallet missing');
      const entry = await postLedgerEntry(tx, wallet, {
        requestId: r.id,
        kind: 'correction',
        idempotencyKey: key,
        balanceDeltaMicros: delta,
        reservedDeltaMicros: 0n,
        actorId: actor.id,
        reason: input.reason,
        metadata: { previousCharged: formatMoney(r.chargedMicros), targetCharged: formatMoney(target) },
      });
      await tx.update(requests).set({ chargedMicros: target }).where(eq(requests.id, r.id));
      await recordAudit(tx, {
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
}
