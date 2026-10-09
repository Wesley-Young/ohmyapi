import { serviceToken } from '@fraqjs/kernel';
import { TRPCError } from '@trpc/server';

import { definePlugin } from '../../kernel.js';

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class CredentialVault {
  static readonly token = serviceToken<CredentialVault>('ohmyapi/credential-vault');
  private readonly key?: Buffer;
  constructor(raw: string | undefined) {
    if (raw !== undefined && raw !== '') {
      if (!/^[a-fA-F0-9]{64}$/.test(raw))
        throw new Error('CHANNEL_ENCRYPTION_KEY must contain 64 hexadecimal characters');
      this.key = Buffer.from(raw, 'hex');
    }
  }

  private requireKey() {
    if (!this.key) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '请先配置 CHANNEL_ENCRYPTION_KEY' });
    return this.key;
  }

  encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.requireKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.');
  }

  decrypt(value: string) {
    const [version, iv, tag, encrypted] = value.split('.');
    if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Invalid encrypted credential');
    const cipher = createDecipheriv('aes-256-gcm', this.requireKey(), Buffer.from(iv, 'base64url'));
    cipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([cipher.update(Buffer.from(encrypted, 'base64url')), cipher.final()]).toString('utf8');
  }
}

export const CredentialVaultPlugin = definePlugin({
  name: 'ohmyapi-credential-vault',
  provides: [CredentialVault],
  apply(ctx) {
    ctx.provide(CredentialVault, new CredentialVault(process.env.CHANNEL_ENCRYPTION_KEY));
  },
});
