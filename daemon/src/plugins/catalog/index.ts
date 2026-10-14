import { CredentialVault } from '../../core/vault.js';
import { definePlugin } from '../../kernel.js';
import { AuthService } from '../auth/service.js';
import { DatabaseService } from '../database/index.js';
import { OutboundHttp } from '../outbound/index.js';
import { SubscriptionService } from '../subscription/service.js';
import { ChannelGrants } from './grants.js';
import { ModelCatalog } from './models.js';
import { CatalogService } from './service.js';

export const CatalogPlugin = definePlugin({
  name: 'ohmyapi-catalog',
  inject: {
    database: DatabaseService,
    auth: AuthService,
    vault: CredentialVault,
    subscription: SubscriptionService,
    outbound: OutboundHttp,
  },
  provides: [CatalogService, ModelCatalog, ChannelGrants],
  apply(ctx) {
    ctx.provide(
      CatalogService,
      new CatalogService({
        db: ctx.database.db,
        auth: ctx.auth,
        vault: ctx.vault,
        subscription: ctx.subscription,
        outbound: ctx.outbound,
        logger: ctx.logger,
      }),
    );
    ctx.provide(ModelCatalog, new ModelCatalog({ auth: ctx.auth }));
    ctx.provide(ChannelGrants, new ChannelGrants({ db: ctx.database.db, auth: ctx.auth }));
  },
});
