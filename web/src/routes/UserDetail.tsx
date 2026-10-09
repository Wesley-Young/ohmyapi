import { Badge, Box, Heading, HStack, Link, Stack, Text } from '@chakra-ui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router';

import { ChannelGrants } from '../components/channel-grants';
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
import { formError } from '../lib/format';
import { invalidateUser, trpc, trpcClient } from '../lib/trpc';

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
              minLength={8}
              maxLength={1024}
              required
              error={error?.fields.password?.[0]}
              helper="至少 8 个字符；会话和 API Key 将失效"
            />
            <ErrorText>{error?.message}</ErrorText>
            {task.isSuccess && (
              <Text role="status" fontSize="sm">
                密码已重置
              </Text>
            )}
            <PrimaryButton type="submit" alignSelf="start" loading={task.isPending}>
              重置
            </PrimaryButton>
          </Stack>
        </form>
      </Stack>
    </Panel>
  );
}

export default function UserDetail() {
  const userId = useParams().userId ?? '';
  const navigate = useNavigate();
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
                <HStack gap="3" flexWrap="wrap">
                  {user.data.role === 'user' && !user.data.deleted && (
                    <>
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
                      <ConfirmAction
                        label="删除用户"
                        danger
                        description={`删除用户「${user.data.username}」后，其会话和所有 API Key 将失效。余额、历史请求与流水保留。`}
                        action={() => trpcClient.admin.users.delete.mutate({ userId })}
                        onSuccess={async () => {
                          await invalidateUser(userId);
                          navigate('/console/users', { replace: true });
                        }}
                      />
                    </>
                  )}
                </HStack>
              }
            >
              <HStack gap="3">
                <Text>{user.data.username}</Text>
                <Badge
                  colorPalette={user.data.deleted || user.data.status === 'disabled' ? 'gray' : 'green'}
                  letterSpacing="normal"
                >
                  {user.data.deleted ? '已删除' : user.data.status === 'active' ? '启用' : '已禁用'}
                </Badge>
              </HStack>
            </Title>
            <WalletSummary wallet={wallet.data} />
            <Box>
              <WalletReconciliation userId={userId} />
            </Box>
            {user.data.role === 'user' && !user.data.deleted && <ResetPassword key={userId} userId={userId} />}
            {user.data.role === 'user' && !user.data.deleted && <ChannelGrants key={userId} userId={userId} />}
            {user.data.role === 'user' && !user.data.deleted && (
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
