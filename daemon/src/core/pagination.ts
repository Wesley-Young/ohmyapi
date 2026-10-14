import { z } from 'zod';

/** 列表接口统一的每页条数；查询多取一条用于判断是否还有下一页。 */
export const pageSize = 20;

export const pageInput = z.number().int().min(0).max(100_000).default(0);
export const paginationInput = z.object({ page: pageInput }).default({ page: 0 });
export const searchInput = z.string().trim().max(64).default('');

/** 把多取一条的查询结果整理为分页响应。 */
export function toPage<T>(rows: T[]) {
  return { items: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
}
