import { Badge, Button, HStack, Stack, Text } from '@chakra-ui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useRef, useState } from 'react';

import { formError } from '../lib/format';
import { queryClient, trpc } from '../lib/trpc';
import { IconButton } from './icon-button';
import { ErrorText, FormDialog, PrimaryButton } from './ui';

export function OpenAIResetCredits({
  channelId,
  channelName,
  enabled,
  onBusyChange,
}: {
  channelId: string;
  channelName: string;
  enabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const [selected, setSelected] = useState<{ id: string; expiresAt: string; redeemRequestId: string }>();
  const [notice, setNotice] = useState<string>();
  const requestIds = useRef(new Map<string, string>());
  const creditsKey = trpc.admin.catalog.openAIResetCredits.queryKey({ channelId });
  const consume = useMutation(
    trpc.admin.catalog.consumeOpenAIResetCredit.mutationOptions({
      retry: false,
      onMutate: async () => {
        onBusyChange(true);
        setNotice(undefined);
        await queryClient.cancelQueries({ queryKey: creditsKey, exact: true });
      },
      onSuccess: (result) => {
        setSelected(undefined);
        setNotice(
          `重置卡已使用，已重置 ${result.windowsReset} 个额度窗口${result.cooldownCleared ? '' : '；本地冷却状态更新失败，请刷新渠道状态'}`,
        );
      },
      onSettled: async () => {
        await Promise.allSettled([
          queryClient.invalidateQueries({ queryKey: creditsKey, exact: true }),
          queryClient.invalidateQueries(trpc.admin.catalog.openAIQuota.queryFilter({ channelId })),
          queryClient.invalidateQueries(trpc.admin.catalog.list.queryFilter()),
        ]);
        onBusyChange(false);
      },
    }),
  );
  const query = useQuery(
    trpc.admin.catalog.openAIResetCredits.queryOptions(
      { channelId },
      {
        enabled: enabled && !consume.isPending,
        staleTime: 30_000,
        refetchInterval: 60_000,
        retry: false,
      },
    ),
  );
  const data = enabled && !query.isError ? query.data : undefined;
  const usable = (credit: { usable: boolean; expiresAt: string | null }) =>
    credit.usable && credit.expiresAt !== null && Date.parse(credit.expiresAt) > Date.now();
  const availableCredits = data?.credits.filter(usable) ?? [];
  const nextCredit = availableCredits[0];
  const canConsume = enabled && !query.isFetching && !query.isError && !!selected && nextCredit?.id === selected.id;
  return (
    <Stack gap="3" borderWidth="1px" borderColor="gray.200" borderRadius="lg" p="4">
      <HStack justify="space-between" flexWrap="wrap">
        <HStack gap="2">
          <Text fontSize="sm" fontWeight="500">
            重置卡
          </Text>
          {data && <Badge colorPalette="gray">可用 {availableCredits.length} 张</Badge>}
        </HStack>
        <HStack gap="2">
          <Button
            type="button"
            variant="outline"
            colorPalette="red"
            color="red.600"
            size="xs"
            disabled={!nextCredit || consume.isPending || query.isFetching}
            onClick={() => {
              if (!nextCredit?.expiresAt) return;
              consume.reset();
              const redeemRequestId = requestIds.current.get(nextCredit.id) ?? crypto.randomUUID();
              requestIds.current.set(nextCredit.id, redeemRequestId);
              setSelected({ id: nextCredit.id, expiresAt: nextCredit.expiresAt, redeemRequestId });
            }}
          >
            使用
          </Button>
          <IconButton
            aria-label="刷新重置卡"
            variant="ghost"
            size="xs"
            disabled={!enabled || consume.isPending || query.isFetching}
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw size={14} aria-hidden="true" />
          </IconButton>
        </HStack>
      </HStack>
      {!enabled ? (
        <Text fontSize="sm" color="gray.500">
          启用渠道并完成授权后可查询重置卡
        </Text>
      ) : query.isPending ? (
        <Text fontSize="sm" color="gray.500">
          正在查询重置卡…
        </Text>
      ) : data && !data.credits.length ? (
        <Text fontSize="sm" color="gray.500">
          暂无可用重置卡
        </Text>
      ) : (
        data?.credits.map((credit, index) => (
          <HStack key={credit.id} gap="3" flexWrap="wrap">
            <Text fontSize="sm">#{index + 1}</Text>
            {!credit.supported && <Badge colorPalette="gray">当前套餐不可用</Badge>}
            {credit.expiresAt && Date.parse(credit.expiresAt) <= Date.now() && (
              <Badge colorPalette="gray">已过期</Badge>
            )}
            {credit.expiresAt && <Badge>有效期至 {new Date(credit.expiresAt).toLocaleString()}</Badge>}
          </HStack>
        ))
      )}
      <ErrorText>{formError(query.error)?.message}</ErrorText>
      {!selected && <ErrorText>{formError(consume.error)?.message}</ErrorText>}
      {notice && (
        <Text fontSize="sm" role="status">
          {notice}
        </Text>
      )}
      {selected && (
        <FormDialog open title="使用重置卡" busy={consume.isPending} onClose={() => setSelected(undefined)}>
          <Stack gap="4">
            <Text fontSize="sm">
              将为渠道「{channelName}」消耗最近到期的 1 张可用重置卡。重置卡使用后无法撤销。
            </Text>
            <Text fontSize="sm" color="gray.500">
              所选卡有效期至 {new Date(selected.expiresAt).toLocaleString()}
            </Text>
            <ErrorText>{formError(consume.error)?.message}</ErrorText>
            {!consume.isPending && !query.isFetching && nextCredit?.id !== selected.id && (
              <ErrorText>可用重置卡已变化，请关闭后重新确认。</ErrorText>
            )}
            <HStack justify="end">
              <Button type="button" variant="ghost" disabled={consume.isPending} onClick={() => setSelected(undefined)}>
                取消
              </Button>
              <PrimaryButton
                type="button"
                bg="red.600"
                _hover={{ bg: 'red.700' }}
                disabled={!canConsume || consume.isPending}
                loading={consume.isPending}
                onClick={() =>
                  consume.mutate({ channelId, creditId: selected.id, redeemRequestId: selected.redeemRequestId })
                }
              >
                确认使用
              </PrimaryButton>
            </HStack>
          </Stack>
        </FormDialog>
      )}
    </Stack>
  );
}
