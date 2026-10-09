import { definePlugin } from '../../kernel.js';
import { AuthService } from '../auth/service.js';
import { CredentialVault } from '../catalog/vault.js';
import { SubscriptionService } from './service.js';

export const SubscriptionPlugin = definePlugin({
  name: 'ohmyapi-subscription',
  inject: { auth: AuthService, vault: CredentialVault },
  provides: [SubscriptionService],
  apply(ctx) {
    ctx.provide(SubscriptionService, new SubscriptionService(ctx.auth, ctx.vault));
  },
});
