import { Badge, Box, Button, Grid, Heading, HStack, Stack, Table, Text } from '@chakra-ui/react';
import type { RouterInputs, RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useMutation, useQuery } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { useRef, useState } from 'react';

import { useAuth } from '../lib/auth';
import { displayMoney, formError, localDate } from '../lib/format';
import { invalidateUser, queryClient, trpc } from '../lib/trpc';
import { SelectField } from '../routes/Catalog';
import { ErrorText, FormDialog, FormInput, Loading, PrimaryButton } from './ui';

export const requestStatuses: Record<string, string> = {
  received: '处理中',
  reserved: '已预占',
  forwarding: '转发中',
  settling: '结算中',
  settled: '已结算',
  released: '已释放',
  rejected: '已拒绝',
  needs_review: '待核对',
  completed: '历史未计费',
};
const ledgerKinds = { reserve: '预占', settlement: '消费', release: '释放', correction: '修正', adjustment: '调账' };
const refreshRequests = (userId: string, requestId: string) =>
  Promise.all([
    invalidateUser(userId),
    queryClient.invalidateQueries(trpc.requests.pathFilter()),
    queryClient.invalidateQueries(trpc.admin.requests.pathFilter()),
    queryClient.invalidateQueries(trpc.requestDetail.queryFilter({ requestId })),
    queryClient.invalidateQueries(trpc.admin.billing.reconcile.queryFilter({ userId })),
  ]);
const definitive = (error: unknown) =>
  error instanceof TRPCClientError &&
  ['BAD_REQUEST', 'FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND', 'CONFLICT'].includes(error.data?.code);
type Detail = RouterOutputs['requestDetail'];
type Resolution = RouterInputs['admin']['billing']['resolve'];
type Correction = RouterInputs['admin']['billing']['correct'];
type ZeroResolution = RouterInputs['admin']['billing']['resolveZero'];

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
                <Text overflowWrap="anywhere">{r.model}</Text>
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
                    {r.usageEstimate.inputImageTokens > 0 && (
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
                  ['原预占', r.reserved],
                  ['冻结金额', r.held],
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
                  </HStack>
                  <Box overflowX="auto">
                    <Table.Root size="sm">
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
                <Table.Root size="sm">
                  <Table.Header>
                    <Table.Row>
                      {['类型', '时间', '余额变化', '冻结变化'].map((h) => (
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
                        <Table.Cell>{displayMoney(e.reservedAmount)}</Table.Cell>
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

export function BulkZeroBilling({
  requestIds,
  onSuccess,
}: {
  requestIds: string[];
  onSuccess: (count: number) => void;
}) {
  const { data: actor } = useAuth();
  const storageKey = `ohmyapi:resolve-zero:${actor?.id}`;
  const [saved] = useState<ZeroResolution | undefined>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
      return Array.isArray(value?.requestIds) && value.requestIds.length && typeof value.idempotencyKey === 'string'
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  });
  const operation = useRef<ZeroResolution | undefined>(saved);
  const [open, setOpen] = useState(Boolean(saved));
  const [ids, setIds] = useState<string[]>(saved?.requestIds ?? []);
  const [reason, setReason] = useState(saved?.reason ?? '管理员批量确认按 0 计费');
  const task = useMutation(
    trpc.admin.billing.resolveZero.mutationOptions({
      onMutate: (input) => sessionStorage.setItem(storageKey, JSON.stringify(input)),
      onError: (error) => {
        if (definitive(error)) {
          operation.current = undefined;
          sessionStorage.removeItem(storageKey);
          void queryClient.invalidateQueries(trpc.admin.requests.pathFilter());
        }
      },
      onSuccess: async (result) => {
        operation.current = undefined;
        sessionStorage.removeItem(storageKey);
        onSuccess(result.count);
        await Promise.all([
          ...result.userIds.map(invalidateUser),
          queryClient.invalidateQueries(trpc.requests.pathFilter()),
          queryClient.invalidateQueries(trpc.admin.requests.pathFilter()),
          queryClient.invalidateQueries(trpc.requestDetail.pathFilter()),
          queryClient.invalidateQueries(trpc.admin.billing.reconcile.pathFilter()),
          queryClient.invalidateQueries(trpc.admin.stats.pathFilter()),
        ]);
        setOpen(false);
      },
    }),
  );
  const locked = task.isPending || Boolean(operation.current);
  return (
    <>
      <PrimaryButton
        size="sm"
        disabled={!requestIds.length && !operation.current}
        onClick={() => {
          setIds(operation.current?.requestIds ?? [...requestIds]);
          task.reset();
          setOpen(true);
        }}
      >
        {operation.current ? '重试按 0 计费' : '全部按 0 计费'}
      </PrimaryButton>
      {open && (
        <FormDialog open title="批量按 0 计费" busy={task.isPending} onClose={() => setOpen(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (task.isPending) return;
              operation.current ??= { requestIds: ids, reason, idempotencyKey: crypto.randomUUID() };
              task.mutate(operation.current);
            }}
          >
            <Stack gap="5">
              <FormInput
                label="核对依据"
                value={reason}
                required
                maxLength={500}
                disabled={locked}
                onChange={(event) => setReason(event.target.value)}
              />
              <ErrorText>{formError(task.error)?.message}</ErrorText>
              {operation.current && !task.isPending && (
                <Text fontSize="sm" color="gray.500">
                  上次结果尚未确认，请用相同内容重试。
                </Text>
              )}
              <HStack>
                <PrimaryButton type="submit" loading={task.isPending} disabled={!ids.length}>
                  {operation.current ? '重试按 0 计费' : '确认按 0 计费'} ({ids.length})
                </PrimaryButton>
                <Button variant="ghost" disabled={task.isPending} onClick={() => setOpen(false)}>
                  关闭
                </Button>
              </HStack>
            </Stack>
          </form>
        </FormDialog>
      )}
    </>
  );
}

function ResolutionForm({ r, close }: { r: Detail; close: () => void }) {
  const { data: actor } = useAuth();
  const storageKey = `ohmyapi:resolve:${actor?.id}:${r.id}`;
  const [saved] = useState<Resolution | undefined>(() => {
    try {
      const v = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
      return v?.requestId === r.id && typeof v.idempotencyKey === 'string' ? v : undefined;
    } catch {
      return undefined;
    }
  });
  const operation = useRef<Resolution | undefined>(saved);
  const [action, setAction] = useState<Resolution['action']>(
    saved?.action ?? (r.preview ? 'settle_usage' : 'settle_amount'),
  );
  const [reason, setReason] = useState(saved?.reason ?? '');
  const [amount, setAmount] = useState(saved?.amount ?? '');
  const [usage, setUsage] = useState({
    inputTokens: r.usage?.inputTokens ?? '0',
    outputTokens: r.usage?.outputTokens ?? '0',
    cacheReadTokens: r.usage?.cacheReadTokens ?? '0',
    cacheWriteTokens: r.usage?.cacheWriteTokens ?? '0',
    webSearchCalls: r.usage?.webSearchCalls ?? '0',
    webSearchPreviewCalls: r.usage?.webSearchPreviewCalls ?? '0',
    ...saved?.usage,
  });
  const task = useMutation(
    trpc.admin.billing.resolve.mutationOptions({
      onMutate: (input) => {
        sessionStorage.setItem(storageKey, JSON.stringify(input));
      },
      onError: (e) => {
        if (definitive(e)) {
          operation.current = undefined;
          sessionStorage.removeItem(storageKey);
        }
      },
      onSuccess: async (result) => {
        operation.current = undefined;
        sessionStorage.removeItem(storageKey);
        await refreshRequests(result.userId, r.id);
        close();
      },
    }),
  );
  const locked = task.isPending || Boolean(operation.current);
  return (
    <FormDialog open title="核对请求费用" busy={task.isPending} onClose={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (task.isPending) return;
          operation.current ??= {
            requestId: r.id,
            action,
            reason,
            amount: action === 'settle_amount' ? amount : undefined,
            usage: action === 'settle_usage' ? usage : undefined,
            idempotencyKey: crypto.randomUUID(),
          };
          task.mutate(operation.current);
        }}
      >
        <Stack gap="5">
          <Text fontSize="sm" color="gray.500">
            冻结 {r.held} {r.currency}。请依据上游请求记录确认费用，未确认用量不能视为免费。
          </Text>
          <SelectField
            label="核对方式"
            value={action}
            onChange={(v) => {
              if (!locked && v) setAction(v as Resolution['action']);
            }}
            options={[
              { id: 'settle_usage', name: '按确认后的用量结算' },
              { id: 'settle_amount', name: '按确认后的费用结算' },
              { id: 'release', name: '确认未消费，释放冻结' },
            ]}
          />
          {action === 'settle_usage' && (
            <Grid templateColumns={{ base: '1fr', sm: '1fr 1fr' }} gap="4">
              {(
                [
                  ['inputTokens', '普通输入 Token'],
                  ['outputTokens', '输出 Token'],
                  ['cacheReadTokens', '缓存读取 Token'],
                  ['cacheWriteTokens', '缓存写入 Token'],
                  ['webSearchCalls', 'Web Search 调用次数'],
                  ['webSearchPreviewCalls', 'Web Search Preview 调用次数'],
                ] as const
              ).map(([key, label]) => (
                <FormInput
                  key={key}
                  label={label}
                  value={usage[key]}
                  required
                  inputMode="numeric"
                  disabled={locked}
                  onChange={(e) => setUsage({ ...usage, [key]: e.target.value })}
                />
              ))}
            </Grid>
          )}
          {action === 'settle_amount' && (
            <FormInput
              label={`确认费用（${r.currency}）`}
              value={amount}
              required
              inputMode="decimal"
              disabled={locked}
              onChange={(e) => setAmount(e.target.value)}
              helper="最多六位小数；0 表示已确认免费"
            />
          )}
          <FormInput
            label="核对依据"
            value={reason}
            required
            maxLength={500}
            disabled={locked}
            onChange={(e) => setReason(e.target.value)}
          />
          <ErrorText>{formError(task.error)?.message}</ErrorText>
          {operation.current && !task.isPending && (
            <Text fontSize="sm" color="gray.500">
              上次结果尚未确认，请用相同内容重试。
            </Text>
          )}
          <HStack>
            <PrimaryButton type="submit" loading={task.isPending}>
              {operation.current ? '重试核对' : '确认核对'}
            </PrimaryButton>
            <Button variant="ghost" disabled={task.isPending} onClick={close}>
              关闭
            </Button>
          </HStack>
        </Stack>
      </form>
    </FormDialog>
  );
}
function CorrectionForm({ r, close }: { r: Detail; close: () => void }) {
  const { data: actor } = useAuth();
  const storageKey = `ohmyapi:correct:${actor?.id}:${r.id}`;
  const [saved] = useState<Correction | undefined>(() => {
    try {
      const v = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
      return v?.requestId === r.id && typeof v.idempotencyKey === 'string' ? v : undefined;
    } catch {
      return undefined;
    }
  });
  const operation = useRef<Correction | undefined>(saved);
  const [amount, setAmount] = useState(saved?.amount ?? r.charged ?? '0');
  const [reason, setReason] = useState(saved?.reason ?? '');
  const task = useMutation(
    trpc.admin.billing.correct.mutationOptions({
      onMutate: (input) => {
        sessionStorage.setItem(storageKey, JSON.stringify(input));
      },
      onError: (e) => {
        if (definitive(e)) {
          operation.current = undefined;
          sessionStorage.removeItem(storageKey);
        }
      },
      onSuccess: async (result) => {
        operation.current = undefined;
        sessionStorage.removeItem(storageKey);
        await refreshRequests(result.userId, r.id);
        close();
      },
    }),
  );
  const locked = task.isPending || Boolean(operation.current);
  return (
    <FormDialog open title="追加费用修正" busy={task.isPending} onClose={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (task.isPending) return;
          operation.current ??= { requestId: r.id, amount, reason, idempotencyKey: crypto.randomUUID() };
          task.mutate(operation.current);
        }}
      >
        <Stack gap="5">
          <Text fontSize="sm" color="gray.500">
            当前累计扣费 {r.charged} {r.currency}。减少费用会退款，增加费用会补扣，原流水保留。
          </Text>
          <FormInput
            label={`修正后的累计费用（${r.currency}）`}
            value={amount}
            inputMode="decimal"
            required
            disabled={locked}
            onChange={(e) => setAmount(e.target.value)}
          />
          <FormInput
            label="修正依据"
            value={reason}
            required
            maxLength={500}
            disabled={locked}
            onChange={(e) => setReason(e.target.value)}
          />
          <ErrorText>{formError(task.error)?.message}</ErrorText>
          {operation.current && !task.isPending && (
            <Text fontSize="sm" color="gray.500">
              上次结果尚未确认，请用相同内容重试。
            </Text>
          )}
          <HStack>
            <PrimaryButton type="submit" loading={task.isPending}>
              {operation.current ? '重试修正' : '确认修正'}
            </PrimaryButton>
            <Button variant="ghost" disabled={task.isPending} onClick={close}>
              关闭
            </Button>
          </HStack>
        </Stack>
      </form>
    </FormDialog>
  );
}
export function BillingAction({
  requestId,
  kind,
  close,
}: {
  requestId: string;
  kind: 'resolve' | 'correct';
  close: () => void;
}) {
  const data = useQuery(trpc.requestDetail.queryOptions({ requestId }));
  if (!data.data)
    return (
      <FormDialog open title="请求账单" onClose={close}>
        <ErrorText>{formError(data.error)?.message}</ErrorText>
        {data.isPending && <Loading />}
      </FormDialog>
    );
  return kind === 'resolve' ? (
    <ResolutionForm r={data.data} close={close} />
  ) : (
    <CorrectionForm r={data.data} close={close} />
  );
}

export function WalletReconciliation({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const data = useQuery(trpc.admin.billing.reconcile.queryOptions({ userId }, { enabled: open }));
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          void data.refetch();
          setOpen(true);
        }}
      >
        核对钱包
      </Button>
      {open && (
        <FormDialog open title="钱包一致性核对" onClose={() => setOpen(false)}>
          <Stack gap="4">
            <ErrorText>{formError(data.error)?.message}</ErrorText>
            {data.isPending ? (
              <Loading />
            ) : (
              data.data && (
                <>
                  <Text fontWeight="600">
                    {data.data.consistent ? '钱包、流水与请求冻结一致' : '存在账务差异，请核对流水'}
                  </Text>
                  {[
                    ['钱包余额', data.data.balance],
                    ['流水累计余额', data.data.ledgerBalance],
                    ['钱包冻结', data.data.reserved],
                    ['流水累计冻结', data.data.ledgerReserved],
                    ['请求冻结合计', data.data.requestHeld],
                  ].map(([label, value]) => (
                    <HStack key={label} justify="space-between">
                      <Text fontSize="sm">{label}</Text>
                      <Text fontFamily="mono" fontSize="sm">
                        {value} {data.data.currency}
                      </Text>
                    </HStack>
                  ))}
                </>
              )
            )}
          </Stack>
        </FormDialog>
      )}
    </>
  );
}
