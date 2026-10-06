import { Heading, Stack } from '@chakra-ui/react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';

import { Centered, ErrorText, FormInput, Loading, PrimaryButton } from '../components/ui';
import { useAuth } from '../lib/auth';
import { formError } from '../lib/format';
import { setSession, trpc } from '../lib/trpc';

export default function Login() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const task = useMutation(
    trpc.auth.login.mutationOptions({
      meta: { publicAuth: true },
      onSuccess: async (user) => {
        setPassword('');
        await setSession(user);
        navigate('/console', { replace: true });
      },
    }),
  );
  const error = formError(task.error);
  if (auth.isPending && auth.data === undefined)
    return (
      <Centered>
        <Loading />
      </Centered>
    );
  if (auth.data) return <Navigate to="/console" replace />;
  return (
    <Centered>
      <Stack gap="7">
        <Heading as="h1" fontSize="28px" letterSpacing="-0.04em">
          登录
        </Heading>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!task.isPending) task.mutate({ username, password });
          }}
        >
          <Stack gap="5">
            <FormInput
              label="用户名"
              autoComplete="username"
              value={username}
              required
              maxLength={64}
              onChange={(event) => setUsername(event.target.value)}
              error={error?.fields.username?.[0]}
            />
            <FormInput
              label="密码"
              type="password"
              autoComplete="current-password"
              value={password}
              required
              maxLength={1024}
              onChange={(event) => setPassword(event.target.value)}
              error={error?.fields.password?.[0]}
            />
            <ErrorText>{error?.message ?? formError(auth.error)?.message}</ErrorText>
            <PrimaryButton type="submit" w="full" loading={task.isPending}>
              登录
            </PrimaryButton>
          </Stack>
        </form>
      </Stack>
    </Centered>
  );
}
