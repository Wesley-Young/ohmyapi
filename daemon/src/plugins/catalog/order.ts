import type { channels } from '../database/schema/index.ts';

const channelTypeOrder = {
  aggregate: 0,
  api: 1,
  subscription: 2,
} satisfies Record<(typeof channels.$inferSelect)['type'], number>;

type OrderedChannel = {
  id: string;
  name: string;
  type: keyof typeof channelTypeOrder;
  enabled: boolean;
  subscription?: { errorCode: string | null } | null;
};

/** 渠道列表的统一排序：需要重新授权的渠道在前，其次启用优先、按类型分组，名称按自然顺序排列。 */
export function compareChannels(a: OrderedChannel, b: OrderedChannel) {
  return (
    Number(!a.subscription?.errorCode) - Number(!b.subscription?.errorCode) ||
    Number(b.enabled) - Number(a.enabled) ||
    channelTypeOrder[a.type] - channelTypeOrder[b.type] ||
    a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) ||
    a.id.localeCompare(b.id)
  );
}
