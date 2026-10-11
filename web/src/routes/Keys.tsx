import { Badge, Box, Button, Checkbox, Field, HStack, NativeSelect, Stack, Table, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useMutation, useQuery } from '@tanstack/react-query';
import { BookOpen, Check, Copy, Download, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { CCSwitchDialog } from '../components/cc-switch-dialog';
import { IconButton } from '../components/icon-button';
import { KeyUsageDialog } from '../components/key-usage-dialog';
import { ErrorText, FormDialog, FormInput, Loading, PageControls, PrimaryButton, Title } from '../components/ui';
import { formError, localDate } from '../lib/format';
import { queryClient, trpc } from '../lib/trpc';
import { SelectField } from './Catalog';

type ApiKey = RouterOutputs['keys']['list']['items'][number];

function dateTimeInput(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, -1);
}

function isAnthropicOnly(channel: RouterOutputs['keys']['channels'][number] | undefined) {
  if (!channel) return true; // unable to determine, assume true to disable export
  return channel.endpoints.length === 1 && channel.endpoints[0] === '/v1/messages';
}

export default function Keys() {
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const [showingUsage, setShowingUsage] = useState(false);
  const [exportingKeyId, setExportingKeyId] = useState<string>();
  const data = useQuery(trpc.keys.list.queryOptions({ page }));
  const channels = useQuery(trpc.keys.channels.queryOptions());
  const [name, setName] = useState('');
  const [channelId, setChannelId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [restricted, setRestricted] = useState(false);
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [copiedId, setCopiedId] = useState<string>();
  const [copyError, setCopyError] = useState<string>();
  const [localError, setLocalError] = useState<string>();
  const [editing, setEditing] = useState<ApiKey>();
  const refresh = () => queryClient.invalidateQueries(trpc.keys.pathFilter());
  const deletion = useMutation(
    trpc.keys.delete.mutationOptions({
      onSuccess: async () => {
        setCopiedId(undefined);
        setPage(0);
        await refresh();
      },
    }),
  );
  const task = useMutation(
    trpc.keys.create.mutationOptions({
      onSuccess: async () => {
        setCreating(false);
        setName('');
        setChannelId('');
        setExpiresAt('');
        setModelIds([]);
        setRestricted(false);
        setCopiedId(undefined);
        setCopyError(undefined);
        setLocalError(undefined);
        setPage(0);
        await refresh();
      },
    }),
  );
  const update = useMutation(
    trpc.keys.update.mutationOptions({
      onSuccess: async () => {
        close();
        await refresh();
      },
    }),
  );
  const saveTask = editing ? update : task;
  const channelOptions = [...(channels.data ?? [])];
  if (editing?.channelId && !channelOptions.some((channel) => channel.id === editing.channelId))
    channelOptions.push({
      id: editing.channelId,
      name: `${editing.channelName ?? '原渠道'}（不可用）`,
      endpoints: [],
      models: [],
    });
  const models = [...(channels.data?.find((channel) => channel.id === channelId)?.models ?? [])];
  if (editing && channelId === editing.channelId)
    for (const [index, id] of editing.modelIds.entries())
      if (!models.some((model) => model.id === id)) models.push({ id, name: `${editing.modelNames[index]}（不可用）` });
  const close = () => {
    setCreating(false);
    setEditing(undefined);
    task.reset();
    update.reset();
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
          <HStack gap="3" flexWrap="wrap">
            <Button type="button" size="sm" variant="ghost" onClick={() => setShowingUsage(true)}>
              <BookOpen size={16} aria-hidden="true" />
              使用说明
            </Button>
            <PrimaryButton
              size="sm"
              onClick={() => {
                close();
                setCreating(true);
              }}
            >
              创建 Key
            </PrimaryButton>
          </HStack>
        }
      >
        API Key
      </Title>
      <ErrorText>{formError(data.error ?? channels.error)?.message}</ErrorText>
      <ErrorText>{copyError}</ErrorText>
      <ErrorText>{formError(deletion.error)?.message}</ErrorText>
      {showingUsage && <KeyUsageDialog onClose={() => setShowingUsage(false)} />}
      {exportingKeyId && <CCSwitchDialog keyId={exportingKeyId} onClose={() => setExportingKeyId(undefined)} />}
      {(creating || editing) && (
        <FormDialog open title={editing ? '编辑 Key' : '创建 Key'} busy={saveTask.isPending} onClose={close}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setLocalError(undefined);
              if (saveTask.isPending) return;
              if (!channelId && (!editing || editing.channelId)) return setLocalError('请选择渠道');
              const modelPermissionsChanged =
                editing &&
                (restricted !== editing.restrictModels ||
                  (restricted &&
                    (modelIds.length !== editing.modelIds.length ||
                      modelIds.some((id) => !editing.modelIds.includes(id)))));
              if (
                restricted &&
                !modelIds.length &&
                (!editing || modelPermissionsChanged || (channelId || null) !== editing.channelId)
              )
                return setLocalError('至少选择一个模型');
              const expiration = expiresAt ? new Date(expiresAt) : null;
              if (expiration && !Number.isFinite(expiration.getTime())) return setLocalError('请输入有效的日期和时间');
              const expirationValue =
                editing && expiresAt === dateTimeInput(editing.expiresAt)
                  ? editing.expiresAt
                  : (expiration?.toISOString() ?? null);
              if (expiration && expiration.getTime() <= Date.now() && expirationValue !== editing?.expiresAt)
                return setLocalError('有效期必须晚于当前时间');
              if (editing) {
                update.mutate({
                  keyId: editing.id,
                  name,
                  channelId: channelId && channelId !== editing.channelId ? channelId : undefined,
                  expiresAt: expirationValue,
                  modelIds: modelPermissionsChanged ? (restricted ? modelIds : null) : undefined,
                });
              } else {
                task.mutate({
                  name,
                  channelId,
                  expiresAt: expirationValue ?? undefined,
                  modelIds: restricted ? modelIds : undefined,
                });
              }
            }}
          >
            <Stack gap="5">
              <FormInput label="名称" value={name} required maxLength={64} onChange={(e) => setName(e.target.value)} />
              <Stack gap="2">
                <SelectField
                  label="绑定渠道"
                  value={channelId}
                  onChange={(id) => {
                    setChannelId(id);
                    setModelIds([]);
                  }}
                  options={channelOptions}
                />
                {channelId && (
                  <Text fontSize="sm" color="gray.500">
                    支持端点：
                    {channels.data
                      ?.find((channel) => channel.id === channelId)
                      ?.endpoints.filter((endpoint) => endpoint !== '/v1/responses/compact')
                      .join(', ') ?? '—'}
                  </Text>
                )}
                {!channels.isPending && !channels.data?.length && (
                  <Text fontSize="sm" color="gray.500">
                    暂无可用渠道，请联系管理员配置渠道和授权。
                  </Text>
                )}
              </Stack>
              <FormInput
                label="有效期"
                type="datetime-local"
                step="any"
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
                    <option value="all">渠道内全部模型</option>
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
                      请选择包含模型的渠道
                    </Text>
                  )}
                </Stack>
              )}
              <ErrorText>{localError ?? formError(saveTask.error)?.message}</ErrorText>
              <HStack>
                <PrimaryButton
                  type="submit"
                  loading={saveTask.isPending}
                  disabled={!channelId && (!editing || Boolean(editing.channelId))}
                >
                  {editing ? '保存' : '创建'}
                </PrimaryButton>
                <Button variant="ghost" disabled={saveTask.isPending} onClick={close}>
                  取消
                </Button>
              </HStack>
            </Stack>
          </form>
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
                    {['名称', 'Key', '渠道', '有效期', '状态', '操作'].map((h) => (
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
                        <Table.Cell whiteSpace="nowrap">
                          <HStack gap="2">
                            <Text as="span" fontFamily="mono">
                              {key.token.slice(0, 12)}…
                            </Text>
                            <IconButton
                              variant="ghost"
                              size="xs"
                              aria-label={
                                copiedId === key.id ? `已复制「${key.name}」的 Key` : `复制「${key.name}」的 Key`
                              }
                              title={copiedId === key.id ? '已复制' : '复制 Key'}
                              onClick={async () => {
                                setCopyError(undefined);
                                setCopiedId(undefined);
                                try {
                                  await navigator.clipboard.writeText(key.token);
                                  setCopiedId(key.id);
                                } catch {
                                  setCopyError('复制失败，请检查浏览器剪贴板权限后重试');
                                }
                              }}
                            >
                              {copiedId === key.id ? (
                                <Check size={16} strokeWidth={1.75} aria-hidden="true" focusable="false" />
                              ) : (
                                <Copy size={16} strokeWidth={1.75} aria-hidden="true" focusable="false" />
                              )}
                            </IconButton>
                          </HStack>
                        </Table.Cell>
                        <Table.Cell whiteSpace="nowrap">
                          <HStack gap="2" flexWrap="wrap">
                            <Text>{key.channelName ?? '未绑定'}</Text>
                            {key.channelDeleted && <Badge colorPalette="gray">已删除</Badge>}
                          </HStack>
                        </Table.Cell>
                        <Table.Cell whiteSpace="nowrap">{key.expiresAt ? localDate(key.expiresAt) : '长期'}</Table.Cell>
                        <Table.Cell whiteSpace="nowrap">
                          {key.revokedAt
                            ? '已撤销'
                            : expired
                              ? '已过期'
                              : key.channelDeleted
                                ? '渠道已删除'
                                : !key.channelId
                                  ? '待绑定'
                                  : '有效'}
                        </Table.Cell>
                        <Table.Cell>
                          <HStack gap="2" flexWrap="wrap">
                            <Button
                              type="button"
                              aria-label={`导出「${key.name}」到 CC Switch`}
                              variant="outline"
                              size="sm"
                              disabled={
                                !channels.data ||
                                isAnthropicOnly(channels.data.find((channel) => channel.id === key.channelId)) ||
                                Boolean(key.revokedAt || expired || key.channelDeleted || !key.channelId)
                              }
                              onClick={() => setExportingKeyId(key.id)}
                            >
                              <Download size={16} aria-hidden="true" />
                              导出
                            </Button>
                            <IconButton
                              aria-label={`编辑 Key「${key.name}」`}
                              title="编辑 Key"
                              variant="ghost"
                              size="sm"
                              disabled={Boolean(key.revokedAt) || deletion.isPending}
                              onClick={() => {
                                close();
                                setEditing(key);
                                setName(key.name);
                                setChannelId(key.channelId ?? '');
                                setExpiresAt(dateTimeInput(key.expiresAt));
                                setRestricted(key.restrictModels);
                                setModelIds(key.modelIds);
                              }}
                            >
                              <Pencil size={16} aria-hidden="true" />
                            </IconButton>
                            <IconButton
                              variant="ghost"
                              size="sm"
                              color="red.600"
                              aria-label={`删除 Key「${key.name}」`}
                              disabled={deletion.isPending}
                              loading={deletion.isPending && deletion.variables?.keyId === key.id}
                              onClick={() => deletion.mutate({ keyId: key.id })}
                            >
                              <Trash2 size={16} aria-hidden="true" />
                            </IconButton>
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
