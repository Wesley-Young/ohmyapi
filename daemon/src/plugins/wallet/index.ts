import { definePlugin } from '../../kernel.js';
import { AuthService } from '../auth/service.js';
import { DatabaseService } from '../database/index.js';
import { WalletService } from './service.js';

export const WalletPlugin = definePlugin({
  name: 'ohmyapi-wallet',
  inject: { database: DatabaseService, auth: AuthService },
  provides: [WalletService],
  apply(ctx) {
    ctx.provide(WalletService, new WalletService({ db: ctx.database.db, auth: ctx.auth }));
  },
});
