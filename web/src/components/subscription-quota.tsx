import { Button, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useMutation, useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { formatUsd, localDateTime } from '../lib/format';
import type { SubscriptionProvider } from '../lib/subscription';
import { queryClient, trpc } from '../lib/trpc';
import { IconButton, Tooltip } from './icon-button';
import { SubscriptionCycleDialog, subscriptionCycleQuery } from './subscription-cycle';
import { Metric } from './ui';

type Quota = RouterOutputs['admin']['catalog']['openAIQuota'];

// Antigravity 以 Gemini 额度池作为账号额度，结构与其他平台一致；周期详情中有说明。
const quotaEndpoints = {
  openai: { query: trpc.admin.catalog.openAIQuota, refresh: trpc.admin.catalog.refreshOpenAIQuota },
  claude: { query: trpc.admin.catalog.claudeQuota, refresh: trpc.admin.catalog.refreshClaudeQuota },
  antigravity: { query: trpc.admin.catalog.antigravityQuota, refresh: trpc.admin.catalog.refreshAntigravityQuota },
} satisfies Record<SubscriptionProvider, unknown>;

/** 额度与套餐共用同一个查询，组件各自订阅时不会重复请求。 */
export function subscriptionQuotaQuery(provider: SubscriptionProvider, channelId: string, enabled: boolean) {
  return quotaEndpoints[provider].query.queryOptions(
    { channelId },
    { enabled, staleTime: 60_000, refetchInterval: 60_000, retry: false },
  );
}

const usageColor = (used: number | null | undefined) =>
  used != null && used >= 90 ? '#ef4444' : used != null && used >= 75 ? '#f59e0b' : '#22c55e';

function QuotaWindow({
  label,
  window,
  unavailable,
  extra,
  children,
}: {
  label: '5h' | '7d';
  window: Quota['fiveHour'];
  unavailable: string;
  extra?: ReactNode;
  children?: ReactNode;
}) {
  const used = window?.usedPercent;
  const color = usageColor(used);
  const percent = used == null ? '—' : used > 999 ? '>999%' : `${Math.round(used)}%`;
  const resetAt = window?.resetsAt ? new Date(window.resetsAt).getTime() : Number.NaN;
  const minutesUntilReset = Math.max(0, Math.floor((resetAt - Date.now()) / 60_000));
  const hoursUntilReset = Math.floor(minutesUntilReset / 60);
  const resetCountdown = Number.isFinite(resetAt)
    ? label === '5h'
      ? `${hoursUntilReset}h ${minutesUntilReset % 60}m`
      : `${Math.floor(hoursUntilReset / 24)}d ${hoursUntilReset % 24}h`
    : '';
  const description = window
    ? `${label} 已用 ${percent}，${window.resetsAt ? `${localDateTime(window.resetsAt)} 重置` : '重置时间未知'}`
    : `${label}：${unavailable}`;
  return (
    <Metric
      label={label}
      extra={
        <>
          {resetCountdown && (
            <Text color="gray.400" fontVariantNumeric="tabular-nums">
              {resetCountdown}
            </Text>
          )}
          {extra}
        </>
      }
      meter={{ value: used ?? null, color, label: `${label} 已用额度` }}
    >
      <Tooltip content={description}>
        <Text
          tabIndex={0}
          aria-label={description}
          color={used == null ? 'gray.400' : used >= 75 ? color : undefined}
          borderRadius="sm"
        >
          {percent}
        </Text>
      </Tooltip>
      {children}
    </Metric>
  );
}

/** 5h 和 7d 两个额度指标格，放在渠道卡片的指标网格中。 */
export function SubscriptionQuota({
  provider,
  channelId,
  enabled,
  reauthorizationRequired,
}: {
  provider: SubscriptionProvider;
  channelId: string;
  enabled: boolean;
  reauthorizationRequired: boolean;
}) {
  const canFetch = enabled && !reauthorizationRequired;
  const { query: quotaEndpoint, refresh: refreshEndpoint } = quotaEndpoints[provider];
  const quotaKey = quotaEndpoint.queryKey({ channelId });
  const refresh = useMutation(
    refreshEndpoint.mutationOptions({
      onMutate: () => queryClient.cancelQueries({ queryKey: quotaKey, exact: true }),
      onSuccess: async (quota) => {
        queryClient.setQueryData(quotaKey, quota);
        await queryClient.invalidateQueries(trpc.admin.catalog.subscriptionCycleUsage.queryFilter({ channelId }));
      },
    }),
  );
  const query = useQuery(subscriptionQuotaQuery(provider, channelId, canFetch && !refresh.isPending));
  const refreshFailed = refresh.isError && refresh.submittedAt > query.dataUpdatedAt;
  const data = canFetch && !query.isError ? query.data : undefined;
  const [showingCycle, setShowingCycle] = useState(false);
  // 周期起点依赖上游 7d 重置时间，额度就绪后再估算费用。
  const cycle = useQuery(subscriptionCycleQuery(channelId, !!data?.sevenDay && !refresh.isPending));
  const unavailable = !enabled
    ? '渠道已禁用'
    : reauthorizationRequired
      ? '需要重新授权'
      : query.isError
        ? '额度获取失败，将自动重试'
        : query.isPending
          ? '正在获取额度'
          : '上游未提供此窗口额度';
  const failed = canFetch && (query.isError || refreshFailed);
  const refreshTitle = !enabled
    ? '渠道已禁用'
    : reauthorizationRequired
      ? '需要重新授权'
      : refreshFailed
        ? '刷新失败，点击重试'
        : query.isError
          ? '额度获取失败，点击重试'
          : '刷新额度';
  return (
    <>
      <QuotaWindow
        label="5h"
        window={data?.fiveHour ?? null}
        unavailable={unavailable}
        extra={
          <IconButton
            aria-label={refreshTitle}
            title={refreshTitle}
            variant="ghost"
            size="2xs"
            minW="5"
            h="5"
            ms="auto"
            color={failed ? 'red.600' : 'gray.500'}
            disabled={!canFetch || query.isFetching || refresh.isPending}
            loading={refresh.isPending}
            onClick={() => refresh.mutate({ channelId })}
          >
            <RefreshCw size={12} aria-hidden="true" />
          </IconButton>
        }
      />
      <QuotaWindow label="7d" window={data?.sevenDay ?? null} unavailable={unavailable}>
        {cycle.data && data?.sevenDay && (
          <Button
            variant="ghost"
            size="2xs"
            h="5"
            px="1"
            fontSize="xs"
            fontWeight="500"
            color="gray.600"
            fontVariantNumeric="tabular-nums"
            aria-label={`本周期等效 API 费用约 ${formatUsd(cycle.data.amount)}，查看明细`}
            title={
              cycle.data.projectedAmount !== null
                ? `本周期等效 API 费用（估算），整个周期约 ${formatUsd(cycle.data.projectedAmount)}`
                : '本周期等效 API 费用（估算）'
            }
            onClick={() => setShowingCycle(true)}
          >
            ≈ {formatUsd(cycle.data.amount)}
          </Button>
        )}
      </QuotaWindow>
      {showingCycle && <SubscriptionCycleDialog channelId={channelId} onClose={() => setShowingCycle(false)} />}
    </>
  );
}
