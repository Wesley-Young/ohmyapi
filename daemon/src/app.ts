import HonoPlugin from '@fraqjs/plugin-hono';

import type { AppConfig } from './config.ts';
import { GracefulHttpServer } from './core/http-server.ts';
import { logHandler } from './core/logging.ts';
import { AppContext } from './kernel.ts';
import { AuthPlugin } from './plugins/auth/index.ts';
import { BillingPlugin } from './plugins/billing/index.ts';
import { CatalogPlugin } from './plugins/catalog/index.ts';
import { DatabasePlugin } from './plugins/database/index.ts';
import { GatewayPlugin } from './plugins/gateway/index.ts';
import { GroupsPlugin } from './plugins/groups/index.ts';
import { HttpPlugin } from './plugins/http/index.ts';
import { KeysPlugin } from './plugins/keys/index.ts';
import { ModerationPlugin } from './plugins/moderation/index.ts';
import { OutboundPlugin } from './plugins/outbound/index.ts';
import { PricingPlugin } from './plugins/pricing/index.ts';
import { SubscriptionPlugin } from './plugins/subscription/index.ts';
import { UsersPlugin } from './plugins/users/index.ts';
import { CredentialVaultPlugin } from './plugins/vault/index.ts';
import { WalletPlugin } from './plugins/wallet/index.ts';

export function createApp(config: AppConfig) {
  const server = new GracefulHttpServer();
  const ctx = AppContext.create(config);
  ctx.logBus.on('log', logHandler);
  ctx.install(DatabasePlugin);
  ctx.install(AuthPlugin);
  ctx.install(GroupsPlugin);
  ctx.install(UsersPlugin);
  ctx.install(KeysPlugin);
  ctx.install(WalletPlugin);
  ctx.install(PricingPlugin);
  ctx.install(BillingPlugin);
  ctx.install(CredentialVaultPlugin);
  ctx.install(OutboundPlugin);
  ctx.install(SubscriptionPlugin);
  ctx.install(CatalogPlugin);
  ctx.install(ModerationPlugin);
  ctx.install(GatewayPlugin);
  ctx.install(HonoPlugin, { ...config.server, serveOptions: { createServer: server.createServer } });
  ctx.install(HttpPlugin);
  return { ctx, server };
}
