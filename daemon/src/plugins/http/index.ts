import { HonoService } from '@fraqjs/plugin-hono';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

import { definePlugin } from '../../kernel.js';
import { appRouter } from '../../trpc/router.js';

export const HttpPlugin = definePlugin({
  name: 'ohmyapi-http',
  inject: { hono: HonoService },
  apply(ctx) {
    const app = ctx.hono.app;
    const startedAt = new Date().toISOString();

    app.get('/api/health', (c) => c.json({ name: 'ohmyapi', status: 'ok' }));
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
