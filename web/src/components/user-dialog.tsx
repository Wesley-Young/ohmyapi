import { Badge, Separator, Stack, Text } from '@chakra-ui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { refreshUser } from '../lib/cache';
import { formError, localDate } from '../lib/format';
import { trpc, trpcClient } from '../lib/trpc';
import { ChannelBlocks, ChannelGrants } from './channel-grants';
import { UserGroups } from './group-members';
import {
  ConfirmAction,
  ErrorText,
  Facts,
  FormDialog,
  FormInput,
  Loading,
  PageControls,
  PrimaryButton,
  Section,
  SettingRow,
} from './ui';
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

function ConcurrencyLimit({ userId, value, fallback }: { userId: string; value: number | null; fallback: number }) {
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  const task = useMutation(
    trpc.admin.users.setConcurrency.mutationOptions({
      onSuccess: () => refreshUser(userId),
    }),
  );
  const error = formError(task.error);
  return (
    <Section title="并发上限">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!task.isPending) task.mutate({ userId, maxConcurrent: draft.trim() ? Number(draft) : null });
        }}
      >
        <Stack gap="5" maxW="400px">
          <FormInput
            label="同时进行的请求数"
            type="number"
            min={1}
            max={1000}
            value={draft}
            placeholder={String(fallback)}
            onChange={(event) => {
              setDraft(event.target.value);
              task.reset();
            }}
            error={error?.fields.maxConcurrent?.[0]}
            helper={`1–1000，留空使用全局配置（${fallback}）`}
          />
          <ErrorText>{error?.message}</ErrorText>
          {task.isSuccess && (
            <Text role="status" fontSize="sm">
              已保存
            </Text>
          )}
          <PrimaryButton type="submit" alignSelf="start" loading={task.isPending}>
            保存
          </PrimaryButton>
        </Stack>
      </form>
    </Section>
  );
}

type AccountUser = { id: string; username: string; role: 'admin' | 'user'; status: 'active' | 'disabled' };

function Account({ user, onDeleted }: { user: AccountUser; onDeleted: () => void }) {
  const userId = user.id;
  const active = user.status === 'active';
  return (
    <Section title="账号操作">
      <Stack gap="4" separator={<Separator borderColor="gray.100" />}>
        {user.role === 'user' && (
          <SettingRow
            title="状态"
            hint={
              active ? '目前启用，禁用后会话失效，API Key 暂停访问' : '目前禁用，启用后可重新登录并使用未撤销的 API Key'
            }
            action={
              <ConfirmAction
                label={active ? '禁用用户' : '启用用户'}
                description={
                  active ? '该用户的会话将失效，API Key 将暂停访问。' : '重新允许该用户登录及使用尚未撤销的 API Key。'
                }
                action={async () => {
                  await trpcClient.admin.users.setStatus.mutate({ userId, status: active ? 'disabled' : 'active' });
                  await refreshUser(userId);
                }}
              />
            }
          />
        )}
        {user.role === 'user' && (
          <SettingRow
            title="登录会话"
            hint="强制重新登录，API Key 不受影响"
            action={
              <ConfirmAction
                label="退出所有会话"
                description="该用户需要重新登录，API Key 不受影响。"
                action={async () => {
                  await trpcClient.admin.users.revokeSessions.mutate({ userId });
                  await refreshUser(userId);
                }}
              />
            }
          />
        )}
        <SettingRow
          title="角色"
          hint={user.role === 'admin' ? '降级后失去管理员权限' : '提升后可管理用户、渠道、定价和余额'}
          action={<UserRoleAction user={user} />}
        />
        {user.role === 'user' && (
          <SettingRow
            title="删除用户"
            hint="会话和 API Key 失效，余额、请求与流水保留"
            action={
              <ConfirmAction
                label="删除用户"
                danger
                description={`删除用户「${user.username}」后，其会话和所有 API Key 将失效。余额、历史请求与流水保留。`}
                action={() => trpcClient.admin.users.delete.mutate({ userId })}
                onSuccess={async () => {
                  await refreshUser(userId);
                  onDeleted();
                }}
              />
            }
          />
        )}
      </Stack>
    </Section>
  );
}

/** 管理单个用户：账号状态与角色、并发上限、钱包、密码、用户组、渠道授权与屏蔽、资金流水。 */
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
              <Facts
                items={[
                  { label: '角色', value: <Badge>{user.data.role === 'admin' ? '管理员' : '普通用户'}</Badge> },
                  {
                    label: '状态',
                    value: (
                      <Badge colorPalette={user.data.deleted || user.data.status === 'disabled' ? 'gray' : 'green'}>
                        {user.data.deleted ? '已删除' : user.data.status === 'active' ? '启用' : '已禁用'}
                      </Badge>
                    ),
                  },
                  { label: '创建时间', value: localDate(user.data.createdAt) },
                ]}
              />
              <WalletSummary wallet={wallet.data} />
              {!user.data.deleted && <Account user={user.data} onDeleted={onClose} />}
              {!user.data.deleted && (
                <ConcurrencyLimit
                  userId={userId}
                  value={user.data.maxConcurrent}
                  fallback={user.data.defaultMaxConcurrent}
                />
              )}
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
