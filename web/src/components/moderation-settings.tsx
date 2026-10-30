import { Button, Field, HStack, Stack, Text, Textarea } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { refreshModeration } from '../lib/cache';
import { formError } from '../lib/format';
import { trpc } from '../lib/trpc';
import { SelectField } from './fields';
import { ErrorText, FormDialog, FormInput, PrimaryButton } from './ui';

type Settings = RouterOutputs['admin']['moderation']['settings'];

/** 审核渠道、模型和规则；不选择渠道时停用审计，不再采集新内容。 */
export function ModerationSettings({ settings, onClose }: { settings: Settings; onClose: () => void }) {
  const [channelId, setChannelId] = useState(settings.channelId ?? '');
  const [model, setModel] = useState(settings.model ?? '');
  const [rules, setRules] = useState(settings.rules);
  const task = useMutation(
    trpc.admin.moderation.saveSettings.mutationOptions({
      onSuccess: async () => {
        await refreshModeration();
        onClose();
      },
    }),
  );
  const error = formError(task.error);
  return (
    <FormDialog open title="审核设置" busy={task.isPending} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!task.isPending) task.mutate({ channelId: channelId || null, model: channelId ? model : null, rules });
        }}
      >
        <fieldset disabled={task.isPending} style={{ border: 0, padding: 0, minWidth: 0 }}>
          <Stack gap="5">
            <Stack gap="2">
              <SelectField
                label="审核渠道"
                value={channelId}
                onChange={setChannelId}
                options={settings.channels.map((channel) => ({
                  id: channel.id,
                  name: channel.enabled ? channel.name : `${channel.name}（已禁用）`,
                }))}
              />
              <Text fontSize="sm" color="gray.500">
                {settings.channels.length
                  ? '通过 System One 决策接口审核；不选择时停用审计。'
                  : '没有支持 /v1/systemone 端点的 API 渠道，请先添加。'}
              </Text>
            </Stack>
            {channelId && (
              <FormInput
                label="审核模型"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="jev-latest"
                required
                maxLength={128}
                error={error?.fields.model?.[0]}
              />
            )}
            <Field.Root invalid={Boolean(error?.fields.rules)}>
              <Field.Label>审核规则</Field.Label>
              <Textarea
                aria-label="审核规则"
                value={rules}
                onChange={(e) => setRules(e.target.value)}
                placeholder={settings.defaultRules}
                rows={9}
                maxLength={8000}
              />
              {error?.fields.rules && <Field.ErrorText>{error.fields.rules[0]}</Field.ErrorText>}
            </Field.Root>
            <ErrorText>{error?.message}</ErrorText>
          </Stack>
        </fieldset>
        <HStack mt="5">
          <PrimaryButton type="submit" loading={task.isPending}>
            保存设置
          </PrimaryButton>
          <Button type="button" variant="ghost" disabled={task.isPending} onClick={onClose}>
            取消
          </Button>
        </HStack>
      </form>
    </FormDialog>
  );
}
