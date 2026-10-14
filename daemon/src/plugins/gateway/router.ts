import { paginationInput } from '../../core/pagination.js';
import { adminProcedure, protectedProcedure } from '../../trpc/procedures.js';
import { listRequestsInput } from './schemas.js';
import type { GatewayService } from './service.js';

export function requestRoutes(gateway: GatewayService) {
  return {
    user: protectedProcedure
      .input(paginationInput)
      .query(({ ctx, input }) => gateway.list(ctx.principal.user.id, input.page)),
    admin: adminProcedure
      .input(listRequestsInput)
      .query(({ input }) => gateway.list(undefined, input.page, input.reviewOnly)),
  };
}
