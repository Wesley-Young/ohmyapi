import { z } from 'zod';

import { adminScopes } from '../database/schema/index.ts';

export const usernameInput = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_.-]{2,63}$/, '用户名需为 3–64 位小写字母、数字、点、下划线或连字符');
export const passwordInput = z
  .string()
  .min(8, '密码至少 8 个字符')
  .max(1024, '密码过长')
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 1024, '密码过长');
const currentPassword = z.string().min(1, '请填写密码').max(1024, '密码过长');

export const loginInput = z.object({ username: usernameInput, password: currentPassword });
export const changePasswordInput = z.object({ currentPassword, newPassword: passwordInput });

export const adminTokenIdInput = z.object({ tokenId: z.uuid() });
export const createAdminTokenInput = z.object({
  name: z.string().trim().min(1, '请填写名称').max(64, '名称最多 64 个字符'),
  scopes: z.array(z.enum(adminScopes)).min(1, '至少选择一项权限').max(adminScopes.length),
  expiresAt: z.iso.datetime().optional(),
});

export type CreateAdminTokenInput = z.infer<typeof createAdminTokenInput>;
