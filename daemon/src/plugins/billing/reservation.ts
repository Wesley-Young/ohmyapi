import { and, eq } from 'drizzle-orm';

import { GatewayError } from '../../core/errors.js';
import type { Transaction } from '../database/client.js';
import { activeApiKey, activeChannel, activeModel } from '../database/query.js';
import {
  apiKeyChannels,
  apiKeys,
  effectiveChannelModels as channelAvailableModels,
  effectiveChannelEndpoints as channelEndpoints,
  channels,
  type Endpoint,
  models,
  users,
} from '../database/schema/index.js';
import { lockExecutionRoute } from '../gateway/routing.js';
import { canUseChannel, keyAllowsModel } from '../keys/access.js';
import type { LockedPrice } from '../pricing/service.js';

export type ReservationInput = {
  requestId: string;
  userId: string;
  keyId: string;
  modelId: string;
  channelId: string;
  executionChannel: typeof channels.$inferSelect;
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
