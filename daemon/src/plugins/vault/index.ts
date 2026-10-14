import { CredentialVault } from '../../core/vault.ts';
import { definePlugin } from '../../kernel.ts';

export const CredentialVaultPlugin = definePlugin({
  name: 'ohmyapi-credential-vault',
  provides: [CredentialVault],
  apply(ctx) {
    ctx.provide(CredentialVault, new CredentialVault(ctx.config.encryptionKey));
  },
});
