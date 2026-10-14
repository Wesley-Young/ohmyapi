import { definePlugin } from '../../kernel.js';
import { AuthService } from '../auth/service.js';
import { DatabaseService } from '../database/index.js';
import { PricingService } from './service.js';

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
