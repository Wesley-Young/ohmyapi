import { definePlugin } from '../../kernel.js';
import { AuthService } from '../auth/service.js';
import { SubscriptionService } from '../subscription/service.js';
import { CatalogService } from './service.js';
import { CredentialVault } from './vault.js';

export const CatalogPlugin = definePlugin({
  name: 'ohmyapi-catalog',
  inject: { auth: AuthService, vault: CredentialVault, subscription: SubscriptionService },
  provides: [CatalogService],
  apply(ctx) {
    ctx.provide(CatalogService, new CatalogService(ctx.auth, ctx.vault, ctx.logger, ctx.subscription));
  },
});
