import { definePlugin } from '../../kernel.js';
import { AuthService } from '../auth/service.js';
import { CatalogService, CredentialVault } from './service.js';

export const CatalogPlugin = definePlugin({
  name: 'ohmyapi-catalog',
  inject: { auth: AuthService },
  provides: [CatalogService],
  apply(ctx) {
    const vault = new CredentialVault(process.env.CHANNEL_ENCRYPTION_KEY);
    ctx.provide(CatalogService, new CatalogService(ctx.auth, vault, ctx.logger));
  },
});
