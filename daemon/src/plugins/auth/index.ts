import { errorDetails, formatEvent } from '../../core/logging.ts';
import { definePlugin } from '../../kernel.ts';
import { DatabaseService } from '../database/index.ts';
import { AuthService } from './service.ts';
import { AdminTokens } from './tokens.ts';

export const AuthPlugin = definePlugin({
  name: 'ohmyapi-auth',
  inject: { database: DatabaseService },
  provides: [AuthService, AdminTokens],
  apply(ctx) {
    const auth = new AuthService({ db: ctx.database.db, logger: ctx.logger });
    ctx.provide(AuthService, auth);
    ctx.provide(AdminTokens, new AdminTokens({ db: ctx.database.db, auth }));
    ctx.interval(60 * 60 * 1000, async () => {
      try {
        await auth.cleanupSessions();
      } catch (error) {
        ctx.logger.error(formatEvent('会话清理失败', errorDetails(error)));
      }
    });
  },
});
