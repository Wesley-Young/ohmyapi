import { definePlugin } from '../../kernel.ts';
import { AuthService } from '../auth/service.ts';
import { DatabaseService } from '../database/index.ts';
import { PricingService } from '../pricing/service.ts';
import { BillingRecords } from './records.ts';
import { BillingReview } from './review.ts';
import { BillingService } from './service.ts';

export const BillingPlugin = definePlugin({
  name: 'ohmyapi-billing',
  inject: { database: DatabaseService, auth: AuthService, pricing: PricingService },
  provides: [BillingService, BillingReview, BillingRecords],
  async apply(ctx) {
    const db = ctx.database.db;
    const billing = new BillingService({ db, pricing: ctx.pricing, logger: ctx.logger });
    ctx.provide(BillingService, billing);
    ctx.provide(BillingReview, new BillingReview({ auth: ctx.auth, pricing: ctx.pricing, billing }));
    ctx.provide(BillingRecords, new BillingRecords({ db, pricing: ctx.pricing }));
    await billing.start(ctx.config.database);
    ctx.interval(15000, () => billing.tick());
  },
});
