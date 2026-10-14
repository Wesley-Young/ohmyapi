import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';

import { authRoutes } from '../plugins/auth/router.ts';
import type { AuthService } from '../plugins/auth/service.ts';
import type { BillingRecords } from '../plugins/billing/records.ts';
import type { BillingReview } from '../plugins/billing/review.ts';
import { billingRoutes } from '../plugins/billing/router.ts';
import type { ChannelGrants } from '../plugins/catalog/grants.ts';
import type { ModelCatalog } from '../plugins/catalog/models.ts';
import { catalogAdminRoutes } from '../plugins/catalog/router.ts';
import type { CatalogService } from '../plugins/catalog/service.ts';
import type { RequestHistory } from '../plugins/gateway/history.ts';
import { requestRoutes } from '../plugins/gateway/router.ts';
import { groupAdminRoutes } from '../plugins/groups/router.ts';
import type { GroupService } from '../plugins/groups/service.ts';
import { keyRoutes } from '../plugins/keys/router.ts';
import type { KeyService } from '../plugins/keys/service.ts';
import { pricingRoutes } from '../plugins/pricing/router.ts';
import type { PricingService } from '../plugins/pricing/service.ts';
import { subscriptionAdminRoutes } from '../plugins/subscription/router.ts';
import type { SubscriptionService } from '../plugins/subscription/service.ts';
import { userAdminRoutes } from '../plugins/users/router.ts';
import type { UserService } from '../plugins/users/service.ts';
import { walletRoutes } from '../plugins/wallet/router.ts';
import type { WalletService } from '../plugins/wallet/service.ts';
import { publicProcedure, router } from './procedures.ts';

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
