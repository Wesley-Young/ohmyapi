import { adminProcedure } from '../../trpc/procedures.ts';
import {
  consumeResetCreditInput,
  fetchSubscriptionModelsInput,
  setCycleResetInput,
  startOAuthInput,
  subscriptionChannelInput,
} from './schemas.ts';
import type { SubscriptionService } from './service.ts';

/** 订阅渠道的管理操作，挂载在渠道目录（admin.catalog）下。 */
export function subscriptionAdminRoutes(subscription: SubscriptionService) {
  return {
    openAIResetCredits: adminProcedure
      .input(subscriptionChannelInput)
      .query(({ ctx, input }) => subscription.listOpenAIResetCredits(ctx.principal, input.channelId)),
    consumeOpenAIResetCredit: adminProcedure
      .input(consumeResetCreditInput)
      .mutation(({ ctx, input }) => subscription.consumeOpenAIResetCredit(ctx.principal, input)),
    refreshOpenAIQuota: adminProcedure
      .input(subscriptionChannelInput)
      .mutation(({ ctx, input }) => subscription.openAIQuota(ctx.principal, input.channelId, true)),
    openAIQuota: adminProcedure
      .input(subscriptionChannelInput)
      .query(({ ctx, input }) => subscription.openAIQuota(ctx.principal, input.channelId)),
    refreshClaudeQuota: adminProcedure
      .input(subscriptionChannelInput)
      .mutation(({ ctx, input }) => subscription.claudeUsage(ctx.principal, input.channelId, true)),
    claudeQuota: adminProcedure
      .input(subscriptionChannelInput)
      .query(({ ctx, input }) => subscription.claudeUsage(ctx.principal, input.channelId)),
    refreshAntigravityQuota: adminProcedure
      .input(subscriptionChannelInput)
      .mutation(({ ctx, input }) => subscription.antigravityUsage(ctx.principal, input.channelId, true)),
    antigravityQuota: adminProcedure
      .input(subscriptionChannelInput)
      .query(({ ctx, input }) => subscription.antigravityUsage(ctx.principal, input.channelId)),
    subscriptionCycleUsage: adminProcedure
      .input(subscriptionChannelInput)
      .query(({ ctx, input }) => subscription.cycleUsage(ctx.principal, input.channelId)),
    setSubscriptionCycleReset: adminProcedure
      .input(setCycleResetInput)
      .mutation(({ ctx, input }) => subscription.setCycleReset(ctx.principal, input)),
    startSubscriptionOAuth: adminProcedure
      .input(startOAuthInput)
      .mutation(({ ctx, input }) => subscription.startOAuth(ctx.principal, input?.provider)),
    refreshSubscription: adminProcedure
      .input(subscriptionChannelInput)
      .mutation(({ ctx, input }) => subscription.refresh(ctx.principal, input.channelId)),
    fetchSubscriptionModels: adminProcedure
      .input(fetchSubscriptionModelsInput)
      .mutation(({ ctx, input }) => subscription.models(ctx.principal, input)),
  };
}
