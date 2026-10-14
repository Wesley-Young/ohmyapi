import { CredentialVault } from '../../core/vault.js';
import { definePlugin } from '../../kernel.js';
import { BillingService } from '../billing/service.js';
import { DatabaseService } from '../database/index.js';
import { OutboundHttp } from '../outbound/index.js';
import { PricingService } from '../pricing/service.js';
import { SubscriptionService } from '../subscription/service.js';
import { GatewayService } from './service.js';

export const GatewayPlugin = definePlugin({
  name: 'ohmyapi-gateway',
  inject: {
    database: DatabaseService,
    pricing: PricingService,
    billing: BillingService,
    vault: CredentialVault,
    subscription: SubscriptionService,
    outbound: OutboundHttp,
  },
  provides: [GatewayService],
  apply(ctx) {
    const gateway = new GatewayService({
      db: ctx.database.db,
      pricing: ctx.pricing,
      billing: ctx.billing,
      vault: ctx.vault,
      subscription: ctx.subscription,
      outbound: ctx.outbound,
      config: ctx.config.gateway,
      logger: ctx.logger,
    });
    ctx.provide(GatewayService, gateway);
    ctx.billing.onLeaseLost(() => {
      void gateway.dispose();
    });
  },
});
