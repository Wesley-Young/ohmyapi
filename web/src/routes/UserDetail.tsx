import { Box, Grid, Heading, HStack, Link, Stack, Text } from '@chakra-ui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { useRef, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router';

import { ModelGrants } from '../components/model-grants';
import { WalletReconciliation } from '../components/request-billing';
import {
  ConfirmAction,
  ErrorText,
  FormInput,
  Loading,
  PageControls,
  Panel,
  PrimaryButton,
  Title,
} from '../components/ui';
import { Ledger, WalletSummary } from '../components/wallet';
import { useAuth } from '../lib/auth';
import { formError } from '../lib/format';
import { invalidateUser, trpc, trpcClient } from '../lib/trpc';

function Adjustment({ userId }: { userId: string }) {
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
      },
    }),
  );
  const error = formError(task.error);
  return (
    <Panel>
      <Stack gap="5">
        <Heading as="h2" fontSize="lg">
          调整余额
        </Heading>
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
              label="调整金额"
              inputMode="decimal"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                task.reset();
              }}
              required
              maxLength={30}
              helper="正数增加，负数扣减；最多六位小数"
              error={error?.fields.amount?.[0]}
              disabled={task.isPending || Boolean(operation.current)}
            />
            <FormInput
              label="原因"
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                task.reset();
              }}
              required
              maxLength={300}
              error={error?.fields.reason?.[0]}
              disabled={task.isPending || Boolean(operation.current)}
            />
            <ErrorText>{error?.message}</ErrorText>
            {task.isSuccess && (
              <Text role="status" fontSize="sm">
                余额已调整
              </Text>
            )}
            <HStack flexWrap="wrap">
              <PrimaryButton type="submit" loading={task.isPending}>
                {operation.current ? '重试调整' : '确认调整'}
              </PrimaryButton>
            </HStack>
            {operation.current && !task.isPending && (
              <Text fontSize="sm" color="gray.500">
                上次调整结果尚未确认，请重试。
              </Text>
            )}
          </Stack>
        </form>
      </Stack>
    </Panel>
  );
}

function ResetPassword({ userId }: { userId: string }) {
  const [password, setPassword] = useState('');
  const task = useMutation(
    trpc.admin.users.resetPassword.mutationOptions({
      onSuccess: async () => {
        setPassword('');
        await invalidateUser(userId);
      },
    }),
  );
  const error = formError(task.error);
  return (
    <Panel>
      <Stack gap="5">
        <Heading as="h2" fontSize="lg">
          重置密码
        </Heading>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!task.isPending) task.mutate({ userId, password });
          }}
        >
          <Stack gap="5">
            <FormInput
              label="新密码"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                task.reset();
              }}
              minLength={12}
              maxLength={1024}
              required
              error={error?.fields.password?.[0]}
              helper="至少 12 个字符；会话和 API Key 将失效"
            />
            <ErrorText>{error?.message}</ErrorText>
            {task.isSuccess && (
              <Text role="status" fontSize="sm">
                密码已重置
              </Text>
            )}
            <PrimaryButton type="submit" alignSelf="start" loading={task.isPending}>
              重置密码
            </PrimaryButton>
          </Stack>
        </form>
      </Stack>
    </Panel>
  );
}

export default function UserDetail() {
  const userId = useParams().userId ?? '';
  const [page, setPage] = useState(0);
  const user = useQuery(trpc.admin.users.get.queryOptions({ userId }));
  const wallet = useQuery(trpc.admin.wallet.get.queryOptions({ userId }));
  const ledger = useQuery(trpc.admin.wallet.ledger.queryOptions({ userId, page }));
  return (
    <Stack gap="7">
      <Link asChild color="gray.500" fontSize="sm" alignSelf="start">
        <RouterLink to="/console/users">← 用户</RouterLink>
      </Link>
      <ErrorText>{formError(user.error ?? wallet.error ?? ledger.error)?.message}</ErrorText>
      {user.isPending || wallet.isPending || ledger.isPending ? (
        <Loading />
      ) : (
        user.data &&
        wallet.data &&
        ledger.data && (
          <>
            <Title
              action={
                <HStack gap="3">
                  <Text fontSize="sm" color="gray.500">
                    {user.data.status === 'active' ? '启用' : '已禁用'}
                  </Text>
                  {user.data.role === 'user' && (
                    <ConfirmAction
                      label={user.data.status === 'active' ? '禁用' : '启用'}
                      description={
                        user.data.status === 'active'
                          ? '该用户的会话将失效，API Key 将暂停访问。'
                          : '重新允许该用户登录及使用尚未撤销的 API Key。'
                      }
                      action={async () => {
                        await trpcClient.admin.users.setStatus.mutate({
                          userId,
                          status: user.data?.status === 'active' ? 'disabled' : 'active',
                        });
                        await invalidateUser(userId);
                      }}
                    />
                  )}
                </HStack>
              }
            >
              {user.data.username}
            </Title>
            <WalletSummary wallet={wallet.data} />
            <Box>
              <WalletReconciliation userId={userId} />
            </Box>
            <Grid templateColumns={{ base: '1fr', md: '1fr 1fr' }} gap="5">
              <Adjustment key={userId} userId={userId} />
              {user.data.role === 'user' && <ResetPassword key={userId} userId={userId} />}
            </Grid>
            {user.data.role === 'user' && <ModelGrants key={userId} userId={userId} />}
            {user.data.role === 'user' && (
              <Box>
                <ConfirmAction
                  label="退出所有会话"
                  description="该用户需要重新登录，API Key 不受影响。"
                  action={async () => {
                    await trpcClient.admin.users.revokeSessions.mutate({ userId });
                    await invalidateUser(userId);
                  }}
                />
              </Box>
            )}
            <Stack gap="4">
              <Heading as="h2" fontSize="lg">
                资金流水
              </Heading>
              <Ledger items={ledger.data.items} />
              <PageControls page={page} hasMore={ledger.data.hasMore} onPage={setPage} />
            </Stack>
          </>
        )
      )}
    </Stack>
  );
}
