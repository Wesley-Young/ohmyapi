import { adminProcedure, protectedProcedure } from '../../trpc/procedures.js';
import { userIdInput } from '../users/schemas.js';
import type { BillingRecords } from './records.js';
import type { BillingReview } from './review.js';
import { correctBillInput, requestIdInput, resolveBillInput, resolveZeroBillsInput } from './schemas.js';

export function billingRoutes(records: BillingRecords, review: BillingReview) {
  return {
    requestDetail: protectedProcedure
      .input(requestIdInput)
      .query(({ ctx, input }) => records.detail(ctx.principal, input.requestId)),
    admin: {
      resolve: adminProcedure
        .input(resolveBillInput)
        .mutation(({ ctx, input }) => review.resolve(ctx.principal, input)),
      resolveZero: adminProcedure
        .input(resolveZeroBillsInput)
        .mutation(({ ctx, input }) => review.resolveZero(ctx.principal, input)),
      correct: adminProcedure
        .input(correctBillInput)
        .mutation(({ ctx, input }) => review.correct(ctx.principal, input)),
      reconcile: adminProcedure.input(userIdInput).query(({ input }) => records.reconcile(input.userId)),
    },
  };
}
