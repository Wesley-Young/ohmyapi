import { Badge, Box, Grid, Heading, HStack, Stack, Table, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useQuery } from '@tanstack/react-query';

import { displayMoney, formError, isZeroMoney, localDate } from '../lib/format';
import { trpc } from '../lib/trpc';
import { ModelLabel } from './brand-icon';
import { ErrorText, FormDialog, Loading } from './ui';

const requestStatuses = {
  received: '处理中',
  reserved: '已受理',
  forwarding: '转发中',
  settling: '结算中',
  settled: '已结算',
  released: '已释放',
  rejected: '已拒绝',
  needs_review: '待核对',
  completed: '历史未计费',
} satisfies Record<RouterOutputs['requestDetail']['status'], string>;
const ledgerKinds = { reserve: '预占', settlement: '消费', release: '释放', correction: '修正', adjustment: '调账' };

export function RequestDetail({ requestId, close }: { requestId: string; close: () => void }) {
  const data = useQuery(
    trpc.requestDetail.queryOptions(
      { requestId },
      {
        refetchInterval: (query) =>
          query.state.data && ['received', 'reserved', 'forwarding', 'settling'].includes(query.state.data.status)
            ? 3000
            : false,
      },
    ),
  );
  const r = data.data;
  // 只有早期请求的流水会改变冻结金额。
  const ledgerHolds = r?.ledger.some((e) => !isZeroMoney(e.reservedAmount)) ?? false;
  return (
    <FormDialog open title={`请求账单${r?.id ? ` (${r.id})` : ''}`} onClose={close}>
      <Stack gap="5">
        <ErrorText>{formError(data.error)?.message}</ErrorText>
        {data.isPending ? (
          <Loading />
        ) : (
          r && (
            <>
              <HStack gap="2" flexWrap="wrap">
                <ModelLabel model={r.model} overflowWrap="anywhere" />
                <Badge colorPalette="gray">{requestStatuses[r.status]}</Badge>
                {r.usageEstimate && <Badge colorPalette="orange">估算</Badge>}
              </HStack>
              {r.usageEstimate && (
                <Stack gap="2">
                  <Text fontSize="sm" color="gray.600">
                    客户端断连，用量按上游报告和已收到的内容估算，可能与上游最终账单存在差异。
                  </Text>
                  <HStack gap="2" flexWrap="wrap">
                    <Badge colorPalette="gray">
                      输入：{r.usageEstimate.inputSource === 'upstream' ? '上游报告' : '请求估算'}
                    </Badge>
                    {r.usage?.cacheReadTokens === null && <Badge colorPalette="orange">缓存用量未知</Badge>}
                    <Badge colorPalette="gray">
                      输出：
                      {r.usageEstimate.outputSource === 'upstream'
                        ? '上游报告'
                        : r.usageEstimate.outputSource === 'upstream_with_observed_tail'
                          ? '上游报告与后续输出估算'
                          : '已收到内容估算'}
                    </Badge>
                    {(r.usageEstimate.inputImageTokens ?? 0) > 0 && (
                      <Badge colorPalette="gray">图像估算：{r.usageEstimate.inputImageTokens} Token</Badge>
                    )}
                    {r.usageEstimate.searchSource !== 'none' && (
                      <Badge colorPalette="gray">
                        搜索：
                        {
                          { upstream: '上游报告', observed: '已观察调用', request: '请求估算' }[
                            r.usageEstimate.searchSource
                          ]
                        }
                      </Badge>
                    )}
                  </HStack>
                </Stack>
              )}
              {r.subscriptionAccountId && (
                <Text fontSize="xs" color="gray.500" overflowWrap="anywhere">
                  订阅账号 ID：{r.subscriptionAccountId}
                </Text>
              )}
              {r.attempts.length > 0 && (
                <Stack gap="2">
                  <Text fontSize="sm" fontWeight="500">
                    实际转发渠道
                  </Text>
                  {r.attempts.map((attempt) => (
                    <HStack key={attempt.id} gap="2" flexWrap="wrap">
                      <Text fontSize="sm" overflowWrap="anywhere">
                        {attempt.channelName}
                      </Text>
                      <Badge>{attempt.channelType === 'api' ? 'API 渠道' : '订阅渠道'}</Badge>
                      <Badge>
                        {
                          {
                            prepared: '准备中',
                            forwarding: '转发中',
                            completed: '已完成',
                            failed: '失败',
                            unknown: '执行结果待核对',
                          }[attempt.status]
                        }
                      </Badge>
                    </HStack>
                  ))}
                </Stack>
              )}
              {r.upstreamRequestId && (
                <Text fontSize="xs" color="gray.500" overflowWrap="anywhere">
                  上游请求 ID：{r.upstreamRequestId}
                </Text>
              )}
              <Grid templateColumns={{ base: '1fr', sm: 'repeat(3, 1fr)' }} gap="3">
                {[
                  // 预占只见于早期请求。
                  ...(isZeroMoney(r.reserved) ? [] : [['原预占', r.reserved]]),
                  ...(isZeroMoney(r.held) ? [] : [['冻结金额', r.held]]),
                  ['累计已扣', r.charged ?? '—'],
                ].map(([label, value]) => (
                  <Box key={label} borderWidth="1px" borderColor="gray.200" borderRadius="lg" p="3">
                    <Text fontSize="xs" color="gray.500">
                      {label}（{r.currency}）
                    </Text>
                    <Text fontWeight="600">{displayMoney(value)}</Text>
                  </Box>
                ))}
              </Grid>
              {(r.errorCode || r.errorMessage) && (
                <Box borderWidth="1px" borderColor="gray.200" borderRadius="lg" p="4">
                  <Stack gap="2">
                    <Heading size="sm">错误信息</Heading>
                    <HStack gap="2" flexWrap="wrap">
                      {r.errorCode && <Badge colorPalette="orange">{r.errorCode}</Badge>}
                      {r.httpStatus !== null && <Badge colorPalette="gray">HTTP {r.httpStatus}</Badge>}
                    </HStack>
                    {r.errorMessage && (
                      <Text fontSize="sm" whiteSpace="pre-wrap" overflowWrap="anywhere">
                        {r.errorMessage}
                      </Text>
                    )}
                  </Stack>
                </Box>
              )}
              {r.preview && (
                <Stack gap="2">
                  <Heading as="h3" fontSize="sm">
                    保存用量的价格明细{r.usageEstimate ? '（估算）' : !r.usageFinal && '（用量未最终确认）'}
                  </Heading>
                  <HStack gap="2" flexWrap="wrap">
                    <Text fontSize="sm" fontWeight="600">
                      {r.preview.total} {r.currency}
                    </Text>
                    <Badge colorPalette="gray">
                      {r.preview.ruleLabel} {displayMoney(r.preview.multiplier)}×
                    </Badge>
                    <Badge colorPalette="gray">
                      {r.preview.pricingMode === 'passthrough' ? '透传倍率' : '统一倍率'}
                    </Badge>
                    <Badge colorPalette="gray">
                      {r.preview.multiplierSource === 'model' ? '模型专属倍率' : '整体倍率'}
                    </Badge>
                  </HStack>
                  <Box overflowX="auto">
                    <Table.Root size="sm" whiteSpace="nowrap">
                      <Table.Header>
                        <Table.Row>
                          <Table.ColumnHeader>类别</Table.ColumnHeader>
                          <Table.ColumnHeader>用量</Table.ColumnHeader>
                          <Table.ColumnHeader>单价</Table.ColumnHeader>
                          <Table.ColumnHeader>金额</Table.ColumnHeader>
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {r.preview.items.map((i) => (
                          <Table.Row key={i.category}>
                            <Table.Cell>
                              {
                                {
                                  input: '输入',
                                  output: '输出',
                                  cacheRead: '缓存读',
                                  cacheWrite: '缓存写',
                                  webSearch: 'Web Search',
                                  webSearchPreview: 'Web Search Preview',
                                }[
                                  i.category as
                                    | 'input'
                                    | 'output'
                                    | 'cacheRead'
                                    | 'cacheWrite'
                                    | 'webSearch'
                                    | 'webSearchPreview'
                                ]
                              }
                            </Table.Cell>
                            <Table.Cell>
                              {i.tokens} {i.unit === 'thousand_calls' ? '次' : 'Token'}
                            </Table.Cell>
                            <Table.Cell>
                              {i.price ?? '—'} / {i.unit === 'thousand_calls' ? '千次' : '百万 Token'}
                            </Table.Cell>
                            <Table.Cell>{displayMoney(i.amount)}</Table.Cell>
                          </Table.Row>
                        ))}
                      </Table.Body>
                    </Table.Root>
                  </Box>
                </Stack>
              )}
              {r.pricing?.source === 'administrator_amount' && (
                <Text fontSize="sm">已按管理员核对费用结算，依据：{String(r.pricing.reason)}</Text>
              )}
              <ErrorText>{r.previewError}</ErrorText>
              <Heading as="h3" fontSize="sm">
                关联流水
              </Heading>
              <Box overflowX="auto">
                <Table.Root size="sm" whiteSpace="nowrap">
                  <Table.Header>
                    <Table.Row>
                      {['类型', '时间', '余额变化', ...(ledgerHolds ? ['冻结变化'] : [])].map((h) => (
                        <Table.ColumnHeader key={h}>{h}</Table.ColumnHeader>
                      ))}
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {r.ledger.map((e) => (
                      <Table.Row key={e.id}>
                        <Table.Cell>{ledgerKinds[e.kind]}</Table.Cell>
                        <Table.Cell>{localDate(e.createdAt)}</Table.Cell>
                        <Table.Cell>{displayMoney(e.amount)}</Table.Cell>
                        {ledgerHolds && <Table.Cell>{displayMoney(e.reservedAmount)}</Table.Cell>}
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              </Box>
              {!r.ledger.length && (
                <Text fontSize="sm" color="gray.500">
                  无关联资金流水
                </Text>
              )}
            </>
          )
        )}
      </Stack>
    </FormDialog>
  );
}
