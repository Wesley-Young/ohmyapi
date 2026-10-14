import { CredentialVault } from '../../core/vault.js';
import { definePlugin } from '../../kernel.js';
import { AuthService } from '../auth/service.js';
import { DatabaseService } from '../database/index.js';
import { OutboundHttp } from '../outbound/index.js';
import { SubscriptionService } from './service.js';

export const SubscriptionPlugin = definePlugin({
  name: 'ohmyapi-subscription',
  inject: { database: DatabaseService, auth: AuthService, vault: CredentialVault, outbound: OutboundHttp },
  provides: [SubscriptionService],
  apply(ctx) {
    const subscription = new SubscriptionService({
      db: ctx.database.db,
      auth: ctx.auth,
      vault: ctx.vault,
      outbound: ctx.outbound,
    });
    ctx.provide(SubscriptionService, subscription);
    ctx.interval(30_000, () => subscription.maintain());
  },
});
