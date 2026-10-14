import { CredentialVault } from '../../core/vault.js';
import { definePlugin } from '../../kernel.js';

export const CredentialVaultPlugin = definePlugin({
  name: 'ohmyapi-credential-vault',
  provides: [CredentialVault],
  apply(ctx) {
    ctx.provide(CredentialVault, new CredentialVault(ctx.config.encryptionKey));
  },
});
