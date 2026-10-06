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
  FormDialog,
  FormInput,
  Loading,
  PageControls,
  Panel,
  PrimaryButton,
  Title,
} from '../components/ui';
import { formError, localDate } from '../lib/format';
import { queryClient, trpc, trpcClient } from '../lib/trpc';
import { SelectField } from './Catalog';

export default function Keys() {
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const data = useQuery(trpc.keys.list.queryOptions({ page }));
  const channels = useQuery(trpc.keys.channels.queryOptions());
  const [name, setName] = useState('');
  const [channelId, setChannelId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [restricted, setRestricted] = useState(false);
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [binding, setBinding] = useState<string>();
  const [bindChannelId, setBindChannelId] = useState('');
  const refresh = () => queryClient.invalidateQueries(trpc.keys.list.pathFilter());
  const task = useMutation(
    trpc.keys.create.mutationOptions({
      onSuccess: async () => {
        setCreating(false);
        setName('');
        setChannelId('');
        setExpiresAt('');
        setModelIds([]);
        setRestricted(false);
        setCopied(false);
        setLocalError(undefined);
        setPage(0);
        await refresh();
      },
    }),
  );
  const bind = useMutation(
    trpc.keys.bindChannel.mutationOptions({
      onSuccess: async () => {
        setBinding(undefined);
        await refresh();
      },
    }),
  );
  const secret = task.data?.token;
  const models = channels.data?.find((c) => c.id === channelId)?.models ?? [];
  const close = () => {
    setCreating(false);
    task.reset();
    setName('');
    setChannelId('');
    setExpiresAt('');
    setRestricted(false);
    setModelIds([]);
    setLocalError(undefined);
  };
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
              setCreating(true);
            }}
          >
            创建 Key
          </PrimaryButton>
        }
      >
        API Key
      </Title>
      <ErrorText>{formError(data.error ?? channels.error)?.message}</ErrorText>
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
                    setLocalError('复制失败，请手动选择并复制 Key');
                  }
                }}
              >
                {copied ? '已复制' : '复制'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  task.reset();
                  setCopied(false);
                  setLocalError(undefined);
                }}
              >
                已保存
              </Button>
            </HStack>
            <ErrorText>{localError}</ErrorText>
          </Stack>
        </Panel>
      )}
      {creating && (
        <FormDialog open title="创建 Key" busy={task.isPending} onClose={close}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setLocalError(undefined);
              if (!channelId) return setLocalError('请选择渠道');
              if (restricted && !modelIds.length) return setLocalError('至少选择一个模型');
              if (!task.isPending)
                task.mutate({
                  name,
                  channelId,
                  expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
                  modelIds: restricted ? modelIds : undefined,
                });
            }}
          >
            <Stack gap="5">
              <FormInput label="名称" value={name} required maxLength={64} onChange={(e) => setName(e.target.value)} />
              <SelectField
                label="绑定渠道"
                value={channelId}
                onChange={(id) => {
                  setChannelId(id);
                  setModelIds([]);
                }}
                options={channels.data ?? []}
              />
              {!channels.isPending && !channels.data?.length && (
                <Text fontSize="sm" color="gray.500">
                  暂无可用渠道，请联系管理员配置渠道和模型授权。
                </Text>
              )}
              <FormInput
                label="有效期"
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                helper="留空表示长期有效"
              />
              <Field.Root>
                <Field.Label>模型权限</Field.Label>
                <NativeSelect.Root>
                  <NativeSelect.Field
                    aria-label="模型权限"
                    value={restricted ? 'selected' : 'all'}
                    onChange={(e) => setRestricted(e.target.value === 'selected')}
                  >
                    <option value="all">渠道内全部已授权模型</option>
                    <option value="selected">指定模型</option>
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
              </Field.Root>
              {restricted && (
                <Stack gap="2">
                  {models.map((m) => (
                    <Checkbox.Root
                      key={m.id}
                      checked={modelIds.includes(m.id)}
                      onCheckedChange={(e) =>
                        setModelIds(e.checked ? [...modelIds, m.id] : modelIds.filter((id) => id !== m.id))
                      }
                    >
                      <Checkbox.HiddenInput />
                      <Checkbox.Control />
                      <Checkbox.Label>{m.name}</Checkbox.Label>
                    </Checkbox.Root>
                  ))}
                  {!models.length && (
                    <Text fontSize="sm" color="gray.500">
                      请选择有授权模型的渠道
                    </Text>
                  )}
                </Stack>
              )}
              <ErrorText>{localError ?? formError(task.error)?.message}</ErrorText>
              <HStack>
                <PrimaryButton type="submit" loading={task.isPending} disabled={!channelId}>
                  创建
                </PrimaryButton>
                <Button variant="ghost" disabled={task.isPending} onClick={close}>
                  取消
                </Button>
              </HStack>
            </Stack>
          </form>
        </FormDialog>
      )}
      {binding && (
        <FormDialog open title="绑定旧 Key 的渠道" busy={bind.isPending} onClose={() => setBinding(undefined)}>
          <Stack gap="5">
            <Text fontSize="sm" color="gray.500">
              绑定后固定使用此渠道，切换渠道请创建新 Key。
            </Text>
            <SelectField
              label="绑定渠道"
              value={bindChannelId}
              onChange={setBindChannelId}
              options={channels.data ?? []}
            />
            <ErrorText>{formError(bind.error)?.message}</ErrorText>
            <PrimaryButton
              disabled={!bindChannelId}
              loading={bind.isPending}
              onClick={() => bind.mutate({ keyId: binding, channelId: bindChannelId })}
            >
              确认绑定
            </PrimaryButton>
          </Stack>
        </FormDialog>
      )}
      {data.isPending ? (
        <Loading />
      ) : (
        data.data && (
          <>
            <Box overflowX="auto">
              <Table.Root size="sm">
                <Table.Header>
                  <Table.Row>
                    {['名称', 'Key', '渠道', '模型', '有效期', '状态', '操作'].map((h) => (
                      <Table.ColumnHeader key={h}>{h}</Table.ColumnHeader>
                    ))}
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
                        <Table.Cell whiteSpace="nowrap">{key.channelName ?? '未绑定'}</Table.Cell>
                        <Table.Cell minW="140px" maxW="280px" overflowWrap="anywhere">
                          {key.restrictModels ? key.modelNames.join('、') || '无可用模型' : '渠道内已授权模型'}
                        </Table.Cell>
                        <Table.Cell whiteSpace="nowrap">{key.expiresAt ? localDate(key.expiresAt) : '长期'}</Table.Cell>
                        <Table.Cell whiteSpace="nowrap">
                          {key.revokedAt ? '已撤销' : expired ? '已过期' : !key.channelId ? '待绑定' : '有效'}
                        </Table.Cell>
                        <Table.Cell>
                          <HStack>
                            {!key.channelId && !key.revokedAt && !expired && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  bind.reset();
                                  setBindChannelId('');
                                  setBinding(key.id);
                                }}
                              >
                                绑定渠道
                              </Button>
                            )}
                            <ConfirmAction
                              label="撤销"
                              description={`撤销「${key.name}」后无法恢复。`}
                              disabled={Boolean(key.revokedAt)}
                              action={() => trpcClient.keys.revoke.mutate({ keyId: key.id })}
                              onSuccess={refresh}
                            />
                          </HStack>
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table.Root>
            </Box>
            {!data.data.items.length && (
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
