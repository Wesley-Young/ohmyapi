import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';

import { authRoutes } from '../plugins/auth/router.js';
import type { AuthService } from '../plugins/auth/service.js';
import type { BillingRecords } from '../plugins/billing/records.js';
import type { BillingReview } from '../plugins/billing/review.js';
import { billingRoutes } from '../plugins/billing/router.js';
import type { ChannelGrants } from '../plugins/catalog/grants.js';
import type { ModelCatalog } from '../plugins/catalog/models.js';
import { catalogAdminRoutes } from '../plugins/catalog/router.js';
import type { CatalogService } from '../plugins/catalog/service.js';
import type { RequestHistory } from '../plugins/gateway/history.js';
import { requestRoutes } from '../plugins/gateway/router.js';
import { groupAdminRoutes } from '../plugins/groups/router.js';
import type { GroupService } from '../plugins/groups/service.js';
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
  groups: GroupService;
  keys: KeyService;
  wallet: WalletService;
  pricing: PricingService;
  billingRecords: BillingRecords;
  billingReview: BillingReview;
  catalog: CatalogService;
  modelCatalog: ModelCatalog;
  channelGrants: ChannelGrants;
  subscription: SubscriptionService;
  requestHistory: RequestHistory;
}

/** 汇总各模块的路由；这里即是完整的 RPC 接口清单。 */
export function createAppRouter(services: RouterServices) {
  const wallet = walletRoutes(services.wallet);
  const pricing = pricingRoutes(services.pricing, services.keys);
  const billing = billingRoutes(services.billingRecords, services.billingReview);
  const requests = requestRoutes(services.requestHistory);
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
      catalog: {
        ...subscriptionAdminRoutes(services.subscription),
        ...catalogAdminRoutes(services.catalog, services.modelCatalog, services.channelGrants),
      },
      requests: requests.admin,
      users: userAdminRoutes(services.users),
      groups: groupAdminRoutes(services.groups),
      wallet: wallet.admin,
    },
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type RouterInputs = inferRouterInputs<AppRouter>;
