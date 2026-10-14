import { and, type Column, eq, gt, isNull, like, or, sql } from 'drizzle-orm';
import type { PgSelect } from 'drizzle-orm/pg-core';

import { pageSize } from '../../core/pagination.ts';
import { apiKeys, channels, models, subscriptionAccounts, users } from './schema/index.ts';

// ---- 可用性条件：软删除、启用状态与有效期 ----

export const activeUser = () => and(eq(users.status, 'active'), isNull(users.deletedAt));

/** 未吊销、未删除且未过期的 API Key。 */
export const activeApiKey = () =>
  and(
    isNull(apiKeys.revokedAt),
    isNull(apiKeys.deletedAt),
    or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
  );

export const activeChannel = () => and(eq(channels.enabled, true), isNull(channels.deletedAt));

export const activeModel = () => and(eq(models.enabled, true), isNull(models.deletedAt));

/** 非订阅渠道，或绑定的订阅账号已启用、未删除且没有错误。 */
export function availableSubscription() {
  return sql`(${channels.type} <> 'subscription' or exists (
    select 1 from ${subscriptionAccounts}
    where ${subscriptionAccounts.id} = ${channels.subscriptionAccountId}
      and ${subscriptionAccounts.enabled} = true
      and ${subscriptionAccounts.deletedAt} is null
      and ${subscriptionAccounts.errorCode} is null
  ))`;
}

// ---- 列表查询 ----

/** 按页读取，多取一条用于判断是否还有下一页；配合 core/pagination 的 toPage 使用。 */
export function paginate<T extends PgSelect>(query: T, page: number) {
  return query.limit(pageSize + 1).offset(page * pageSize);
}

/** 包含匹配；转义 LIKE 通配符，空字符串不加条件。 */
export function containsText(column: Column, search: string) {
  return search ? like(column, `%${search.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`) : undefined;
}
