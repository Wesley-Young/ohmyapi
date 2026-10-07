import { definePlugin } from '../../kernel.js';
import { AuthService } from '../auth/service.js';
import { UserService } from './service.js';

export const UsersPlugin = definePlugin({
  name: 'ohmyapi-users',
  inject: { auth: AuthService },
  provides: [UserService],
  apply(ctx) {
    ctx.provide(UserService, new UserService(ctx.auth));
  },
});
