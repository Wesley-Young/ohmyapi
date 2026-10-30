import type { RouterOutputs } from '@ohmyapi/daemon/trpc';

type ModerationItem = RouterOutputs['admin']['moderation']['list']['items'][number];
export type ModerationVerdict = NonNullable<ModerationItem['verdict']>;
export type ModerationCategory = NonNullable<ModerationItem['category']>;
export type ModerationStatus = ModerationItem['status'];
export type ModerationReason = ModerationItem['reason'];

export const verdictLabels = {
  pass: '通过',
  suspect: '疑似',
  violation: '违规',
} satisfies Record<ModerationVerdict, string>;

export const verdictColors = {
  pass: 'green',
  suspect: 'yellow',
  violation: 'red',
} satisfies Record<ModerationVerdict, string>;

export const categoryLabels = {
  cyber_attack: '网络攻击',
  violence: '暴力',
  fraud: '欺诈',
  harassment_hate: '骚扰与仇恨',
  jailbreak: '越狱',
  none: '无',
} satisfies Record<ModerationCategory, string>;

export const statusLabels = {
  pending: '排队中',
  running: '审核中',
  done: '已审核',
  failed: '审核失败',
} satisfies Record<ModerationStatus, string>;

export const reasonLabels = {
  rate: '比例抽样',
  floor: '保底抽样',
} satisfies Record<ModerationReason, string>;

export const severityLabels = ['无', '轻微', '明确', '严重'] as const;

/** 抽样比例以百万分之一保存，界面以百分比显示，最多四位小数。 */
export const ppmToPercent = (ppm: number) => String(Number((ppm / 10_000).toFixed(4)));

export function percentToPpm(value: string) {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,4})?$/.test(trimmed)) return undefined;
  const ppm = Math.round(Number(trimmed) * 10_000);
  return ppm <= 1_000_000 ? ppm : undefined;
}
