import { definePlugin } from '../../kernel.js';
import { AuthService } from '../auth/service.js';
import { KeyService } from './service.js';

export const KeysPlugin = definePlugin({
  name: 'ohmyapi-keys',
  inject: { auth: AuthService },
  provides: [KeyService],
  apply(ctx) {
    ctx.provide(KeyService, new KeyService(ctx.auth));
  },
});
