import { Button, Stack } from '@chakra-ui/react';
import { useMutation } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';

import { formError } from '../lib/format';
import { queryClient, trpc } from '../lib/trpc';
import { ErrorText, FormDialog, FormInput, PrimaryButton } from './ui';

/**
 * 修改密码表单。heading 显示在表单上方，frame 决定外层容器（页面或弹窗），
 * 外层可据 busy 在提交期间阻止关闭。
 */
export function ChangePasswordForm({
  heading,
  cancelLabel,
  onSaved,
  onCancel,
  frame,
}: {
  heading?: ReactNode;
  cancelLabel: string;
  onSaved: () => void;
  onCancel: () => void;
  frame: (content: ReactNode, busy: boolean) => ReactNode;
}) {
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
        onSaved();
      },
    }),
  );
  const error = formError(task.error);
  const content = (
    <Stack gap="7">
      {heading}
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
          <Button variant="ghost" disabled={task.isPending} onClick={onCancel}>
            {cancelLabel}
          </Button>
        </Stack>
      </form>
    </Stack>
  );
  return frame(content, task.isPending);
}

export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  return (
    <ChangePasswordForm
      cancelLabel="取消"
      onSaved={onClose}
      onCancel={onClose}
      frame={(content, busy) => (
        <FormDialog open onClose={onClose} title="修改密码" busy={busy}>
          {content}
        </FormDialog>
      )}
    />
  );
}
