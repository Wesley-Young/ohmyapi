import { readDatabaseConfig } from '../../config.js';
import { definePlugin } from '../../kernel.js';
import { AuthService } from '../auth/service.js';
import { PricingService } from '../pricing/service.js';
import { BillingService } from './service.js';

export const BillingPlugin = definePlugin({
  name: 'ohmyapi-billing',
  inject: { auth: AuthService, pricing: PricingService },
  provides: [BillingService],
  async apply(ctx) {
    const billing = new BillingService(ctx.auth, ctx.pricing, ctx.logger);
    ctx.provide(BillingService, billing);
    await billing.start(readDatabaseConfig());
    ctx.interval(15000, () => billing.tick());
  },
});
