import { Badge, HStack, Stack, Text } from '@chakra-ui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { refreshUser } from '../lib/cache';
import { formError } from '../lib/format';
import { trpc, trpcClient } from '../lib/trpc';
import { ChannelBlocks, ChannelGrants } from './channel-grants';
import { UserGroups } from './group-members';
import { ConfirmAction, ErrorText, FormDialog, FormInput, Loading, PageControls, PrimaryButton, Section } from './ui';
import { UserRoleAction } from './user-role-action';
import { Ledger, WalletSummary } from './wallet';
import { WalletReconciliation } from './wallet-reconciliation';

function ResetPassword({ userId }: { userId: string }) {
  const [password, setPassword] = useState('');
  const task = useMutation(
    trpc.admin.users.resetPassword.mutationOptions({
      onSuccess: async () => {
        setPassword('');
        await refreshUser(userId);
      },
    }),
  );
  const error = formError(task.error);
  return (
    <Section title="重置密码">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!task.isPending) task.mutate({ userId, password });
        }}
      >
        <Stack gap="5" maxW="400px">
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
    </Section>
  );
}

/** 管理单个用户：账号状态、钱包、密码、用户组、渠道授权与屏蔽、资金流水。 */
export function UserDialog({ userId, onClose }: { userId: string; onClose: () => void }) {
  const [page, setPage] = useState(0);
  const user = useQuery(trpc.admin.users.get.queryOptions({ userId }));
  const wallet = useQuery(trpc.admin.wallet.get.queryOptions({ userId }));
  const ledger = useQuery(trpc.admin.wallet.ledger.queryOptions({ userId, page }));
  const managed = user.data?.role === 'user' && !user.data.deleted;
  return (
    <FormDialog open size="xl" title={user.data?.username ?? '用户'} onClose={onClose}>
      <Stack gap="6">
        <ErrorText>{formError(user.error ?? wallet.error ?? ledger.error)?.message}</ErrorText>
        {user.isPending || wallet.isPending || ledger.isPending ? (
          <Loading />
        ) : (
          user.data &&
          wallet.data &&
          ledger.data && (
            <>
              <HStack justify="space-between" align="start" gap="3" flexWrap="wrap">
                <HStack gap="2" flexWrap="wrap">
                  <Badge>{user.data.role === 'admin' ? '管理员' : '普通用户'}</Badge>
                  <Badge colorPalette={user.data.deleted || user.data.status === 'disabled' ? 'gray' : 'green'}>
                    {user.data.deleted ? '已删除' : user.data.status === 'active' ? '启用' : '已禁用'}
                  </Badge>
                </HStack>
                <HStack gap="3" flexWrap="wrap">
                  {!user.data.deleted && <UserRoleAction user={user.data} />}
                  {managed && (
                    <>
                      <ConfirmAction
                        label="退出所有会话"
                        description="该用户需要重新登录，API Key 不受影响。"
                        action={async () => {
                          await trpcClient.admin.users.revokeSessions.mutate({ userId });
                          await refreshUser(userId);
                        }}
                      />
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
                          await refreshUser(userId);
                        }}
                      />
                      <ConfirmAction
                        label="删除用户"
                        danger
                        description={`删除用户「${user.data.username}」后，其会话和所有 API Key 将失效。余额、历史请求与流水保留。`}
                        action={() => trpcClient.admin.users.delete.mutate({ userId })}
                        onSuccess={async () => {
                          await refreshUser(userId);
                          onClose();
                        }}
                      />
                    </>
                  )}
                </HStack>
              </HStack>
              <WalletSummary wallet={wallet.data} />
              {managed && (
                <>
                  <ResetPassword userId={userId} />
                  <UserGroups userId={userId} />
                  <ChannelGrants userId={userId} />
                  <ChannelBlocks userId={userId} />
                </>
              )}
              <Section title="资金流水" action={<WalletReconciliation userId={userId} />}>
                <Ledger items={ledger.data.items} />
                <PageControls page={page} hasMore={ledger.data.hasMore} onPage={setPage} />
              </Section>
            </>
          )
        )}
      </Stack>
    </FormDialog>
  );
}
