import type { RouterOutputs } from '@ohmyapi/daemon/trpc';

import { formatCount } from './format';

export type RequestItem =
  | RouterOutputs['requests']['items'][number]
  | RouterOutputs['admin']['requests']['items'][number];
export const requestMetricColumns = [
  { key: 'input', label: '输入', group: 'tokens' },
  { key: 'output', label: '输出', group: 'tokens' },
  { key: 'cache', label: '缓存读', group: 'throughput' },
  { key: 'rate', label: 'TPS', group: 'throughput' },
  { key: 'first', label: '首字（s）', group: 'first' },
  { key: 'total', label: '耗时（s）', group: 'total' },
] as const;

/** 流式请求使用网关测量值，旧的非流式记录按输出量和总耗时计算。 */
function outputRate(r: RequestItem) {
  if (r.outputTps !== null) return r.outputTps;
  if (r.streaming || r.ttftMs !== null || !r.usage || r.durationMs === null || r.durationMs <= 0) return undefined;
  return (Number(r.usage.outputTokens) / r.durationMs) * 1000;
}

function totalTone(seconds: number, tokens: number) {
  if (tokens < 100 || seconds <= 0) return seconds < 10 ? 'green.700' : seconds < 30 ? 'yellow.700' : 'red.600';
  const throughput = tokens / seconds;
  return throughput >= 30 ? 'green.700' : throughput >= 15 ? 'yellow.700' : 'red.600';
}

export function requestMetrics(r: RequestItem) {
  const usage = r.status === 'forwarding' ? null : r.usage;
  const rate = usage ? outputRate(r) : undefined;
  const first = r.ttftMs === null ? null : r.ttftMs / 1000;
  const total = r.durationMs === null ? null : Math.max(0, r.durationMs) / 1000;
  return {
    input: { value: usage ? formatCount(BigInt(usage.inputTokens) + BigInt(usage.cacheWriteTokens)) : '—' },
    output: { value: usage ? formatCount(usage.outputTokens) : '—' },
    cache: { value: usage ? (usage.cacheReadTokens === null ? '未知' : formatCount(usage.cacheReadTokens)) : '—' },
    rate: { value: rate === undefined ? '—' : formatCount(Math.round(rate)) },
    first: {
      value: first?.toFixed(1) ?? '—',
      color: first === null ? 'gray.500' : first < 5 ? 'green.700' : first < 10 ? 'yellow.700' : 'red.600',
    },
    total: {
      value: total?.toFixed(1) ?? '—',
      color: total === null ? 'gray.500' : totalTone(total, Number(r.usage?.outputTokens ?? 0)),
    },
  };
}

export function requestOwner(r: RequestItem, platform: boolean) {
  return (platform ? r.username : 'apiKeyName' in r ? r.apiKeyName : null) ?? '—';
}
