import { initTRPC } from '@trpc/server';

export interface RpcContext {
  startedAt: string;
}

const t = initTRPC.context<RpcContext>().create();

export const appRouter = t.router({
  system: t.router({
    status: t.procedure.query(({ ctx }) => ({
      name: 'ohmyapi',
      status: 'ok' as const,
      startedAt: ctx.startedAt,
    })),
  }),
});

export type AppRouter = typeof appRouter;
