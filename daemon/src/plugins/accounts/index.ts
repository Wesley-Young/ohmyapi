import { definePlugin } from '../../kernel.js';
import { AuthService } from '../../services/auth.js';
import { KeyService } from '../../services/keys.js';
import { UserService } from '../../services/users.js';
import { WalletService } from '../../services/wallet.js';
import { DatabaseService } from '../database/index.js';

export const AccountsPlugin = definePlugin({
  name: 'ohmyapi-accounts',
  inject: { database: DatabaseService },
  provides: [AuthService, UserService, KeyService, WalletService],
  apply(ctx) {
    const auth = new AuthService(ctx.database.db);
    ctx.provide(AuthService, auth);
    ctx.provide(UserService, new UserService(auth));
    ctx.provide(KeyService, new KeyService(auth));
    ctx.provide(WalletService, new WalletService(auth));
    ctx.interval(60 * 60 * 1000, async () => {
      try {
        await auth.cleanupSessions();
      } catch {
        ctx.logger.error('Session cleanup failed');
      }
    });
  },
});
