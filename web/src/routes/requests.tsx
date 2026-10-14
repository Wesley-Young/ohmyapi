import { Badge, Box, Button, Checkbox, HStack, ProgressCircle, Stack, Table, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Brain, ClipboardCheck, Eye, Gauge, Package, Pencil } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';

import { BillingAction, BulkZeroBilling } from '../components/billing-review';
import { IconButton } from '../components/icon-button';
import { RequestDetail } from '../components/request-detail';
import { useReviewCount } from '../components/review-badge';
import { ErrorText, Loading, PageControls, Title } from '../components/ui';
import { useAuth } from '../lib/auth';
import { formError, localDate } from '../lib/format';
import { trpc } from '../lib/trpc';

const usageKinds = {
  input: { label: '输入', icon: ArrowDown },
  output: { label: '输出', icon: ArrowUp },
  cacheRead: { label: '缓存读', icon: Package },
  tps: { label: 'TPS', icon: Gauge },
  effort: { label: '推理强度', icon: Brain },
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

type RequestItem = RouterOutputs['requests']['items'][number];

// 表格横向滚动时操作列固定在右侧；只设左边框颜色，保留行分隔线。
const pinnedColumn = {
  position: 'sticky',
  right: '0',
  zIndex: '1',
  bg: 'white',
  borderLeftWidth: '1px',
  borderLeftColor: 'gray.100',
} as const;

/** 网关测量的输出速度；流式请求只统计首个内容之后的生成阶段。 */
function outputRate(r: RequestItem) {
  if (r.outputTps !== null) return r.outputTps;
  // 有 TTFT 但没有速度时，网关判断生成窗口过短，不再回退到总耗时估算。
  if (r.ttftMs !== null || !r.usage || r.durationMs === null || r.durationMs <= 0) return undefined;
  // 旧记录没有测量值，沿用输出 ÷ 总耗时。
  return (Number(r.usage.outputTokens) / r.durationMs) * 1000;
}

function RateBadge({ request }: { request: RequestItem }) {
  const rate = outputRate(request);
  return rate === undefined ? null : <UsageBadge kind="tps" value={`${Math.round(rate)} tps`} />;
}

type Tone = keyof typeof durationColors;

const firstTokenTone = (seconds: number): Tone => (seconds < 5 ? 'success' : seconds < 10 ? 'warning' : 'danger');

// 输出足够多时按输出 ÷ 总耗时判断，否则按总耗时判断。
function totalTone(seconds: number, tokens: number): Tone {
  if (tokens < 100 || seconds <= 0) return seconds < 10 ? 'success' : seconds < 30 ? 'warning' : 'danger';
  const throughput = tokens / seconds;
  return throughput >= 30 ? 'success' : throughput >= 15 ? 'warning' : 'danger';
}

function formatSeconds(seconds: number) {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(0)}s`;
}

function RequestDuration({ request: r }: { request: RequestItem }) {
  if (r.durationMs === null) return <Text color="gray.500">—</Text>;
  const seconds = Math.max(0, r.durationMs) / 1000;
  const rows = [
    ...(r.ttftMs !== null ? [{ label: '首字', seconds: r.ttftMs / 1000, tone: firstTokenTone(r.ttftMs / 1000) }] : []),
    { label: '耗时', seconds, tone: totalTone(seconds, Number(r.usage?.outputTokens ?? 0)) },
  ];
  return (
    <HStack gap="2" align="stretch" whiteSpace="nowrap">
      <Stack gap="0" w="1" minH="5" flexShrink="0" borderRadius="full" overflow="hidden" aria-hidden="true">
        {rows.map(({ label, tone }) => (
          <Box key={label} flex="1" bg={durationColors[tone]} opacity={tone === 'success' ? 0.9 : 0.8} />
        ))}
      </Stack>
      <Stack gap="0.5" fontVariantNumeric="tabular-nums">
        {rows.map(({ label, seconds, tone }) => (
          <HStack key={label} gap="1.5">
            <Text color="gray.500">{label}</Text>
            <Text color={durationColors[tone]}>{formatSeconds(seconds)}</Text>
          </HStack>
        ))}
      </Stack>
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
  const reviews = useReviewCount(admin);
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
            aria-label={reviews ? `待核对，${reviews} 条` : '待核对'}
            onClick={() => {
              setReviewOnly(true);
              setPage(0);
              setSelectedIds([]);
            }}
          >
            待核对 ({reviews})
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
            {/* 内容不换行，列宽由内容决定，超出容器时横向滚动。 */}
            <Box overflowX="auto">
              <Table.Root size="sm" whiteSpace="nowrap">
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
                      'API Key',
                      '模型',
                      'Token 用量',
                      '耗时',
                      `扣费/冻结（${data.data.currency}）`,
                    ].map((h) => (
                      <Table.ColumnHeader key={h}>{h}</Table.ColumnHeader>
                    ))}
                    <Table.ColumnHeader {...pinnedColumn}>操作</Table.ColumnHeader>
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
                      <Table.Cell>{r.channelName ?? r.channelId ?? '—'}</Table.Cell>
                      {admin && <Table.Cell>{r.username}</Table.Cell>}
                      <Table.Cell>{r.apiKeyName === null ? <Text color="gray.500">—</Text> : r.apiKeyName}</Table.Cell>
                      <Table.Cell>
                        <Stack gap="2" align="start">
                          <Text>{r.model}</Text>
                          {r.reasoningEffort && <UsageBadge kind="effort" value={r.reasoningEffort} />}
                        </Stack>
                      </Table.Cell>
                      <Table.Cell>
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
                            <HStack gap="2">
                              <UsageBadge
                                kind="input"
                                value={String(Number(r.usage.inputTokens) + Number(r.usage.cacheWriteTokens))}
                              />
                              <UsageBadge kind="output" value={r.usage.outputTokens} />
                              {r.usageEstimate && <Badge colorPalette="orange">估算</Badge>}
                            </HStack>
                            <HStack gap="2">
                              <UsageBadge kind="cacheRead" value={r.usage.cacheReadTokens ?? '未知'} />
                              <RateBadge request={r} />
                            </HStack>
                          </Stack>
                        ) : (
                          '—'
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <RequestDuration request={r} />
                      </Table.Cell>
                      <Table.Cell>{r.chargedAmount || r.heldAmount}</Table.Cell>
                      <Table.Cell {...pinnedColumn}>
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
