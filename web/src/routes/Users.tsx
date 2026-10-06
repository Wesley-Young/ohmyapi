import { Box, Button, Code, HStack, Input, Link, Stack, Table, Text } from '@chakra-ui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router';

import { ErrorText, FormInput, Loading, PageControls, Panel, PrimaryButton, Title } from '../components/ui';
import { displayMoney, formError, localDate } from '../lib/format';
import { queryClient, trpc } from '../lib/trpc';

export default function Users() {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [draftSearch, setDraftSearch] = useState('');
  const data = useQuery(trpc.admin.users.list.queryOptions({ page, search }));
  const [creating, setCreating] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
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
        setPage(0);
        await queryClient.invalidateQueries(trpc.admin.users.list.pathFilter());
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
      {credentials && (
        <Panel>
          <Stack gap="4">
            <Text fontWeight="600">用户已创建 · {credentials.user.username}</Text>
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
              <Link asChild color="#635bff" fontSize="sm">
                <RouterLink to={`/console/users/${credentials.user.id}`}>管理用户</RouterLink>
              </Link>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCopyError(undefined);
                  task.reset();
                }}
              >
                已保存
              </Button>
            </HStack>
            <ErrorText>{copyError ?? error?.message}</ErrorText>
          </Stack>
        </Panel>
      )}
      {creating && (
        <Panel>
          <Box maxW="400px">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!task.isPending) task.mutate({ username, password: password || undefined });
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
                  minLength={12}
                  maxLength={1024}
                  onChange={(event) => setPassword(event.target.value)}
                  error={error?.fields.password?.[0]}
                  helper="留空自动生成 16 字符密码"
                />
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
                      task.reset();
                    }}
                  >
                    取消
                  </Button>
                </HStack>
              </Stack>
            </form>
          </Box>
        </Panel>
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
                <Table.Root size="sm">
                  <Table.Header>
                    <Table.Row>
                      <Table.ColumnHeader>用户名</Table.ColumnHeader>
                      <Table.ColumnHeader>角色</Table.ColumnHeader>
                      <Table.ColumnHeader>状态</Table.ColumnHeader>
                      <Table.ColumnHeader textAlign="end">余额（{data.data.currency}）</Table.ColumnHeader>
                      <Table.ColumnHeader>创建时间</Table.ColumnHeader>
                      <Table.ColumnHeader />
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {data.data.items.map((user) => (
                      <Table.Row key={user.id}>
                        <Table.Cell fontWeight="500">{user.username}</Table.Cell>
                        <Table.Cell whiteSpace="nowrap">{user.role === 'admin' ? '管理员' : '用户'}</Table.Cell>
                        <Table.Cell whiteSpace="nowrap" color={user.status === 'disabled' ? 'gray.500' : undefined}>
                          {user.status === 'active' ? '启用' : '已禁用'}
                        </Table.Cell>
                        <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums">
                          {displayMoney(user.balance)}
                        </Table.Cell>
                        <Table.Cell whiteSpace="nowrap">{localDate(user.createdAt)}</Table.Cell>
                        <Table.Cell>
                          <Link asChild color="#635bff" fontWeight="500">
                            <RouterLink to={`/console/users/${user.id}`}>管理</RouterLink>
                          </Link>
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
