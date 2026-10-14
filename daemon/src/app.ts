import HonoPlugin from '@fraqjs/plugin-hono';

import type { AppConfig } from './config.js';
import { logHandler } from './core/logging.js';
import { AppContext } from './kernel.js';
import { AuthPlugin } from './plugins/auth/index.js';
import { BillingPlugin } from './plugins/billing/index.js';
import { CatalogPlugin } from './plugins/catalog/index.js';
import { DatabasePlugin } from './plugins/database/index.js';
import { GatewayPlugin } from './plugins/gateway/index.js';
import { GroupsPlugin } from './plugins/groups/index.js';
import { HttpPlugin } from './plugins/http/index.js';
import { KeysPlugin } from './plugins/keys/index.js';
import { OutboundPlugin } from './plugins/outbound/index.js';
import { PricingPlugin } from './plugins/pricing/index.js';
import { SubscriptionPlugin } from './plugins/subscription/index.js';
import { UsersPlugin } from './plugins/users/index.js';
import { CredentialVaultPlugin } from './plugins/vault/index.js';
import { WalletPlugin } from './plugins/wallet/index.js';

export function createApp(config: AppConfig) {
  const ctx = AppContext.create(config);
  ctx.logBus.on('log', logHandler);
  ctx.install(DatabasePlugin);
  ctx.install(AuthPlugin);
  ctx.install(UsersPlugin);
  ctx.install(GroupsPlugin);
  ctx.install(KeysPlugin);
  ctx.install(WalletPlugin);
  ctx.install(PricingPlugin);
  ctx.install(BillingPlugin);
  ctx.install(CredentialVaultPlugin);
  ctx.install(OutboundPlugin);
  ctx.install(SubscriptionPlugin);
  ctx.install(CatalogPlugin);
  ctx.install(GatewayPlugin);
  ctx.install(HonoPlugin, config.server);
  ctx.install(HttpPlugin);
  return ctx;
}
