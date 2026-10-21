import { createRoute, z } from '@hono/zod-openapi';

import { AppError } from '../../core/errors.ts';
import { cursorLimitInput } from '../../core/pagination.ts';
import {
  type ApiAuth,
  createApi,
  errorResponse,
  jsonBody,
  jsonResponse,
  moneySchema,
  userIdParams,
} from '../../openapi/common.ts';
import { createUserInput } from './schemas.ts';
import type { UserService } from './service.ts';

const userSchema = z
  .object({
    id: z.uuid(),
    username: z.string(),
    role: z.enum(['admin', 'user']),
    status: z.enum(['active', 'disabled']),
    maxConcurrent: z.number().int().nullable().meta({
      description: '网关并发请求数上限；null 表示使用服务端的全局配置',
    }),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'User' });

const listQuery = z.object({
  username: z.string().trim().toLowerCase().max(64).optional().meta({ description: '按用户名精确查找，忽略大小写' }),
  cursor: z.string().max(512).optional().meta({ description: '上一页响应中的 `nextCursor`' }),
  limit: cursorLimitInput.meta({ description: '每页条数，1–100', example: 20 }),
});

const createBody = z
  .object({
    username: createUserInput.shape.username.meta({ example: 'alice' }),
    password: createUserInput.shape.password.meta({ description: '留空时随机生成，并在响应中返回' }),
    groupIds: createUserInput.shape.groupIds.meta({ description: '加入的用户组' }),
    sync: createUserInput.shape.sync.meta({ description: '是否授予所加入用户组的现有成员共有的渠道' }),
    initialBalance: createUserInput.shape.initialBalance.meta({
      description: '初始余额，零或正数，最多六位小数；留空时使用服务端配置的默认值',
      example: '10',
    }),
  })
  .meta({ id: 'CreateUser' });

const notFound = errorResponse('用户不存在或已删除');
const unauthorized = errorResponse('缺少管理令牌，或令牌无效、已过期');
const forbidden = errorResponse('令牌缺少所需权限');

/** 隐藏已删除的用户，与列表保持一致。 */
async function activeUser(users: UserService, userId: string) {
  const { id, username, role, status, maxConcurrent, createdAt, deleted } = await users.get(userId);
  if (deleted) throw new AppError('not_found', '用户不存在');
  return { id, username, role, status, maxConcurrent, createdAt };
}

export function userApi(users: UserService, auth: ApiAuth) {
  const read = auth.admin('users:read');
  const write = auth.admin('users:write');
  return createApi()
    .openapi(
      createRoute({
        method: 'get',
        path: '/admin/users',
        tags: ['Users'],
        summary: '用户列表',
        description: '未删除的用户，按创建时间倒序。需要权限 `users:read`。',
        security: read.security,
        middleware: [read.middleware] as const,
        request: { query: listQuery },
        responses: {
          200: jsonResponse(
            z
              .object({
                items: z.array(userSchema),
                nextCursor: z.string().nullable().meta({ description: '下一页的游标；没有更多时为 null' }),
              })
              .meta({ id: 'UserPage' }),
            '用户列表',
          ),
          400: errorResponse('参数或游标无效'),
          401: unauthorized,
          403: forbidden,
        },
      }),
      async (c) => c.json(await users.page(c.req.valid('query')), 200),
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/admin/users/{userId}',
        tags: ['Users'],
        summary: '用户详情',
        description: '需要权限 `users:read`。',
        security: read.security,
        middleware: [read.middleware] as const,
        request: { params: userIdParams },
        responses: {
          200: jsonResponse(userSchema, '用户'),
          401: unauthorized,
          403: forbidden,
          404: notFound,
        },
      }),
      async (c) => c.json(await activeUser(users, c.req.valid('param').userId), 200),
    )
    .openapi(
      createRoute({
        method: 'post',
        path: '/admin/users',
        tags: ['Users'],
        summary: '创建用户',
        description: '创建普通用户。用户名已存在时返回 409，可按用户名查询已有用户。需要权限 `users:write`。',
        security: write.security,
        middleware: [write.middleware] as const,
        request: { body: jsonBody(createBody) },
        responses: {
          201: jsonResponse(
            z
              .object({
                user: userSchema,
                generatedPassword: z
                  .string()
                  .nullable()
                  .meta({ description: '未指定密码时生成的密码，只返回这一次；指定了密码时为 null' }),
                initialBalance: moneySchema,
              })
              .meta({ id: 'CreatedUser' }),
            '已创建的用户',
          ),
          400: errorResponse('参数无效'),
          401: unauthorized,
          403: forbidden,
          409: errorResponse('用户名已存在'),
        },
      }),
      async (c) => {
        const input = c.req.valid('json');
        const created = await users.create(c.get('principal'), input);
        return c.json(
          {
            user: await activeUser(users, created.user.id),
            generatedPassword: input.password === undefined ? created.password : null,
            initialBalance: created.initialBalance,
          },
          201,
        );
      },
    )
    .openapi(
      createRoute({
        method: 'patch',
        path: '/admin/users/{userId}',
        tags: ['Users'],
        summary: '启用或停用用户',
        description:
          '适用于普通用户。停用后，用户的登录会话立即失效，API Key 随即停止服务；状态与当前相同时原样返回。需要权限 `users:write`。',
        security: write.security,
        middleware: [write.middleware] as const,
        request: {
          params: userIdParams,
          body: jsonBody(
            z
              .object({ status: z.enum(['active', 'disabled'], { error: '状态需为 active 或 disabled' }) })
              .meta({ id: 'UpdateUser' }),
          ),
        },
        responses: {
          200: jsonResponse(userSchema, '更新后的用户'),
          400: errorResponse('参数无效'),
          401: unauthorized,
          403: errorResponse('令牌缺少所需权限，或目标是管理员'),
          404: notFound,
        },
      }),
      async (c) => {
        const { userId } = c.req.valid('param');
        const { status } = c.req.valid('json');
        const user = await activeUser(users, userId);
        if (user.status === status) return c.json(user, 200);
        await users.manage(c.get('principal'), userId, status === 'active' ? 'enable' : 'disable');
        return c.json(await activeUser(users, userId), 200);
      },
    );
}
