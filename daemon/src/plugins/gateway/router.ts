import { paginationInput } from '../../core/pagination.js';
import { adminProcedure, protectedProcedure } from '../../trpc/procedures.js';
import type { RequestHistory } from './history.js';
import { listRequestsInput } from './schemas.js';

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
