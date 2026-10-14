import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';

import { authRoutes } from '../plugins/auth/router.js';
import type { AuthService } from '../plugins/auth/service.js';
import { billingRoutes } from '../plugins/billing/router.js';
import type { BillingService } from '../plugins/billing/service.js';
import { catalogAdminRoutes } from '../plugins/catalog/router.js';
import type { CatalogService } from '../plugins/catalog/service.js';
import { requestRoutes } from '../plugins/gateway/router.js';
import type { GatewayService } from '../plugins/gateway/service.js';
import { keyRoutes } from '../plugins/keys/router.js';
import type { KeyService } from '../plugins/keys/service.js';
import { pricingRoutes } from '../plugins/pricing/router.js';
import type { PricingService } from '../plugins/pricing/service.js';
import { subscriptionAdminRoutes } from '../plugins/subscription/router.js';
import type { SubscriptionService } from '../plugins/subscription/service.js';
import { userAdminRoutes } from '../plugins/users/router.js';
import type { UserService } from '../plugins/users/service.js';
import { walletRoutes } from '../plugins/wallet/router.js';
import type { WalletService } from '../plugins/wallet/service.js';
import { publicProcedure, router } from './procedures.js';

export interface RouterServices {
  startedAt: string;
  auth: AuthService;
  users: UserService;
  keys: KeyService;
  wallet: WalletService;
  pricing: PricingService;
  billing: BillingService;
  catalog: CatalogService;
  subscription: SubscriptionService;
  gateway: GatewayService;
}

/** 汇总各模块的路由；这里即是完整的 RPC 接口清单。 */
export function createAppRouter(services: RouterServices) {
  const wallet = walletRoutes(services.wallet);
  const pricing = pricingRoutes(services.pricing, services.keys);
  const billing = billingRoutes(services.billing);
  const requests = requestRoutes(services.gateway);
  return router({
    system: {
      status: publicProcedure.query(() => ({ name: 'ohmyapi', status: 'ok' as const, startedAt: services.startedAt })),
    },
    auth: authRoutes(services.auth),
    keys: keyRoutes(services.keys),
    modelPlaza: pricing.modelPlaza,
    wallet: wallet.user,
    requests: requests.user,
    requestDetail: billing.requestDetail,
    admin: {
      ...wallet.platform,
      billing: billing.admin,
      pricing: pricing.admin,
      catalog: { ...subscriptionAdminRoutes(services.subscription), ...catalogAdminRoutes(services.catalog) },
      requests: requests.admin,
      users: userAdminRoutes(services.users),
      wallet: wallet.admin,
    },
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type RouterInputs = inferRouterInputs<AppRouter>;
