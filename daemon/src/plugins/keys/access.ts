import { and, eq, or, type SQL, sql } from 'drizzle-orm';

import type { Database, Transaction } from '../database/client.ts';
import { activeApiKey, activeUser } from '../database/query.ts';
import {
  apiKeyChannels,
  apiKeyModelGrants,
  apiKeys,
  channels,
  userChannelBlocks,
  userChannelGrants,
  users,
} from '../database/schema/index.ts';

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

/**
 * 渠道访问规则：管理员可用全部渠道；公开渠道对未被屏蔽的用户开放；
 * 非公开渠道需要为用户单独授权。
 */
export async function canUseChannel(
  db: Database | Transaction,
  user: { id: string; role: string },
  channel: { id: string; isPublic: boolean },
) {
  if (user.role === 'admin') return true;
  const table = channel.isPublic ? userChannelBlocks : userChannelGrants;
  const [row] = await db
    .select({ channelId: table.channelId })
    .from(table)
    .where(and(eq(table.userId, user.id), eq(table.channelId, channel.id)));
  return channel.isPublic ? !row : Boolean(row);
}

/** 与 canUseChannel 相同的规则，作为引用 channels 表的查询条件；管理员返回 undefined。 */
export function channelAccessible(user: { id: string; role: string }): SQL | undefined {
  if (user.role === 'admin') return undefined;
  const listed = (table: typeof userChannelBlocks | typeof userChannelGrants) =>
    sql`exists (select 1 from ${table} where ${table.userId} = ${user.id} and ${table.channelId} = ${channels.id})`;
  return or(
    and(eq(channels.isPublic, true), sql`not ${listed(userChannelBlocks)}`),
    and(eq(channels.isPublic, false), listed(userChannelGrants)),
  );
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
