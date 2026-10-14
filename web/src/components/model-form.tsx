import { Button, HStack, Stack } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { refreshCatalog } from '../lib/cache';
import { formError } from '../lib/format';
import { trpc } from '../lib/trpc';
import { EnabledField } from './fields';
import { ErrorText, FormDialog, FormInput, PrimaryButton } from './ui';

export function ModelForm({
  initial,
  close,
  onSaved,
}: {
  initial?: RouterOutputs['admin']['catalog']['list']['models'][number];
  close: () => void;
  onSaved: (id: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [inputTokenLimit, setInputTokenLimit] = useState(String(initial?.inputTokenLimit ?? 1_000_000));
  const [outputTokenLimit, setOutputTokenLimit] = useState(String(initial?.outputTokenLimit ?? 128_000));
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const task = useMutation(
    trpc.admin.catalog.saveModel.mutationOptions({
      onSuccess: async (model) => {
        await refreshCatalog();
        close();
        onSaved(model.id);
      },
    }),
  );
  return (
    <FormDialog open title={initial ? '编辑模型元数据' : '添加模型'} onClose={close} busy={task.isPending}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!task.isPending)
            task.mutate({
              id: initial?.id,
              name,
              enabled,
              inputTokenLimit: Number(inputTokenLimit),
              outputTokenLimit: Number(outputTokenLimit),
            });
        }}
      >
        <Stack gap="5">
          <FormInput label="模型名称" value={name} onChange={(e) => setName(e.target.value)} required maxLength={128} />
          <FormInput
            label="输入 Token 容量"
            type="number"
            min={1}
            required
            value={inputTokenLimit}
            onChange={(e) => setInputTokenLimit(e.target.value)}
            helper="JSON 正文的字节数也不能超过此值"
          />
          <FormInput
            label="输出 Token 上限"
            type="number"
            min={1}
            required
            value={outputTokenLimit}
            onChange={(e) => setOutputTokenLimit(e.target.value)}
          />
          <EnabledField value={enabled} onChange={setEnabled} />
          <ErrorText>{formError(task.error)?.message}</ErrorText>
          <HStack>
            <PrimaryButton type="submit" loading={task.isPending}>
              保存模型
            </PrimaryButton>
            <Button variant="ghost" disabled={task.isPending} onClick={close}>
              取消
            </Button>
          </HStack>
        </Stack>
      </form>
    </FormDialog>
  );
}
