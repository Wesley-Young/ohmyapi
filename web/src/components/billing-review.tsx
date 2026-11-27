import { Button, Grid, HStack, Stack, Text } from '@chakra-ui/react';
import type { RouterInputs, RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { refreshBatchBilling, refreshRequestBilling } from '../lib/cache';
import { displayAmount, formError } from '../lib/format';
import { queryClient, trpc } from '../lib/trpc';
import { SelectField } from './fields';
import { ErrorText, Facts, FormDialog, FormInput, Loading, PrimaryButton } from './ui';

type Detail = RouterOutputs['requestDetail'];
type Resolution = RouterInputs['admin']['billing']['resolve'];

type BatchResult = RouterOutputs['admin']['billing']['resolveBatch'];

/** 批量核对：服务端按保存的用量分类，弹窗先展示分类数量，确认后结算。 */
export function BulkBilling({
  requestIds,
  onSuccess,
}: {
  requestIds: string[];
  onSuccess: (result: BatchResult) => void;
}) {
  const [ids, setIds] = useState<string[]>();
  return (
    <>
      <PrimaryButton size="sm" disabled={!requestIds.length} onClick={() => setIds([...requestIds])}>
        批量结算
      </PrimaryButton>
      {ids && (
        <BulkBillingDialog
          ids={ids}
          close={() => setIds(undefined)}
          onSuccess={(result) => {
            onSuccess(result);
            setIds(undefined);
          }}
        />
      )}
    </>
  );
}

function BulkBillingDialog({
  ids,
  close,
  onSuccess,
}: {
  ids: string[];
  close: () => void;
  onSuccess: (result: BatchResult) => void;
}) {
  const [reason, setReason] = useState('管理员批量核对');
  const plan = useQuery(trpc.admin.billing.batchPlan.queryOptions({ requestIds: ids }, { staleTime: 0 }));
  const task = useMutation(
    trpc.admin.billing.resolveBatch.mutationOptions({
      // 部分请求可能已被其他人处理，刷新列表后重新选择。
      onError: () => void queryClient.invalidateQueries(trpc.admin.requests.pathFilter()),
      onSuccess: async (result) => {
        await refreshBatchBilling(result.userIds);
        onSuccess(result);
      },
    }),
  );
  const p = plan.data;
  const count = p ? p.usage.count + p.zero : 0;
  return (
    <FormDialog open title="批量结算" busy={task.isPending} onClose={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (task.isPending) return;
          task.mutate({ requestIds: ids, reason });
        }}
      >
        <Stack gap="5">
          {plan.isPending && <Loading />}
          <ErrorText>{formError(plan.error)?.message}</ErrorText>
          {p && (
            <Facts
              items={[
                {
                  label: '按记录用量结算',
                  value: `${p.usage.count} 个，共 ${displayAmount(p.usage.amount, p.currency)}`,
                },
                { label: '无用量，按 0 结算', value: `${p.zero} 个` },
                { label: '需逐条核对', value: `${p.manual} 个` },
              ]}
            />
          )}
          {!!p?.manual && (
            <Text fontSize="sm" color="gray.500">
              缓存用量未知或无法计价的请求保持待核对。
            </Text>
          )}
          {!!p?.stale && <ErrorText>{p.stale} 个请求已发生状态变化，请关闭后重新选择</ErrorText>}
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
            <PrimaryButton type="submit" loading={task.isPending} disabled={!count || !!p?.stale}>
              确认结算 ({count})
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

function ResolutionForm({ r, close }: { r: Detail; close: () => void }) {
  const [action, setAction] = useState<Resolution['action']>(r.preview ? 'settle_usage' : 'settle_amount');
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [usage, setUsage] = useState({
    generatedImages: r.usage?.generatedImages ?? '',
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
            usage:
              action === 'settle_usage'
                ? {
                    ...usage,
                    generatedImages: r.endpoint === '/v1/images' ? usage.generatedImages : undefined,
                  }
                : undefined,
          });
        }}
      >
        <Stack gap="5">
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
              {(r.endpoint === '/v1/images'
                ? ([['generatedImages', '实际出图张数']] as const)
                : ([
                    ['inputTokens', '普通输入 Token'],
                    ['outputTokens', '输出 Token'],
                    ['cacheReadTokens', '缓存读取 Token'],
                    ['cacheWriteTokens', '缓存写入 Token'],
                    ['webSearchCalls', 'Web Search 调用次数'],
                    ['webSearchPreviewCalls', 'Web Search Preview 调用次数'],
                  ] as const)
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
              helper="最多六位小数"
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
