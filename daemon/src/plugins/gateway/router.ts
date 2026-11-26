import { adminProcedure, protectedProcedure } from '../../trpc/procedures.ts';
import type { RequestHistory } from './history.ts';
import { listRequestsInput, ownRequestsInput } from './schemas.ts';
import type { GatewayService } from './service.ts';

export function playgroundRoutes(gateway: GatewayService) {
  return { options: protectedProcedure.query(({ ctx }) => gateway.playgroundOptions(ctx.principal.user)) };
}

export function requestRoutes(history: RequestHistory) {
  return {
    user: protectedProcedure
      .input(ownRequestsInput)
      .query(({ ctx, input }) => history.listOwn(ctx.principal.user.id, input)),
    ownOptions: protectedProcedure.query(({ ctx }) => history.ownFilterOptions(ctx.principal.user.id)),
    platformOptions: adminProcedure.query(() => history.platformFilterOptions()),
    admin: adminProcedure.input(listRequestsInput).query(({ input }) => history.listAll(input)),
  };
}
