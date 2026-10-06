import {
  Box,
  Button,
  Checkbox,
  Code,
  Field,
  Heading,
  HStack,
  NativeSelect,
  Stack,
  Table,
  Text,
} from '@chakra-ui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

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
import { formError, localDate } from '../lib/format';
import { queryClient, trpc, trpcClient } from '../lib/trpc';

export default function Keys() {
  const [page, setPage] = useState(0);
  const data = useQuery(trpc.keys.list.queryOptions({ page }));
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [restricted, setRestricted] = useState(false);
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [localError, setLocalError] = useState<ReturnType<typeof formError>>();
  const models = useQuery(trpc.keys.models.queryOptions(undefined, { enabled: creating }));
  const task = useMutation(
    trpc.keys.create.mutationOptions({
      onSuccess: async () => {
        setCopied(false);
        setLocalError(undefined);
        setCreating(false);
        setName('');
        setExpiresAt('');
        setModelIds([]);
        setRestricted(false);
        setPage(0);
        await queryClient.invalidateQueries(trpc.keys.list.pathFilter());
      },
    }),
  );
  const secret = task.data?.token;
  const error = localError ?? formError(task.error);
  return (
    <Stack gap="7">
      <Title
        action={
          <PrimaryButton
            size="sm"
            disabled={Boolean(secret)}
            onClick={() => {
              task.reset();
              setLocalError(undefined);
              setCreating(!creating);
            }}
          >
            创建 Key
          </PrimaryButton>
        }
      >
        API Key
      </Title>
      <ErrorText>{formError(data.error)?.message}</ErrorText>
      {secret && (
        <Panel>
          <Stack gap="4">
            <Heading as="h2" fontSize="lg">
              保存你的 Key
            </Heading>
            <Text fontSize="sm" color="gray.500">
              完整 Key 仅显示这一次。
            </Text>
            <Code p="4" fontSize="sm" whiteSpace="normal" overflowWrap="anywhere" userSelect="all">
              {secret}
            </Code>
            <HStack>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(secret);
                    setCopied(true);
                  } catch {
                    setCopied(false);
                    setLocalError({ message: '复制失败，请手动选择并复制 Key', fields: {} });
                  }
                }}
              >
                {copied ? '已复制' : '复制'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setLocalError(undefined);
                  setCopied(false);
                  task.reset();
                }}
              >
                已保存
              </Button>
            </HStack>
            <ErrorText>{error?.message}</ErrorText>
          </Stack>
        </Panel>
      )}
      {creating && (
        <Panel>
          <Box maxW="480px">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setLocalError(undefined);
                if (restricted && !modelIds.length)
                  return setLocalError({ message: '至少选择一个模型', fields: { modelIds: ['至少选择一个模型'] } });
                if (!task.isPending)
                  task.mutate({
                    name,
                    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
                    modelIds: restricted ? modelIds : undefined,
                  });
              }}
            >
              <Stack gap="5">
                <FormInput
                  label="名称"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  maxLength={64}
                  error={error?.fields.name?.[0]}
                />
                <FormInput
                  label="有效期"
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                  helper="留空表示长期有效"
                  error={error?.fields.expiresAt?.[0]}
                />
                <Field.Root invalid={Boolean(error?.fields.modelIds)}>
                  <Field.Label htmlFor="key-model-access">模型权限</Field.Label>
                  <NativeSelect.Root>
                    <NativeSelect.Field
                      id="key-model-access"
                      value={restricted ? 'selected' : 'all'}
                      onChange={(event) => setRestricted(event.target.value === 'selected')}
                    >
                      <option value="all">全部已授权模型</option>
                      <option value="selected">指定模型</option>
                    </NativeSelect.Field>
                    <NativeSelect.Indicator />
                  </NativeSelect.Root>
                  {restricted && (
                    <Stack gap="2" mt="2">
                      {models.data?.length ? (
                        models.data.map((model) => (
                          <Checkbox.Root
                            key={model.id}
                            checked={modelIds.includes(model.id)}
                            onCheckedChange={(event) =>
                              setModelIds((previous) =>
                                event.checked ? [...previous, model.id] : previous.filter((id) => id !== model.id),
                              )
                            }
                          >
                            <Checkbox.HiddenInput />
                            <Checkbox.Control />
                            <Checkbox.Label>{model.name}</Checkbox.Label>
                          </Checkbox.Root>
                        ))
                      ) : (
                        <Text fontSize="sm" color="gray.500">
                          暂无已授权模型
                        </Text>
                      )}
                    </Stack>
                  )}
                  <Field.ErrorText>{error?.fields.modelIds?.[0]}</Field.ErrorText>
                </Field.Root>
                <ErrorText>{error?.message}</ErrorText>
                <HStack>
                  <PrimaryButton type="submit" loading={task.isPending}>
                    创建
                  </PrimaryButton>
                  <Button
                    variant="ghost"
                    disabled={task.isPending}
                    onClick={() => {
                      setCreating(false);
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
                      <Table.ColumnHeader>名称</Table.ColumnHeader>
                      <Table.ColumnHeader>Key</Table.ColumnHeader>
                      <Table.ColumnHeader>模型</Table.ColumnHeader>
                      <Table.ColumnHeader>有效期</Table.ColumnHeader>
                      <Table.ColumnHeader>状态</Table.ColumnHeader>
                      <Table.ColumnHeader />
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {data.data.items.map((key) => {
                      const expired = key.expiresAt !== null && new Date(key.expiresAt).getTime() <= Date.now();
                      return (
                        <Table.Row key={key.id}>
                          <Table.Cell>{key.name}</Table.Cell>
                          <Table.Cell whiteSpace="nowrap" fontFamily="mono">
                            {key.prefix}
                          </Table.Cell>
                          <Table.Cell minW="140px" maxW="280px" overflowWrap="anywhere">
                            {key.restrictModels ? key.modelNames.join('、') || '无可用模型' : '全部已授权模型'}
                          </Table.Cell>
                          <Table.Cell whiteSpace="nowrap">
                            {key.expiresAt ? localDate(key.expiresAt) : '长期'}
                          </Table.Cell>
                          <Table.Cell whiteSpace="nowrap" color={key.revokedAt || expired ? 'gray.500' : undefined}>
                            {key.revokedAt ? '已撤销' : expired ? '已过期' : '有效'}
                          </Table.Cell>
                          <Table.Cell>
                            <ConfirmAction
                              label="撤销"
                              description={`撤销「${key.name}」后无法恢复。`}
                              disabled={Boolean(key.revokedAt)}
                              action={() => trpcClient.keys.revoke.mutate({ keyId: key.id })}
                              onSuccess={() => queryClient.invalidateQueries(trpc.keys.list.pathFilter())}
                            />
                          </Table.Cell>
                        </Table.Row>
                      );
                    })}
                  </Table.Body>
                </Table.Root>
              </Box>
            ) : (
              <Text color="gray.500" py="8" fontSize="sm">
                暂无 Key
              </Text>
            )}
            <PageControls page={page} hasMore={data.data.hasMore} onPage={setPage} />
          </>
        )
      )}
    </Stack>
  );
}
