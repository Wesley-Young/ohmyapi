import { billingConventions, formatMoney, parseMoney } from '../../core/money.ts';
import type { ModelOutputKind } from '../database/schema/index.ts';
import type { RuleInput } from './schemas.ts';

const maxInteger = 9_223_372_036_854_775_807n;
/** 单个请求可计费的搜索调用数上限。 */
export const maxSearchCalls = 10_000;

export type Rule = {
  id: string;
  label: string;
  kind: RuleInput['kind'];
  contextMin: bigint | null;
  contextMax: bigint | null;
  weekdaysMask: number | null;
  startMinute: number | null;
  endMinute: number | null;
  outputKind?: ModelOutputKind;
  inputPriceMicros: bigint | null;
  outputPriceMicros: bigint | null;
  cacheReadPriceMicros: bigint | null;
  cacheWritePriceMicros: bigint | null;
  imagePriceMicros: bigint | null;
  webSearchPriceMicros: bigint | null;
  webSearchPreviewPriceMicros: bigint | null;
};
export function expandRules(inputs: RuleInput[], outputKind: ModelOutputKind) {
  return inputs.flatMap((r) => {
    const rule = {
      outputKind,
      label: r.label,
      kind: r.kind,
      contextMin: r.contextMin === null ? null : BigInt(r.contextMin),
      contextMax: r.contextMax === null ? null : BigInt(r.contextMax),
      weekdaysMask: r.weekdaysMask,
      startMinute: r.startMinute,
      endMinute: r.endMinute,
      inputPriceMicros: r.inputPrice === null ? null : parseMoney(r.inputPrice),
      outputPriceMicros: r.outputPrice === null ? null : parseMoney(r.outputPrice),
      cacheReadPriceMicros: r.cacheReadPrice === null ? null : parseMoney(r.cacheReadPrice),
      cacheWritePriceMicros: r.cacheWritePrice === null ? null : parseMoney(r.cacheWritePrice),
      imagePriceMicros: r.imagePrice === null ? null : parseMoney(r.imagePrice),
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
  for (const r of rules) {
    if (r.outputKind === 'image') {
      if (
        r.imagePriceMicros === null ||
        r.contextMin !== null ||
        [
          r.inputPriceMicros,
          r.outputPriceMicros,
          r.cacheReadPriceMicros,
          r.cacheWritePriceMicros,
          r.webSearchPriceMicros,
          r.webSearchPreviewPriceMicros,
        ].some((v) => v !== null)
      )
        throw new Error('图像规则只支持默认价或时段价，须填写每张单价');
    } else if (r.inputPriceMicros === null || r.outputPriceMicros === null || r.imagePriceMicros !== null)
      throw new Error('文本规则须填写输入、输出单价，图像单价应留空');
  }
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
type TokenQuantities = {
  inputTokens: bigint;
  outputTokens: bigint;
  cacheReadTokens: bigint;
  cacheWriteTokens: bigint;
  contextTokens: bigint;
  webSearchCalls: bigint;
  webSearchPreviewCalls: bigint;
};
export type Quantities = TokenQuantities | { generatedImages: bigint };

export function matchRule<T extends Rule>(rules: T[], at: Date, contextTokens: bigint): T | undefined {
  const matchesTime = ruleTimeMatcher(at);
  return [...rules]
    .sort(
      (a, b) => billingConventions.rulePrecedence.indexOf(a.kind) - billingConventions.rulePrecedence.indexOf(b.kind),
    )
    .find(
      (r) =>
        (r.contextMin === null ||
          (contextTokens >= r.contextMin && (r.contextMax === null || contextTokens < r.contextMax))) &&
        matchesTime(r),
    );
}
/** 规则保存时会整体重建 ID，跨版本按生效条件识别同一条规则。 */
export function ruleSignature(
  r: Pick<Rule, 'kind' | 'weekdaysMask' | 'startMinute' | 'endMinute'> & {
    contextMin: bigint | string | null;
    contextMax: bigint | string | null;
  },
) {
  return [r.kind, r.contextMin, r.contextMax, r.weekdaysMask, r.startMinute, r.endMinute].map(String).join('|');
}
function tokenPriceItems(rule: Rule, usage: TokenQuantities) {
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
  return [
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
}

export function fastTokenMultiplier(
  responseTier: string | null | undefined,
  fastMultiplier?: number,
  fastRequested?: boolean,
) {
  // 旧快照只记录倍率，沿用当时按终止响应判定 Fast 的规则。
  if (fastRequested === undefined)
    return responseTier === 'priority' || responseTier === 'fast' ? fastMultiplier : undefined;
  // Codex OAuth 的 default 也可能表示 Fast。只有明确回报 flex 或 scale 才免除 Fast 加价。
  return fastRequested && responseTier !== 'flex' && responseTier !== 'scale' ? fastMultiplier : undefined;
}

export function quote(rules: Rule[], at: Date, usage: Quantities, multiplierMicros: bigint, tokenMultiplier = 1) {
  const contextTokens = 'inputTokens' in usage ? usage.contextTokens : 0n;
  const rule = matchRule(rules, at, contextTokens);
  if (!rule) throw new Error('没有匹配的价格规则');
  if (!('inputTokens' in usage) && (usage.generatedImages < 0n || rule.imagePriceMicros === null))
    throw new Error('出图张数无效或图像单价尚未配置');
  const items =
    'inputTokens' in usage
      ? tokenPriceItems(rule, usage)
      : ([
          {
            category: 'images',
            tokens: usage.generatedImages,
            price: rule.imagePriceMicros,
            unit: 'image',
            scale: 1_000_000n,
          },
        ] as const);
  const labels = {
    images: '图像生成',
    input: '输入',
    output: '输出',
    cacheRead: '缓存读取',
    cacheWrite: '缓存写入',
    webSearch: 'Web Search',
    webSearchPreview: 'Web Search Preview',
  };
  let numerator = 0n;
  const details = items.map(({ category, tokens, price: basePrice, unit, scale }) => {
    const price = unit === 'million_tokens' && basePrice !== null ? basePrice * BigInt(tokenMultiplier) : basePrice;
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
    contextTokens: contextTokens.toString(),
    items: details,
    total: formatMoney(totalMicros),
    totalMicros: totalMicros.toString(),
    numerator: numerator.toString(),
    denominator: denominator.toString(),
    rounding: 'ceil_total' as const,
    timezone: billingConventions.timezone,
  };
}
