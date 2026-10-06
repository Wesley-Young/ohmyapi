import { HonoService } from '@fraqjs/plugin-hono';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

import { definePlugin } from '../../kernel.js';
import { appRouter } from '../../trpc/router.js';
import { DatabaseService } from '../database/index.js';

export const HttpPlugin = definePlugin({
  name: 'ohmyapi-http',
  inject: { hono: HonoService, database: DatabaseService },
  apply(ctx) {
    const app = ctx.hono.app;
    const startedAt = new Date().toISOString();

    app.get('/api/health', (c) => c.json({ name: 'ohmyapi', status: 'ok' }));
    app.get('/api/ready', async (c) => {
      try {
        await ctx.database.checkConnection();
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
        createContext: () => ({ startedAt }),
      }),
    );
    app.notFound((c) => c.json({ error: 'Not found' }, 404));
    app.onError((error, c) => {
      ctx.logger.error('HTTP request failed', error);
      return c.json({ error: 'Internal server error' }, 500);
    });
  },
});
