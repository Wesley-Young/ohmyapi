import { Button, HStack, Stack, Text } from '@chakra-ui/react';
import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import { refreshUser } from '../lib/cache';
import { displayMoney, formError } from '../lib/format';
import { trpc } from '../lib/trpc';
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
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  // 同一内容的重试沿用同一标识，网络中断后重试不会重复调账；修改内容即换新标识。
  const idempotencyKey = useRef<string | undefined>(undefined);
  const task = useMutation(
    trpc.admin.wallet.adjust.mutationOptions({
      onSuccess: async () => {
        idempotencyKey.current = undefined;
        setAmount('');
        setReason('');
        await refreshUser(userId);
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
            idempotencyKey.current ??= crypto.randomUUID();
            task.mutate({ userId, amount, reason: reason.trim(), idempotencyKey: idempotencyKey.current });
          }}
        >
          <Stack gap="5">
            <FormInput
              label={`调整金额（${currency}）`}
              inputMode="decimal"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                idempotencyKey.current = undefined;
                task.reset();
              }}
              required
              maxLength={30}
              helper="正数充值，负数扣费；最多六位小数"
              error={error?.fields.amount?.[0]}
              disabled={task.isPending}
            />
            <FormInput
              label="原因（选填）"
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                idempotencyKey.current = undefined;
                task.reset();
              }}
              maxLength={300}
              error={error?.fields.reason?.[0]}
              disabled={task.isPending}
            />
            <ErrorText>{error?.message}</ErrorText>
            <HStack flexWrap="wrap">
              <PrimaryButton type="submit" loading={task.isPending}>
                确认调整
              </PrimaryButton>
              <Button variant="ghost" disabled={task.isPending} onClick={onClose}>
                取消
              </Button>
            </HStack>
          </Stack>
        </form>
      </Stack>
    </FormDialog>
  );
}
