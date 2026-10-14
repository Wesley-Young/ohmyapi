import { definePlugin } from '../../kernel.js';
import { AuthService } from '../auth/service.js';
import { DatabaseService } from '../database/index.js';
import { GroupService } from './service.js';

export const GroupsPlugin = definePlugin({
  name: 'ohmyapi-groups',
  inject: { database: DatabaseService, auth: AuthService },
  provides: [GroupService],
  apply(ctx) {
    ctx.provide(GroupService, new GroupService({ db: ctx.database.db, auth: ctx.auth }));
  },
});
