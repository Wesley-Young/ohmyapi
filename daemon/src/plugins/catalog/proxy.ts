import { and, eq, isNull } from 'drizzle-orm';

import { AppError } from '../../core/errors.js';
import type { CredentialVault } from '../../core/vault.js';
import type { AuthService, Principal } from '../auth/service.js';
import { channels } from '../database/schema/catalog.js';

// undefined 保留已有配置，null 明确直连，字符串用于保存或预览新的代理。
export async function channelProxy(
  auth: AuthService,
  vault: CredentialVault,
  principal: Principal,
  channelId: string | undefined,
  override: string | null | undefined,
) {
  return auth.authorized(principal, { admin: true }, async (tx) => {
    const [channel] = channelId
      ? await tx
          .select({ encrypted: channels.proxyUrlEncrypted })
          .from(channels)
          .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
      : [];
    if (channelId && !channel) throw new AppError('not_found', '渠道不存在');
    if (override !== undefined) return override;
    return channel?.encrypted ? vault.decrypt(channel.encrypted) : null;
  });
}
