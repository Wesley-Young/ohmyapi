import { paginationInput } from '../../core/pagination.ts';
import { adminProcedure, protectedProcedure } from '../../trpc/procedures.ts';
import type { RequestHistory } from './history.ts';
import { listRequestsInput } from './schemas.ts';

export function requestRoutes(history: RequestHistory) {
  return {
    user: protectedProcedure
      .input(paginationInput)
      .query(({ ctx, input }) => history.list(ctx.principal.user.id, input.page)),
    admin: adminProcedure
      .input(listRequestsInput)
      .query(({ input }) => history.list(undefined, input.page, input.reviewOnly)),
  };
}
