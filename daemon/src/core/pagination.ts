import { z } from 'zod';

/** 列表接口统一的每页条数；查询多取一条用于判断是否还有下一页。 */
export const pageSize = 20;

export const pageInput = z.number().int().min(0).max(100_000).default(0);
export const paginationInput = z.object({ page: pageInput }).default({ page: 0 });
export const searchInput = z.string().trim().max(64).default('');
