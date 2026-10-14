import { z } from 'zod';

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
