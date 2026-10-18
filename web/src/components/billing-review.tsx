import { Button, Grid, HStack, Stack, Text } from '@chakra-ui/react';
import type { RouterInputs, RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { refreshRequestBilling, refreshUser } from '../lib/cache';
import { formError, isZeroMoney } from '../lib/format';
import { queryClient, trpc } from '../lib/trpc';
import { SelectField } from './fields';
import { ErrorText, FormDialog, FormInput, Loading, PrimaryButton } from './ui';

type Detail = RouterOutputs['requestDetail'];
type Resolution = RouterInputs['admin']['billing']['resolve'];

export function BulkZeroBilling({
  requestIds,
  onSuccess,
}: {
  requestIds: string[];
  onSuccess: (count: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [reason, setReason] = useState('管理员批量确认按 0 计费');
  const task = useMutation(
    trpc.admin.billing.resolveZero.mutationOptions({
      // 部分请求可能已被其他人处理，刷新列表后重新选择。
      onError: () => void queryClient.invalidateQueries(trpc.admin.requests.pathFilter()),
      onSuccess: async (result) => {
        onSuccess(result.count);
        await Promise.all([
          ...result.userIds.map(refreshUser),
          queryClient.invalidateQueries(trpc.requests.pathFilter()),
          queryClient.invalidateQueries(trpc.admin.requests.pathFilter()),
          queryClient.invalidateQueries(trpc.requestDetail.pathFilter()),
          queryClient.invalidateQueries(trpc.admin.billing.reconcile.pathFilter()),
          queryClient.invalidateQueries(trpc.admin.stats.pathFilter()),
          queryClient.invalidateQueries(trpc.admin.reviewCount.queryFilter()),
        ]);
        setOpen(false);
      },
    }),
  );
  return (
    <>
      <PrimaryButton
        size="sm"
        disabled={!requestIds.length}
        onClick={() => {
          setIds([...requestIds]);
          task.reset();
          setOpen(true);
        }}
      >
        全部按 0 计费
      </PrimaryButton>
      {open && (
        <FormDialog open title="批量按 0 计费" busy={task.isPending} onClose={() => setOpen(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (task.isPending) return;
              task.mutate({ requestIds: ids, reason });
            }}
          >
            <Stack gap="5">
              <FormInput
                label="核对依据"
                value={reason}
                required
                maxLength={500}
                disabled={task.isPending}
                onChange={(event) => setReason(event.target.value)}
              />
              <ErrorText>{formError(task.error)?.message}</ErrorText>
              <HStack>
                <PrimaryButton type="submit" loading={task.isPending} disabled={!ids.length}>
                  确认按 0 计费 ({ids.length})
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
  const [action, setAction] = useState<Resolution['action']>(r.preview ? 'settle_usage' : 'settle_amount');
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [usage, setUsage] = useState({
    inputTokens: r.usage?.inputTokens ?? '0',
    outputTokens: r.usage?.outputTokens ?? '0',
    cacheReadTokens: r.usage?.cacheReadTokens ?? '0',
    cacheWriteTokens: r.usage?.cacheWriteTokens ?? '0',
    webSearchCalls: r.usage?.webSearchCalls ?? '0',
    webSearchPreviewCalls: r.usage?.webSearchPreviewCalls ?? '0',
  });
  const task = useMutation(
    trpc.admin.billing.resolve.mutationOptions({
      onSuccess: async (result) => {
        await refreshRequestBilling(result.userId, r.id);
        close();
      },
    }),
  );
  const locked = task.isPending;
  return (
    <FormDialog open title="核对请求费用" busy={task.isPending} onClose={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (task.isPending) return;
          task.mutate({
            requestId: r.id,
            action,
            reason,
            amount: action === 'settle_amount' ? amount : undefined,
            usage: action === 'settle_usage' ? usage : undefined,
          });
        }}
      >
        <Stack gap="5">
          <Text fontSize="sm" color="gray.500">
            {isZeroMoney(r.held) ? '' : `冻结 ${r.held} ${r.currency}。`}
            请依据上游请求记录确认费用，未确认用量不能视为免费。
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
              { id: 'release', name: '确认未消费，不扣费' },
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
          <HStack>
            <PrimaryButton type="submit" loading={task.isPending}>
              确认核对
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
  const [amount, setAmount] = useState(r.charged ?? '0');
  const [reason, setReason] = useState('');
  const task = useMutation(
    trpc.admin.billing.correct.mutationOptions({
      onSuccess: async (result) => {
        await refreshRequestBilling(result.userId, r.id);
        close();
      },
    }),
  );
  const locked = task.isPending;
  return (
    <FormDialog open title="追加费用修正" busy={task.isPending} onClose={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (task.isPending) return;
          task.mutate({ requestId: r.id, amount, reason });
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
          <HStack>
            <PrimaryButton type="submit" loading={task.isPending}>
              确认修正
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
