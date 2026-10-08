import type { HonoService } from '@fraqjs/plugin-hono';
import { serveStatic } from '@hono/node-server/serve-static';

import { statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The source and compiled modules have the same directory depth. Never depend on cwd.
const webRoot = fileURLToPath(new URL('../../../../web/dist/', import.meta.url));
const reservedPath = /^\/(api|v1)(\/|$)|(?:^|\/)\./;

export function serveWeb(app: HonoService['app']) {
  if (!statSync(join(webRoot, 'index.html'), { throwIfNoEntry: false })?.isFile()) {
    throw new Error('Frontend build is missing; run pnpm build before pnpm start');
  }

  const files = serveStatic({
    root: webRoot,
    onFound: (path, c) => {
      c.header(
        'Cache-Control',
        path.startsWith(`${join(webRoot, 'assets')}${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
  });
  const index = serveStatic({
    root: webRoot,
    path: 'index.html',
    onFound: (_path, c) => c.header('Cache-Control', 'no-cache'),
  });

  app.on(['GET', 'HEAD'], '*', (c, next) => {
    if (reservedPath.test(c.req.path)) return next();
    return files(c, next);
  });
  app.on(['GET', 'HEAD'], '*', (c, next) => {
    const path = c.req.path;
    // Missing assets and API endpoints keep their 404; document routes receive the SPA shell.
    if (reservedPath.test(path) || path === '/assets' || path.startsWith('/assets/') || extname(path)) {
      return next();
    }
    return index(c, next);
  });
}
