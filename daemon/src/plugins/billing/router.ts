import { adminProcedure, protectedProcedure } from '../../trpc/procedures.ts';
import { userIdInput } from '../users/schemas.ts';
import type { BillingRecords } from './records.ts';
import type { BillingReview } from './review.ts';
import {
  batchRequestsInput,
  correctBillInput,
  requestIdInput,
  resolveBatchInput,
  resolveBillInput,
} from './schemas.ts';

export function billingRoutes(records: BillingRecords, review: BillingReview) {
  return {
    requestDetail: protectedProcedure
      .input(requestIdInput)
      .query(({ ctx, input }) => records.detail(ctx.principal, input.requestId)),
    admin: {
      resolve: adminProcedure
        .input(resolveBillInput)
        .mutation(({ ctx, input }) => review.resolve(ctx.principal, input)),
      batchPlan: adminProcedure
        .input(batchRequestsInput)
        .query(({ ctx, input }) => review.batchPlan(ctx.principal, input)),
      resolveBatch: adminProcedure
        .input(resolveBatchInput)
        .mutation(({ ctx, input }) => review.resolveBatch(ctx.principal, input)),
      correct: adminProcedure
        .input(correctBillInput)
        .mutation(({ ctx, input }) => review.correct(ctx.principal, input)),
      reconcile: adminProcedure.input(userIdInput).query(({ input }) => records.reconcile(input.userId)),
    },
  };
}
