import { GatewayError } from '@ohmyapi/protocols';
import { and, desc, eq, sql } from 'drizzle-orm';

import type { ChannelConcurrency } from '../catalog/concurrency.ts';
import type { Database } from '../database/client.ts';
import { activeChannel, activeModel, availableSubscription } from '../database/query.ts';
import type { Endpoint, ReasoningEffortRule } from '../database/schema/index.ts';
import {
  aggregateChannelMembers,
  channelAvailableModels,
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

/** Key 绑定的入口渠道和请求的模型；upstreamModel 和 reasoningEffortRules 是入口渠道为该模型配置的上游名称和推理强度规则。 */
export type EntryRoute = {
  model: { id: string; name: string; inputTokenLimit: number; outputTokenLimit: number };
  channel: Channel;
  upstreamModel: string | null;
  reasoningEffortRules: ReasoningEffortRule[];
};

/** 执行渠道为模型配置的转发改写：上游名称（null 表示使用模型名称）和推理强度规则。 */
export type ExecutionRoute = {
  channel: Channel;
  upstreamModel: string | null;
  reasoningEffortRules: ReasoningEffortRule[];
  affinity?: AffinitySelection;
  release?: () => void;
};

/** API 渠道按渠道计数；未设置上限时只计数不限制。 */
function reserveApiChannel(concurrency: ChannelConcurrency, channel: Channel) {
  return concurrency.tryAcquire(channel.id, channel.maxConcurrent ?? Number.POSITIVE_INFINITY);
}

/**
 * 选择执行请求的渠道，并为它占用并发名额：API 渠道按渠道计数，聚合渠道的订阅成员按账号计数。
 * 直接使用的订阅渠道由适配器按账号占用。release 释放这里占用的名额，可重复调用。
 * upstreamModel 和 reasoningEffortRules 是执行渠道为该模型配置的上游名称和推理强度规则。
 */
export async function selectExecutionChannel(
  db: Database,
  subscriptions: SubscriptionChannels,
  concurrency: ChannelConcurrency,
  route: EntryRoute,
  parsed: Record<string, unknown>,
  endpoint: Endpoint,
  request: Request,
  cache: ChannelAffinity,
  userId: string,
): Promise<ExecutionRoute> {
  const { channel: entry, model } = route;
  if (entry.type !== 'aggregate') {
    const { upstreamModel, reasoningEffortRules } = route;
    if (entry.type !== 'api') return { channel: entry, upstreamModel, reasoningEffortRules };
    const release = reserveApiChannel(concurrency, entry);
    if (!release)
      throw new GatewayError(429, 'channel_concurrency_exceeded', 'The channel concurrency limit was reached');
    return { channel: entry, upstreamModel, reasoningEffortRules, release };
  }
  const session = requestSession(request, parsed, endpoint);
  const affinity = session
    ? cache.lookup(entry.id, model.name, {
        family: session.family,
        value: JSON.stringify([userId, session.value]),
      })
    : undefined;
  const rows = await db
    .select({
      channel: channels,
      member: aggregateChannelMembers,
      account: subscriptionAccounts,
      upstreamModel: channelAvailableModels.upstreamModel,
      reasoningEffortRules: channelAvailableModels.reasoningEffortRules,
    })
    .from(aggregateChannelMembers)
    .innerJoin(channels, eq(channels.id, aggregateChannelMembers.memberChannelId))
    .leftJoin(subscriptionAccounts, eq(subscriptionAccounts.id, channels.subscriptionAccountId))
    .leftJoin(
      channelAvailableModels,
      and(eq(channelAvailableModels.channelId, channels.id), eq(channelAvailableModels.modelId, model.id)),
    )
    .where(and(eq(aggregateChannelMembers.aggregateChannelId, entry.id), activeChannel(), availableSubscription()))
    .orderBy(desc(aggregateChannelMembers.priority), channels.id);
  // 以下到占用名额之间没有异步操作，其他请求不会在筛选后抢先占满选中的成员。
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
  // 订阅账号的模型冷却按发往上游的模型名记录。
  const available = compatible.filter(({ channel, account, upstreamModel }) =>
    channel.type === 'api'
      ? channel.maxConcurrent === null || concurrency.active(channel.id) < channel.maxConcurrent
      : account &&
        (!account.cooldownUntil || account.cooldownUntil.getTime() <= Date.now()) &&
        !(Date.parse(account.modelCooldowns[upstreamModel ?? model.name] ?? '') > Date.now()) &&
        subscriptions.activeRequests(account.id) < account.maxConcurrent,
  );
  if (!available.length)
    throw new GatewayError(503, 'aggregate_unavailable', 'No aggregate member is currently available');
  const previous = affinity?.previous?.channelId;
  const bound = previous ? available.find((row) => row.channel.id === previous) : undefined;
  const selected =
    bound ?? weightedPick(available.filter((row) => row.member.priority === available[0].member.priority));
  const release =
    selected.channel.type === 'api'
      ? reserveApiChannel(concurrency, selected.channel)
      : selected.account && subscriptions.reserve(selected.account.id, selected.account.maxConcurrent);
  if (!release) throw new GatewayError(503, 'aggregate_unavailable', 'No aggregate member is currently available');
  return {
    channel: selected.channel,
    upstreamModel: selected.upstreamModel,
    reasoningEffortRules: selected.reasoningEffortRules ?? [],
    affinity,
    release,
  };
}

function weightedPick<T extends { member: { weight: number } }>(rows: T[]) {
  let weight = Math.random() * rows.reduce((sum, row) => sum + row.member.weight, 0);
  for (const row of rows) {
    weight -= row.member.weight;
    if (weight < 0) return row;
  }
  return rows[rows.length - 1];
}

/** 解析模型并确认 Key 绑定的入口渠道提供该模型和端点，且用户与 Key 均有权使用。 */
export async function resolveEntryRoute(
  db: Database,
  identity: KeyIdentity,
  requestedModel: string,
  endpoint: Endpoint,
  details: { modelName?: string; upstreamTimeoutMs?: number },
): Promise<EntryRoute> {
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
      .select({
        channel: channels,
        accessible: access ? sql<boolean>`(${access})` : sql<boolean>`true`,
        upstreamModel: channelAvailableModels.upstreamModel,
        reasoningEffortRules: channelAvailableModels.reasoningEffortRules,
      })
      .from(channels)
      .innerJoin(effectiveChannelModels, eq(effectiveChannelModels.channelId, channels.id))
      .innerJoin(effectiveChannelEndpoints, eq(effectiveChannelEndpoints.channelId, channels.id))
      // 聚合渠道不配置上游名称和推理强度规则，由选中的子渠道提供。
      .leftJoin(
        channelAvailableModels,
        and(eq(channelAvailableModels.channelId, channels.id), eq(channelAvailableModels.modelId, model.id)),
      )
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
  const configured = route.channel.type !== 'aggregate';
  return {
    model,
    channel: route.channel,
    upstreamModel: configured ? route.upstreamModel : null,
    reasoningEffortRules: configured ? (route.reasoningEffortRules ?? []) : [],
  };
}
