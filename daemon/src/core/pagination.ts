import { z } from 'zod';

import { AppError } from './errors.ts';

/** 列表接口统一的每页条数；查询多取一条用于判断是否还有下一页。 */
export const pageSize = 20;

export const pageInput = z.number().int().min(0).max(100_000).default(0);
export const paginationInput = z.object({ page: pageInput }).default({ page: 0 });
export const searchInput = z.string().trim().max(64).default('');

/** 把多取一条的查询结果整理为分页响应。 */
export function toPage<T>(rows: T[]) {
  return { items: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
}

/** 游标分页的每页条数。 */
export const cursorLimitInput = z.coerce
  .number({ error: '每页条数需为 1–100 的整数' })
  .int('每页条数需为 1–100 的整数')
  .min(1, '每页条数需为 1–100 的整数')
  .max(100, '每页条数需为 1–100 的整数')
  .default(20);

/** 游标对调用方不透明：把定位条件编码为 base64url 的 JSON。 */
export function encodeCursor(value: object) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor<T extends z.ZodType>(cursor: string, schema: T): z.infer<T> {
  try {
    return schema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new AppError('bad_request', '分页游标无效');
  }
}

/** 把多取一条的查询结果整理为游标分页响应。 */
export function toCursorPage<T>(rows: T[], limit: number, cursorOf: (row: T) => object) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(cursorOf(last)) : null };
}
