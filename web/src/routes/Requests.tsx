import { Box, Button, HStack, Stack, Table, Text } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';

import { BillingAction, RequestDetail, requestStatuses } from '../components/request-billing';
import { ErrorText, Loading, PageControls, Title } from '../components/ui';
import { useAuth } from '../lib/auth';
import { formError, localDate } from '../lib/format';
import { trpc } from '../lib/trpc';

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
      <Text color="gray.500" fontSize="sm">
        费用按实际用量结算。缺少最终用量的请求保留冻结额，核对后结算或释放。
      </Text>
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
                      '时间 / 请求 ID',
                      ...(admin ? ['用户'] : []),
                      '模型 / 端点',
                      '结果',
                      'Token 用量',
                      `已扣 / 冻结（${data.data.currency}）`,
                      '操作',
                    ].map((h) => (
                      <Table.ColumnHeader key={h}>{h}</Table.ColumnHeader>
                    ))}
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {data.data.items.map((r) => (
                    <Table.Row key={r.id}>
                      <Table.Cell whiteSpace="nowrap">
                        <Text>{localDate(r.receivedAt)}</Text>
                        <Text fontSize="xs" color="gray.500" title={r.upstreamRequestId ?? undefined}>
                          {r.id}
                        </Text>
                      </Table.Cell>
                      {admin && <Table.Cell>{r.username}</Table.Cell>}
                      <Table.Cell>
                        <Text>{r.model}</Text>
                        <Text fontSize="xs" color="gray.500">
                          {r.endpoint}
                          {r.streaming && ' · SSE'}
                        </Text>
                      </Table.Cell>
                      <Table.Cell whiteSpace="nowrap">
                        <Text>{requestStatuses[r.status]}</Text>
                        <HStack fontSize="xs" color="gray.500">
                          <Text>{r.httpStatus ?? '—'}</Text>
                          <Text>{r.durationMs === null ? '' : `${r.durationMs}ms`}</Text>
                        </HStack>
                        {r.errorCode && (
                          <Text fontSize="xs" color="gray.500">
                            {r.errorCode}
                          </Text>
                        )}
                      </Table.Cell>
                      <Table.Cell whiteSpace="nowrap">
                        {r.usage ? (
                          <>
                            <Text>
                              输入 {r.usage.input} · 输出 {r.usage.output}
                            </Text>
                            <Text fontSize="xs" color="gray.500">
                              缓存读 {r.usage.cacheRead} · 写 {r.usage.cacheWrite} · 上下文 {r.usage.context}
                            </Text>
                          </>
                        ) : (
                          '—'
                        )}
                      </Table.Cell>
                      <Table.Cell whiteSpace="nowrap">
                        <Text>
                          {r.chargedAmount ?? '—'} / {r.heldAmount}
                        </Text>
                        {typeof r.pricing?.ruleLabel === 'string' && (
                          <Text fontSize="xs" color="gray.500">
                            {r.pricing.ruleLabel} · ×{String(r.pricing.multiplier)}
                          </Text>
                        )}
                      </Table.Cell>
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
                              冲正
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
