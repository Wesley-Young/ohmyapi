import HonoPlugin from '@fraqjs/plugin-hono';

import { readBillingCurrency, readDatabaseConfig } from './config.js';
import { AppContext } from './kernel.js';
import { AccountsPlugin } from './plugins/accounts/index.js';
import { DatabasePlugin } from './plugins/database/index.js';
import { GatewayPlugin } from './plugins/gateway/index.js';
import { HttpPlugin } from './plugins/http/index.js';

export function createApp(options: { host: string; port: number }) {
  const ctx = AppContext.create();
  ctx.logBus.on('log', ({ level, module, message, error }) => {
    console[level](`[${module}] ${message}`, ...(error ? [error] : []));
  });
  ctx.install(DatabasePlugin, readDatabaseConfig(), readBillingCurrency());
  ctx.install(AccountsPlugin);
  ctx.install(GatewayPlugin);
  ctx.install(HonoPlugin, options);
  ctx.install(HttpPlugin);
  return ctx;
}
