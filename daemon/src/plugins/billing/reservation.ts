import { and, eq } from 'drizzle-orm';

import { GatewayError } from '../../core/errors.js';
import type { Transaction } from '../database/client.js';
import { activeApiKey, activeChannel, activeModel, availableSubscription } from '../database/query.js';
import {
  aggregateChannelMembers,
  apiKeyChannels,
  apiKeys,
  effectiveChannelModels as channelAvailableModels,
  effectiveChannelEndpoints as channelEndpoints,
  channels,
  type Endpoint,
  effectiveChannelEndpoints,
  effectiveChannelModels,
  models,
  users,
} from '../database/schema/index.js';
import { canUseChannel, keyAllowsModel } from '../keys/access.js';
import type { LockedPrice } from '../pricing/service.js';

type Channel = typeof channels.$inferSelect;

/** 网关选定的入口渠道与实际执行渠道。 */
export type ExecutionRoute = { channelId: string; modelId: string; endpoint: Endpoint; executionChannel: Channel };

export type ReservationInput = {
  requestId: string;
  userId: string;
  keyId: string;
  modelId: string;
  channelId: string;
  executionChannel: Channel;
  price: LockedPrice;
  inputLimit: number;
  outputLimit: number;
  body: Record<string, unknown>;
  endpoint: Endpoint;
};

/**
 * 预占前在锁内重新确认准入：用户、Key、渠道、模型、端点及授权在网关校验后可能已被修改。
 * 锁住用户及路由涉及的渠道和模型，使预占与禁用、撤销授权等管理操作串行化。
 */
export async function lockAdmission(tx: Transaction, input: ReservationInput) {
  const [user] = await tx.select().from(users).where(eq(users.id, input.userId)).for('update');
  const [key] = await tx
    .select({ restrictModels: apiKeys.restrictModels })
    .from(apiKeys)
    .innerJoin(apiKeyChannels, eq(apiKeyChannels.apiKeyId, apiKeys.id))
    .where(
      and(
        eq(apiKeys.id, input.keyId),
        eq(apiKeys.userId, input.userId),
        eq(apiKeyChannels.channelId, input.channelId),
        activeApiKey(),
      ),
    );
  if (user?.status !== 'active' || user.deletedAt || !key)
    throw new GatewayError(401, 'invalid_api_key', 'Invalid or expired API Key');
  const [channel] = await tx
    .select({ id: channels.id, isPublic: channels.isPublic })
    .from(channels)
    .innerJoin(channelAvailableModels, eq(channelAvailableModels.channelId, channels.id))
    .innerJoin(models, eq(models.id, channelAvailableModels.modelId))
    .innerJoin(channelEndpoints, eq(channelEndpoints.channelId, channels.id))
    .where(
      and(
        eq(channels.id, input.channelId),
        eq(models.id, input.modelId),
        activeChannel(),
        activeModel(),
        eq(channelEndpoints.endpoint, input.endpoint),
      ),
    )
    .for('share', { of: [channels, models] });
  if (!channel) throw new GatewayError(503, 'channel_unavailable', 'The API Key channel is unavailable');
  await lockExecutionRoute(tx, input);
  if (!(await canUseChannel(tx, user, channel)))
    throw new GatewayError(403, 'channel_forbidden', 'Channel authorization was revoked');
  if (!(await keyAllowsModel(tx, { id: input.keyId, restrictModels: key.restrictModels }, input.modelId)))
    throw new GatewayError(403, 'model_forbidden', 'API Key does not authorize this model');
  return user;
}

// 在预占和发送前复查入口交集及实际成员，配置变更不能绕过成员关系或能力校验。
export async function lockExecutionRoute(tx: Transaction, input: ExecutionRoute) {
  const [entry] = await tx
    .select({ type: channels.type })
    .from(channels)
    .innerJoin(effectiveChannelModels, eq(effectiveChannelModels.channelId, channels.id))
    .innerJoin(effectiveChannelEndpoints, eq(effectiveChannelEndpoints.channelId, channels.id))
    .where(
      and(
        eq(channels.id, input.channelId),
        activeChannel(),
        eq(effectiveChannelModels.modelId, input.modelId),
        eq(effectiveChannelEndpoints.endpoint, input.endpoint),
      ),
    )
    .for('share', { of: channels });
  if (!entry) throw new GatewayError(503, 'channel_unavailable', 'The entry channel capability changed');
  const selected = input.executionChannel;
  if (entry.type === 'aggregate') {
    const [member] = await tx
      .select()
      .from(aggregateChannelMembers)
      .where(
        and(
          eq(aggregateChannelMembers.aggregateChannelId, input.channelId),
          eq(aggregateChannelMembers.memberChannelId, selected.id),
        ),
      )
      .for('share');
    if (!member) throw new GatewayError(503, 'channel_unavailable', 'The selected member was removed');
  } else if (input.channelId !== selected.id) {
    throw new GatewayError(503, 'channel_unavailable', 'The selected channel does not match the entry');
  }
  const [actual] = await tx
    .select({ channel: channels })
    .from(channels)
    .innerJoin(effectiveChannelModels, eq(effectiveChannelModels.channelId, channels.id))
    .innerJoin(effectiveChannelEndpoints, eq(effectiveChannelEndpoints.channelId, channels.id))
    .where(
      and(
        eq(channels.id, selected.id),
        activeChannel(),
        eq(effectiveChannelModels.modelId, input.modelId),
        eq(effectiveChannelEndpoints.endpoint, input.endpoint),
        availableSubscription(),
      ),
    )
    .for('share', { of: channels });
  const current = actual?.channel;
  if (
    !current ||
    current.type === 'aggregate' ||
    current.type !== selected.type ||
    current.baseUrl !== selected.baseUrl ||
    current.proxyUrlEncrypted !== selected.proxyUrlEncrypted ||
    current.credentialEncrypted !== selected.credentialEncrypted ||
    current.subscriptionAccountId !== selected.subscriptionAccountId
  )
    throw new GatewayError(503, 'channel_unavailable', 'The selected channel configuration changed');
}
