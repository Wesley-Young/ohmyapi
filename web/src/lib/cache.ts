import { queryClient, trpc } from './trpc';

/** 用户的账号、钱包或授权变化后，刷新相关的管理与个人数据。 */
export function refreshUser(userId: string) {
  return Promise.all([
    queryClient.invalidateQueries(trpc.admin.users.get.queryFilter({ userId })),
    queryClient.invalidateQueries(trpc.admin.users.list.pathFilter()),
    queryClient.invalidateQueries(trpc.admin.catalog.channelGrants.pathFilter()),
    queryClient.invalidateQueries(trpc.admin.groups.pathFilter()),
    queryClient.invalidateQueries(trpc.admin.wallet.get.queryFilter({ userId })),
    queryClient.invalidateQueries(trpc.admin.wallet.ledger.queryFilter({ userId })),
    queryClient.invalidateQueries(trpc.wallet.pathFilter()),
  ]);
}

/** 渠道或模型变化后，刷新目录及依赖它的 Key、模型广场和额度数据。 */
export const refreshCatalog = () =>
  Promise.all([
    queryClient.invalidateQueries(trpc.admin.catalog.list.queryFilter()),
    queryClient.invalidateQueries(trpc.admin.catalog.openAIQuota.pathFilter()),
    queryClient.invalidateQueries(trpc.admin.catalog.claudeQuota.pathFilter()),
    queryClient.invalidateQueries(trpc.admin.catalog.openAIResetCredits.pathFilter()),
    queryClient.invalidateQueries(trpc.keys.models.queryFilter()),
    queryClient.invalidateQueries(trpc.modelPlaza.queryFilter()),
    queryClient.invalidateQueries(trpc.keys.channels.queryFilter()),
    queryClient.invalidateQueries(trpc.keys.list.pathFilter()),
    queryClient.invalidateQueries(trpc.keys.playgroundOptions.queryFilter()),
    queryClient.invalidateQueries(trpc.admin.catalog.grants.pathFilter()),
    queryClient.invalidateQueries(trpc.admin.catalog.channelGrants.pathFilter()),
    queryClient.invalidateQueries(trpc.admin.groups.pathFilter()),
  ]);

/** 渠道授权或用户组变化后，刷新授权、用户组及依赖授权的 Key 和模型广场。 */
export const refreshGrants = () =>
  Promise.all([
    queryClient.invalidateQueries(trpc.admin.catalog.grants.pathFilter()),
    queryClient.invalidateQueries(trpc.admin.catalog.channelGrants.pathFilter()),
    queryClient.invalidateQueries(trpc.admin.groups.pathFilter()),
    queryClient.invalidateQueries(trpc.keys.pathFilter()),
    queryClient.invalidateQueries(trpc.modelPlaza.queryFilter()),
  ]);

/** 人工核对或修正某个请求的计费后，刷新请求列表、详情、对账与待核对计数。 */
export const refreshRequestBilling = (userId: string, requestId: string) =>
  Promise.all([
    refreshUser(userId),
    queryClient.invalidateQueries(trpc.requests.pathFilter()),
    queryClient.invalidateQueries(trpc.admin.requests.pathFilter()),
    queryClient.invalidateQueries(trpc.requestDetail.queryFilter({ requestId })),
    queryClient.invalidateQueries(trpc.admin.billing.reconcile.queryFilter({ userId })),
    queryClient.invalidateQueries(trpc.admin.reviewCount.queryFilter()),
  ]);
