import { CredentialVault } from '../../core/vault.ts';
import { definePlugin } from '../../kernel.ts';
import { AuthService } from '../auth/service.ts';
import { DatabaseService } from '../database/index.ts';
import { OutboundHttp } from '../outbound/index.ts';
import { SubscriptionService } from '../subscription/service.ts';
import { ChannelDirectory } from './directory.ts';
import { ChannelGrants } from './grants.ts';
import { ModelCatalog } from './models.ts';
import { CatalogService } from './service.ts';

export const CatalogPlugin = definePlugin({
  name: 'ohmyapi-catalog',
  inject: {
    database: DatabaseService,
    auth: AuthService,
    vault: CredentialVault,
    subscription: SubscriptionService,
    outbound: OutboundHttp,
  },
  provides: [CatalogService, ModelCatalog, ChannelGrants, ChannelDirectory],
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
    ctx.provide(ChannelDirectory, new ChannelDirectory({ db: ctx.database.db, subscription: ctx.subscription }));
    ctx.provide(ModelCatalog, new ModelCatalog({ auth: ctx.auth }));
    ctx.provide(ChannelGrants, new ChannelGrants({ db: ctx.database.db, auth: ctx.auth }));
  },
});
