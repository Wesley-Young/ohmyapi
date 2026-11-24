import { and, eq, or, type SQL, sql } from 'drizzle-orm';

import type { Database, Transaction } from '../database/client.ts';
import { channels, userChannelBlocks, userChannelGrants } from '../database/schema/index.ts';

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
