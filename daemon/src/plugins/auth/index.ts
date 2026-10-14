import { errorDetails, formatEvent } from '../../core/logging.js';
import { definePlugin } from '../../kernel.js';
import { DatabaseService } from '../database/index.js';
import { AuthService } from './service.js';

export const AuthPlugin = definePlugin({
  name: 'ohmyapi-auth',
  inject: { database: DatabaseService },
  provides: [AuthService],
  apply(ctx) {
    const auth = new AuthService({ db: ctx.database.db, logger: ctx.logger });
    ctx.provide(AuthService, auth);
    ctx.interval(60 * 60 * 1000, async () => {
      try {
        await auth.cleanupSessions();
      } catch (error) {
        ctx.logger.error(formatEvent('会话清理失败', errorDetails(error)));
      }
    });
  },
});
