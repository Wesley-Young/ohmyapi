import { definePlugin } from '../../kernel.js';
import { AuthService } from '../auth/service.js';
import { DatabaseService } from '../database/index.js';
import { GroupService } from '../groups/service.js';
import { UserService } from './service.js';

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
      }),
    );
  },
});
