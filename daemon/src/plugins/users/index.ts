import { definePlugin } from '../../kernel.ts';
import { AuthService } from '../auth/service.ts';
import { DatabaseService } from '../database/index.ts';
import { GroupService } from '../groups/service.ts';
import { UserService } from './service.ts';

export const UsersPlugin = definePlugin({
  name: 'ohmyapi-users',
  inject: { database: DatabaseService, auth: AuthService, groups: GroupService },
  provides: [UserService],
  apply(ctx) {
    ctx.provide(
      UserService,
      new UserService({
        db: ctx.database.db,
        auth: ctx.auth,
        groups: ctx.groups,
        initialBalanceMicros: ctx.config.userInitialBalanceMicros,
        currency: ctx.config.currency,
        defaultMaxConcurrent: ctx.config.gateway.maxConcurrent,
      }),
    );
  },
});
