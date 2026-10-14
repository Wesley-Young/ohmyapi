import { serviceToken } from '@fraqjs/kernel';

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** 使用 AES-256-GCM 加密保存渠道凭据和代理地址；密钥格式由配置读取时校验。 */
export class CredentialVault {
  static readonly token = serviceToken<CredentialVault>('ohmyapi/credential-vault');
  private readonly key: Buffer;
  constructor(hexKey: string) {
    this.key = Buffer.from(hexKey, 'hex');
  }

  encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
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
    const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    cipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([cipher.update(Buffer.from(encrypted, 'base64url')), cipher.final()]).toString('utf8');
  }
}
