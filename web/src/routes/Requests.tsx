import { Badge, Box, Button, HStack, Stack, Table, Text } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';

import { BillingAction, RequestDetail, requestStatuses } from '../components/request-billing';
import { ErrorText, Loading, PageControls, Title } from '../components/ui';
import { useAuth } from '../lib/auth';
import { formError, localDate } from '../lib/format';
import { trpc } from '../lib/trpc';

const usageKinds = {
  input: { label: '输入', path: 'M3 12h12m-4-4 4 4-4 4M15 4h5v16h-5' },
  output: { label: '输出', path: 'M9 4H4v16h5m0-8h12m-4-4 4 4-4 4' },
  cacheRead: { label: '缓存读', path: 'M17 12v8m-3-3 3 3 3-3' },
  cacheWrite: { label: '缓存写', path: 'M17 20v-8m-3 3 3-3 3 3' },
} as const;

function UsageBadge({ kind, value }: { kind: keyof typeof usageKinds; value: string }) {
  const { label, path } = usageKinds[kind];
  return (
    <Badge colorPalette="gray" gap="1.5" fontVariantNumeric="tabular-nums">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {(kind === 'cacheRead' || kind === 'cacheWrite') && (
          <>
            <ellipse cx="7" cy="5" rx="4" ry="2" />
            <path d="M3 5v12c0 1.1 1.8 2 4 2s4-.9 4-2V5M3 11c0 1.1 1.8 2 4 2s4-.9 4-2" />
          </>
        )}
        <path d={path} />
      </svg>
      {label} {value}
    </Badge>
  );
}

export default function Requests() {
  const { data: user } = useAuth();
  const [params] = useSearchParams();
  const [detailId, setDetailId] = useState<string | undefined>(params.get('request') ?? undefined);
  const [action, setAction] = useState<{ requestId: string; kind: 'resolve' | 'correct' }>();
  const [reviewOnly, setReviewOnly] = useState(false);
  const [page, setPage] = useState(0);
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
        <HStack>
          <Button
            size="sm"
            variant={reviewOnly ? 'outline' : 'solid'}
            onClick={() => {
              setReviewOnly(false);
              setPage(0);
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
            }}
          >
            待核对
          </Button>
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
                      <Table.Cell>{localDate(r.receivedAt)}</Table.Cell>
                      {admin && <Table.Cell>{r.username}</Table.Cell>}
                      <Table.Cell>{r.model}</Table.Cell>
                      <Table.Cell whiteSpace="nowrap">
                        <Text>{requestStatuses[r.status]}</Text>
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
