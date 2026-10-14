import { definePlugin } from '../../kernel.ts';
import { AuthService } from '../auth/service.ts';
import { DatabaseService } from '../database/index.ts';
import { PricingService } from './service.ts';

export const PricingPlugin = definePlugin({
  name: 'ohmyapi-pricing',
  inject: { database: DatabaseService, auth: AuthService },
  provides: [PricingService],
  apply(ctx) {
    ctx.provide(
      PricingService,
      new PricingService({ db: ctx.database.db, auth: ctx.auth, currency: ctx.config.currency }),
    );
  },
});
