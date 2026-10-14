import { createRoute, z } from '@hono/zod-openapi';

import { type ApiAuth, createApi, errorResponse, jsonResponse } from '../../openapi/common.ts';
import type { KeyService } from './service.ts';

const meSchema = z
  .object({
    user: z.object({
      id: z.uuid(),
      username: z.string(),
      role: z.enum(['admin', 'user']),
    }),
    key: z.object({
      id: z.uuid(),
      name: z.string(),
      createdAt: z.iso.datetime(),
      expiresAt: z.iso.datetime().nullable().meta({ description: '过期时间；null 表示长期有效' }),
      channel: z
        .object({ id: z.uuid(), name: z.string() })
        .nullable()
        .meta({ description: '绑定的渠道；未绑定或渠道已删除时为 null' }),
    }),
  })
  .meta({ id: 'Me' });

export function keyApi(keys: KeyService, auth: ApiAuth) {
  return createApi().openapi(
    createRoute({
      method: 'get',
      path: '/me',
      tags: ['Me'],
      summary: '当前用户和 API Key',
      security: auth.apiKey.security,
      middleware: [auth.apiKey.middleware] as const,
      responses: {
        200: jsonResponse(meSchema, '当前 API Key 所属的用户及 Key 信息'),
        401: errorResponse('缺少 API Key，或 Key 无效、已过期'),
      },
    }),
    async (c) => c.json(await keys.describe(c.get('identity')), 200),
  );
}
