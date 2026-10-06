import { Button, Heading, Stack } from '@chakra-ui/react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { Centered, ErrorText, FormInput, PrimaryButton } from '../components/ui';
import { formError } from '../lib/format';
import { queryClient, trpc } from '../lib/trpc';

export default function ChangePassword() {
  const navigate = useNavigate();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [confirmationError, setConfirmationError] = useState<string>();
  const task = useMutation(
    trpc.auth.changePassword.mutationOptions({
      onSuccess: async () => {
        setCurrent('');
        setNew('');
        setConfirmation('');
        await queryClient.invalidateQueries(trpc.auth.me.queryFilter());
        navigate('/console', { replace: true });
      },
    }),
  );
  const error = formError(task.error);
  return (
    <Centered>
      <Stack gap="7">
        <Stack gap="2">
          <Heading as="h1" fontSize="28px" letterSpacing="-0.04em">
            修改密码
          </Heading>
        </Stack>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setConfirmationError(undefined);
            if (newPassword !== confirmation) return setConfirmationError('两次输入的密码不一致');
            if (!task.isPending) task.mutate({ currentPassword, newPassword });
          }}
        >
          <Stack gap="5">
            <FormInput
              label="当前密码"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrent(event.target.value)}
              required
              maxLength={1024}
            />
            <FormInput
              label="新密码"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNew(event.target.value)}
              required
              minLength={8}
              maxLength={1024}
              helper="至少 8 个字符"
              error={error?.fields.newPassword?.[0]}
            />
            <FormInput
              label="确认新密码"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              required
              minLength={8}
              maxLength={1024}
              error={confirmationError}
            />
            <ErrorText>{error?.message}</ErrorText>
            <PrimaryButton type="submit" w="full" loading={task.isPending}>
              保存密码
            </PrimaryButton>
            <Button variant="ghost" disabled={task.isPending} onClick={() => navigate('/console')}>
              返回控制台
            </Button>
          </Stack>
        </form>
      </Stack>
    </Centered>
  );
}
