import { paginationInput } from '../../core/pagination.ts';
import { adminProcedure, protectedProcedure } from '../../trpc/procedures.ts';
import type { RequestHistory } from './history.ts';
import { listRequestsInput } from './schemas.ts';

export function requestRoutes(history: RequestHistory) {
  return {
    user: protectedProcedure
      .input(paginationInput)
      .query(({ ctx, input }) => history.listOwn(ctx.principal.user.id, input.page)),
    admin: adminProcedure.input(listRequestsInput).query(({ input }) => history.listAll(input.page, input.reviewOnly)),
  };
}
