import { and, eq } from 'drizzle-orm';

import type { Database, Transaction } from '../database/client.ts';
import { activeApiKey, activeUser } from '../database/query.ts';
import { apiKeyChannels, apiKeyModelGrants, apiKeys, userChannelGrants, users } from '../database/schema/index.ts';

export const apiKeyPattern = /^sk-[A-Za-z0-9_-]{43}$/;

/** 查找有效的 API Key、所属用户及绑定渠道；Key 无效、过期或用户已停用时返回 undefined。 */
export async function findKeyIdentity(db: Database, token: string) {
  const [identity] = await db
    .select({ key: apiKeys, user: users, channelId: apiKeyChannels.channelId })
    .from(apiKeys)
    .innerJoin(users, eq(apiKeys.userId, users.id))
    .leftJoin(apiKeyChannels, eq(apiKeyChannels.apiKeyId, apiKeys.id))
    .where(and(eq(apiKeys.key, token), activeApiKey(), activeUser()));
  return identity;
}

export type KeyIdentity = NonNullable<Awaited<ReturnType<typeof findKeyIdentity>>>;

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
