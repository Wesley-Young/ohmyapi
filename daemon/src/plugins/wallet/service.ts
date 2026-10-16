import { serviceToken } from '@fraqjs/kernel';
import { and, desc, eq, gte, lte, type SQL, sql } from 'drizzle-orm';

import { AppError } from '../../core/errors.ts';
import { formatMoney, parseMoney } from '../../core/money.ts';
import { toPage } from '../../core/pagination.ts';
import { recordAudit } from '../auth/audit.ts';
import type { AuthService, Principal } from '../auth/service.ts';
import type { Database } from '../database/client.ts';
import { paginate } from '../database/query.ts';
import {
  models,
  requests,
  requestUsage,
  systemSettings,
  users,
  walletLedger,
  wallets,
} from '../database/schema/index.ts';
import { type LedgerEntry, ledgerAmounts, lockWallet, postLedgerEntry } from './ledger.ts';
import type { AdjustWalletInput, StatsRange } from './schemas.ts';

const ledgerDto = (entry: LedgerEntry) => ({
  id: entry.id,
  kind: entry.kind,
  ...ledgerAmounts(entry),
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

const within = (range: StatsRange) =>
  sql`${requests.receivedAt} >= now() - ${range === '24h' ? sql`interval '24 hours'` : sql`interval '30 days'`} and ${requests.receivedAt} <= now()`;

const statsDto = (stats: { requestCount: string; tokens: string; chargedMicros: string }) => ({
  requestCount: stats.requestCount,
  tokens: stats.tokens,
  chargedAmount: formatMoney(BigInt(stats.chargedMicros)),
});

export class WalletService {
  static readonly token = serviceToken<WalletService>('ohmyapi/wallet');
  private readonly db: Database;
  private readonly auth: AuthService;
  constructor({ db, auth }: { db: Database; auth: AuthService }) {
    this.db = db;
    this.auth = auth;
  }

  async get(userId: string) {
    const [wallet] = await this.db.select().from(wallets).where(eq(wallets.userId, userId));
    if (!wallet) throw new AppError('not_found', '钱包不存在');
    const [settings] = await this.db.select({ currency: systemSettings.currency }).from(systemSettings);
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
      this.db
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

  /**
   * 个人按消费排序；全站按请求数排行，前 10 名之后与未识别模型的请求合并为“其他”一行，合计仍与卡片一致。
   * `others` 只在合并行上有值，表示其中已识别的模型数。
   */
  async models(userId: string | undefined, range: StatsRange) {
    const rows = await this.db
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
      others: null as number | null,
      ...statsDto(stats),
    }));
    if (userId) return items;
    const known = items.filter((row) => row.modelId);
    const unknown = sorted.filter((row) => !row.modelId);
    if (!unknown.length && known.length <= 11) return known;
    const extra = sorted.filter((row) => row.modelId).slice(10);
    const rest = [...extra, ...unknown];
    const sum = (key: 'requestCount' | 'tokens' | 'chargedMicros') =>
      rest.reduce((total, row) => total + BigInt(row[key]), 0n).toString();
    return [
      ...known.slice(0, 10),
      {
        modelId: null,
        name: null,
        others: extra.length,
        ...statsDto({ requestCount: sum('requestCount'), tokens: sum('tokens'), chargedMicros: sum('chargedMicros') }),
      },
    ];
  }

  private async aggregateStats(userId?: string, range: StatsRange = '24h') {
    const [stats] = await this.db
      .select(usageStats())
      .from(requests)
      .leftJoin(requestUsage, eq(requestUsage.requestId, requests.id))
      .where(and(userId ? eq(requests.userId, userId) : undefined, within(range)));
    return statsDto(stats);
  }

  /** 不传 `userId` 时统计全站。 */
  async trend(userId?: string) {
    const now = new Date();
    // Seven calendar days in Asia/Shanghai, including the current partial day.
    const dayMs = 86_400_000;
    const offsetMs = 8 * 3_600_000;
    const today = new Date(now.getTime() + offsetMs).toISOString().slice(0, 10);
    const start = new Date(`${today}T00:00:00+08:00`).getTime() - 6 * dayMs;
    const date = sql<string>`to_char(${requests.receivedAt} at time zone 'Asia/Shanghai', 'YYYY-MM-DD')`;
    const rows = await this.db
      .select({ date, ...usageStats() })
      .from(requests)
      .leftJoin(requestUsage, eq(requestUsage.requestId, requests.id))
      .where(
        and(
          userId ? eq(requests.userId, userId) : undefined,
          gte(requests.receivedAt, new Date(start)),
          lte(requests.receivedAt, now),
        ),
      )
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
      this.db.select({ currency: systemSettings.currency }).from(systemSettings),
    ]);
    return { last24Hours, last30Days, currency: settings.currency };
  }

  /** 与请求列表「待核对」筛选条件一致，供导航徽标轮询。 */
  async reviewCount() {
    const [review] = await this.db
      .select({ count: sql<number>`count(*)::integer` })
      .from(requests)
      .where(and(eq(requests.status, 'needs_review'), eq(requests.billingEnabled, true)));
    return review.count;
  }

  async ledger(userId: string, page: number) {
    const rows = await paginate(
      this.db
        .select({ entry: walletLedger, actorName: users.username })
        .from(walletLedger)
        .leftJoin(users, eq(walletLedger.actorId, users.id))
        .where(eq(walletLedger.userId, userId))
        .orderBy(desc(walletLedger.createdAt), desc(walletLedger.id))
        .$dynamic(),
      page,
    );
    const { items, hasMore } = toPage(rows);
    return { items: items.map(({ entry, actorName }) => ({ ...ledgerDto(entry), actorName })), hasMore };
  }

  async adjust(principal: Principal, input: AdjustWalletInput) {
    const delta = parseMoney(input.amount);
    if (!delta) throw new AppError('bad_request', '调整金额不能为零');
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
          throw new AppError('conflict', '该操作标识已用于其他余额调整');
        return ledgerDto(existing);
      }
      const [target] = await tx.select().from(users).where(eq(users.id, input.userId)).for('update');
      if (!target || target.deletedAt) throw new AppError('not_found', '用户不存在或已删除');
      const wallet = await lockWallet(tx, input.userId);
      if (!wallet) throw new AppError('not_found', '钱包不存在');
      const next = wallet.balanceMicros + delta;
      if (delta < 0n && next < wallet.reservedMicros) throw new AppError('bad_request', '扣减金额超过可用余额');
      if (next < -9223372036854775808n || next > 9223372036854775807n)
        throw new AppError('bad_request', '调整后的余额超出范围');
      const entry = await postLedgerEntry(tx, wallet, {
        kind: 'adjustment',
        idempotencyKey: key,
        balanceDeltaMicros: delta,
        reservedDeltaMicros: 0n,
        actorId: actor.id,
        reason: input.reason,
      });
      await recordAudit(tx, {
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
