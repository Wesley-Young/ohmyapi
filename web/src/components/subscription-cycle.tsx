import { Badge, Box, Button, HStack, Stack, Table, Text } from '@chakra-ui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { dateTimeInput, formError, localDate } from '../lib/format';
import { queryClient, trpc } from '../lib/trpc';
import { ErrorText, FormDialog, FormInput, Loading, PrimaryButton } from './ui';

/** 等效 API 费用固定以美元展示。 */
export function usd(amount: string) {
  const value = Number(amount);
  if (value > 0 && value < 0.005) return '<$0.01';
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function subscriptionCycleQuery(channelId: string, enabled: boolean) {
  return trpc.admin.catalog.subscriptionCycleUsage.queryOptions(
    { channelId },
    { enabled, staleTime: 60_000, refetchInterval: 60_000, retry: false },
  );
}

const sources = { upstream: '按上游重置时间', manual: '管理员填写', rolling: '最近 7 天' } as const;
const count = (value: string | number) => BigInt(value).toLocaleString('zh-CN');
const tokenColumns = [
  ['inputTokens', '输入'],
  ['outputTokens', '输出'],
  ['cacheReadTokens', '缓存读'],
  ['cacheWriteTokens', '缓存写'],
] as const;

function ManualReset({ channelId, value, active }: { channelId: string; value: string | null; active: boolean }) {
  const [input, setInput] = useState(dateTimeInput(value));
  const [localError, setLocalError] = useState<string>();
  const save = useMutation(
    trpc.admin.catalog.setSubscriptionCycleReset.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries(trpc.admin.catalog.subscriptionCycleUsage.queryFilter({ channelId })),
    }),
  );
  const submit = (resetAt: string | null) => {
    setLocalError(undefined);
    save.mutate({ channelId, resetAt });
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const date = new Date(input);
        if (!input || !Number.isFinite(date.getTime())) return setLocalError('请输入有效的日期和时间');
        if (date.getTime() > Date.now()) return setLocalError('重置时刻不能晚于当前时间');
        submit(date.toISOString());
      }}
    >
      <Stack gap="3">
        <FormInput
          label="上次重置时刻"
          type="datetime-local"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          error={localError}
          helper={
            value && !active ? '已填写的时刻不在当前上游周期内，未生效' : '续费等导致提前重置时填写，仅在当前周期内生效'
          }
        />
        <ErrorText>{formError(save.error)?.message}</ErrorText>
        <HStack>
          <PrimaryButton type="submit" size="sm" loading={save.isPending && save.variables?.resetAt !== null}>
            保存
          </PrimaryButton>
          {value && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={save.isPending}
              loading={save.isPending && save.variables?.resetAt === null}
              onClick={() => {
                setInput('');
                submit(null);
              }}
            >
              清除
            </Button>
          )}
        </HStack>
      </Stack>
    </form>
  );
}

export function SubscriptionCycleDialog({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const query = useQuery(subscriptionCycleQuery(channelId, true));
  const data = query.data;
  return (
    <FormDialog open title="本周期等效 API 费用" onClose={onClose} size="xl">
      {query.isPending ? (
        <Loading />
      ) : !data ? (
        <ErrorText>{formError(query.error)?.message ?? '获取失败'}</ErrorText>
      ) : (
        <Stack gap="6">
          <Stack gap="2">
            <HStack gap="3" align="baseline" flexWrap="wrap">
              <Text fontSize="2xl" fontWeight="600" fontVariantNumeric="tabular-nums">
                {usd(data.amount)}
              </Text>
              <Text fontSize="sm" color="gray.500">
                {count(data.requests)} 个请求
              </Text>
            </HStack>
            {data.usedPercent !== null && (
              <Text fontSize="sm" color="gray.600">
                {data.projectedAmount !== null
                  ? `按已用 ${Math.round(data.usedPercent)}% 推算，整个周期约 ${usd(data.projectedAmount)}`
                  : '已用不足 5%，暂不推算整个周期的额度'}
              </Text>
            )}
            <HStack gap="2" flexWrap="wrap">
              <Badge colorPalette="gray">{sources[data.source]}</Badge>
              <Badge colorPalette="gray">
                {localDate(data.startsAt)} – {data.resetsAt ? localDate(data.resetsAt) : '现在'}
              </Badge>
            </HStack>
            <ErrorText>{formError(query.error)?.message}</ErrorText>
          </Stack>
          {(data.fallback.requests > 0 || data.unconfirmed.requests > 0 || data.unpricedRequests > 0) && (
            <Stack gap="1" fontSize="sm" color="gray.600">
              {data.fallback.requests > 0 && (
                <Text>
                  其中 {usd(data.fallback.amount)}（{count(data.fallback.requests)}{' '}
                  个请求）的价格规则已变更，按默认规则估算
                </Text>
              )}
              {data.unconfirmed.requests > 0 && (
                <Text>
                  其中 {usd(data.unconfirmed.amount)}（{count(data.unconfirmed.requests)} 个请求）的用量尚未最终确认
                </Text>
              )}
              {data.unpricedRequests > 0 && (
                <Text>{count(data.unpricedRequests)} 个请求的部分用量缺少单价，未计入</Text>
              )}
            </Stack>
          )}
          {data.models.length ? (
            <Box overflowX="auto">
              <Table.Root size="sm" aria-label="按模型统计">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>模型</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="end">请求</Table.ColumnHeader>
                    {tokenColumns.map(([key, label]) => (
                      <Table.ColumnHeader key={key} textAlign="end" whiteSpace="nowrap">
                        {label}
                      </Table.ColumnHeader>
                    ))}
                    <Table.ColumnHeader textAlign="end">金额</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {data.models.map((row) => (
                    <Table.Row key={row.modelId ?? 'unknown'}>
                      <Table.Cell color={row.name ? undefined : 'gray.500'} overflowWrap="anywhere">
                        {row.name ?? '未识别模型'}
                      </Table.Cell>
                      {[
                        ['requests', count(row.requests)],
                        ...tokenColumns.map(([key]) => [key, count(row[key])]),
                        ['amount', usd(row.amount)],
                      ].map(([key, value]) => (
                        <Table.Cell key={key} textAlign="end" whiteSpace="nowrap" fontVariantNumeric="tabular-nums">
                          {value}
                        </Table.Cell>
                      ))}
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Box>
          ) : (
            <Text fontSize="sm" color="gray.500">
              本周期暂无请求
            </Text>
          )}
          {data.provider === 'claude' && (
            <ManualReset
              key={data.manualResetAt ?? ''}
              channelId={channelId}
              value={data.manualResetAt}
              active={data.manualResetActive}
            />
          )}
        </Stack>
      )}
    </FormDialog>
  );
}
