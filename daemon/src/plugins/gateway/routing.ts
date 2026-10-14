import { and, desc, eq } from 'drizzle-orm';

import { GatewayError } from '../../core/errors.js';
import type { Database } from '../database/client.js';
import { activeChannel, availableSubscription } from '../database/query.js';
import type { Endpoint } from '../database/schema/index.js';
import { aggregateChannelMembers, channels, subscriptionAccounts } from '../database/schema/index.js';
import type { SubscriptionChannels } from './adapters.js';
import type { AffinitySelection, ChannelAffinity } from './affinity.js';
import { requestSession } from './session.js';

type Channel = typeof channels.$inferSelect;

export async function selectExecutionChannel(
  db: Database,
  subscriptions: SubscriptionChannels,
  entry: Channel,
  parsed: Record<string, unknown>,
  endpoint: Endpoint,
  request: Request,
  cache: ChannelAffinity,
  userId: string,
): Promise<{ channel: Channel; affinity?: AffinitySelection }> {
  if (entry.type !== 'aggregate') return { channel: entry };
  const session = requestSession(request, parsed, endpoint);
  const affinity = session
    ? cache.lookup(entry.id, String(parsed.model), {
        family: session.family,
        value: JSON.stringify([userId, session.value]),
      })
    : undefined;
  const rows = await db
    .select({ channel: channels, member: aggregateChannelMembers, account: subscriptionAccounts })
    .from(aggregateChannelMembers)
    .innerJoin(channels, eq(channels.id, aggregateChannelMembers.memberChannelId))
    .leftJoin(subscriptionAccounts, eq(subscriptionAccounts.id, channels.subscriptionAccountId))
    .where(and(eq(aggregateChannelMembers.aggregateChannelId, entry.id), activeChannel(), availableSubscription()))
    .orderBy(desc(aggregateChannelMembers.priority), channels.id);
  // 只按端点筛选成员；订阅不支持的参数由适配器删除或改写，不影响路由。
  const compatible = rows.filter(
    ({ channel, account }) =>
      channel.type === 'api' ||
      (channel.type === 'subscription' &&
        account !== null &&
        subscriptions.supportsEndpoint(account.provider, endpoint)),
  );
  if (rows.length && !compatible.length)
    throw new GatewayError(400, 'aggregate_request_unsupported', 'No member supports the requested endpoint');
  const available = compatible.filter(
    ({ channel, account }) =>
      channel.type === 'api' ||
      (account &&
        (!account.cooldownUntil || account.cooldownUntil.getTime() <= Date.now()) &&
        !(Date.parse(account.modelCooldowns[String(parsed.model)] ?? '') > Date.now()) &&
        subscriptions.activeRequests(account.id) < account.maxConcurrent),
  );
  if (!available.length)
    throw new GatewayError(503, 'aggregate_unavailable', 'No aggregate member is currently available');
  if (affinity?.previous) {
    const id = affinity.previous.channelId;
    const bound = available.find((row) => row.channel.id === id);
    if (bound) return { channel: bound.channel, affinity };
  }
  const preferred = available.filter((row) => row.member.priority === available[0].member.priority);
  let channel = preferred[preferred.length - 1].channel;
  let weight = Math.random() * preferred.reduce((sum, row) => sum + row.member.weight, 0);
  for (const row of preferred) {
    weight -= row.member.weight;
    if (weight < 0) {
      channel = row.channel;
      break;
    }
  }
  return { channel, affinity };
}
