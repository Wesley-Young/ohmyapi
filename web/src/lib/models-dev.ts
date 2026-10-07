import type { RouterInputs } from '@ohmyapi/daemon/trpc';

type ImportEntry = RouterInputs['admin']['catalog']['importModels']['models'][number];
export type ImportPreset = ImportEntry['preset'];
type Rule = ImportEntry['rules'][number];
export type ImportPrices = Pick<Rule, 'inputPrice' | 'outputPrice' | 'cacheReadPrice' | 'cacheWritePrice'>;
export type SourceModel = {
  key: string;
  providerId: string;
  providerName: string;
  name: string;
  displayName: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
  prices: ImportPrices;
};
export const importPresets = { none: '无预设', gpt: 'GPT 预设', deepseek: 'DeepSeek 预设' };
const maxMicros = 9_223_372_036_854_775_807n;

export function suggestedPreset(name: string): ImportPreset {
  const normalized = name.toLowerCase();
  if (normalized.includes('gpt')) return 'gpt';
  if (normalized.includes('deepseek')) return 'deepseek';
  return 'none';
}

function formatPrice(micros: bigint): string {
  if (micros < 0n || micros > maxMicros) throw new Error('单价超出范围');
  return `${micros / 1_000_000n}.${(micros % 1_000_000n).toString().padStart(6, '0')}`;
}
function parsePrice(value: string): bigint {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value)) throw new Error('金额需为非负数，最多六位小数');
  const [whole, fraction = ''] = value.split('.');
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (micros > maxMicros) throw new Error('金额超出范围');
  return micros;
}
function scalePrice(price: string | null, numerator: bigint, denominator = 1n): string | null {
  if (price === null) return null;
  return formatPrice((parsePrice(price) * numerator + denominator - 1n) / denominator);
}
export function convertPrices(prices: ImportPrices, rate: string): ImportPrices {
  const multiplier = parsePrice(rate);
  if (multiplier === 0n) throw new Error('请输入大于 0 的 USD 换算系数');
  return {
    inputPrice: scalePrice(prices.inputPrice, multiplier, 1_000_000n) as string,
    outputPrice: scalePrice(prices.outputPrice, multiplier, 1_000_000n) as string,
    cacheReadPrice: scalePrice(prices.cacheReadPrice, multiplier, 1_000_000n),
    cacheWritePrice: scalePrice(prices.cacheWritePrice, multiplier, 1_000_000n),
  };
}
// Generate once for both preview and submission; fractional micros round up.
export function buildImportRules(prices: ImportPrices, preset: ImportPreset): Rule[] {
  const base: Rule = {
    ...prices,
    label: '默认价格',
    kind: 'default',
    contextMin: null,
    contextMax: null,
    weekdaysMask: null,
    startMinute: null,
    endMinute: null,
  };
  if (preset === 'none') return [base];
  const doubled = {
    inputPrice: scalePrice(prices.inputPrice, 2n) as string,
    outputPrice: scalePrice(prices.outputPrice, 2n) as string,
    cacheReadPrice: scalePrice(prices.cacheReadPrice, 2n),
    cacheWritePrice: scalePrice(prices.cacheWritePrice, 2n),
  };
  if (preset === 'gpt')
    return [
      base,
      {
        ...base,
        ...doubled,
        label: '长上下文（超过 272k）',
        kind: 'context',
        contextMin: '272001',
        outputPrice: scalePrice(prices.outputPrice, 3n, 2n) as string,
      },
    ];
  return [
    base,
    ...[
      { label: '工作日上午高峰', startMinute: 540, endMinute: 720 },
      { label: '工作日下午高峰', startMinute: 840, endMinute: 1080 },
    ].map((period): Rule => ({ ...base, ...doubled, ...period, kind: 'time', weekdaysMask: 31 })),
  ];
}

function sourcePrice(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('无效的模型价格');
  // Expand scientific notation using integers to preserve tiny nonzero prices.
  const [decimal, exponent = '0'] = value.toString().toLowerCase().split('e');
  const [whole, fraction = ''] = decimal.split('.');
  const digits = BigInt(whole + fraction);
  const shift = 6 + Number(exponent) - fraction.length;
  const divisor = shift < 0 ? 10n ** BigInt(-shift) : 1n;
  return formatPrice(shift >= 0 ? digits * 10n ** BigInt(shift) : (digits + divisor - 1n) / divisor);
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
const capacity = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;

export async function fetchModelsDev(signal: AbortSignal): Promise<SourceModel[]> {
  const response = await fetch('https://models.dev/api.json', {
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (!response.ok) throw new Error('无法读取 models.dev，请稍后重试');
  const providers = record(await response.json());
  const models = new Map<string, SourceModel>();
  for (const [providerId, raw] of Object.entries(providers)) {
    if (providerId.length > 128) continue;
    const provider = record(raw);
    const providerName = typeof provider.name === 'string' && provider.name ? provider.name.slice(0, 256) : providerId;
    for (const rawModel of Object.values(record(provider.models))) {
      const model = record(rawModel);
      const name = model.id;
      if (typeof name !== 'string' || name.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_./:-]*$/.test(name)) continue;
      const cost = record(model.cost);
      const limit = record(model.limit);
      try {
        const inputPrice = sourcePrice(cost.input);
        const outputPrice = sourcePrice(cost.output);
        if (inputPrice === null || outputPrice === null) continue;
        const key = JSON.stringify([providerId, name]);
        models.set(key, {
          key,
          providerId,
          providerName,
          name,
          displayName: typeof model.name === 'string' && model.name ? model.name.slice(0, 256) : name,
          inputTokenLimit: capacity(limit.input, capacity(limit.context, 1_000_000)),
          outputTokenLimit: capacity(limit.output, 128_000),
          prices: {
            inputPrice,
            outputPrice,
            cacheReadPrice: sourcePrice(cost.cache_read),
            cacheWritePrice: sourcePrice(cost.cache_write),
          },
        });
      } catch {
        // An invalid remote entry must not prevent selecting other models.
      }
    }
  }
  if (!models.size) throw new Error('models.dev 未返回可导入的模型');
  return [...models.values()].sort(
    (a, b) => a.providerName.localeCompare(b.providerName) || a.name.localeCompare(b.name),
  );
}
