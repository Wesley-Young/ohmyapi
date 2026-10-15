import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';

import { AppError } from '../core/errors.ts';
import { type EventLogger, errorDetails, formatEvent } from '../core/logging.ts';
import type { AdminTokens } from '../plugins/auth/tokens.ts';
import { channelApi } from '../plugins/catalog/api.ts';
import type { ChannelDirectory } from '../plugins/catalog/directory.ts';
import { keyApi } from '../plugins/keys/api.ts';
import type { KeyService } from '../plugins/keys/service.ts';
import { subscriptionApi } from '../plugins/subscription/api.ts';
import type { SubscriptionService } from '../plugins/subscription/service.ts';
import { userApi } from '../plugins/users/api.ts';
import type { UserService } from '../plugins/users/service.ts';
import { walletApi } from '../plugins/wallet/api.ts';
import type { WalletService } from '../plugins/wallet/service.ts';
import { apiError, createApi, createApiAuth, errorStatuses } from './common.ts';

export const apiBasePath = '/api/v1';

export interface ApiServices {
  keys: KeyService;
  adminTokens: AdminTokens;
  users: UserService;
  wallet: WalletService;
  channels: ChannelDirectory;
  subscription: SubscriptionService;
}

export interface ApiOptions {
  logger: EventLogger;
  requestId(req: Request): string;
}

/** 汇总各模块的公开 API；挂载到根应用的 `/`，路径都带 `/api/v1` 前缀。 */
export function createPublicApi(services: ApiServices, { logger, requestId }: ApiOptions) {
  const api = createApi().basePath(apiBasePath);
  api.use('*', async (c, next) => {
    c.set('requestId', requestId(c.req.raw));
    c.header('Cache-Control', 'no-store');
    await next();
  });
  api.use(
    '*',
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json(apiError('payload_too_large', '请求体过大'), 413),
    }),
  );

  const auth = createApiAuth({ keys: services.keys, tokens: services.adminTokens });
  api.route('/', keyApi(services.keys, auth));
  api.route('/', walletApi(services.wallet, auth));
  api.route('/', userApi(services.users, auth));
  api.route('/', channelApi(services.channels, auth));
  api.route('/', subscriptionApi(services.subscription, auth));

  api.openAPIRegistry.registerComponent('securitySchemes', 'apiKey', {
    type: 'http',
    scheme: 'bearer',
    description: '网关 API Key（sk-...）',
  });
  api.openAPIRegistry.registerComponent('securitySchemes', 'adminToken', {
    type: 'http',
    scheme: 'bearer',
    description: '管理令牌（oma_admin_...），由管理员在控制台的个人信息页面创建',
  });
  api.doc31('/openapi.json', { openapi: '3.1.0', info: { title: 'ohmyapi', version: '1' } });
  api.all('*', (c) => c.json(apiError('not_found', '接口不存在'), 404));

  api.onError((error, c) => {
    if (error instanceof AppError) return c.json(apiError(error.kind, error.message), errorStatuses[error.kind]);
    // 请求体解析失败：JSON 格式错误，或 Content-Type 不是 application/json。
    if (error instanceof HTTPException && error.status === 400)
      return c.json(apiError('bad_request', '请求体不是有效的 JSON'), 400);
    if (error instanceof HTTPException && error.status === 415)
      return c.json(apiError('unsupported_media_type', 'Content-Type 需为 application/json'), 415);
    logger.error(
      formatEvent('API 请求失败', {
        requestId: c.get('requestId'),
        route: c.req.routePath,
        method: c.req.method,
        ...errorDetails(error),
      }),
    );
    return c.json(apiError('internal_error', '操作失败，请稍后重试'), 500);
  });
  return api;
}
