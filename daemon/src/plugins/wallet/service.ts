import { serviceToken } from '@fraqjs/kernel';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, gte, lte, type SQL, sql } from 'drizzle-orm';

import type { AuthService, Principal } from '../auth/service.js';
import { formatMoney, parseMoney } from '../billing/conventions.js';
import {
  adminAuditLogs,
  models,
  requests,
  requestUsage,
  systemSettings,
  users,
  walletLedger,
  wallets,
} from '../database/schema/index.js';
import { pageSize } from '../users/service.js';

const ledgerDto = (entry: typeof walletLedger.$inferSelect) => ({
  id: entry.id,
  kind: entry.kind,
  amount: formatMoney(entry.balanceDeltaMicros),
  reservedAmount: formatMoney(entry.reservedDeltaMicros),
  balanceAfter: formatMoney(entry.balanceAfterMicros),
  reservedAfter: formatMoney(entry.reservedAfterMicros),
  reason: entry.reason,
  actorId: entry.actorId,
  requestId: entry.requestId,
  createdAt: entry.createdAt.toISOString(),
});

const usageStats = () => ({
  requestCount: sql<string>`count(*)::text`,
  tokens: sql<string>`coalesce(sum(${requestUsage.inputTokens} + ${requestUsage.outputTokens} + ${requestUsage.cacheReadTokens} + ${requestUsage.cacheWriteTokens}), 0)::text`,
  chargedMicros: sql<string>`coalesce(sum(${requests.chargedMicros}) filter (where ${requests.status} = 'settled'), 0)::text`,
});

const within = (range: '24h' | '30d') =>
  sql`${requests.receivedAt} >= now() - ${range === '24h' ? sql`interval '24 hours'` : sql`interval '30 days'`} and ${requests.receivedAt} <= now()`;

const statsDto = (stats: { requestCount: string; tokens: string; chargedMicros: string }) => ({
  requestCount: stats.requestCount,
  tokens: stats.tokens,
  chargedAmount: formatMoney(BigInt(stats.chargedMicros)),
});

export class WalletService {
  static readonly token = serviceToken<WalletService>('ohmyapi/wallet');
  private readonly auth: AuthService;
  constructor(auth: AuthService) {
    this.auth = auth;
  }

  async get(userId: string) {
    const [wallet] = await this.auth.db.select().from(wallets).where(eq(wallets.userId, userId));
    if (!wallet) throw new TRPCError({ code: 'NOT_FOUND', message: '钱包不存在' });
    const [settings] = await this.auth.db.select({ currency: systemSettings.currency }).from(systemSettings);
    return {
      currency: settings.currency,
      balance: formatMoney(wallet.balanceMicros),
      reserved: formatMoney(wallet.reservedMicros),
      available: formatMoney(wallet.balanceMicros - wallet.reservedMicros),
    };
  }

  async stats(userId: string) {
    // Calendar month in Asia/Shanghai; the 30-day window is rolling.
    const monthStart = sql`(date_trunc('month', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai')`;
    const settled = (since: SQL) =>
      sql<string>`coalesce(sum(${requests.chargedMicros}) filter (where ${requests.status} = 'settled' and ${requests.receivedAt} >= ${since}), 0)::text`;
    const [stats, [spending]] = await Promise.all([
      this.aggregateStats(userId),
      this.auth.db
        .select({
          month: settled(monthStart),
          last30Days: settled(sql`now() - interval '30 days'`),
        })
        .from(requests)
        .where(
          and(
            eq(requests.userId, userId),
            sql`${requests.receivedAt} >= least(${monthStart}, now() - interval '30 days') and ${requests.receivedAt} <= now()`,
          ),
        ),
    ]);
    return {
      ...stats,
      monthChargedAmount: formatMoney(BigInt(spending.month)),
      last30DaysChargedAmount: formatMoney(BigInt(spending.last30Days)),
    };
  }

  /** 个人按消费排序；全站按请求数排行，前 10 名之后合并为一行，合计仍与卡片一致。 */
  async models(userId: string | undefined, range: '24h' | '30d') {
    const rows = await this.auth.db
      .select({ modelId: requests.modelId, name: models.name, ...usageStats() })
      .from(requests)
      .leftJoin(requestUsage, eq(requestUsage.requestId, requests.id))
      .leftJoin(models, eq(models.id, requests.modelId))
      .where(and(userId ? eq(requests.userId, userId) : undefined, within(range)))
      .groupBy(requests.modelId, models.name);
    const descending = (a: string, b: string) => {
      const difference = BigInt(b) - BigInt(a);
      return difference > 0n ? 1 : difference < 0n ? -1 : 0;
    };
    const sorted = rows.sort((a, b) =>
      userId
        ? descending(a.chargedMicros, b.chargedMicros) || descending(a.requestCount, b.requestCount)
        : descending(a.requestCount, b.requestCount) || descending(a.chargedMicros, b.chargedMicros),
    );
    // Requests rejected before model resolution carry no model and are reported together.
    const items = sorted.map(({ modelId, name, ...stats }) => ({
      modelId,
      name: modelId ? name : null,
      others: 0,
      ...statsDto(stats),
    }));
    if (userId || sorted.length <= 11) return items;
    const rest = sorted.slice(10);
    const sum = (key: 'requestCount' | 'tokens' | 'chargedMicros') =>
      rest.reduce((total, row) => total + BigInt(row[key]), 0n).toString();
    return [
      ...items.slice(0, 10),
      {
        modelId: null,
        name: null,
        others: rest.length,
        ...statsDto({ requestCount: sum('requestCount'), tokens: sum('tokens'), chargedMicros: sum('chargedMicros') }),
      },
    ];
  }

  private async aggregateStats(userId?: string, range: '24h' | '30d' = '24h') {
    const [stats] = await this.auth.db
      .select(usageStats())
      .from(requests)
      .leftJoin(requestUsage, eq(requestUsage.requestId, requests.id))
      .where(and(userId ? eq(requests.userId, userId) : undefined, within(range)));
    return statsDto(stats);
  }

  async trend(userId: string) {
    const now = new Date();
    // Seven calendar days in Asia/Shanghai, including the current partial day.
    const dayMs = 86_400_000;
    const offsetMs = 8 * 3_600_000;
    const today = new Date(now.getTime() + offsetMs).toISOString().slice(0, 10);
    const start = new Date(`${today}T00:00:00+08:00`).getTime() - 6 * dayMs;
    const date = sql<string>`to_char(${requests.receivedAt} at time zone 'Asia/Shanghai', 'YYYY-MM-DD')`;
    const rows = await this.auth.db
      .select({ date, ...usageStats() })
      .from(requests)
      .leftJoin(requestUsage, eq(requestUsage.requestId, requests.id))
      .where(and(eq(requests.userId, userId), gte(requests.receivedAt, new Date(start)), lte(requests.receivedAt, now)))
      .groupBy(date);
    const byDate = new Map(rows.map((row) => [row.date, statsDto(row)]));
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(start + index * dayMs + offsetMs).toISOString().slice(0, 10);
      return { date, ...(byDate.get(date) ?? { requestCount: '0', tokens: '0', chargedAmount: '0.000000' }) };
    });
  }

  async platformStats() {
    const [last24Hours, last30Days, [settings]] = await Promise.all([
      this.aggregateStats(undefined, '24h'),
      this.aggregateStats(undefined, '30d'),
      this.auth.db.select({ currency: systemSettings.currency }).from(systemSettings),
    ]);
    return { last24Hours, last30Days, currency: settings.currency };
  }

  /** 与请求列表「待核对」筛选条件一致，供导航徽标轮询。 */
  async reviewCount() {
    const [review] = await this.auth.db
      .select({ count: sql<number>`count(*)::integer` })
      .from(requests)
      .where(and(eq(requests.status, 'needs_review'), eq(requests.billingEnabled, true)));
    return review.count;
  }

  async ledger(userId: string, page: number) {
    const rows = await this.auth.db
      .select({ entry: walletLedger, actorName: users.username })
      .from(walletLedger)
      .leftJoin(users, eq(walletLedger.actorId, users.id))
      .where(eq(walletLedger.userId, userId))
      .orderBy(desc(walletLedger.createdAt), desc(walletLedger.id))
      .limit(pageSize + 1)
      .offset(page * pageSize);
    return {
      items: rows.slice(0, pageSize).map(({ entry, actorName }) => ({ ...ledgerDto(entry), actorName })),
      hasMore: rows.length > pageSize,
    };
  }

  async adjust(
    principal: Principal,
    input: { userId: string; amount: string; reason: string; idempotencyKey: string },
  ) {
    const delta = parseMoney(input.amount);
    if (!delta) throw new TRPCError({ code: 'BAD_REQUEST', message: '调整金额不能为零' });
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const key = `adjust:${actor.id}:${input.idempotencyKey}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      const [existing] = await tx.select().from(walletLedger).where(eq(walletLedger.idempotencyKey, key));
      if (existing) {
        if (
          existing.userId !== input.userId ||
          existing.balanceDeltaMicros !== delta ||
          existing.reason !== input.reason
        )
          throw new TRPCError({ code: 'CONFLICT', message: '该操作标识已用于其他余额调整' });
        return ledgerDto(existing);
      }
      const [target] = await tx.select().from(users).where(eq(users.id, input.userId)).for('update');
      if (!target || target.deletedAt) throw new TRPCError({ code: 'NOT_FOUND', message: '用户不存在或已删除' });
      const [wallet] = await tx.select().from(wallets).where(eq(wallets.userId, input.userId)).for('update');
      if (!wallet) throw new TRPCError({ code: 'NOT_FOUND', message: '钱包不存在' });
      const next = wallet.balanceMicros + delta;
      if (delta < 0n && next < wallet.reservedMicros)
        throw new TRPCError({ code: 'BAD_REQUEST', message: '扣减金额超过可用余额' });
      if (next < -9223372036854775808n || next > 9223372036854775807n)
        throw new TRPCError({ code: 'BAD_REQUEST', message: '调整后的余额超出范围' });
      await tx.update(wallets).set({ balanceMicros: next }).where(eq(wallets.userId, input.userId));
      const [entry] = await tx
        .insert(walletLedger)
        .values({
          userId: input.userId,
          kind: 'adjustment',
          idempotencyKey: key,
          balanceDeltaMicros: delta,
          reservedDeltaMicros: 0n,
          balanceAfterMicros: next,
          reservedAfterMicros: wallet.reservedMicros,
          actorId: actor.id,
          reason: input.reason,
        })
        .returning();
      await tx.insert(adminAuditLogs).values({
        actorId: actor.id,
        action: 'wallet.adjust',
        targetType: 'user',
        targetId: input.userId,
        metadata: {
          ledgerId: entry.id,
          amount: formatMoney(delta),
          balanceBefore: formatMoney(wallet.balanceMicros),
          balanceAfter: formatMoney(next),
          reason: input.reason,
        },
      });
      return ledgerDto(entry);
    });
  }
}
