import { adminProcedure, protectedProcedure } from '../../trpc/procedures.js';
import { userIdInput } from '../users/schemas.js';
import { correctBillInput, requestIdInput, resolveBillInput, resolveZeroBillsInput } from './schemas.js';
import type { BillingService } from './service.js';

export function billingRoutes(billing: BillingService) {
  return {
    requestDetail: protectedProcedure
      .input(requestIdInput)
      .query(({ ctx, input }) => billing.detail(ctx.principal, input.requestId)),
    admin: {
      resolve: adminProcedure
        .input(resolveBillInput)
        .mutation(({ ctx, input }) => billing.resolve(ctx.principal, input)),
      resolveZero: adminProcedure
        .input(resolveZeroBillsInput)
        .mutation(({ ctx, input }) => billing.resolveZero(ctx.principal, input)),
      correct: adminProcedure
        .input(correctBillInput)
        .mutation(({ ctx, input }) => billing.correct(ctx.principal, input)),
      reconcile: adminProcedure.input(userIdInput).query(({ input }) => billing.reconcile(input.userId)),
    },
  };
}
