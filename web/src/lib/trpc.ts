import type { AppRouter, RouterOutputs } from '@ohmyapi/daemon/trpc';
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { createTRPCClient, httpLink, TRPCClientError } from '@trpc/client';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';

export const trpcClient = createTRPCClient<AppRouter>({
  links: [
    httpLink({
      url: '/api/trpc',
      headers: { 'X-Ohmyapi-Request': '1' },
      fetch: (url, options) => fetch(url, { ...options, credentials: 'same-origin' }),
    }),
  ],
});

type Session = RouterOutputs['auth']['me'];
let cacheOwner: string | null | undefined;
const unauthorized = (error: unknown) => error instanceof TRPCClientError && error.data?.code === 'UNAUTHORIZED';

function clearAccountCache(user: Session) {
  cacheOwner = user?.id ?? null;
  queryClient.removeQueries({ predicate: (query) => !query.meta?.session });
  queryClient.getMutationCache().clear();
}

function refreshSession(error: unknown) {
  if (unauthorized(error)) void queryClient.invalidateQueries(trpc.auth.me.queryFilter());
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: refreshSession,
    onSuccess: (data, query) => {
      const session = data as Session;
      if (query.meta?.session && cacheOwner !== (session?.id ?? null)) clearAccountCache(session);
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _result, mutation) => {
      if (!mutation.meta?.publicAuth) refreshSession(error);
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (count, error) => count < 1 && !(error instanceof TRPCClientError && error.data?.httpStatus < 500),
    },
    mutations: { retry: false, gcTime: 0 },
  },
});

export const trpc = createTRPCOptionsProxy<AppRouter>({ client: trpcClient, queryClient });

/** Cancel old requests before replacing the authenticated cache owner. */
export async function setSession(user: Session) {
  await queryClient.cancelQueries();
  clearAccountCache(user);
  queryClient.setQueryData(trpc.auth.me.queryKey(), user);
}

export function invalidateUser(userId: string) {
  return Promise.all([
    queryClient.invalidateQueries(trpc.admin.users.get.queryFilter({ userId })),
    queryClient.invalidateQueries(trpc.admin.users.list.pathFilter()),
    queryClient.invalidateQueries(trpc.admin.wallet.get.queryFilter({ userId })),
    queryClient.invalidateQueries(trpc.admin.wallet.ledger.queryFilter({ userId })),
    queryClient.invalidateQueries(trpc.wallet.pathFilter()),
  ]);
}
