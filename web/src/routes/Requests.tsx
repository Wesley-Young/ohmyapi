import { Badge, Box, Button, Checkbox, HStack, ProgressCircle, Stack, Table, Text } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ClipboardCheck, Eye, Gauge, Package, Pencil } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';

import { IconButton } from '../components/icon-button';
import { BillingAction, BulkZeroBilling, RequestDetail } from '../components/request-billing';
import { ErrorText, Loading, PageControls, Title } from '../components/ui';
import { useAuth } from '../lib/auth';
import { formError, localDate } from '../lib/format';
import { trpc } from '../lib/trpc';

const usageKinds = {
  input: { label: '输入', icon: ArrowDown },
  output: { label: '输出', icon: ArrowUp },
  cacheRead: { label: '缓存读', icon: Package },
  tps: { label: 'TPS', icon: Gauge },
} as const;

function UsageBadge({ kind, value }: { kind: keyof typeof usageKinds; value: string }) {
  const { label, icon: Icon } = usageKinds[kind];
  return (
    <Badge colorPalette="gray" gap="1.5" fontVariantNumeric="tabular-nums" aria-label={`${label} ${value}`}>
      <Icon size={14} strokeWidth={1.75} aria-hidden="true" focusable="false" />
      {value}
    </Badge>
  );
}

// 沿用 new-api 的耗时/吞吐分档及浅色主题状态色。
const durationColors = {
  success: 'oklch(0.596 0.145 163.225)',
  warning: 'oklch(0.681 0.162 75.834)',
  danger: 'oklch(0.577 0.245 27.325)',
};

function RequestDuration({ durationMs, output }: { durationMs: number | null; output?: string }) {
  if (durationMs === null) return <Text color="gray.500">—</Text>;
  const seconds = Math.max(0, durationMs) / 1000;
  const tokens = Number(output ?? 0);
  const throughput = seconds > 0 ? tokens / seconds : 0;
  const tone =
    tokens >= 100 && seconds > 0
      ? throughput >= 30
        ? 'success'
        : throughput >= 15
          ? 'warning'
          : 'danger'
      : seconds < 10
        ? 'success'
        : seconds < 30
          ? 'warning'
          : 'danger';
  const color = durationColors[tone];
  return (
    <HStack gap="2" whiteSpace="nowrap">
      <Box
        w="1"
        h="5"
        flexShrink="0"
        borderRadius="full"
        bg={color}
        opacity={tone === 'success' ? 0.9 : 0.8}
        aria-hidden="true"
      />
      <Text color={color} fontVariantNumeric="tabular-nums">
        {seconds.toFixed(1)}s
      </Text>
    </HStack>
  );
}

export default function Requests() {
  const { data: user } = useAuth();
  const [params] = useSearchParams();
  const [detailId, setDetailId] = useState<string | undefined>(params.get('request') ?? undefined);
  const [action, setAction] = useState<{ requestId: string; kind: 'resolve' | 'correct' }>();
  const [reviewOnly, setReviewOnly] = useState(params.get('reviewOnly') === 'true');
  const [page, setPage] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [resolvedCount, setResolvedCount] = useState(0);
  const admin = user?.role === 'admin';
  const own = useQuery(
    trpc.requests.queryOptions(
      { page },
      {
        enabled: !admin,
        refetchInterval: 5000,
      },
    ),
  );
  const all = useQuery(
    trpc.admin.requests.queryOptions(
      { page, reviewOnly },
      {
        enabled: admin,
        refetchInterval: 5000,
      },
    ),
  );
  const data = admin ? all : own;
  const selectable = data.data?.items.filter((r) => r.billingEnabled && r.status === 'needs_review') ?? [];
  const pageIds = selectable.map((r) => r.id);
  const selectedOnPage = pageIds.filter((id) => selectedIds.includes(id)).length;
  return (
    <Stack gap="7">
      <Title
        action={
          <Button size="sm" variant="outline" loading={data.isFetching} onClick={() => void data.refetch()}>
            刷新
          </Button>
        }
      >
        请求记录
      </Title>
      {admin && (
        <HStack flexWrap="wrap">
          <Button
            size="sm"
            variant={reviewOnly ? 'outline' : 'solid'}
            onClick={() => {
              setReviewOnly(false);
              setPage(0);
              setSelectedIds([]);
            }}
          >
            全部请求
          </Button>
          <Button
            size="sm"
            variant={reviewOnly ? 'solid' : 'outline'}
            onClick={() => {
              setReviewOnly(true);
              setPage(0);
              setSelectedIds([]);
            }}
          >
            待核对
          </Button>
        </HStack>
      )}
      {admin && reviewOnly && (
        <HStack gap="3" flexWrap="wrap">
          <Text fontSize="sm" color="gray.600">
            已选 {selectedIds.length} / 100
          </Text>
          <BulkZeroBilling
            key={user.id}
            requestIds={selectedIds}
            onSuccess={(count) => {
              setSelectedIds([]);
              setResolvedCount(count);
            }}
          />
          {selectedIds.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setSelectedIds([])}>
              清空选择
            </Button>
          )}
          {resolvedCount > 0 && (
            <Text fontSize="sm" color="gray.600" role="status">
              已将 {resolvedCount} 个请求按 0 结算
            </Text>
          )}
        </HStack>
      )}
      {detailId && <RequestDetail requestId={detailId} close={() => setDetailId(undefined)} />}
      {action && <BillingAction requestId={action.requestId} kind={action.kind} close={() => setAction(undefined)} />}
      <ErrorText>{formError(data.error)?.message}</ErrorText>
      {data.isPending ? (
        <Loading />
      ) : (
        data.data && (
          <>
            <Box overflowX="auto">
              <Table.Root size="sm">
                <Table.Header>
                  <Table.Row>
                    {admin && reviewOnly && (
                      <Table.ColumnHeader width="10">
                        <Checkbox.Root
                          checked={
                            pageIds.length > 0 && selectedOnPage === pageIds.length
                              ? true
                              : selectedOnPage > 0
                                ? 'indeterminate'
                                : false
                          }
                          disabled={
                            !pageIds.length ||
                            (selectedOnPage < pageIds.length &&
                              selectedIds.length + pageIds.length - selectedOnPage > 100)
                          }
                          onCheckedChange={(event) => {
                            setResolvedCount(0);
                            setSelectedIds((ids) =>
                              event.checked === true
                                ? [...new Set([...ids, ...pageIds])].slice(0, 100)
                                : ids.filter((id) => !pageIds.includes(id)),
                            );
                          }}
                        >
                          <Checkbox.HiddenInput aria-label="选择当前页的待核对请求" />
                          <Checkbox.Control />
                        </Checkbox.Root>
                      </Table.ColumnHeader>
                    )}
                    {[
                      '时间',
                      '渠道',
                      ...(admin ? ['用户'] : []),
                      '模型',
                      'Token 用量',
                      '耗时',
                      `扣费/冻结（${data.data.currency}）`,
                      '操作',
                    ].map((h) => (
                      <Table.ColumnHeader key={h}>{h}</Table.ColumnHeader>
                    ))}
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {data.data.items.map((r) => (
                    <Table.Row key={r.id}>
                      {admin && reviewOnly && (
                        <Table.Cell>
                          <Checkbox.Root
                            checked={selectedIds.includes(r.id)}
                            disabled={
                              !selectedIds.includes(r.id) &&
                              (!r.billingEnabled || r.status !== 'needs_review' || selectedIds.length >= 100)
                            }
                            onCheckedChange={(event) => {
                              setResolvedCount(0);
                              setSelectedIds((ids) =>
                                event.checked === true
                                  ? [...new Set([...ids, r.id])].slice(0, 100)
                                  : ids.filter((id) => id !== r.id),
                              );
                            }}
                          >
                            <Checkbox.HiddenInput aria-label={`选择请求 ${r.id}`} />
                            <Checkbox.Control />
                          </Checkbox.Root>
                        </Table.Cell>
                      )}
                      <Table.Cell>{localDate(r.receivedAt)}</Table.Cell>
                      <Table.Cell minW="140px" maxW="240px">
                        <Stack gap="2">
                          <Text overflowWrap="anywhere">{r.channelName ?? r.channelId ?? '—'}</Text>
                          <HStack gap="2" flexWrap="wrap">
                            {r.channelType && (
                              <Badge>
                                {{ api: 'API 渠道', subscription: '订阅渠道', aggregate: '聚合渠道' }[r.channelType]}
                              </Badge>
                            )}
                            {admin &&
                              r.executionChannels
                                .filter((channel) => channel.channelId !== r.channelId)
                                .map((channel) => (
                                  <Badge key={channel.id} whiteSpace="normal" overflowWrap="anywhere">
                                    执行：{channel.channelName}
                                  </Badge>
                                ))}
                          </HStack>
                        </Stack>
                      </Table.Cell>
                      {admin && <Table.Cell>{r.username}</Table.Cell>}
                      <Table.Cell>{r.model}</Table.Cell>
                      <Table.Cell minW="220px" maxW="320px">
                        {r.status === 'forwarding' ? (
                          <ProgressCircle.Root value={null} size="xs" colorPalette="gray" minH="12" alignItems="center">
                            <ProgressCircle.Label srOnly>请求正在转发</ProgressCircle.Label>
                            <ProgressCircle.Circle
                              css={{ '--size': '20px', '--thickness': '2px' }}
                              _motionReduce={{ animation: 'none' }}
                            >
                              <ProgressCircle.Track stroke="gray.200" />
                              <ProgressCircle.Range
                                stroke="gray.700"
                                _motionReduce={{ animation: 'none', strokeDasharray: '40, 100' }}
                              />
                            </ProgressCircle.Circle>
                          </ProgressCircle.Root>
                        ) : r.usage ? (
                          <Stack gap="2">
                            <HStack gap="2" flexWrap="wrap">
                              <UsageBadge kind="input" value={r.usage.input} />
                              <UsageBadge kind="output" value={r.usage.output} />
                              {r.usageEstimate && <Badge colorPalette="orange">估算</Badge>}
                            </HStack>
                            <HStack gap="2" flexWrap="wrap">
                              <UsageBadge kind="cacheRead" value={r.usage.cacheRead ?? '未知'} />
                              {r.durationMs !== null && r.durationMs > 0 && (
                                <UsageBadge
                                  kind="tps"
                                  value={`${Math.round((parseInt(r.usage.output, 10) / r.durationMs) * 1000)} tps`}
                                />
                              )}
                            </HStack>
                          </Stack>
                        ) : (
                          '—'
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <RequestDuration durationMs={r.durationMs} output={r.usage?.output} />
                      </Table.Cell>
                      <Table.Cell>{r.chargedAmount || r.heldAmount}</Table.Cell>
                      <Table.Cell>
                        <HStack gap="1">
                          <IconButton aria-label="查看详情" size="sm" variant="ghost" onClick={() => setDetailId(r.id)}>
                            <Eye size={16} aria-hidden="true" />
                          </IconButton>
                          {admin && r.billingEnabled && r.status === 'needs_review' && (
                            <IconButton
                              aria-label="核对费用"
                              size="sm"
                              variant="ghost"
                              onClick={() => setAction({ requestId: r.id, kind: 'resolve' })}
                            >
                              <ClipboardCheck size={16} aria-hidden="true" />
                            </IconButton>
                          )}
                          {admin && r.billingEnabled && r.status === 'settled' && (
                            <IconButton
                              aria-label="修正费用"
                              size="sm"
                              variant="ghost"
                              onClick={() => setAction({ requestId: r.id, kind: 'correct' })}
                            >
                              <Pencil size={16} aria-hidden="true" />
                            </IconButton>
                          )}
                        </HStack>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Box>
            {!data.data.items.length && (
              <Text fontSize="sm" color="gray.500">
                暂无请求
              </Text>
            )}
            <PageControls page={page} hasMore={data.data.hasMore} onPage={setPage} />
          </>
        )
      )}
    </Stack>
  );
}
