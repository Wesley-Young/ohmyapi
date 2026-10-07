import { HonoService } from '@fraqjs/plugin-hono';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { bodyLimit } from 'hono/body-limit';
import { getCookie } from 'hono/cookie';
import { serialize } from 'hono/utils/cookie';

import { readSessionConfig } from '../../config.js';
import { definePlugin } from '../../kernel.js';
import { AuthService } from '../../services/auth.js';
import { BillingService } from '../../services/billing.js';
import { CatalogService, endpoints } from '../../services/catalog.js';
import { GatewayService } from '../../services/gateway.js';
import { KeyService } from '../../services/keys.js';
import { PricingService } from '../../services/pricing.js';
import { UserService } from '../../services/users.js';
import { WalletService } from '../../services/wallet.js';
import { appRouter } from '../../trpc/router.js';
import { DatabaseService } from '../database/index.js';

export const HttpPlugin = definePlugin({
  name: 'ohmyapi-http',
  inject: {
    hono: HonoService,
    database: DatabaseService,
    auth: AuthService,
    catalog: CatalogService,
    gateway: GatewayService,
    pricing: PricingService,
    billing: BillingService,
    keys: KeyService,
    users: UserService,
    wallet: WalletService,
  },
  apply(ctx) {
    const app = ctx.hono.app;
    const startedAt = new Date().toISOString();
    const sessionConfig = readSessionConfig();
    const cookieName: string = sessionConfig.secure ? '__Host-ohmyapi_session' : 'ohmyapi_session';
    const cookieOptions = { path: '/', httpOnly: true, sameSite: 'Strict' as const, secure: sessionConfig.secure };

    const rpcBodyLimit = bodyLimit({ maxSize: 64 * 1024 });
    const importBodyLimit = bodyLimit({ maxSize: 256 * 1024 });
    app.use('/api/trpc/*', (c, next) =>
      (c.req.path === '/api/trpc/admin.catalog.importModels' ? importBodyLimit : rpcBodyLimit)(c, next),
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
      try {
        await ctx.database.checkConnection();
        ctx.billing.assertReady();
        return c.json({ name: 'ohmyapi', status: 'ready' });
      } catch {
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
            startedAt,
            token,
            principal: await ctx.auth.resolve(token),
            auth: ctx.auth,
            catalog: ctx.catalog,
            gateway: ctx.gateway,
            pricing: ctx.pricing,
            billing: ctx.billing,
            keys: ctx.keys,
            users: ctx.users,
            wallet: ctx.wallet,
            setSession: (value: string, expiresAt: Date) =>
              resHeaders.append('Set-Cookie', serialize(cookieName, value, { ...cookieOptions, expires: expiresAt })),
            clearSession: () =>
              resHeaders.append('Set-Cookie', serialize(cookieName, '', { ...cookieOptions, maxAge: 0 })),
          };
        },
        responseMeta: () => ({ headers: { 'Cache-Control': 'no-store' } }),
        onError: ({ error, path }) => {
          if (error.code === 'INTERNAL_SERVER_ERROR') ctx.logger.error(`RPC failed: ${path ?? 'unknown'}`);
        },
      }),
    );
    for (const endpoint of endpoints) {
      app.post(endpoint, (c) => ctx.gateway.forward(c.req.raw, endpoint));
      app.all(endpoint, () =>
        ctx.gateway.error(endpoint, 405, 'method_not_allowed', 'Only POST is supported', crypto.randomUUID()),
      );
    }
    app.notFound((c) => c.json({ error: 'Not found' }, 404));
    app.onError((_error, c) => {
      ctx.logger.error('HTTP request failed');
      return c.json({ error: 'Internal server error' }, 500);
    });
  },
});
