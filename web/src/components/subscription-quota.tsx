import { Box, Button, HStack, Progress, Stack, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useMutation, useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { queryClient, trpc } from '../lib/trpc';
import { IconButton, Tooltip } from './icon-button';
import { SubscriptionCycleDialog, subscriptionCycleQuery, usd } from './subscription-cycle';

type Quota = RouterOutputs['admin']['catalog']['openAIQuota'];

/** 额度与套餐共用同一个查询，组件各自订阅时不会重复请求。 */
export function subscriptionQuotaQuery(provider: 'openai' | 'claude', channelId: string, enabled: boolean) {
  const endpoint = provider === 'claude' ? trpc.admin.catalog.claudeQuota : trpc.admin.catalog.openAIQuota;
  return endpoint.queryOptions({ channelId }, { enabled, staleTime: 60_000, refetchInterval: 60_000, retry: false });
}

function QuotaWindow({
  label,
  window,
  unavailable,
  extra,
}: {
  label: '5h' | '7d';
  window: Quota['fiveHour'];
  unavailable: string;
  extra?: ReactNode;
}) {
  const used = window?.usedPercent;
  const color = used != null && used >= 90 ? '#ef4444' : used != null && used >= 75 ? '#f59e0b' : '#22c55e';
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
    ? `${label} 已用 ${percent}，${window.resetsAt ? `${new Date(window.resetsAt).toLocaleString()} 重置` : '重置时间未知'}`
    : `${label}：${unavailable}`;
  return (
    <HStack gap="2">
      <Tooltip content={description}>
        <HStack gap="2" tabIndex={0} aria-label={description}>
          <Text fontSize="xs" color="gray.500" w="5" flexShrink={0}>
            {label}
          </Text>
          <Text
            fontSize="xs"
            color={used != null && used >= 75 ? color : 'gray.500'}
            w="10"
            flexShrink={0}
            textAlign="right"
            fontVariantNumeric="tabular-nums"
          >
            {percent}
          </Text>
          {used == null ? (
            <Box w="20" h="1.5" bg="gray.100" borderRadius="full" />
          ) : (
            <Progress.Root value={Math.min(used, 100)} w="20" aria-label={`${label} 已用额度`}>
              <Progress.Track h="1.5" bg="gray.100" borderRadius="full">
                <Progress.Range bg={color} borderRadius="full" />
              </Progress.Track>
            </Progress.Root>
          )}
          <Text fontSize="xs" color="gray.500" minW="12" whiteSpace="nowrap" fontVariantNumeric="tabular-nums">
            {resetCountdown}
          </Text>
        </HStack>
      </Tooltip>
      {extra}
    </HStack>
  );
}

export function SubscriptionQuota({
  provider,
  channelId,
  enabled,
  reauthorizationRequired,
}: {
  provider: 'openai' | 'claude';
  channelId: string;
  enabled: boolean;
  reauthorizationRequired: boolean;
}) {
  const canFetch = enabled && !reauthorizationRequired;
  const quotaEndpoint = provider === 'claude' ? trpc.admin.catalog.claudeQuota : trpc.admin.catalog.openAIQuota;
  const refreshEndpoint =
    provider === 'claude' ? trpc.admin.catalog.refreshClaudeQuota : trpc.admin.catalog.refreshOpenAIQuota;
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
  return (
    <Stack gap="1.5" w="fit-content" aria-busy={canFetch && (query.isFetching || refresh.isPending)}>
      <HStack gap="2">
        <Stack gap="1.5">
          <QuotaWindow label="5h" window={data?.fiveHour ?? null} unavailable={unavailable} />
          <QuotaWindow
            label="7d"
            window={data?.sevenDay ?? null}
            unavailable={unavailable}
            extra={
              cycle.data && data?.sevenDay ? (
                <Button
                  variant="ghost"
                  size="2xs"
                  px="1"
                  fontSize="xs"
                  fontWeight="500"
                  color="gray.700"
                  fontVariantNumeric="tabular-nums"
                  aria-label={`本周期等效 API 费用约 ${usd(cycle.data.amount)}，查看明细`}
                  title={
                    cycle.data.projectedAmount !== null
                      ? `本周期等效 API 费用（估算），整个周期约 ${usd(cycle.data.projectedAmount)}`
                      : '本周期等效 API 费用（估算）'
                  }
                  onClick={() => setShowingCycle(true)}
                >
                  ≈ {usd(cycle.data.amount)}
                </Button>
              ) : undefined
            }
          />
        </Stack>
        <IconButton
          aria-label="刷新额度"
          title={!enabled ? '渠道已禁用' : reauthorizationRequired ? '需要重新授权' : '刷新额度'}
          variant="ghost"
          size="xs"
          color="gray.500"
          disabled={!canFetch || query.isFetching || refresh.isPending}
          loading={refresh.isPending}
          onClick={() => refresh.mutate({ channelId })}
        >
          <RefreshCw size={14} aria-hidden="true" />
        </IconButton>
      </HStack>
      {showingCycle && <SubscriptionCycleDialog channelId={channelId} onClose={() => setShowingCycle(false)} />}
      {canFetch && (query.isError || refreshFailed) && (
        <Text fontSize="xs" color="gray.500" role="status">
          {refreshFailed ? '刷新失败，请重试' : '获取失败'}
        </Text>
      )}
    </Stack>
  );
}
