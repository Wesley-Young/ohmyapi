import { z } from 'zod';

import { priceInput, searchCountInput, tokenInput } from '../pricing/schemas.js';

const requestId = z.uuid();
export const resolveBillInput = z.object({
  requestId,
  action: z.enum(['release', 'settle_usage', 'settle_amount']),
  reason: z.string().trim().min(1, '请填写核对依据').max(500),
  idempotencyKey: z.uuid(),
  amount: priceInput.optional(),
  usage: z
    .object({
      inputTokens: tokenInput,
      outputTokens: tokenInput,
      cacheReadTokens: tokenInput,
      cacheWriteTokens: tokenInput,
      webSearchCalls: searchCountInput.default('0'),
      webSearchPreviewCalls: searchCountInput.default('0'),
    })
    .optional(),
});
export const correctBillInput = z.object({
  requestId,
  amount: priceInput,
  reason: z.string().trim().min(1, '请填写修正依据').max(500),
  idempotencyKey: z.uuid(),
});
export const resolveZeroBillsInput = resolveBillInput.pick({ reason: true, idempotencyKey: true }).extend({
  requestIds: z
    .array(requestId)
    .min(1, '请先选择待核对请求')
    .max(100, '每批最多核对 100 个请求')
    .refine((ids) => new Set(ids).size === ids.length, '请求标识不能重复'),
});
export const requestIdInput = z.object({ requestId });

export type ResolveBillInput = z.infer<typeof resolveBillInput>;
export type CorrectBillInput = z.infer<typeof correctBillInput>;
export type ResolveZeroBillsInput = z.infer<typeof resolveZeroBillsInput>;
