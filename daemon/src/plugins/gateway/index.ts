import { readBillingCurrency, readDatabaseConfig, readGatewayConfig } from '../../config.js';
import { definePlugin } from '../../kernel.js';
import { AuthService } from '../../services/auth.js';
import { BillingService } from '../../services/billing.js';
import { CatalogService, CredentialVault } from '../../services/catalog.js';
import { GatewayService } from '../../services/gateway.js';
import { PricingService } from '../../services/pricing.js';
import { DatabaseService } from '../database/index.js';

export const GatewayPlugin = definePlugin({
  name: 'ohmyapi-gateway',
  inject: { database: DatabaseService, auth: AuthService },
  provides: [CatalogService, GatewayService, PricingService, BillingService],
  async apply(ctx) {
    const pricing = new PricingService(ctx.auth, readBillingCurrency());
    ctx.provide(PricingService, pricing);
    const billing = new BillingService(ctx.auth, pricing, (message) => ctx.logger.error(message));
    ctx.provide(BillingService, billing);
    await billing.start(readDatabaseConfig());
    const vault = new CredentialVault(process.env.CHANNEL_ENCRYPTION_KEY);
    ctx.provide(CatalogService, new CatalogService(ctx.auth, vault));
    const gateway = new GatewayService(ctx.database.db, pricing, billing, vault, readGatewayConfig(), (message) =>
      ctx.logger.error(message),
    );
    ctx.provide(GatewayService, gateway);
    billing.onLeaseLost(() => {
      void gateway.dispose();
    });
    ctx.interval(15000, () => billing.tick());
  },
});
