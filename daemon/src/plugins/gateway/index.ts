import { readGatewayConfig } from '../../config.js';
import { definePlugin } from '../../kernel.js';
import { BillingService } from '../billing/service.js';
import { CatalogService } from '../catalog/service.js';
import { DatabaseService } from '../database/index.js';
import { PricingService } from '../pricing/service.js';
import { GatewayService } from './service.js';

export const GatewayPlugin = definePlugin({
  name: 'ohmyapi-gateway',
  inject: {
    database: DatabaseService,
    pricing: PricingService,
    billing: BillingService,
    catalog: CatalogService,
  },
  provides: [GatewayService],
  apply(ctx) {
    const gateway = new GatewayService(
      ctx.database.db,
      ctx.pricing,
      ctx.billing,
      ctx.catalog.vault,
      readGatewayConfig(),
      ctx.logger,
    );
    ctx.provide(GatewayService, gateway);
    ctx.billing.onLeaseLost(() => {
      void gateway.dispose();
    });
  },
});
