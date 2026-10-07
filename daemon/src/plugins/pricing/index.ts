import { readBillingCurrency } from '../../config.js';
import { definePlugin } from '../../kernel.js';
import { AuthService } from '../auth/service.js';
import { PricingService } from './service.js';

export const PricingPlugin = definePlugin({
  name: 'ohmyapi-pricing',
  inject: { auth: AuthService },
  provides: [PricingService],
  apply(ctx) {
    ctx.provide(PricingService, new PricingService(ctx.auth, readBillingCurrency()));
  },
});
