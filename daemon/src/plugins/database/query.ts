import { and, type Column, eq, gt, isNull, like, or } from 'drizzle-orm';
import type { PgSelect } from 'drizzle-orm/pg-core';

import { pageSize } from '../../core/pagination.js';
import { apiKeys, channels, models, users } from './schema/index.js';

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

// ---- 列表查询 ----

/** 按页读取，多取一条用于判断是否还有下一页；配合 core/pagination 的 toPage 使用。 */
export function paginate<T extends PgSelect>(query: T, page: number) {
  return query.limit(pageSize + 1).offset(page * pageSize);
}

/** 包含匹配；转义 LIKE 通配符，空字符串不加条件。 */
export function containsText(column: Column, search: string) {
  return search ? like(column, `%${search.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`) : undefined;
}
