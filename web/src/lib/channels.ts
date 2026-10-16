import type { RouterOutputs } from '@ohmyapi/daemon/trpc';

/** 渠道类型，与后端定义保持一致。 */
export type ChannelType = RouterOutputs['admin']['catalog']['list']['channels'][number]['type'];

export const channelTypeLabels = {
  api: 'API 渠道',
  subscription: '订阅渠道',
  aggregate: '聚合渠道',
} satisfies Record<ChannelType, string>;
