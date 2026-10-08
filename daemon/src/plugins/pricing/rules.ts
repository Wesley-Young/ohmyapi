import { z } from 'zod';

import { billingConventions, formatMoney, parseMoney } from '../billing/conventions.js';
import { maxSearchCalls } from '../billing/search.js';

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
export type Rule = {
  id: string;
  label: string;
  kind: RuleInput['kind'];
  contextMin: bigint | null;
  contextMax: bigint | null;
  weekdaysMask: number | null;
  startMinute: number | null;
  endMinute: number | null;
  inputPriceMicros: bigint;
  outputPriceMicros: bigint;
  cacheReadPriceMicros: bigint | null;
  cacheWritePriceMicros: bigint | null;
  webSearchPriceMicros: bigint | null;
  webSearchPreviewPriceMicros: bigint | null;
};
export function expandRules(inputs: RuleInput[]) {
  return inputs.flatMap((r) => {
    const rule = {
      label: r.label,
      kind: r.kind,
      contextMin: r.contextMin === null ? null : BigInt(r.contextMin),
      contextMax: r.contextMax === null ? null : BigInt(r.contextMax),
      weekdaysMask: r.weekdaysMask,
      startMinute: r.startMinute,
      endMinute: r.endMinute,
      inputPriceMicros: parseMoney(r.inputPrice),
      outputPriceMicros: parseMoney(r.outputPrice),
      cacheReadPriceMicros: r.cacheReadPrice === null ? null : parseMoney(r.cacheReadPrice),
      cacheWritePriceMicros: r.cacheWritePrice === null ? null : parseMoney(r.cacheWritePrice),
      webSearchPriceMicros: r.webSearchPrice === null ? null : parseMoney(r.webSearchPrice),
      webSearchPreviewPriceMicros: r.webSearchPreviewPrice === null ? null : parseMoney(r.webSearchPreviewPrice),
    };
    if (r.startMinute !== null && r.endMinute !== null && r.weekdaysMask !== null && r.endMinute < r.startMinute) {
      const legs: (typeof rule)[] = [{ ...rule, endMinute: 1440 }];
      if (r.endMinute > 0)
        legs.push({ ...rule, startMinute: 0, weekdaysMask: ((r.weekdaysMask << 1) & 127) | (r.weekdaysMask >> 6) });
      return legs;
    }
    return [rule];
  });
}
export function validateRules(rules: Omit<Rule, 'id'>[]) {
  if (rules.filter((r) => r.kind === 'default').length !== 1) throw new Error('模型定价必须恰好有一条默认规则');
  for (let i = 0; i < rules.length; i++)
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i];
      const b = rules[j];
      if (a.kind !== b.kind || a.kind === 'default') continue;
      const contextOverlap =
        a.kind === 'time' ||
        ((b.contextMax === null || (a.contextMin as bigint) < b.contextMax) &&
          (a.contextMax === null || (b.contextMin as bigint) < a.contextMax));
      const timeOverlap =
        a.kind === 'context' ||
        (((a.weekdaysMask as number) & (b.weekdaysMask as number)) !== 0 &&
          (a.startMinute as number) < (b.endMinute as number) &&
          (b.startMinute as number) < (a.endMinute as number));
      if (contextOverlap && timeOverlap) throw new Error(`同优先级规则重叠：${a.label} / ${b.label}`);
    }
}
const localTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: billingConventions.timezone,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
export function ruleTimeMatcher(at: Date) {
  const parts = Object.fromEntries(localTime.formatToParts(at).map((p) => [p.type, p.value]));
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday);
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return (r: Pick<Rule, 'weekdaysMask' | 'startMinute' | 'endMinute'>) =>
    r.weekdaysMask === null ||
    ((r.weekdaysMask & (1 << day)) !== 0 && minute >= (r.startMinute as number) && minute < (r.endMinute as number));
}
export type Quantities = {
  inputTokens: bigint;
  outputTokens: bigint;
  cacheReadTokens: bigint;
  cacheWriteTokens: bigint;
  contextTokens: bigint;
  webSearchCalls: bigint;
  webSearchPreviewCalls: bigint;
};
export function quote(rules: Rule[], at: Date, usage: Quantities, multiplierMicros: bigint) {
  const matchesTime = ruleTimeMatcher(at);
  const rule = [...rules]
    .sort(
      (a, b) => billingConventions.rulePrecedence.indexOf(a.kind) - billingConventions.rulePrecedence.indexOf(b.kind),
    )
    .find(
      (r) =>
        (r.contextMin === null ||
          (usage.contextTokens >= r.contextMin && (r.contextMax === null || usage.contextTokens < r.contextMax))) &&
        matchesTime(r),
    );
  if (!rule) throw new Error('没有匹配的价格规则');
  if (
    usage.inputTokens < 0n ||
    usage.outputTokens < 0n ||
    usage.cacheReadTokens < 0n ||
    usage.cacheWriteTokens < 0n ||
    usage.contextTokens !== usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens ||
    usage.webSearchCalls < 0n ||
    usage.webSearchCalls > BigInt(maxSearchCalls) ||
    usage.webSearchPreviewCalls < 0n ||
    usage.webSearchPreviewCalls > BigInt(maxSearchCalls)
  )
    throw new Error('计费用量无效');
  const items = [
    { category: 'input', tokens: usage.inputTokens, price: rule.inputPriceMicros, unit: 'million_tokens', scale: 1n },
    {
      category: 'output',
      tokens: usage.outputTokens,
      price: rule.outputPriceMicros,
      unit: 'million_tokens',
      scale: 1n,
    },
    {
      category: 'cacheRead',
      tokens: usage.cacheReadTokens,
      price: rule.cacheReadPriceMicros,
      unit: 'million_tokens',
      scale: 1n,
    },
    {
      category: 'cacheWrite',
      tokens: usage.cacheWriteTokens,
      price: rule.cacheWritePriceMicros,
      unit: 'million_tokens',
      scale: 1n,
    },
    {
      category: 'webSearch',
      tokens: usage.webSearchCalls,
      price: rule.webSearchPriceMicros,
      unit: 'thousand_calls',
      scale: 1000n,
    },
    {
      category: 'webSearchPreview',
      tokens: usage.webSearchPreviewCalls,
      price: rule.webSearchPreviewPriceMicros,
      unit: 'thousand_calls',
      scale: 1000n,
    },
  ] as const;
  const labels = {
    input: '输入',
    output: '输出',
    cacheRead: '缓存读取',
    cacheWrite: '缓存写入',
    webSearch: 'Web Search',
    webSearchPreview: 'Web Search Preview',
  };
  let numerator = 0n;
  const details = items.map(({ category, tokens, price, unit, scale }) => {
    if (tokens > 0n && price === null) throw new Error(`${labels[category]}单价尚未配置`);
    const itemNumerator = tokens * (price ?? 0n) * multiplierMicros * scale;
    numerator += itemNumerator;
    const whole = itemNumerator / 1_000_000_000_000_000_000n;
    const fraction = (itemNumerator % 1_000_000_000_000_000_000n).toString().padStart(18, '0');
    return {
      category,
      unit,
      tokens: tokens.toString(),
      price: price === null ? null : formatMoney(price),
      amount: `${whole}.${fraction}`,
    };
  });
  const denominator = billingConventions.priceTokenUnit * billingConventions.moneyScale;
  const totalMicros = (numerator + denominator - 1n) / denominator;
  if (totalMicros > maxInteger) throw new Error('费用超出金额范围');
  return {
    ruleId: rule.id,
    ruleLabel: rule.label,
    ruleKind: rule.kind,
    multiplier: formatMoney(multiplierMicros),
    contextTokens: usage.contextTokens.toString(),
    items: details,
    total: formatMoney(totalMicros),
    totalMicros: totalMicros.toString(),
    numerator: numerator.toString(),
    denominator: denominator.toString(),
    rounding: 'ceil_total' as const,
    timezone: billingConventions.timezone,
  };
}
