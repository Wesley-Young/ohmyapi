import { serviceToken } from '@fraqjs/kernel';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';

import { formatMoney, parseMoney } from '../billing/conventions.js';
import {
  adminAuditLogs,
  requests,
  requestUsage,
  systemSettings,
  users,
  walletLedger,
  wallets,
} from '../db/schema/index.js';
import type { AuthService, Principal } from './auth.js';
import { pageSize } from './users.js';

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
    return this.aggregateStats(userId);
  }

  private async aggregateStats(userId?: string) {
    const [stats] = await this.auth.db
      .select(usageStats())
      .from(requests)
      .leftJoin(requestUsage, eq(requestUsage.requestId, requests.id))
      .where(
        and(
          userId ? eq(requests.userId, userId) : undefined,
          sql`${requests.receivedAt} >= now() - interval '24 hours' and ${requests.receivedAt} <= now()`,
        ),
      );
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
    const [stats, [review], [settings]] = await Promise.all([
      this.aggregateStats(),
      this.auth.db
        .select({ count: sql<string>`count(*)::text` })
        .from(requests)
        .where(eq(requests.status, 'needs_review')),
      this.auth.db.select({ currency: systemSettings.currency }).from(systemSettings),
    ]);
    return { ...stats, reviewCount: review.count, currency: settings.currency };
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
