import { useQuery } from '@tanstack/react-query';

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
