import { definePlugin } from '../../kernel.js';
import { DatabaseService } from '../database/index.js';
import { AuthService } from './service.js';

export const AuthPlugin = definePlugin({
  name: 'ohmyapi-auth',
  inject: { database: DatabaseService },
  provides: [AuthService],
  apply(ctx) {
    const auth = new AuthService(ctx.database.db);
    ctx.provide(AuthService, auth);
    ctx.interval(60 * 60 * 1000, async () => {
      try {
        await auth.cleanupSessions();
      } catch {
        ctx.logger.error('Session cleanup failed');
      }
    });
  },
});
