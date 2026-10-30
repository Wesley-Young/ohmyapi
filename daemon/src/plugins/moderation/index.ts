import { CredentialVault } from '../../core/vault.ts';
import { definePlugin } from '../../kernel.ts';
import { AuthService } from '../auth/service.ts';
import { DatabaseService } from '../database/index.ts';
import { OutboundHttp } from '../outbound/index.ts';
import { ModerationSampler } from './sampler.ts';
import { ModerationService } from './service.ts';

export const ModerationPlugin = definePlugin({
  name: 'ohmyapi-moderation',
  inject: { database: DatabaseService, auth: AuthService, vault: CredentialVault, outbound: OutboundHttp },
  provides: [ModerationSampler, ModerationService],
  async apply(ctx) {
    const db = ctx.database.db;
    const sampler = new ModerationSampler({
      db,
      vault: ctx.vault,
      config: ctx.config.moderation,
      encryptionKey: ctx.config.encryptionKey,
      logger: ctx.logger,
    });
    const moderation = new ModerationService({
      db,
      auth: ctx.auth,
      vault: ctx.vault,
      outbound: ctx.outbound,
      sampler,
      config: ctx.config.moderation,
      logger: ctx.logger,
    });
    ctx.provide(ModerationSampler, sampler);
    ctx.provide(ModerationService, moderation);
    await moderation.start();
    ctx.interval(15000, () => moderation.tick());
  },
});
