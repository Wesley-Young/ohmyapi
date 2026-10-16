import { Button, Checkbox, Field, HStack, NativeSelect, Stack, Text } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { dateTimeInput, formError } from '../lib/format';
import { queryClient, trpc } from '../lib/trpc';
import { ModelLabel } from './brand-icon';
import { type ChannelOption, ChannelSelect } from './channel-select';
import { ErrorText, FormDialog, FormInput, PrimaryButton } from './ui';

type ApiKey = RouterOutputs['keys']['list']['items'][number];

/** 创建或编辑 Key。编辑时以现有 Key 的设置为初始值。 */
export function KeyForm({
  editing,
  onClose,
  onCreated,
}: {
  editing?: ApiKey;
  onClose: () => void;
  onCreated: () => Promise<unknown>;
}) {
  const channels = useQuery(trpc.keys.channels.queryOptions());
  const [name, setName] = useState(editing?.name ?? '');
  const [channelId, setChannelId] = useState(editing?.channelId ?? '');
  const [expiresAt, setExpiresAt] = useState(editing ? dateTimeInput(editing.expiresAt) : '');
  const [restricted, setRestricted] = useState(editing?.restrictModels ?? false);
  const [modelIds, setModelIds] = useState<string[]>(editing?.modelIds ?? []);
  const [localError, setLocalError] = useState<string>();
  const task = useMutation(trpc.keys.create.mutationOptions({ onSuccess: onCreated }));
  const update = useMutation(
    trpc.keys.update.mutationOptions({
      onSuccess: async () => {
        onClose();
        await queryClient.invalidateQueries(trpc.keys.pathFilter());
      },
    }),
  );
  const saveTask = editing ? update : task;
  const channelOptions = useMemo(() => {
    const options: ChannelOption[] = [...(channels.data ?? [])];
    if (editing?.channelId && !options.some((channel) => channel.id === editing.channelId))
      options.push({ id: editing.channelId, name: editing.channelName ?? '原渠道', unavailable: true });
    return options;
  }, [channels.data, editing?.channelId, editing?.channelName]);
  const models = [...(channels.data?.find((channel) => channel.id === channelId)?.models ?? [])];
  if (editing && channelId === editing.channelId)
    for (const [index, id] of editing.modelIds.entries())
      if (!models.some((model) => model.id === id)) models.push({ id, name: `${editing.modelNames[index]}（不可用）` });
  return (
    <FormDialog open title={editing ? '编辑 Key' : '创建 Key'} busy={saveTask.isPending} onClose={onClose}>
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
            <ChannelSelect
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
                  <Checkbox.Label>
                    <ModelLabel model={m.name} />
                  </Checkbox.Label>
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
            <Button variant="ghost" disabled={saveTask.isPending} onClick={onClose}>
              取消
            </Button>
          </HStack>
        </Stack>
      </form>
    </FormDialog>
  );
}
