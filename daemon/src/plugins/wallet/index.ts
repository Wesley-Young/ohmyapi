import { definePlugin } from '../../kernel.ts';
import { AuthService } from '../auth/service.ts';
import { DatabaseService } from '../database/index.ts';
import { WalletService } from './service.ts';

export const WalletPlugin = definePlugin({
  name: 'ohmyapi-wallet',
  inject: { database: DatabaseService, auth: AuthService },
  provides: [WalletService],
  apply(ctx) {
    ctx.provide(
      WalletService,
      new WalletService({ db: ctx.database.db, auth: ctx.auth, currency: ctx.config.currency }),
    );
  },
});
