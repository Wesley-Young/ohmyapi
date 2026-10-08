import { Badge, Box, Button, Checkbox, HStack, Stack, Table, Text } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { DatabaseBackup, DatabaseZap, LogIn, LogOut } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';

import { BillingAction, BulkZeroBilling, RequestDetail, requestStatuses } from '../components/request-billing';
import { ErrorText, Loading, PageControls, Title } from '../components/ui';
import { useAuth } from '../lib/auth';
import { formError, localDate } from '../lib/format';
import { trpc } from '../lib/trpc';

const usageKinds = {
  input: { label: '输入', icon: LogIn },
  output: { label: '输出', icon: LogOut },
  cacheRead: { label: '缓存读', icon: DatabaseZap },
  cacheWrite: { label: '缓存写', icon: DatabaseBackup },
} as const;

function UsageBadge({ kind, value }: { kind: keyof typeof usageKinds; value: string }) {
  const { label, icon: Icon } = usageKinds[kind];
  return (
    <Badge colorPalette="gray" gap="1.5" fontVariantNumeric="tabular-nums">
      <Icon size={14} strokeWidth={1.75} aria-hidden="true" focusable="false" />
      {label} {value}
    </Badge>
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
                      ...(admin ? ['用户'] : []),
                      '模型',
                      '状态',
                      'Token 用量',
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
                      {admin && <Table.Cell>{r.username}</Table.Cell>}
                      <Table.Cell>{r.model}</Table.Cell>
                      <Table.Cell whiteSpace="nowrap">
                        <HStack gap="2" flexWrap="wrap">
                          <Badge colorPalette="gray">{requestStatuses[r.status]}</Badge>
                          {r.usageEstimate && <Badge colorPalette="orange">估算</Badge>}
                        </HStack>
                        <Text fontSize="xs" color="gray.500">
                          {r.durationMs === null ? '' : `${r.durationMs}ms`}
                        </Text>
                        {r.errorCode && (
                          <Text fontSize="xs" color="orange.500">
                            {r.errorCode}
                          </Text>
                        )}
                      </Table.Cell>
                      <Table.Cell minW="220px" maxW="320px">
                        {r.usage ? (
                          <Stack gap="2">
                            <HStack gap="2" flexWrap="wrap">
                              <UsageBadge kind="input" value={r.usage.input} />
                              <UsageBadge kind="output" value={r.usage.output} />
                            </HStack>
                            <HStack gap="2" flexWrap="wrap">
                              <UsageBadge kind="cacheRead" value={r.usage.cacheRead} />
                              <UsageBadge kind="cacheWrite" value={r.usage.cacheWrite} />
                            </HStack>
                          </Stack>
                        ) : (
                          '—'
                        )}
                      </Table.Cell>
                      <Table.Cell>{r.chargedAmount || r.heldAmount}</Table.Cell>
                      <Table.Cell>
                        <HStack>
                          <Button size="sm" variant="ghost" onClick={() => setDetailId(r.id)}>
                            详情
                          </Button>
                          {admin && r.billingEnabled && r.status === 'needs_review' && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setAction({ requestId: r.id, kind: 'resolve' })}
                            >
                              核对
                            </Button>
                          )}
                          {admin && r.billingEnabled && r.status === 'settled' && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setAction({ requestId: r.id, kind: 'correct' })}
                            >
                              修正
                            </Button>
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
