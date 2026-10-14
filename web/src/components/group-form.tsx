import { Button, HStack, Stack } from '@chakra-ui/react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { refreshGrants } from '../lib/cache';
import { formError } from '../lib/format';
import { trpc } from '../lib/trpc';
import { ErrorText, FormDialog, FormInput, PrimaryButton } from './ui';

/** 创建或重命名用户组。 */
export function GroupForm({
  group,
  onClose,
  onSaved,
}: {
  group?: { id: string; name: string };
  onClose: () => void;
  onSaved?: (group: { id: string }) => void;
}) {
  const [name, setName] = useState(group?.name ?? '');
  const options = {
    onSuccess: async (saved: { id: string }) => {
      await refreshGrants();
      onSaved?.(saved);
      onClose();
    },
  };
  const create = useMutation(trpc.admin.groups.create.mutationOptions(options));
  const rename = useMutation(trpc.admin.groups.rename.mutationOptions(options));
  const task = group ? rename : create;
  const submit = () => (group ? rename.mutate({ groupId: group.id, name }) : create.mutate({ name }));
  const error = formError(task.error);
  return (
    <FormDialog open title={group ? '重命名用户组' : '创建用户组'} onClose={onClose} busy={task.isPending}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!task.isPending) submit();
        }}
      >
        <Stack gap="5" maxW="400px">
          <FormInput
            label="名称"
            value={name}
            required
            maxLength={64}
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value);
              task.reset();
            }}
            error={error?.fields.name?.[0]}
          />
          <ErrorText>{error?.fields.name ? undefined : error?.message}</ErrorText>
          <HStack>
            <PrimaryButton type="submit" loading={task.isPending}>
              {group ? '保存' : '创建'}
            </PrimaryButton>
            <Button variant="ghost" disabled={task.isPending} onClick={onClose}>
              取消
            </Button>
          </HStack>
        </Stack>
      </form>
    </FormDialog>
  );
}
