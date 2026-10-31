import type { RouterOutputs } from '@ohmyapi/daemon/trpc';

/** 渠道类型，与后端定义保持一致。 */
export type ChannelType = RouterOutputs['admin']['catalog']['list']['channels'][number]['type'];

export const channelTypeLabels = {
  api: 'API 渠道',
  subscription: '订阅渠道',
  aggregate: '聚合渠道',
} satisfies Record<ChannelType, string>;

type Channel = RouterOutputs['admin']['catalog']['list']['channels'][number];

export const coolingDown = (until: string | null) => !!until && Date.parse(until) > Date.now();

/** 渠道的健康状态，以类型图标上的状态点表示。 */
export function channelStatus(c: Channel): { color: string; label: string } {
  if (!c.enabled) return { color: 'gray.300', label: '已禁用' };
  const sub = c.subscription;
  if (sub?.errorCode)
    return {
      color: 'red.500',
      label: sub.errorCode === 'subscription_refresh_uncertain' ? '需重新导入凭据' : '需要重新授权',
    };
  if (sub && (coolingDown(sub.cooldownUntil) || Object.values(sub.modelCooldowns).some(coolingDown)))
    return { color: 'orange.400', label: '冷却中' };
  return { color: 'green.500', label: '已启用' };
}
