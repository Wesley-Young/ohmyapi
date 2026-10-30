import { CredentialVault } from '../../core/vault.ts';
import { definePlugin } from '../../kernel.ts';
import { BillingService } from '../billing/service.ts';
import { ChannelConcurrency } from '../catalog/concurrency.ts';
import { DatabaseService } from '../database/index.ts';
import { ModerationSampler } from '../moderation/sampler.ts';
import { OutboundHttp } from '../outbound/index.ts';
import { PricingService } from '../pricing/service.ts';
import { SubscriptionRuntime } from '../subscription/runtime.ts';
import { RequestHistory } from './history.ts';
import { GatewayService } from './service.ts';

export const GatewayPlugin = definePlugin({
  name: 'ohmyapi-gateway',
  inject: {
    database: DatabaseService,
    pricing: PricingService,
    billing: BillingService,
    vault: CredentialVault,
    subscriptions: SubscriptionRuntime,
    concurrency: ChannelConcurrency,
    outbound: OutboundHttp,
    moderation: ModerationSampler,
  },
  provides: [GatewayService, RequestHistory],
  apply(ctx) {
    const gateway = new GatewayService({
      db: ctx.database.db,
      pricing: ctx.pricing,
      billing: ctx.billing,
      vault: ctx.vault,
      subscriptions: ctx.subscriptions,
      concurrency: ctx.concurrency,
      outbound: ctx.outbound,
      moderation: ctx.moderation,
      config: ctx.config.gateway,
      logger: ctx.logger,
    });
    ctx.provide(GatewayService, gateway);
    ctx.provide(RequestHistory, new RequestHistory({ db: ctx.database.db, pricing: ctx.pricing }));
  },
});
