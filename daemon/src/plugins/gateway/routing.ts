import { GatewayError } from '@ohmyapi/protocols';
import { and, desc, eq, sql } from 'drizzle-orm';

import type { Database } from '../database/client.ts';
import { activeChannel, activeModel, availableSubscription } from '../database/query.ts';
import type { Endpoint } from '../database/schema/index.ts';
import {
  aggregateChannelMembers,
  channels,
  effectiveChannelEndpoints,
  effectiveChannelModels,
  models,
  subscriptionAccounts,
} from '../database/schema/index.ts';
import { channelAccessible, type KeyIdentity, keyAllowsModel } from '../keys/access.ts';
import type { SubscriptionChannels } from './adapters.ts';
import type { AffinitySelection, ChannelAffinity } from './affinity.ts';
import { requestSession } from './session.ts';

type Channel = typeof channels.$inferSelect;

export async function selectExecutionChannel(
  db: Database,
  subscriptions: SubscriptionChannels,
  entry: Channel,
  parsed: Record<string, unknown>,
  model: string,
  endpoint: Endpoint,
  request: Request,
  cache: ChannelAffinity,
  userId: string,
): Promise<{ channel: Channel; affinity?: AffinitySelection }> {
  if (entry.type !== 'aggregate') return { channel: entry };
  const session = requestSession(request, parsed, endpoint);
  const affinity = session
    ? cache.lookup(entry.id, model, {
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
        !(Date.parse(account.modelCooldowns[model] ?? '') > Date.now()) &&
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

/** 解析模型并确认 Key 绑定的入口渠道提供该模型和端点，且用户与 Key 均有权使用。 */
export async function resolveEntryRoute(
  db: Database,
  identity: KeyIdentity,
  requestedModel: string,
  endpoint: Endpoint,
  details: { modelName?: string; upstreamTimeoutMs?: number },
) {
  const [model] = await db
    .select({
      id: models.id,
      name: models.name,
      inputTokenLimit: models.inputTokenLimit,
      outputTokenLimit: models.outputTokenLimit,
    })
    .from(models)
    .where(and(eq(models.name, requestedModel), activeModel()));
  if (!model) throw new GatewayError(404, 'model_not_found', 'Unknown or disabled model');
  details.modelName = model.name;

  if (!identity.channelId)
    throw new GatewayError(403, 'channel_unbound', 'Bind this legacy API Key to a channel before using it');
  // Key 的模型授权与渠道路由互不依赖，并行查询；渠道访问规则与 canUseChannel 相同，随路由一起判断。
  const access = channelAccessible(identity.user);
  const [modelAllowed, [route]] = await Promise.all([
    keyAllowsModel(db, identity.key, model.id),
    db
      .select({ channel: channels, accessible: access ? sql<boolean>`(${access})` : sql<boolean>`true` })
      .from(channels)
      .innerJoin(effectiveChannelModels, eq(effectiveChannelModels.channelId, channels.id))
      .innerJoin(effectiveChannelEndpoints, eq(effectiveChannelEndpoints.channelId, channels.id))
      .where(
        and(
          eq(channels.id, identity.channelId),
          activeChannel(),
          eq(effectiveChannelModels.modelId, model.id),
          eq(effectiveChannelEndpoints.endpoint, endpoint),
        ),
      ),
  ]);
  if (!modelAllowed) throw new GatewayError(403, 'model_forbidden', 'API Key does not authorize this model');
  if (!route)
    throw new GatewayError(503, 'channel_unavailable', 'The API Key channel does not provide this model and endpoint');
  details.upstreamTimeoutMs = route.channel.timeoutMs;

  if (!route.accessible) throw new GatewayError(403, 'channel_forbidden', 'Channel is not authorized for this user');
  return { model, channel: route.channel };
}
