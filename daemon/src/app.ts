import HonoPlugin from '@fraqjs/plugin-hono';

import { readBillingCurrency, readDatabaseConfig } from './config.js';
import { AppContext } from './kernel.js';
import { logHandler } from './logging.js';
import { AuthPlugin } from './plugins/auth/index.js';
import { BillingPlugin } from './plugins/billing/index.js';
import { CatalogPlugin } from './plugins/catalog/index.js';
import { CredentialVaultPlugin } from './plugins/catalog/vault.js';
import { DatabasePlugin } from './plugins/database/index.js';
import { GatewayPlugin } from './plugins/gateway/index.js';
import { HttpPlugin } from './plugins/http/index.js';
import { KeysPlugin } from './plugins/keys/index.js';
import { PricingPlugin } from './plugins/pricing/index.js';
import { SubscriptionPlugin } from './plugins/subscription/index.js';
import { UsersPlugin } from './plugins/users/index.js';
import { WalletPlugin } from './plugins/wallet/index.js';

export function createApp(options: { host: string; port: number }) {
  const ctx = AppContext.create();
  ctx.logBus.on('log', logHandler);
  ctx.install(DatabasePlugin, readDatabaseConfig(), readBillingCurrency());
  ctx.install(AuthPlugin);
  ctx.install(UsersPlugin);
  ctx.install(KeysPlugin);
  ctx.install(WalletPlugin);
  ctx.install(PricingPlugin);
  ctx.install(BillingPlugin);
  ctx.install(CredentialVaultPlugin);
  ctx.install(SubscriptionPlugin);
  ctx.install(CatalogPlugin);
  ctx.install(GatewayPlugin);
  ctx.install(HonoPlugin, options);
  ctx.install(HttpPlugin);
  return ctx;
}
