import { CredentialVault } from '../../core/vault.ts';
import { definePlugin } from '../../kernel.ts';
import { AuthService } from '../auth/service.ts';
import { DatabaseService } from '../database/index.ts';
import { OutboundHttp } from '../outbound/index.ts';
import { SubscriptionRuntime } from './runtime.ts';
import { SubscriptionService } from './service.ts';

export const SubscriptionPlugin = definePlugin({
  name: 'ohmyapi-subscription',
  inject: { database: DatabaseService, auth: AuthService, vault: CredentialVault, outbound: OutboundHttp },
  provides: [SubscriptionRuntime, SubscriptionService],
  apply(ctx) {
    const runtime = new SubscriptionRuntime({ db: ctx.database.db, vault: ctx.vault, outbound: ctx.outbound });
    const subscription = new SubscriptionService({
      db: ctx.database.db,
      auth: ctx.auth,
      vault: ctx.vault,
      outbound: ctx.outbound,
      runtime,
    });
    ctx.provide(SubscriptionRuntime, runtime);
    ctx.provide(SubscriptionService, subscription);
    ctx.interval(30_000, () => subscription.maintain());
  },
});
