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
import type { CorrectBillInput, ResolveBillInput, ResolveZeroBillsInput } from './schemas.ts';
import { priceRequestUsage, releaseRequest, settleRequest } from './settlement.ts';

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

  async resolveZero(principal: Principal, input: ResolveZeroBillsInput) {
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
