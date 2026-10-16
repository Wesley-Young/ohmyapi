import { Badge, Box, Button, Checkbox, Code, HStack, Input, Stack, Table, Text } from '@chakra-ui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Pencil, Settings2, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { IconButton } from '../components/icon-button';
import {
  ConfirmAction,
  ErrorText,
  FormDialog,
  FormInput,
  Loading,
  NameAction,
  PageControls,
  Panel,
  PrimaryButton,
  pinnedColumn,
  Title,
} from '../components/ui';
import { UserDialog } from '../components/user-dialog';
import { UserRoleAction } from '../components/user-role-action';
import { WalletAdjustmentDialog } from '../components/wallet-adjustment';
import { refreshGrants, refreshUser } from '../lib/cache';
import { displayMoney, formError, localDate } from '../lib/format';
import { queryClient, trpc, trpcClient } from '../lib/trpc';

export default function Users() {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [draftSearch, setDraftSearch] = useState('');
  const data = useQuery(trpc.admin.users.list.queryOptions({ page, search }));
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState<string>();
  const [adjustingUser, setAdjustingUser] = useState<{ id: string; username: string; balance: string } | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [sync, setSync] = useState(true);
  const groups = useQuery({ ...trpc.admin.groups.list.queryOptions(), enabled: creating });
  const defaults = useQuery({ ...trpc.admin.users.createDefaults.queryOptions(), enabled: creating });
  const [initialBalance, setInitialBalance] = useState<string>();
  const balanceValue = initialBalance ?? (defaults.data ? displayMoney(defaults.data.initialBalance) : '');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string>();
  const task = useMutation(
    trpc.admin.users.create.mutationOptions({
      onSuccess: async () => {
        setPassword('');
        setCopied(false);
        setCopyError(undefined);
        setCreating(false);
        setUsername('');
        setGroupIds([]);
        setSync(true);
        setInitialBalance(undefined);
        setPage(0);
        await Promise.all([queryClient.invalidateQueries(trpc.admin.users.list.pathFilter()), refreshGrants()]);
      },
    }),
  );
  const credentials = task.data;
  const error = formError(task.error);
  return (
    <Stack gap="7">
      <Title
        action={
          <PrimaryButton
            size="sm"
            disabled={Boolean(credentials)}
            onClick={() => {
              setCreating(!creating);
              task.reset();
            }}
          >
            创建用户
          </PrimaryButton>
        }
      >
        用户
      </Title>
      {managing && <UserDialog key={managing} userId={managing} onClose={() => setManaging(undefined)} />}
      {adjustingUser && data.data && (
        <WalletAdjustmentDialog
          key={adjustingUser.id}
          userId={adjustingUser.id}
          username={adjustingUser.username}
          balance={adjustingUser.balance}
          currency={data.data.currency}
          onClose={() => setAdjustingUser(null)}
        />
      )}
      {credentials && (
        <Panel>
          <Stack gap="4">
            <HStack gap="2" flexWrap="wrap">
              <Text fontWeight="600" overflowWrap="anywhere">
                {credentials.user.username}
              </Text>
              <Badge colorPalette="green">已创建</Badge>
              {credentials.joined > 0 && <Badge colorPalette="gray">加入 {credentials.joined} 个用户组</Badge>}
              {Number(credentials.initialBalance) > 0 && (
                <Badge colorPalette="gray">初始余额 {displayMoney(credentials.initialBalance)}</Badge>
              )}
              {credentials.syncedChannels > 0 && (
                <Badge colorPalette="gray">同步 {credentials.syncedChannels} 个渠道</Badge>
              )}
            </HStack>
            <Text fontSize="sm" color="gray.500">
              请保存密码，关闭后无法再次查看。
            </Text>
            <Code p="4" alignSelf="start" userSelect="all">
              {credentials.password}
            </Code>
            <HStack flexWrap="wrap">
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(credentials.password);
                    setCopied(true);
                  } catch {
                    setCopyError('复制失败，请手动选择并复制密码');
                  }
                }}
              >
                {copied ? '已复制' : '复制密码'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCopyError(undefined);
                  task.reset();
                }}
              >
                关闭
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setManaging(credentials.user.id)}>
                管理用户
              </Button>
            </HStack>
            <ErrorText>{copyError ?? error?.message}</ErrorText>
          </Stack>
        </Panel>
      )}
      {creating && (
        <FormDialog
          open
          title="创建用户"
          onClose={() => {
            setCreating(false);
            setPassword('');
            setGroupIds([]);
            setSync(true);
            setInitialBalance(undefined);
            task.reset();
          }}
          busy={task.isPending}
        >
          <Box maxW="400px">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!task.isPending)
                  task.mutate({
                    username,
                    password: password || undefined,
                    groupIds,
                    sync: groupIds.length > 0 && sync,
                    initialBalance: balanceValue.trim() || undefined,
                  });
              }}
            >
              <Stack gap="5">
                <FormInput
                  label="用户名"
                  value={username}
                  autoComplete="off"
                  required
                  minLength={3}
                  maxLength={64}
                  onChange={(event) => setUsername(event.target.value)}
                  error={error?.fields.username?.[0]}
                />
                <FormInput
                  label="密码（可选）"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  minLength={8}
                  maxLength={1024}
                  onChange={(event) => setPassword(event.target.value)}
                  error={error?.fields.password?.[0]}
                  helper="留空自动生成 16 字符密码"
                />
                <FormInput
                  label={`初始余额${defaults.data ? `（${defaults.data.currency}）` : ''}`}
                  inputMode="decimal"
                  autoComplete="off"
                  value={balanceValue}
                  disabled={defaults.isPending}
                  onChange={(event) => setInitialBalance(event.target.value)}
                  error={error?.fields.initialBalance?.[0] ?? formError(defaults.error)?.message}
                />
                <Stack gap="3" as="fieldset">
                  <Text as="legend" fontSize="sm" fontWeight="500" mb="3">
                    用户组
                  </Text>
                  <ErrorText>{formError(groups.error)?.message}</ErrorText>
                  {groups.isPending ? (
                    <Loading />
                  ) : (
                    groups.data && (
                      <>
                        {groups.data.map((group) => (
                          <Checkbox.Root
                            key={group.id}
                            checked={groupIds.includes(group.id)}
                            disabled={task.isPending}
                            onCheckedChange={(event) =>
                              setGroupIds((previous) =>
                                event.checked ? [...previous, group.id] : previous.filter((id) => id !== group.id),
                              )
                            }
                          >
                            <Checkbox.HiddenInput />
                            <Checkbox.Control />
                            <Checkbox.Label overflowWrap="anywhere">{group.name}</Checkbox.Label>
                          </Checkbox.Root>
                        ))}
                        {!groups.data.length && (
                          <Text color="gray.500" fontSize="sm">
                            暂无用户组
                          </Text>
                        )}
                      </>
                    )
                  )}
                </Stack>
                {groupIds.length > 0 && (
                  <Checkbox.Root
                    checked={sync}
                    disabled={task.isPending}
                    onCheckedChange={(event) => setSync(event.checked === true)}
                  >
                    <Checkbox.HiddenInput />
                    <Checkbox.Control />
                    <Checkbox.Label>同步各组现有成员共有的渠道</Checkbox.Label>
                  </Checkbox.Root>
                )}
                <ErrorText>{copyError ?? error?.message}</ErrorText>
                <HStack>
                  <PrimaryButton type="submit" loading={task.isPending}>
                    创建用户
                  </PrimaryButton>
                  <Button
                    variant="ghost"
                    disabled={task.isPending}
                    onClick={() => {
                      setCreating(false);
                      setPassword('');
                      setGroupIds([]);
                      setSync(true);
                      setInitialBalance(undefined);
                      task.reset();
                    }}
                  >
                    取消
                  </Button>
                </HStack>
              </Stack>
            </form>
          </Box>
        </FormDialog>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setPage(0);
          setSearch(draftSearch.trim());
        }}
      >
        <HStack maxW="440px">
          <Input
            aria-label="搜索用户名"
            placeholder="搜索用户名"
            value={draftSearch}
            maxLength={64}
            onChange={(event) => setDraftSearch(event.target.value)}
          />
          <Button variant="outline" type="submit">
            搜索
          </Button>
        </HStack>
      </form>
      <ErrorText>{formError(data.error)?.message}</ErrorText>
      {data.isPending ? (
        <Loading />
      ) : (
        data.data && (
          <>
            {data.data.items.length ? (
              <Box overflowX="auto">
                <Table.Root size="sm" whiteSpace="nowrap">
                  <Table.Header>
                    <Table.Row>
                      <Table.ColumnHeader>用户名</Table.ColumnHeader>
                      <Table.ColumnHeader>角色</Table.ColumnHeader>
                      <Table.ColumnHeader>状态</Table.ColumnHeader>
                      <Table.ColumnHeader textAlign="end">余额（{data.data.currency}）</Table.ColumnHeader>
                      <Table.ColumnHeader>创建时间</Table.ColumnHeader>
                      <Table.ColumnHeader {...pinnedColumn}>操作</Table.ColumnHeader>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {data.data.items.map((user) => (
                      <Table.Row key={user.id}>
                        <Table.Cell>
                          <NameAction onClick={() => setManaging(user.id)}>{user.username}</NameAction>
                        </Table.Cell>
                        <Table.Cell>
                          <Badge>{user.role === 'admin' ? '管理员' : '普通用户'}</Badge>
                        </Table.Cell>
                        <Table.Cell color={user.status === 'disabled' ? 'gray.500' : undefined}>
                          {user.status === 'active' ? '启用' : '已禁用'}
                        </Table.Cell>
                        <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums">
                          <HStack justify="end" gap="1">
                            <Text as="span">{displayMoney(user.balance)}</Text>
                            <IconButton
                              type="button"
                              variant="ghost"
                              size="xs"
                              aria-label={`调整「${user.username}」的余额`}
                              title="调整余额"
                              onClick={() => setAdjustingUser(user)}
                            >
                              <Pencil size={14} strokeWidth={1.75} aria-hidden="true" focusable="false" />
                            </IconButton>
                          </HStack>
                        </Table.Cell>
                        <Table.Cell>{localDate(user.createdAt)}</Table.Cell>
                        <Table.Cell {...pinnedColumn}>
                          <HStack gap="1">
                            <IconButton
                              size="sm"
                              variant="ghost"
                              aria-label={`管理「${user.username}」`}
                              onClick={() => setManaging(user.id)}
                            >
                              <Settings2 size={16} aria-hidden="true" />
                            </IconButton>
                            <UserRoleAction user={user} compact />
                            {user.role === 'user' && (
                              <ConfirmAction
                                label="删除"
                                icon={<Trash2 size={16} aria-hidden="true" />}
                                danger
                                description={`删除用户「${user.username}」后，其会话和所有 API Key 将失效。余额、历史请求与流水保留。`}
                                action={() => trpcClient.admin.users.delete.mutate({ userId: user.id })}
                                onSuccess={async () => {
                                  if (credentials?.user.id === user.id) task.reset();
                                  setPage(0);
                                  await refreshUser(user.id);
                                }}
                              />
                            )}
                          </HStack>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              </Box>
            ) : (
              <Text py="8" color="gray.500" fontSize="sm">
                没有匹配的用户
              </Text>
            )}
            <PageControls page={page} hasMore={data.data.hasMore} onPage={setPage} />
          </>
        )
      )}
    </Stack>
  );
}
