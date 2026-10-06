import { Button, Stack } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { Navigate, Outlet } from 'react-router';

import { Centered, ErrorText, Loading } from '../components/ui';
import { formError } from './format';
import { trpc } from './trpc';

export function useAuth() {
  return useQuery(
    trpc.auth.me.queryOptions(undefined, {
      meta: { session: true },
      staleTime: 0,
      retry: false,
      refetchOnWindowFocus: 'always',
    }),
  );
}

export function Authenticated() {
  const auth = useAuth();
  if (auth.isPending)
    return (
      <Centered>
        <Loading />
      </Centered>
    );
  if (auth.error)
    return (
      <Centered>
        <Stack gap="4">
          <ErrorText>{formError(auth.error)?.message}</ErrorText>
          <Button onClick={() => auth.refetch()}>重新加载</Button>
        </Stack>
      </Centered>
    );
  return auth.data ? <Outlet key={auth.data.id} /> : <Navigate to="/login" replace />;
}
