import { z } from 'zod';

import { parseMoney } from '../../core/money.js';
import { maxSearchCalls } from './rules.js';

const maxInteger = 9_223_372_036_854_775_807n;
export const tokenInput = z
  .string()
  .regex(/^(0|[1-9]\d{0,18})$/, 'Token 数需为非负整数')
  .refine((s) => /^(0|[1-9]\d{0,18})$/.test(s) && BigInt(s) <= maxInteger, 'Token 数超出范围');
export const priceInput = z
  .string()
  .max(30)
  .refine((s) => {
    try {
      return parseMoney(s) >= 0n;
    } catch {
      return false;
    }
  }, '单价需为非负金额，最多六位小数');
export const searchCountInput = tokenInput.refine(
  (s) => /^(0|[1-9]\d{0,18})$/.test(s) && BigInt(s) <= BigInt(maxSearchCalls),
  '搜索调用数超出范围',
);
export const multiplierInput = priceInput.refine((s) => {
  try {
    return parseMoney(s) <= 1_000_000_000n;
  } catch {
    return false;
  }
}, '倍率需在 0–1000 之间');
export const ruleInput = z
  .object({
    label: z.string().trim().min(1).max(64),
    kind: z.enum(['default', 'context', 'time', 'combined']),
    contextMin: tokenInput.nullable(),
    contextMax: tokenInput.nullable(),
    weekdaysMask: z.number().int().min(1).max(127).nullable(),
    startMinute: z.number().int().min(0).max(1439).nullable(),
    endMinute: z.number().int().min(0).max(1440).nullable(),
    inputPrice: priceInput,
    outputPrice: priceInput,
    cacheReadPrice: priceInput.nullable(),
    cacheWritePrice: priceInput.nullable(),
    webSearchPrice: priceInput.nullable().default(null),
    webSearchPreviewPrice: priceInput.nullable().default(null),
  })
  .superRefine((rule, ctx) => {
    const context = ['context', 'combined'].includes(rule.kind);
    const time = ['time', 'combined'].includes(rule.kind);
    const min =
      rule.contextMin !== null && /^(0|[1-9]\d{0,18})$/.test(rule.contextMin) ? BigInt(rule.contextMin) : null;
    const max =
      rule.contextMax !== null && /^(0|[1-9]\d{0,18})$/.test(rule.contextMax) ? BigInt(rule.contextMax) : null;
    if (
      context
        ? rule.contextMin === null || (min !== null && max !== null && max <= min)
        : rule.contextMin !== null || rule.contextMax !== null
    )
      ctx.addIssue({ code: 'custom', message: '上下文区间需为 [最小值, 最大值)，最后一档可无上限' });
    if (
      time
        ? rule.weekdaysMask === null ||
          rule.startMinute === null ||
          rule.endMinute === null ||
          rule.startMinute === rule.endMinute
        : rule.weekdaysMask !== null || rule.startMinute !== null || rule.endMinute !== null
    )
      ctx.addIssue({ code: 'custom', message: '请填写有效星期及时间区间' });
  });
export type RuleInput = z.infer<typeof ruleInput>;

export const priceScope = z.object({ modelId: z.uuid() });
export const savePriceInput = priceScope.extend({ rules: z.array(ruleInput).max(200) });
export const previewInput = priceScope.extend({
  channelId: z.uuid().optional(),
  at: z.iso.datetime({ offset: true }),
  inputTokens: tokenInput,
  outputTokens: tokenInput,
  cacheReadTokens: tokenInput,
  cacheWriteTokens: tokenInput,
  webSearchCalls: searchCountInput.default('0'),
  webSearchPreviewCalls: searchCountInput.default('0'),
  multiplier: multiplierInput.optional(),
});

export type PriceScope = z.infer<typeof priceScope>;
export type SavePriceInput = z.infer<typeof savePriceInput>;
export type PreviewInput = z.infer<typeof previewInput>;
