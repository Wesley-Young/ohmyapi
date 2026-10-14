import { Button, HStack, Stack, Text } from '@chakra-ui/react';
import { useMutation } from '@tanstack/react-query';
import { ShieldCheck, ShieldMinus } from 'lucide-react';
import { useState } from 'react';

import { useAuth } from '../lib/auth';
import { refreshUser } from '../lib/cache';
import { formError } from '../lib/format';
import { trpc } from '../lib/trpc';
import { IconButton } from './icon-button';
import { ErrorText, FormDialog, PrimaryButton } from './ui';

export function UserRoleAction({
  user,
  compact,
}: {
  user: { id: string; username: string; role: 'admin' | 'user'; status: 'active' | 'disabled' };
  compact?: boolean;
}) {
  const { data: actor } = useAuth();
  const [open, setOpen] = useState(false);
  const role = user.role === 'admin' ? 'user' : 'admin';
  const label = role === 'admin' ? '提升为管理员' : '降级为普通用户';
  const disabled = !actor || actor.id === user.id || (role === 'admin' && user.status !== 'active');
  const task = useMutation(
    trpc.admin.users.setRole.mutationOptions({
      onSuccess: async () => {
        await refreshUser(user.id);
        setOpen(false);
      },
    }),
  );
  const onClose = () => {
    setOpen(false);
    task.reset();
  };
  const onOpen = () => {
    task.reset();
    setOpen(true);
  };
  const title =
    actor?.id === user.id
      ? '请由其他管理员将你降级为普通用户'
      : role === 'admin' && user.status !== 'active'
        ? '请先启用该用户，再提升为管理员'
        : label;
  return (
    <>
      {compact ? (
        <IconButton
          size="sm"
          variant="ghost"
          aria-label={`将「${user.username}」${label}`}
          title={title}
          disabled={disabled}
          onClick={onOpen}
        >
          {role === 'admin' ? (
            <ShieldCheck size={16} aria-hidden="true" />
          ) : (
            <ShieldMinus size={16} aria-hidden="true" />
          )}
        </IconButton>
      ) : (
        <Button size="sm" variant="outline" title={title} disabled={disabled} onClick={onOpen}>
          {label}
        </Button>
      )}
      <FormDialog open={open} title={label} busy={task.isPending} onClose={onClose}>
        <Stack gap="5">
          <Text color="gray.600">
            {role === 'admin'
              ? `将「${user.username}」提升为管理员后，该用户可以管理用户、渠道、定价和余额，并会移出所有用户组。现有会话将失效，需要重新登录。`
              : `将「${user.username}」降级为普通用户后，该用户将失去管理员权限。现有会话将失效，需要重新登录。`}
          </Text>
          <ErrorText>{formError(task.error)?.message}</ErrorText>
          <HStack justify="end">
            <Button variant="ghost" disabled={task.isPending} onClick={onClose}>
              取消
            </Button>
            <PrimaryButton loading={task.isPending} onClick={() => task.mutate({ userId: user.id, role })}>
              确认{label}
            </PrimaryButton>
          </HStack>
        </Stack>
      </FormDialog>
    </>
  );
}
