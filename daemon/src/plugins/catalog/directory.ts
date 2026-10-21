import { serviceToken } from '@fraqjs/kernel';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';

import { AppError } from '../../core/errors.ts';
import { formatMoney } from '../../core/money.ts';
import { createdCursor, decodeCursor, toCursorPage } from '../../core/pagination.ts';
import type { Database } from '../database/client.ts';
import { createdBefore, createdPosition } from '../database/query.ts';
import {
  aggregateChannelMembers,
  type ChannelType,
  channels,
  effectiveChannelEndpoints,
  endpoints,
  subscriptionAccounts,
} from '../database/schema/index.ts';
import type { SubscriptionService } from '../subscription/service.ts';
import type { ChannelConcurrency } from './concurrency.ts';

const channelColumns = {
  id: channels.id,
  name: channels.name,
  type: channels.type,
  pricingMode: channels.pricingMode,
  baseUrl: channels.baseUrl,
  enabled: channels.enabled,
  isPublic: channels.isPublic,
  timeoutMs: channels.timeoutMs,
  maxConcurrent: channels.maxConcurrent,
  multiplierMicros: channels.multiplierMicros,
  createdAt: channels.createdAt,
  position: createdPosition(channels.createdAt),
  subscription: {
    id: subscriptionAccounts.id,
    provider: subscriptionAccounts.provider,
    credentialEncrypted: subscriptionAccounts.credentialEncrypted,
    maxConcurrent: subscriptionAccounts.maxConcurrent,
    errorCode: subscriptionAccounts.errorCode,
    cooldownUntil: subscriptionAccounts.cooldownUntil,
    modelCooldowns: subscriptionAccounts.modelCooldowns,
  },
};

/** 公开 API 的渠道查询：渠道配置与订阅账号的本地状态，不含凭据和代理地址。 */
export class ChannelDirectory {
  static readonly token = serviceToken<ChannelDirectory>('ohmyapi/channel-directory');
  private readonly db: Database;
  private readonly subscription: SubscriptionService;
  private readonly concurrency: ChannelConcurrency;
  constructor({
    db,
    subscription,
    concurrency,
  }: {
    db: Database;
    subscription: SubscriptionService;
    concurrency: ChannelConcurrency;
  }) {
    this.db = db;
    this.subscription = subscription;
    this.concurrency = concurrency;
  }

  /** 未删除的渠道，按创建时间倒序的游标分页。 */
  async page({ type, cursor, limit }: { type?: ChannelType; cursor?: string; limit: number }) {
    const after = cursor ? decodeCursor(cursor, createdCursor) : undefined;
    const rows = await this.query()
      .where(
        and(
          isNull(channels.deletedAt),
          type ? eq(channels.type, type) : undefined,
          createdBefore(channels.createdAt, channels.id, after),
        ),
      )
      .orderBy(desc(channels.createdAt), desc(channels.id))
      .limit(limit + 1);
    const { items, nextCursor } = toCursorPage(rows, limit, (row) => ({ createdAt: row.position, id: row.id }));
    return { items: await this.describe(items), nextCursor };
  }

  async get(channelId: string) {
    const rows = await this.query().where(and(eq(channels.id, channelId), isNull(channels.deletedAt)));
    if (!rows.length) throw new AppError('not_found', '渠道不存在');
    const [channel] = await this.describe(rows);
    return channel;
  }

  private query() {
    return this.db
      .select(channelColumns)
      .from(channels)
      .leftJoin(subscriptionAccounts, eq(channels.subscriptionAccountId, subscriptionAccounts.id))
      .$dynamic();
  }

  private async describe(rows: Awaited<ReturnType<ReturnType<ChannelDirectory['query']>['execute']>>) {
    const ids = rows.map((row) => row.id);
    const [scopes, members] = ids.length
      ? await Promise.all([
          this.db.select().from(effectiveChannelEndpoints).where(inArray(effectiveChannelEndpoints.channelId, ids)),
          this.db
            .select()
            .from(aggregateChannelMembers)
            .where(inArray(aggregateChannelMembers.aggregateChannelId, ids))
            .orderBy(desc(aggregateChannelMembers.priority), asc(aggregateChannelMembers.memberChannelId)),
        ])
      : [[], []];
    const now = Date.now();
    return rows.map((row) => {
      const identity = { id: row.id, name: row.name };
      const common = {
        enabled: row.enabled,
        isPublic: row.isPublic,
        multiplier: formatMoney(row.multiplierMicros),
        timeoutMs: row.timeoutMs,
        endpoints: endpoints.filter((endpoint) =>
          scopes.some((scope) => scope.channelId === row.id && scope.endpoint === endpoint),
        ),
        createdAt: row.createdAt.toISOString(),
      };
      if (row.type === 'subscription' && row.subscription) {
        const account = row.subscription;
        const cooldownUntil =
          account.cooldownUntil && account.cooldownUntil.getTime() > now ? account.cooldownUntil : null;
        return {
          ...identity,
          type: 'subscription' as const,
          ...common,
          subscription: {
            provider: account.provider,
            email: this.subscription.accountEmail(account.credentialEncrypted, account.provider),
            status: account.errorCode
              ? ('reauthorization_required' as const)
              : cooldownUntil
                ? ('cooling_down' as const)
                : ('active' as const),
            errorCode: account.errorCode,
            cooldownUntil: cooldownUntil?.toISOString() ?? null,
            modelCooldowns: Object.entries(account.modelCooldowns)
              .filter(([, until]) => Date.parse(until) > now)
              .map(([model, until]) => ({ model, until: new Date(until).toISOString() }))
              .sort((a, b) => a.model.localeCompare(b.model)),
            maxConcurrent: account.maxConcurrent,
            activeRequests: this.subscription.activeRequests(account.id),
          },
        };
      }
      if (row.type === 'aggregate')
        return {
          ...identity,
          type: 'aggregate' as const,
          ...common,
          pricingMode: row.pricingMode,
          members: members
            .filter((member) => member.aggregateChannelId === row.id)
            .map((member) => ({ channelId: member.memberChannelId, priority: member.priority, weight: member.weight })),
        };
      return {
        ...identity,
        type: 'api' as const,
        ...common,
        baseUrl: row.baseUrl ?? '',
        maxConcurrent: row.maxConcurrent,
        activeRequests: this.concurrency.active(row.id),
      };
    });
  }
}
