import { Box, Button, Grid, Heading, HStack, Stack, Table, Text } from '@chakra-ui/react';
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
const ledgerKinds = { reserve: '预占', settlement: '消费', release: '释放', correction: '冲正', adjustment: '调账' };
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
    <FormDialog open title="请求账单" onClose={close}>
      <Stack gap="5">
        <ErrorText>{formError(data.error)?.message}</ErrorText>
        {data.isPending ? (
          <Loading />
        ) : (
          r && (
            <>
              <Text fontFamily="mono" fontSize="xs" overflowWrap="anywhere">
                {r.id}
              </Text>
              <Text>
                {r.model} · {requestStatuses[r.status]}
              </Text>
              {r.upstreamRequestId && (
                <Text fontSize="xs" color="gray.500" overflowWrap="anywhere">
                  上游请求：{r.upstreamRequestId}
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
              {r.errorCode && (
                <Text fontSize="sm" color="gray.500">
                  {r.errorCode}
                </Text>
              )}
              {r.preview && (
                <Stack gap="2">
                  <Heading as="h3" fontSize="sm">
                    保存用量的价格明细{!r.usageFinal && '（用量未最终确认）'}
                  </Heading>
                  <Text fontSize="sm">
                    v{r.preview.version} · {r.preview.ruleLabel} · ×{displayMoney(r.preview.multiplier)} ·{' '}
                    {r.preview.total} {r.currency}
                  </Text>
                  <Box overflowX="auto">
                    <Table.Root size="sm">
                      <Table.Header>
                        <Table.Row>
                          <Table.ColumnHeader>类别</Table.ColumnHeader>
                          <Table.ColumnHeader>Token</Table.ColumnHeader>
                          <Table.ColumnHeader>单价 / 百万</Table.ColumnHeader>
                          <Table.ColumnHeader>金额</Table.ColumnHeader>
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {r.preview.items.map((i) => (
                          <Table.Row key={i.category}>
                            <Table.Cell>
                              {
                                { input: '输入', output: '输出', cacheRead: '缓存读', cacheWrite: '缓存写' }[
                                  i.category as 'input' | 'output' | 'cacheRead' | 'cacheWrite'
                                ]
                              }
                            </Table.Cell>
                            <Table.Cell>{i.tokens}</Table.Cell>
                            <Table.Cell>{i.price ?? '未配置'}</Table.Cell>
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
                      {['类型', '余额变化', '冻结变化', '操作人 / 依据'].map((h) => (
                        <Table.ColumnHeader key={h}>{h}</Table.ColumnHeader>
                      ))}
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {r.ledger.map((e) => (
                      <Table.Row key={e.id}>
                        <Table.Cell whiteSpace="nowrap">
                          {ledgerKinds[e.kind]}
                          <Text fontSize="xs" color="gray.500">
                            {localDate(e.createdAt)}
                          </Text>
                        </Table.Cell>
                        <Table.Cell>{displayMoney(e.amount)}</Table.Cell>
                        <Table.Cell>{displayMoney(e.reservedAmount)}</Table.Cell>
                        <Table.Cell minW="180px">
                          <Text>{e.actor}</Text>
                          <Text fontSize="xs" color="gray.500">
                            {e.reason}
                          </Text>
                        </Table.Cell>
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
  const [usage, setUsage] = useState(
    saved?.usage ?? {
      inputTokens: r.usage?.inputTokens ?? '0',
      outputTokens: r.usage?.outputTokens ?? '0',
      cacheReadTokens: r.usage?.cacheReadTokens ?? '0',
      cacheWriteTokens: r.usage?.cacheWriteTokens ?? '0',
    },
  );
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
    <FormDialog open title="追加费用冲正" busy={task.isPending} onClose={close}>
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
            label={`冲正后的累计费用（${r.currency}）`}
            value={amount}
            inputMode="decimal"
            required
            disabled={locked}
            onChange={(e) => setAmount(e.target.value)}
          />
          <FormInput
            label="冲正依据"
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
              {operation.current ? '重试冲正' : '确认冲正'}
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
