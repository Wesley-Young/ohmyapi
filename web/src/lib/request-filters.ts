import type { RouterInputs } from '@ohmyapi/daemon/trpc';

type RequestGroup = NonNullable<Exclude<RouterInputs['requests'], void>['group']>;
export type RequestSection = RequestGroup | 'review';
export const requestSections = { regular: '常规请求', decisions: '决策请求', review: '待核对请求' } satisfies Record<
  RequestSection,
  string
>;

export const requestRanges = { all: '全部时间', today: '今天', week: '近 7 天', custom: '自定义' } as const;
export type RequestRange = keyof typeof requestRanges;

export const emptyRequestFilters = {
  section: 'regular' as RequestSection,
  range: 'all' as RequestRange,
  start: '',
  end: '',
  model: '',
  userId: '',
  channelId: '',
  apiKeyId: '',
};
export type RequestFilters = typeof emptyRequestFilters;

export function readRequestFilters(params: URLSearchParams, platform: boolean): RequestFilters {
  const range = params.get('range');
  const group = params.get('group');
  const section = group === 'decisions' || group === 'systemone' ? 'decisions' : 'regular';
  return {
    section: platform && params.get('reviewOnly') === 'true' ? 'review' : section,
    range: range && Object.hasOwn(requestRanges, range) ? (range as RequestRange) : 'all',
    start: params.get('start') ?? '',
    end: params.get('end') ?? '',
    model: params.get('model') ?? '',
    userId: platform ? (params.get('userId') ?? '') : '',
    channelId: platform ? (params.get('channelId') ?? '') : '',
    apiKeyId: platform ? '' : (params.get('apiKeyId') ?? ''),
  };
}

export function writeRequestFilters(params: URLSearchParams, { section, ...filters }: RequestFilters) {
  const next = new URLSearchParams(params);
  if (section === 'review') next.set('reviewOnly', 'true');
  else next.delete('reviewOnly');
  if (section === 'decisions') next.set('group', section);
  else next.delete('group');
  for (const [key, value] of Object.entries(filters)) {
    if (
      !value ||
      (key === 'range' && value === 'all') ||
      ((key === 'start' || key === 'end') && filters.range !== 'custom')
    )
      next.delete(key);
    else next.set(key, value);
  }
  return next;
}

export function requestTimeBounds({ range, start, end }: RequestFilters) {
  if (range === 'all') return {};
  const from = range === 'custom' ? new Date(`${start}T00:00:00`) : new Date();
  const until = range === 'custom' ? new Date(`${end}T00:00:00`) : new Date(from);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(until.getTime()) || until < from) return undefined;
  from.setHours(0, 0, 0, 0);
  until.setHours(0, 0, 0, 0);
  if (range === 'week') from.setDate(from.getDate() - 6);
  until.setDate(until.getDate() + 1);
  return { from: from.toISOString(), until: until.toISOString() };
}
