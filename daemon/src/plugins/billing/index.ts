import { definePlugin } from '../../kernel.js';
import { AuthService } from '../auth/service.js';
import { DatabaseService } from '../database/index.js';
import { PricingService } from '../pricing/service.js';
import { BillingRecords } from './records.js';
import { BillingReviewService } from './review.js';
import { BillingService } from './service.js';

export const BillingPlugin = definePlugin({
  name: 'ohmyapi-billing',
  inject: { database: DatabaseService, auth: AuthService, pricing: PricingService },
  provides: [BillingService, BillingReviewService, BillingRecords],
  async apply(ctx) {
    const db = ctx.database.db;
    const billing = new BillingService({ db, pricing: ctx.pricing, logger: ctx.logger });
    ctx.provide(BillingService, billing);
    ctx.provide(BillingReviewService, new BillingReviewService({ auth: ctx.auth, pricing: ctx.pricing, billing }));
    ctx.provide(BillingRecords, new BillingRecords({ db, pricing: ctx.pricing }));
    await billing.start(ctx.config.database);
    ctx.interval(15000, () => billing.tick());
  },
});
