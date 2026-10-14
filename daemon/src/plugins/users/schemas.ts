import { z } from 'zod';

import { pageInput, searchInput } from '../../core/pagination.js';
import { passwordInput, usernameInput } from '../auth/schemas.js';

export const userIdInput = z.object({ userId: z.uuid('用户标识无效') });
export const listUsersInput = z.object({ page: pageInput, search: searchInput }).default({ page: 0, search: '' });
export const createUserInput = z.object({ username: usernameInput, password: passwordInput.optional() });
export const setRoleInput = userIdInput.extend({ role: z.enum(['admin', 'user']) });
export const setStatusInput = userIdInput.extend({ status: z.enum(['active', 'disabled']) });
export const resetPasswordInput = userIdInput.extend({ password: passwordInput });
