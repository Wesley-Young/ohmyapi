import { and, eq } from 'drizzle-orm';

import type { Database, Transaction } from '../database/client.js';
import { apiKeyModelGrants, userChannelGrants } from '../database/schema/index.js';

/** 管理员和公开渠道无需授权，其余渠道需要为用户单独授权。 */
export async function canUseChannel(
  db: Database | Transaction,
  user: { id: string; role: string },
  channel: { id: string; isPublic: boolean },
) {
  if (user.role === 'admin' || channel.isPublic) return true;
  const [grant] = await db
    .select({ channelId: userChannelGrants.channelId })
    .from(userChannelGrants)
    .where(and(eq(userChannelGrants.userId, user.id), eq(userChannelGrants.channelId, channel.id)));
  return Boolean(grant);
}

/** 未限制模型的 Key 可调用渠道内所有模型，限制后仅可调用已授权的模型。 */
export async function keyAllowsModel(
  db: Database | Transaction,
  key: { id: string; restrictModels: boolean },
  modelId: string,
) {
  if (!key.restrictModels) return true;
  const [grant] = await db
    .select({ modelId: apiKeyModelGrants.modelId })
    .from(apiKeyModelGrants)
    .where(and(eq(apiKeyModelGrants.apiKeyId, key.id), eq(apiKeyModelGrants.modelId, modelId)));
  return Boolean(grant);
}
