import { definePlugin } from '../../kernel.js';
import { AuthService } from '../auth/service.js';
import { DatabaseService } from '../database/index.js';
import { KeyService } from './service.js';

export const KeysPlugin = definePlugin({
  name: 'ohmyapi-keys',
  inject: { database: DatabaseService, auth: AuthService },
  provides: [KeyService],
  apply(ctx) {
    ctx.provide(KeyService, new KeyService({ db: ctx.database.db, auth: ctx.auth }));
  },
});
