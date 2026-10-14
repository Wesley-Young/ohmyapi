import { HonoService } from '@fraqjs/plugin-hono';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { bodyLimit } from 'hono/body-limit';
import { getCookie } from 'hono/cookie';
import { serialize } from 'hono/utils/cookie';

import { errorDetails, formatEvent } from '../../core/logging.js';
import { definePlugin } from '../../kernel.js';
import { createAppRouter } from '../../trpc/router.js';
import { AuthService } from '../auth/service.js';
import { BillingRecords } from '../billing/records.js';
import { BillingReview } from '../billing/review.js';
import { BillingService } from '../billing/service.js';
import { ChannelGrants } from '../catalog/grants.js';
import { ModelCatalog } from '../catalog/models.js';
import { CatalogService } from '../catalog/service.js';
import { DatabaseService } from '../database/index.js';
import { endpoints } from '../database/schema/index.js';
import { RequestHistory } from '../gateway/history.js';
import { GatewayService } from '../gateway/service.js';
import { KeyService } from '../keys/service.js';
import { PricingService } from '../pricing/service.js';
import { SubscriptionService } from '../subscription/service.js';
import { UserService } from '../users/service.js';
import { WalletService } from '../wallet/service.js';
import { serveWeb } from './web.js';

export const HttpPlugin = definePlugin({
  name: 'ohmyapi-http',
  inject: {
    hono: HonoService,
    database: DatabaseService,
    auth: AuthService,
    catalog: CatalogService,
    modelCatalog: ModelCatalog,
    channelGrants: ChannelGrants,
    gateway: GatewayService,
    requestHistory: RequestHistory,
    pricing: PricingService,
    billing: BillingService,
    billingRecords: BillingRecords,
    billingReview: BillingReview,
    keys: KeyService,
    subscription: SubscriptionService,
    users: UserService,
    wallet: WalletService,
  },
  apply(ctx) {
    const app = ctx.hono.app;
    const appRouter = createAppRouter({
      startedAt: new Date().toISOString(),
      auth: ctx.auth,
      users: ctx.users,
      keys: ctx.keys,
      wallet: ctx.wallet,
      pricing: ctx.pricing,
      billingRecords: ctx.billingRecords,
      billingReview: ctx.billingReview,
      catalog: ctx.catalog,
      modelCatalog: ctx.modelCatalog,
      channelGrants: ctx.channelGrants,
      subscription: ctx.subscription,
      requestHistory: ctx.requestHistory,
    });
    const sessionConfig = ctx.config.session;
    const cookieName: string = sessionConfig.secure ? '__Host-ohmyapi_session' : 'ohmyapi_session';
    const cookieOptions = { path: '/', httpOnly: true, sameSite: 'Strict' as const, secure: sessionConfig.secure };
    const requestInfos = new WeakMap<Request, { requestId: string; startedAt: number }>();
    const requestInfo = (req: Request) => {
      let info = requestInfos.get(req);
      if (!info) {
        info = { requestId: crypto.randomUUID(), startedAt: Date.now() };
        requestInfos.set(req, info);
      }
      return info;
    };
    let readiness: string | undefined;
    app.use('/api/*', async (c, next) => {
      c.header('x-request-id', requestInfo(c.req.raw).requestId);
      await next();
    });

    const rpcBodyLimit = bodyLimit({ maxSize: 64 * 1024 });
    const importBodyLimit = bodyLimit({ maxSize: 256 * 1024 });
    app.use('/api/trpc/*', (c, next) =>
      (['/api/trpc/admin.catalog.importModels', '/api/trpc/admin.catalog.saveChannel'].includes(c.req.path)
        ? importBodyLimit
        : rpcBodyLimit)(c, next),
    );
    app.use('/api/trpc/*', async (c, next) => {
      c.header('Cache-Control', 'no-store');
      if (c.req.method === 'POST') {
        const origin = c.req.header('Origin');
        const expectedOrigin = sessionConfig.origin ?? new URL(c.req.url).origin;
        if (c.req.header('X-Ohmyapi-Request') !== '1' || (origin && origin !== expectedOrigin))
          return c.json({ error: 'Forbidden' }, 403);
      }
      await next();
    });

    app.get('/api/health', (c) => c.json({ name: 'ohmyapi', status: 'ok' }));
    app.get('/api/ready', async (c) => {
      let dependency = 'database';
      try {
        await ctx.database.checkConnection();
        dependency = 'billing';
        ctx.billing.assertReady();
        if (readiness !== 'ready') {
          ctx.logger.info(formatEvent('服务就绪', { previousState: readiness ?? 'unknown' }));
          readiness = 'ready';
        }
        return c.json({ name: 'ohmyapi', status: 'ready' });
      } catch (error) {
        const state = `${dependency}_unavailable`;
        if (readiness !== state) {
          ctx.logger.warn(
            formatEvent('服务未就绪', {
              dependency,
              previousState: readiness ?? 'unknown',
              ...errorDetails(error),
            }),
          );
          readiness = state;
        }
        return c.json({ name: 'ohmyapi', status: 'unavailable' }, 503);
      }
    });
    app.all('/api/trpc/*', (c) =>
      fetchRequestHandler({
        endpoint: '/api/trpc',
        req: c.req.raw,
        router: appRouter,
        createContext: async ({ resHeaders }) => {
          const token = getCookie(c, cookieName);
          return {
            requestId: requestInfo(c.req.raw).requestId,
            logger: ctx.logger,
            token,
            principal: await ctx.auth.resolve(token),
            setSession: (value: string, expiresAt: Date) =>
              resHeaders.append('Set-Cookie', serialize(cookieName, value, { ...cookieOptions, expires: expiresAt })),
            clearSession: () =>
              resHeaders.append('Set-Cookie', serialize(cookieName, '', { ...cookieOptions, maxAge: 0 })),
          };
        },
        responseMeta: () => ({ headers: { 'Cache-Control': 'no-store' } }),
        onError: ({ error, path }) => {
          if (error.code === 'INTERNAL_SERVER_ERROR') {
            const info = requestInfo(c.req.raw);
            ctx.logger.error(
              formatEvent('RPC 请求失败', {
                requestId: info.requestId,
                procedure: path && /^[a-zA-Z][a-zA-Z0-9_.]{0,127}$/.test(path) ? path : 'unknown',
                method: c.req.method,
                durationMs: Date.now() - info.startedAt,
                errorCode: error.code,
                ...errorDetails(error.cause ?? error),
              }),
            );
          }
        },
      }),
    );
    app.get('/v1/models', (c) => ctx.gateway.listModels(c.req.raw));
    app.all('/v1/models', () =>
      ctx.gateway.error('/v1/models', 405, 'method_not_allowed', 'Only GET is supported', crypto.randomUUID()),
    );
    for (const endpoint of endpoints) {
      app.post(endpoint, (c) => ctx.gateway.forward(c.req.raw, endpoint));
      app.all(endpoint, () =>
        ctx.gateway.error(endpoint, 405, 'method_not_allowed', 'Only POST is supported', crypto.randomUUID()),
      );
    }
    if (ctx.config.serveWeb) serveWeb(app);
    app.notFound((c) => c.json({ error: 'Not found' }, 404));
    app.onError((error, c) => {
      const info = requestInfo(c.req.raw);
      c.header('x-request-id', info.requestId);
      ctx.logger.error(
        formatEvent('HTTP 请求失败', {
          requestId: info.requestId,
          route: c.req.routePath,
          method: c.req.method,
          durationMs: Date.now() - info.startedAt,
          ...errorDetails(error),
        }),
      );
      return c.json({ error: 'Internal server error' }, 500);
    });
  },
});
