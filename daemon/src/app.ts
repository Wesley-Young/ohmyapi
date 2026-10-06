import HonoPlugin from '@fraqjs/plugin-hono';

import { AppContext } from './kernel.js';
import { HttpPlugin } from './plugins/http/index.js';

export function createApp(options: { host: string; port: number }) {
  const ctx = AppContext.create();
  ctx.logBus.on('log', ({ level, module, message, error }) => {
    console[level](`[${module}] ${message}`, ...(error ? [error] : []));
  });
  ctx.install(HonoPlugin, options);
  ctx.install(HttpPlugin);
  return ctx;
}
