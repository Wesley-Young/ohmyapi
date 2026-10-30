import { z } from 'zod';

import { pageInput } from '../../core/pagination.ts';

export const moderationListInput = z.object({
  /** alerts：未确认的疑似和违规；all：全部。 */
  filter: z.enum(['alerts', 'all']).default('alerts'),
  page: pageInput,
});
export const moderationIdInput = z.object({ id: z.uuid() });
export const acknowledgeInput = z.object({
  ids: z
    .array(z.uuid())
    .min(1, '请选择要确认的预警')
    .max(100, '每次最多确认 100 条预警')
    .refine((ids) => new Set(ids).size === ids.length, '预警不能重复'),
});
export const moderationSettingsInput = z
  .object({
    /** null 表示停用审核：不再采集新内容，已入队的会话等待重新配置。 */
    channelId: z.uuid().nullable(),
    model: z.string().trim().min(1, '请填写审核模型').max(128).nullable(),
    rules: z.string().trim().max(8000, '审核规则最多 8000 个字符'),
  })
  .refine((input) => !input.channelId || input.model, { message: '请填写审核模型', path: ['model'] });

export type ModerationListInput = z.infer<typeof moderationListInput>;
export type ModerationSettingsInput = z.infer<typeof moderationSettingsInput>;
