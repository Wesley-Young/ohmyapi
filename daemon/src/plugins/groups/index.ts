import { definePlugin } from '../../kernel.ts';
import { AuthService } from '../auth/service.ts';
import { DatabaseService } from '../database/index.ts';
import { GroupService } from './service.ts';

export const GroupsPlugin = definePlugin({
  name: 'ohmyapi-groups',
  inject: { database: DatabaseService, auth: AuthService },
  provides: [GroupService],
  apply(ctx) {
    ctx.provide(GroupService, new GroupService({ db: ctx.database.db, auth: ctx.auth }));
  },
});
