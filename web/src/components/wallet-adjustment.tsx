import { Button, HStack, Stack, Text } from '@chakra-ui/react';
import { useMutation } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { useRef, useState } from 'react';

import { useAuth } from '../lib/auth';
import { displayMoney, formError } from '../lib/format';
import { invalidateUser, trpc } from '../lib/trpc';
import { ErrorText, FormDialog, FormInput, PrimaryButton } from './ui';

export function WalletAdjustmentDialog({
  userId,
  username,
  balance,
  currency,
  onClose,
}: {
  userId: string;
  username: string;
  balance: string;
  currency: string;
  onClose: () => void;
}) {
  const { data: user } = useAuth();
  const storageKey = `ohmyapi:adjust:${user?.id}:${userId}`;
  const [saved] = useState<{ amount: string; reason: string; id: string } | null>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
      return value &&
        typeof value.amount === 'string' &&
        typeof value.reason === 'string' &&
        typeof value.id === 'string'
        ? value
        : null;
    } catch {
      return null;
    }
  });
  const [amount, setAmount] = useState(saved?.amount ?? '');
  const [reason, setReason] = useState(saved?.reason ?? '');
  const operation = useRef(saved);
  const task = useMutation(
    trpc.admin.wallet.adjust.mutationOptions({
      onMutate: () => {
        sessionStorage.setItem(storageKey, JSON.stringify(operation.current));
      },
      onError: (error) => {
        if (
          error instanceof TRPCClientError &&
          ['BAD_REQUEST', 'FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND', 'CONFLICT'].includes(error.data?.code)
        ) {
          operation.current = null;
          sessionStorage.removeItem(storageKey);
        }
      },
      onSuccess: async () => {
        operation.current = null;
        sessionStorage.removeItem(storageKey);
        setAmount('');
        setReason('');
        await invalidateUser(userId);
        onClose();
      },
    }),
  );
  const error = formError(task.error);
  return (
    <FormDialog open title="调整余额" onClose={onClose} busy={task.isPending}>
      <Stack gap="5">
        <Stack gap="1">
          <Text fontWeight="600" overflowWrap="anywhere">
            {username}
          </Text>
          <Text fontSize="sm" color="gray.500">
            当前余额：{displayMoney(balance)} {currency}
          </Text>
        </Stack>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (task.isPending) return;
            operation.current ??= { amount, reason: reason.trim(), id: crypto.randomUUID() };
            const request = operation.current;
            task.mutate({ userId, amount: request.amount, reason: request.reason, idempotencyKey: request.id });
          }}
        >
          <Stack gap="5">
            <FormInput
              label={`调整金额（${currency}）`}
              inputMode="decimal"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                task.reset();
              }}
              required
              maxLength={30}
              helper="正数充值，负数扣费；最多六位小数"
              error={error?.fields.amount?.[0]}
              disabled={task.isPending || Boolean(operation.current)}
            />
            <FormInput
              label="原因（选填）"
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                task.reset();
              }}
              maxLength={300}
              error={error?.fields.reason?.[0]}
              disabled={task.isPending || Boolean(operation.current)}
            />
            <ErrorText>{error?.message}</ErrorText>
            <HStack flexWrap="wrap">
              <PrimaryButton type="submit" loading={task.isPending}>
                {operation.current ? '重试调整' : '确认调整'}
              </PrimaryButton>
              <Button variant="ghost" disabled={task.isPending} onClick={onClose}>
                取消
              </Button>
            </HStack>
            {operation.current && !task.isPending && (
              <Text fontSize="sm" color="gray.500">
                上次调整结果尚未确认，请重试。
              </Text>
            )}
          </Stack>
        </form>
      </Stack>
    </FormDialog>
  );
}
