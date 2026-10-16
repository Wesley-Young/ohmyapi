import { definePlugin } from '../../kernel.ts';
import { AuthService } from '../auth/service.ts';
import { DatabaseService } from '../database/index.ts';
import { KeyService } from './service.ts';

export const KeysPlugin = definePlugin({
  name: 'ohmyapi-keys',
  inject: { database: DatabaseService, auth: AuthService },
  provides: [KeyService],
  apply(ctx) {
    ctx.provide(
      KeyService,
      new KeyService({ db: ctx.database.db, auth: ctx.auth, accessEndpoints: ctx.config.accessEndpoints }),
    );
  },
});
