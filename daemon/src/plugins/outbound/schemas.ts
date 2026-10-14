import { z } from 'zod';

export const proxyUrlInput = z
  .string()
  .trim()
  .min(1, '请填写代理地址')
  .max(4096, '代理地址最多 4096 个字符')
  .refine((value) => {
    try {
      const url = new URL(value);
      decodeURIComponent(url.username);
      decodeURIComponent(url.password);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        Boolean(url.hostname) &&
        url.pathname === '/' &&
        !url.search &&
        !url.hash &&
        (!url.password || Boolean(url.username))
      );
    } catch {
      return false;
    }
  }, '代理需为 HTTP(S) 地址，可包含用户名和密码，不含路径、查询参数和片段')
  .nullable()
  .optional();
