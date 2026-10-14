import { serviceToken } from '@fraqjs/kernel';
import { and, eq, sql } from 'drizzle-orm';

import { AppError, requestErrorMessage } from '../../core/errors.js';
import { formatMoney } from '../../core/money.js';
import type { Principal } from '../auth/service.js';
import type { Database } from '../database/client.js';
import { requestAttempts, requests, requestUsage, users, walletLedger, wallets } from '../database/schema/index.js';
import { type PricingService, publicPricingSnapshot } from '../pricing/service.js';
import { ledgerAmounts } from '../wallet/ledger.js';
import { cacheReadForDisplay } from './cache-usage.js';
import { displayUsage } from './requests.js';
import { type PricedUsage, priceRequestUsage } from './settlement.js';

/** 账单查询：请求的计费明细与钱包对账。 */
export class BillingRecords {
  static readonly token = serviceToken<BillingRecords>('ohmyapi/billing-records');
  private readonly db: Database;
  private readonly pricing: PricingService;
  constructor(deps: { db: Database; pricing: PricingService }) {
    this.db = deps.db;
    this.pricing = deps.pricing;
  }

  async detail(principal: Principal, id: string) {
    const [r] = await this.db
      .select()
      .from(requests)
      .where(
        and(eq(requests.id, id), principal.user.role === 'admin' ? undefined : eq(requests.userId, principal.user.id)),
      );
    if (!r) throw new AppError('not_found', '请求不存在');
    const [usage] = await this.db.select().from(requestUsage).where(eq(requestUsage.requestId, id));
    const attempts =
      principal.user.role === 'admin'
        ? await this.db
            .select()
            .from(requestAttempts)
            .where(eq(requestAttempts.requestId, id))
            .orderBy(requestAttempts.sequence)
        : [];
    const ledger = await this.db
      .select({ entry: walletLedger, actor: users.username })
      .from(walletLedger)
      .leftJoin(users, eq(walletLedger.actorId, users.id))
      .where(eq(walletLedger.requestId, id))
      .orderBy(walletLedger.createdAt, walletLedger.id);
    let preview: PricedUsage | undefined;
    let previewError: string | undefined;
    const cacheRead = usage
      ? cacheReadForDisplay(r.endpoint, r.usageFinal, usage.rawUsage, usage.cacheReadTokens)
      : null;
    if (usage && cacheRead === null) previewError = '缓存用量未知，请依据上游账单核对，不能按零缓存计算费用';
    if (r.billingEnabled && usage && cacheRead !== null)
      try {
        preview = await priceRequestUsage(this.pricing, r, usage);
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
      usage: usage ? displayUsage(r, usage) : null,
      preview: preview
        ? { ...preview, routing: principal.user.role === 'admin' ? preview.routing : undefined }
        : undefined,
      previewError,
      ledger: ledger.map(({ entry: e, actor }) => ({
        id: e.id,
        kind: e.kind,
        ...ledgerAmounts(e),
        reason: e.reason,
        actor: actor ?? '系统',
        createdAt: e.createdAt.toISOString(),
        metadata: principal.user.role === 'admin' ? e.metadata : publicPricingSnapshot(e.metadata),
      })),
    };
  }

  async reconcile(userId: string) {
    return this.db.transaction(
      async (tx) => {
        const [wallet] = await tx.select().from(wallets).where(eq(wallets.userId, userId));
        if (!wallet) throw new AppError('not_found', '钱包不存在');
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
