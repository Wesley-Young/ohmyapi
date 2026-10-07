import { definePlugin } from '../../kernel.js';
import { AuthService } from '../auth/service.js';
import { WalletService } from './service.js';

export const WalletPlugin = definePlugin({
  name: 'ohmyapi-wallet',
  inject: { auth: AuthService },
  provides: [WalletService],
  apply(ctx) {
    ctx.provide(WalletService, new WalletService(ctx.auth));
  },
});
