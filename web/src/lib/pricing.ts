import type { RouterOutputs } from '@ohmyapi/daemon/trpc';

/** 定价规则的编辑模型、类型名称与时段换算。 */
export type Rule = Omit<RouterOutputs['admin']['pricing']['list']['rules'][number], 'id'>;
export type SearchDefaults = RouterOutputs['admin']['pricing']['list']['searchDefaults'];
export const kinds = { default: '默认', context: '上下文', time: '时段', combined: '上下文与时段' };
export const defaultRule: Rule = {
  label: '默认价格',
  kind: 'default',
  contextMin: null,
  contextMax: null,
  weekdaysMask: null,
  startMinute: null,
  endMinute: null,
  inputPrice: '0',
  outputPrice: '0',
  cacheReadPrice: null,
  cacheWritePrice: null,
  webSearchPrice: null,
  webSearchPreviewPrice: null,
};
export const minuteText = (minute: number | null) =>
  minute === null ? '' : `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
export const minuteValue = (value: string) => (value ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null);
export const dayNames = ['一', '二', '三', '四', '五', '六', '日'];
