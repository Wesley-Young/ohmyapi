import { Box, Heading, HStack, Stack, Table, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useQuery } from '@tanstack/react-query';
import { Check, CircleAlert, Copy, CreditCard, Plug } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import {
  displayMoney,
  displayMultiplier,
  formatCount,
  formatSeconds,
  formError,
  isZeroMoney,
  localDate,
} from '../lib/format';
import { trpc } from '../lib/trpc';
import { ModelLabel } from './brand-icon';
import { StatusDot } from './channel-icon';
import { IconButton } from './icon-button';
import { ErrorText, Facts, FormDialog, Loading, Metric } from './ui';

type Detail = RouterOutputs['requestDetail'];

const requestStatuses = {
  received: { label: '处理中', color: 'gray.400' },
  reserved: { label: '已受理', color: 'gray.400' },
  forwarding: { label: '转发中', color: 'blue.500' },
  settling: { label: '结算中', color: 'blue.500' },
  settled: { label: '已结算', color: 'green.500' },
  released: { label: '已释放', color: 'gray.300' },
  rejected: { label: '已拒绝', color: 'red.500' },
  needs_review: { label: '待核对', color: 'orange.400' },
  completed: { label: '历史未计费', color: 'gray.300' },
} satisfies Record<Detail['status'], { label: string; color: string }>;
const attemptStatuses = {
  prepared: { label: '准备中', color: 'gray.300' },
  forwarding: { label: '转发中', color: 'blue.500' },
  completed: { label: '已完成', color: 'green.500' },
  failed: { label: '失败', color: 'red.500' },
  unknown: { label: '执行结果待核对', color: 'orange.400' },
} satisfies Record<Detail['attempts'][number]['status'], { label: string; color: string }>;
const priceCategories: Record<string, string> = {
  input: '输入',
  output: '输出',
  cacheRead: '缓存读',
  cacheWrite: '缓存写',
  webSearch: 'Web Search',
  webSearchPreview: 'Web Search Preview',
};
const ledgerKinds = { reserve: '预占', settlement: '消费', release: '释放', correction: '修正', adjustment: '调账' };

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack as="section" gap="3" borderTopWidth="1px" borderColor="gray.200" pt="4">
      <Heading as="h3" fontSize="sm">
        {title}
      </Heading>
      {children}
    </Stack>
  );
}

function Notice({ tone, children }: { tone: 'red' | 'orange'; children: ReactNode }) {
  return (
    <HStack
      gap="2"
      align="start"
      px="3"
      py="2.5"
      borderRadius="lg"
      bg={`${tone}.50`}
      color={`${tone}.700`}
      fontSize="sm"
    >
      <Box pt="0.5" flexShrink="0">
        <CircleAlert size={14} aria-hidden="true" />
      </Box>
      <Stack gap="1" minW="0">
        {children}
      </Stack>
    </HStack>
  );
}

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <HStack gap="1" minW="0">
      <Text fontFamily="mono" fontSize="xs" color="gray.500" truncate>
        {id}
      </Text>
      <IconButton
        variant="ghost"
        size="2xs"
        color="gray.500"
        aria-label={copied ? '已复制请求 ID' : '复制请求 ID'}
        title={copied ? '已复制' : '复制'}
        onClick={() =>
          navigator.clipboard.writeText(id).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
      </IconButton>
    </HStack>
  );
}

/** 每次转发尝试是时间线上的一个节点，失败节点附错误码。 */
function Attempts({ attempts }: { attempts: Detail['attempts'] }) {
  return (
    <Stack as="ol" gap="3" listStyleType="none" position="relative">
      {attempts.length > 1 && (
        <Box position="absolute" left="4px" top="2" bottom="2" borderLeftWidth="1px" borderColor="gray.200" />
      )}
      {attempts.map((attempt) => {
        const status = attemptStatuses[attempt.status];
        const seconds = attempt.finishedAt
          ? (Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt)) / 1000
          : null;
        const Icon = attempt.channelType === 'api' ? Plug : CreditCard;
        return (
          <HStack as="li" key={attempt.id} gap="3" align="start" position="relative">
            <Box pt="1.5" role="img" aria-label={status.label} title={status.label}>
              <StatusDot color={status.color} ring="white" />
            </Box>
            <Stack gap="0.5" minW="0" flex="1">
              <HStack gap="2" minW="0" fontSize="sm">
                <Box
                  color="gray.500"
                  flexShrink="0"
                  role="img"
                  aria-label={attempt.channelType === 'api' ? 'API 渠道' : '订阅渠道'}
                >
                  <Icon size={14} aria-hidden="true" />
                </Box>
                <Text truncate>{attempt.channelName}</Text>
                {attempt.upstreamModel && (
                  <Text fontSize="xs" color="gray.500" truncate>
                    → {attempt.upstreamModel}
                  </Text>
                )}
                <HStack
                  gap="3"
                  ms="auto"
                  flexShrink="0"
                  fontSize="xs"
                  color="gray.500"
                  fontVariantNumeric="tabular-nums"
                >
                  {attempt.httpStatus !== null && <Text>HTTP {attempt.httpStatus}</Text>}
                  {seconds !== null && <Text>{formatSeconds(Math.max(0, seconds))}</Text>}
                </HStack>
              </HStack>
              {attempt.status === 'failed' && attempt.errorCode && (
                <Text fontSize="xs" color="gray.500" fontFamily="mono" overflowWrap="anywhere">
                  {attempt.errorCode}
                </Text>
              )}
            </Stack>
          </HStack>
        );
      })}
    </Stack>
  );
}

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
  const status = r && requestStatuses[r.status];
  return (
    <FormDialog open title="请求详情" onClose={close}>
      <Stack gap="5">
        <ErrorText>{formError(data.error)?.message}</ErrorText>
        {data.isPending ? (
          <Loading />
        ) : (
          r &&
          status && (
            <>
              <Stack gap="4">
                <CopyId id={r.id} />
                <HStack justify="space-between" align="start" gap="4" flexWrap="wrap">
                  <Stack gap="1.5" minW="0">
                    <Box fontSize="md" fontWeight="600" overflowWrap="anywhere">
                      <ModelLabel model={r.model} />
                    </Box>
                    <HStack gap="2" fontSize="sm" color="gray.600">
                      <StatusDot color={status.color} ring="transparent" />
                      <Text>{status.label}</Text>
                      <Text color="gray.500" fontFamily="mono" fontSize="xs" ms="1">
                        {r.endpoint}
                      </Text>
                    </HStack>
                  </Stack>
                  <HStack gap="6" align="end">
                    {!isZeroMoney(r.reserved) && (
                      // 预占只见于早期请求。
                      <Metric label={`原预占（${r.currency}）`}>{displayMoney(r.reserved)}</Metric>
                    )}
                    {!isZeroMoney(r.held) && (
                      <Metric label={`冻结金额（${r.currency}）`}>{displayMoney(r.held)}</Metric>
                    )}
                    <Stack gap="1" align="end">
                      <Text fontSize="xs" color="gray.500">
                        累计已扣（{r.currency}）
                      </Text>
                      <Text fontSize="xl" fontWeight="600" lineHeight="1" fontVariantNumeric="tabular-nums">
                        {r.charged === null ? '—' : displayMoney(r.charged)}
                      </Text>
                    </Stack>
                  </HStack>
                </HStack>
                {r.usageEstimate && (
                  <Notice tone="orange">
                    <Text>客户端断连，用量按上游报告和已收到的内容估算，可能与上游最终账单存在差异。</Text>
                    {r.usage?.cacheReadTokens === null && <Text fontWeight="500">缓存用量未知。</Text>}
                  </Notice>
                )}
                {(r.errorCode || r.errorMessage) && (
                  <Notice tone="red">
                    {r.errorMessage && (
                      <Text whiteSpace="pre-wrap" overflowWrap="anywhere">
                        {r.errorMessage}
                      </Text>
                    )}
                    {(r.errorCode || r.httpStatus !== null) && (
                      <Text fontSize="xs" color="red.600" fontFamily="mono" overflowWrap="anywhere">
                        {r.errorCode} {r.httpStatus !== null && `(HTTP ${r.httpStatus})`}
                      </Text>
                    )}
                  </Notice>
                )}
              </Stack>

              {(r.attempts.length > 0 || r.upstreamRequestId || r.subscriptionAccountId) && (
                <Section title="转发路径">
                  {r.attempts.length > 0 && <Attempts attempts={r.attempts} />}
                  {(r.upstreamRequestId || r.subscriptionAccountId) && (
                    <Stack gap="0.5" fontSize="xs" color="gray.500" overflowWrap="anywhere">
                      {r.upstreamRequestId && <Text>上游请求 ID：{r.upstreamRequestId}</Text>}
                      {r.subscriptionAccountId && <Text>订阅账号 ID：{r.subscriptionAccountId}</Text>}
                    </Stack>
                  )}
                </Section>
              )}

              {(r.preview || r.pricing?.source === 'administrator_amount' || r.previewError) && (
                <Section
                  title={`费用明细${r.usageEstimate ? '（估算）' : r.preview && !r.usageFinal ? '（用量未最终确认）' : ''}`}
                >
                  {r.preview && (
                    <>
                      <Facts
                        items={[
                          { label: '计价规则', value: r.preview.ruleLabel },
                          { label: '倍率', value: displayMultiplier(r.preview.multiplier) },
                          {
                            label: '倍率来源',
                            value: `${r.preview.pricingMode === 'passthrough' ? '透传' : '统一'}，${
                              r.preview.multiplierSource === 'model' ? '模型专属' : '整体'
                            }`,
                          },
                        ]}
                      />
                      <Box overflowX="auto">
                        <Table.Root size="sm" whiteSpace="nowrap" fontVariantNumeric="tabular-nums">
                          <Table.Header>
                            <Table.Row>
                              <Table.ColumnHeader>类别</Table.ColumnHeader>
                              <Table.ColumnHeader textAlign="end">用量</Table.ColumnHeader>
                              <Table.ColumnHeader textAlign="end">单价</Table.ColumnHeader>
                              <Table.ColumnHeader textAlign="end">金额</Table.ColumnHeader>
                            </Table.Row>
                          </Table.Header>
                          <Table.Body>
                            {r.preview.items.map((i) => (
                              <Table.Row key={i.category}>
                                <Table.Cell>{priceCategories[i.category] ?? i.category}</Table.Cell>
                                <Table.Cell textAlign="end">
                                  {formatCount(i.tokens)} {i.unit === 'thousand_calls' ? '次' : 'Token'}
                                </Table.Cell>
                                <Table.Cell textAlign="end">
                                  {i.price ?? '—'} / {i.unit === 'thousand_calls' ? '千次' : '百万 Token'}
                                </Table.Cell>
                                <Table.Cell textAlign="end">{displayMoney(i.amount)}</Table.Cell>
                              </Table.Row>
                            ))}
                            <Table.Row fontWeight="600">
                              <Table.Cell>合计</Table.Cell>
                              <Table.Cell />
                              <Table.Cell />
                              <Table.Cell textAlign="end">
                                {displayMoney(r.preview.total)} {r.currency}
                              </Table.Cell>
                            </Table.Row>
                          </Table.Body>
                        </Table.Root>
                      </Box>
                    </>
                  )}
                  {r.pricing?.source === 'administrator_amount' && (
                    <Text fontSize="sm">已按管理员核对费用结算，依据：{String(r.pricing.reason)}</Text>
                  )}
                  <ErrorText>{r.previewError}</ErrorText>
                </Section>
              )}

              <Section title="关联流水">
                {r.ledger.length ? (
                  <Box overflowX="auto">
                    <Table.Root size="sm" whiteSpace="nowrap" fontVariantNumeric="tabular-nums">
                      <Table.Header>
                        <Table.Row>
                          <Table.ColumnHeader>类型</Table.ColumnHeader>
                          <Table.ColumnHeader>时间</Table.ColumnHeader>
                          <Table.ColumnHeader textAlign="end">余额变化</Table.ColumnHeader>
                          {ledgerHolds && <Table.ColumnHeader textAlign="end">冻结变化</Table.ColumnHeader>}
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {r.ledger.map((e) => (
                          <Table.Row key={e.id}>
                            <Table.Cell>{ledgerKinds[e.kind]}</Table.Cell>
                            <Table.Cell>{localDate(e.createdAt)}</Table.Cell>
                            <Table.Cell textAlign="end">{displayMoney(e.amount)}</Table.Cell>
                            {ledgerHolds && <Table.Cell textAlign="end">{displayMoney(e.reservedAmount)}</Table.Cell>}
                          </Table.Row>
                        ))}
                      </Table.Body>
                    </Table.Root>
                  </Box>
                ) : (
                  <Text fontSize="sm" color="gray.500">
                    无关联资金流水
                  </Text>
                )}
              </Section>
            </>
          )
        )}
      </Stack>
    </FormDialog>
  );
}
