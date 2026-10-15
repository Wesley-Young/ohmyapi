import { OpenAPIHono, z } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';

import { AppError, type AppErrorKind } from '../core/errors.ts';
import type { TokenPrincipal } from '../plugins/auth/service.ts';
import type { AdminTokens } from '../plugins/auth/tokens.ts';
import type { AdminScope } from '../plugins/database/schema/index.ts';
import { apiKeyPattern, type KeyIdentity } from '../plugins/keys/access.ts';
import type { KeyService } from '../plugins/keys/service.ts';

/** 公开 API 的请求上下文。 */
export type ApiEnv = { Variables: { requestId: string } };

export const errorStatuses = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
  payload_too_large: 413,
  unsupported_media_type: 415,
  too_many_requests: 429,
  internal_error: 500,
  bad_gateway: 502,
} as const satisfies Record<AppErrorKind | 'payload_too_large' | 'unsupported_media_type' | 'internal_error', number>;

export type ApiErrorCode = keyof typeof errorStatuses;

export const errorSchema = z
  .object({
    error: z.object({
      code: z.enum(Object.keys(errorStatuses) as [ApiErrorCode, ...ApiErrorCode[]]),
      message: z.string(),
    }),
  })
  .meta({ id: 'Error' });

export function apiError(code: ApiErrorCode, message: string) {
  return { error: { code, message } };
}

/** 路由文档中的 JSON 响应。 */
export function jsonResponse<T extends z.ZodType>(schema: T, description: string) {
  return { content: { 'application/json': { schema } }, description };
}

export const errorResponse = (description: string) => jsonResponse(errorSchema, description);

/** JSON 请求体，默认必填。 */
export function jsonBody<T extends z.ZodType>(schema: T) {
  return { content: { 'application/json': { schema } }, required: true };
}

/** 金额的十进制字符串，输出固定六位小数。 */
export const moneySchema = z.string().meta({ description: '金额，六位小数的十进制字符串', example: '10.000000' });

/** 路径中的用户标识。 */
export const userIdParams = z.object({
  userId: z.uuid('用户标识无效').meta({ param: { name: 'userId', in: 'path' } }),
});

/** 路径中的渠道标识。 */
export const channelIdParams = z.object({
  channelId: z.uuid('渠道标识无效').meta({ param: { name: 'channelId', in: 'path' } }),
});

/** 管理接口共用的认证错误响应。 */
export const adminErrors = {
  401: errorResponse('缺少管理令牌，或令牌无效、已过期'),
  403: errorResponse('令牌缺少所需权限'),
};

/** 各模块的路由都用它创建，统一参数校验失败时的响应。 */
export function createApi() {
  return new OpenAPIHono<ApiEnv>({
    defaultHook: (result, c) => {
      if (!result.success)
        return c.json(apiError('bad_request', result.error.issues[0]?.message ?? '请求参数无效'), 400);
    },
  });
}

type ApiKeyMiddleware = MiddlewareHandler<{ Variables: { identity: KeyIdentity } }>;
type AdminMiddleware = MiddlewareHandler<{ Variables: { principal: TokenPrincipal } }>;

/** 认证中间件和对应的文档声明；路由的 middleware 和 security 一起使用。 */
export interface ApiAuth {
  /** 网关 API Key，设置 `identity`。 */
  apiKey: { middleware: ApiKeyMiddleware; security: { apiKey: string[] }[] };
  /** 带指定权限的管理令牌，设置 `principal`。 */
  admin(scope: AdminScope): { middleware: AdminMiddleware; security: { adminToken: string[] }[] };
}

function bearer(header: string | undefined) {
  const token = header?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token) throw new AppError('unauthorized', '缺少认证凭据');
  return token;
}

export function createApiAuth({ keys, tokens }: { keys: KeyService; tokens: AdminTokens }): ApiAuth {
  const apiKey: ApiKeyMiddleware = async (c, next) => {
    const token = bearer(c.req.header('authorization'));
    const identity = apiKeyPattern.test(token) ? await keys.identify(token) : undefined;
    if (!identity) throw new AppError('unauthorized', 'API Key 无效或已过期');
    c.set('identity', identity);
    await next();
  };
  const admin = (scope: AdminScope): AdminMiddleware => {
    return async (c, next) => {
      const principal = await tokens.resolve(bearer(c.req.header('authorization')));
      if (!principal) throw new AppError('unauthorized', '管理令牌无效或已过期');
      if (!principal.scopes.includes(scope)) throw new AppError('forbidden', `管理令牌缺少 ${scope} 权限`);
      c.set('principal', principal);
      await next();
    };
  };
  return {
    apiKey: { middleware: apiKey, security: [{ apiKey: [] }] },
    admin: (scope) => ({ middleware: admin(scope), security: [{ adminToken: [scope] }] }),
  };
}
