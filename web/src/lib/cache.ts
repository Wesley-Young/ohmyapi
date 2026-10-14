import { queryClient, trpc } from './trpc';

/** 用户的账号、钱包或授权变化后，刷新相关的管理与个人数据。 */
export function invalidateUser(userId: string) {
  return Promise.all([
    queryClient.invalidateQueries(trpc.admin.users.get.queryFilter({ userId })),
    queryClient.invalidateQueries(trpc.admin.users.list.pathFilter()),
    queryClient.invalidateQueries(trpc.admin.catalog.channelGrants.pathFilter()),
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
  ]);
