import { adminProcedure } from '../../trpc/procedures.ts';
import { acknowledgeInput, moderationIdInput, moderationListInput, moderationSettingsInput } from './schemas.ts';
import type { ModerationService } from './service.ts';

export function moderationAdminRoutes(moderation: ModerationService) {
  return {
    list: adminProcedure.input(moderationListInput).query(({ input }) => moderation.list(input)),
    alertCount: adminProcedure.query(() => moderation.alertCount()),
    // 查看内容会记录审计日志，因此作为变更调用，避免查询缓存重复触发。
    content: adminProcedure
      .input(moderationIdInput)
      .mutation(({ ctx, input }) => moderation.content(ctx.principal, input.id)),
    acknowledge: adminProcedure
      .input(acknowledgeInput)
      .mutation(({ ctx, input }) => moderation.acknowledge(ctx.principal, input.ids)),
    settings: adminProcedure.query(() => moderation.getSettings()),
    saveSettings: adminProcedure
      .input(moderationSettingsInput)
      .mutation(({ ctx, input }) => moderation.saveSettings(ctx.principal, input)),
  };
}
