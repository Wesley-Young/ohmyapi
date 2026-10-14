import { definePlugin } from '../../kernel.js';
import { AuthService } from '../auth/service.js';
import { DatabaseService } from '../database/index.js';
import { PricingService } from '../pricing/service.js';
import { BillingService } from './service.js';

export const BillingPlugin = definePlugin({
  name: 'ohmyapi-billing',
  inject: { database: DatabaseService, auth: AuthService, pricing: PricingService },
  provides: [BillingService],
  async apply(ctx) {
    const billing = new BillingService({
      db: ctx.database.db,
      auth: ctx.auth,
      pricing: ctx.pricing,
      logger: ctx.logger,
    });
    ctx.provide(BillingService, billing);
    await billing.start(ctx.config.database);
    ctx.interval(15000, () => billing.tick());
  },
});
