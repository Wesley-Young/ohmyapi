import type { AppRouter } from '@ohmyapi/daemon/trpc';
import { createTRPCClient, httpBatchLink } from '@trpc/client';

export const trpc = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: '/api/trpc' })],
});
