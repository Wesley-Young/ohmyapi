import { serviceToken } from '@fraqjs/kernel';
import { eq, inArray } from 'drizzle-orm';

import { AppError } from '../../core/errors.ts';
import { formatMoney, parseMoney } from '../../core/money.ts';
import { recordAudit } from '../auth/audit.ts';
import type { AuthService, Principal } from '../auth/service.ts';
import type { Transaction } from '../database/client.ts';
import { requests, requestUsage, type Usage, wallets } from '../database/schema/index.ts';
import type { PricingService } from '../pricing/service.ts';
import { lockWallet, postLedgerEntry } from '../wallet/ledger.ts';
import { lockRequest, usageDto, writeUsage } from './requests.ts';
import type { BatchRequestsInput, CorrectBillInput, ResolveBatchInput, ResolveBillInput } from './schemas.ts';
import { priceRecordedUsage, priceRequestUsage, releaseRequest, settleRequest } from './settlement.ts';

import { randomUUID } from 'node:crypto';

/**
 * 管理员核对：处理待核对请求，并对已结算的费用追加修正。所有操作留有审计记录。
 * 重复提交是安全的：核对只接受仍待核对的请求，修正按目标金额计算差额，费用不变时拒绝。
 */
export class BillingReview {
  static readonly token = serviceToken<BillingReview>('ohmyapi/billing-review');
  private readonly auth: AuthService;
  private readonly pricing: PricingService;
  constructor(deps: { auth: AuthService; pricing: PricingService }) {
    this.auth = deps.auth;
    this.pricing = deps.pricing;
  }

  async resolve(principal: Principal, input: ResolveBillInput) {
    if (input.action === 'settle_usage' && !input.usage) throw new AppError('bad_request', '请填写确认后的用量');
    if (input.action === 'settle_amount' && input.amount === undefined)
      throw new AppError('bad_request', '请填写确认后的费用');
    return this.auth.authorized(principal, { admin: true }, (tx, actor) =>
      this.resolveInTransaction(tx, actor.id, input),
    );
  }

  /** 批量核对前的分类预览，与 resolveBatch 使用同一规则。 */
  async batchPlan(principal: Principal, input: BatchRequestsInput) {
    return this.auth.authorized(principal, { admin: true }, async (tx) => {
      const plans = await this.planBatch(tx, input.requestIds, false);
      const byUsage = plans.filter((p) => p.plan === 'usage');
      return {
        currency: this.pricing.currency,
        usage: {
          count: byUsage.length,
          amount: formatMoney(byUsage.reduce((sum, p) => sum + BigInt(p.priced?.totalMicros ?? 0), 0n)),
        },
        zero: plans.filter((p) => p.plan === 'zero').length,
        manual: plans.filter((p) => p.plan === 'manual').length,
        stale: input.requestIds.length - plans.length + plans.filter((p) => p.plan === 'stale').length,
      };
    });
  }

  /**
   * 批量核对：用量可以自动计价的按记录的用量结算，没有用量记录的按 0 结算，
   * 缓存用量未知或价格无法计算的保持待核对，由管理员逐条处理。
   */
  async resolveBatch(principal: Principal, input: ResolveBatchInput) {
    const ids = [...input.requestIds].sort();
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      // 按固定顺序锁定请求和钱包，整批结算在同一事务中完成。
      const plans = await this.planBatch(tx, ids, true);
      if (plans.length !== ids.length || plans.some((p) => p.plan === 'stale'))
        throw new AppError('conflict', '部分请求已发生状态变化，请刷新后重新选择待核对请求');
      const settled = plans.filter((p) => p.plan !== 'manual');
      const userIds = [...new Set(settled.map((p) => p.r.userId))].sort();
      if (userIds.length)
        await tx.select().from(wallets).where(inArray(wallets.userId, userIds)).orderBy(wallets.userId).for('update');
      for (const { r, plan } of settled)
        await this.resolveInTransaction(
          tx,
          actor.id,
          plan === 'usage'
            ? { requestId: r.id, action: 'settle_recorded', reason: input.reason }
            : { requestId: r.id, action: 'settle_amount', amount: '0', reason: input.reason },
          ids,
        );
      return {
        success: true,
        usage: settled.filter((p) => p.plan === 'usage').length,
        zero: settled.filter((p) => p.plan === 'zero').length,
        manual: plans.length - settled.length,
        userIds,
      };
    });
  }

  private async planBatch(tx: Transaction, ids: string[], lock: boolean) {
    const query = tx.select().from(requests).where(inArray(requests.id, ids)).orderBy(requests.id);
    const rows = await (lock ? query.for('update') : query);
    const usages = await tx.select().from(requestUsage).where(inArray(requestUsage.requestId, ids));
    const usageById = new Map(usages.map((u) => [u.requestId, u]));
    return rows.map((r) => {
      if (!r.billingEnabled || r.status !== 'needs_review') return { r, plan: 'stale' as const };
      const usage = usageById.get(r.id);
      if (!usage) return { r, plan: 'zero' as const };
      const { priced } = priceRecordedUsage(this.pricing, r, usage);
      return priced ? { r, plan: 'usage' as const, priced } : { r, plan: 'manual' as const };
    });
  }

  private async resolveInTransaction(
    tx: Transaction,
    actorId: string,
    input: ResolveBillInput | { requestId: string; action: 'settle_recorded'; reason: string },
    batchRequestIds?: string[],
  ) {
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
    if (!r.billingEnabled || r.status !== 'needs_review')
      throw new AppError('conflict', `请求 ${r.id} 已发生状态变化，请刷新后重新选择待核对请求`);
    const [originalUsage] = await tx.select().from(requestUsage).where(eq(requestUsage.requestId, r.id));
    if (input.action === 'release') await releaseRequest(tx, r, actorId, input.reason);
    else {
      let snapshot: Record<string, unknown>;
      let amount: bigint;
      if (input.action === 'settle_usage') {
        const given = input.usage as NonNullable<typeof input.usage>;
        if (r.endpoint === '/v1/images' && given.generatedImages === undefined)
          throw new AppError('bad_request', '请填写确认后的出图张数');
        if (r.endpoint !== '/v1/images' && BigInt(given.generatedImages ?? 0) !== 0n)
          throw new AppError('bad_request', '仅图像生成请求支持按张核对');
        const usage: Usage = {
          inputTokens: BigInt(given.inputTokens),
          outputTokens: BigInt(given.outputTokens),
          cacheReadTokens: BigInt(given.cacheReadTokens),
          cacheWriteTokens: BigInt(given.cacheWriteTokens),
          generatedImages: BigInt(given.generatedImages ?? 0),
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
      } else if (input.action === 'settle_recorded') {
        const recorded = originalUsage ? priceRecordedUsage(this.pricing, r, originalUsage) : undefined;
        if (!recorded?.priced) throw new AppError('conflict', `请求 ${r.id} 的用量无法自动计价，请逐条核对`);
        snapshot = { ...recorded.priced, source: 'administrator_recorded_usage', reason: input.reason };
        amount = BigInt(recorded.priced.totalMicros);
        await tx.update(requests).set({ usageFinal: true, usageEstimate: null }).where(eq(requests.id, r.id));
      } else {
        amount = parseMoney(input.amount as string);
        snapshot = {
          total: formatMoney(amount),
          totalMicros: amount.toString(),
          source: 'administrator_amount',
          reason: input.reason,
          currency: this.pricing.currency,
        };
      }
      await settleRequest(tx, r, amount, snapshot, actorId, input.reason);
    }
    await recordAudit(tx, {
      actorId,
      action: 'billing.resolve',
      targetType: 'request',
      targetId: r.id,
      metadata: {
        ...payload,
        observedUsage: originalUsage ? usageDto(originalUsage) : null,
        heldBefore: formatMoney(r.heldMicros),
      },
    });
    return { success: true, userId: r.userId };
  }

  async correct(principal: Principal, input: CorrectBillInput) {
    const target = parseMoney(input.amount);
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const r = await lockRequest(tx, input.requestId);
      if (!r) throw new AppError('not_found', '请求不存在');
      if (!r.billingEnabled || r.status !== 'settled' || r.chargedMicros === null)
        throw new AppError('conflict', '仅对已结算计费请求追加修正');
      const delta = r.chargedMicros - target;
      if (delta === 0n) throw new AppError('bad_request', '费用没有变化');
      const wallet = await lockWallet(tx, r.userId);
      if (!wallet) throw new Error('Wallet missing');
      const entry = await postLedgerEntry(tx, wallet, {
        requestId: r.id,
        kind: 'correction',
        idempotencyKey: `correct:${r.id}:${randomUUID()}`,
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
        },
      });
      return { success: true, userId: r.userId };
    });
  }
}
