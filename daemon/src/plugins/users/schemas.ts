import { z } from 'zod';

import { parseMoney } from '../../core/money.ts';
import { pageInput, searchInput } from '../../core/pagination.ts';
import { passwordInput, usernameInput } from '../auth/schemas.ts';

export const userIdInput = z.object({ userId: z.uuid('用户标识无效') });
export const listUsersInput = z.object({ page: pageInput, search: searchInput }).default({ page: 0, search: '' });
export const createUserInput = z.object({
  username: usernameInput,
  password: passwordInput.optional(),
  groupIds: z.array(z.uuid()).max(100).default([]),
  sync: z.boolean().default(true),
  /** 留空时使用 USER_INITIAL_BALANCE。 */
  initialBalance: z
    .string()
    .trim()
    .refine((value) => {
      try {
        return parseMoney(value) >= 0n;
      } catch {
        return false;
      }
    }, '请输入不小于零的金额，最多六位小数')
    .optional(),
});
export const setRoleInput = userIdInput.extend({ role: z.enum(['admin', 'user']) });
export const setStatusInput = userIdInput.extend({ status: z.enum(['active', 'disabled']) });
export const resetPasswordInput = userIdInput.extend({ password: passwordInput });

/** PostgreSQL 输出的 timestamptz 文本，保留微秒精度。 */
export const userCursor = z.object({
  createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/),
  id: z.uuid(),
});
