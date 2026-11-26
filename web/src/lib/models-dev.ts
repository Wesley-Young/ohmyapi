import type { RouterInputs } from '@ohmyapi/daemon/trpc';

type ImportEntry = RouterInputs['admin']['catalog']['importModels']['models'][number];
export type ImportPreset = ImportEntry['preset'];
type Rule = ImportEntry['rules'][number];
type ImportPrices = Pick<Rule, 'inputPrice' | 'outputPrice' | 'cacheReadPrice' | 'cacheWritePrice' | 'imagePrice'>;
export type SourceModel = {
  key: string;
  providerId: string;
  providerName: string;
  official: boolean;
  name: string;
  displayName: string;
  prices: ImportPrices;
} & (
  | { outputKind: 'image'; inputTokenLimit: null; outputTokenLimit: null }
  | { outputKind: 'text'; inputTokenLimit: number; outputTokenLimit: number }
);
export const importPresets = { none: '无预设', gpt: 'GPT 预设', deepseek: 'DeepSeek 预设' };
const maxMicros = 9_223_372_036_854_775_807n;

export function suggestedPreset(model: SourceModel): ImportPreset {
  if (model.outputKind === 'image') return 'none';
  const normalized = model.name.toLowerCase();
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
    imagePrice: scalePrice(prices.imagePrice ?? null, multiplier, 1_000_000n),
    inputPrice: scalePrice(prices.inputPrice, multiplier, 1_000_000n),
    outputPrice: scalePrice(prices.outputPrice, multiplier, 1_000_000n),
    cacheReadPrice: scalePrice(prices.cacheReadPrice, multiplier, 1_000_000n),
    cacheWritePrice: scalePrice(prices.cacheWritePrice, multiplier, 1_000_000n),
  };
}
// Generate once for both preview and submission; fractional micros round up.
export function buildImportRules(
  prices: ImportPrices,
  preset: ImportPreset,
  outputKind: SourceModel['outputKind'],
): Rule[] {
  const base: Rule = {
    ...prices,
    label: '默认价格',
    kind: 'default',
    contextMin: null,
    contextMax: null,
    weekdaysMask: null,
    startMinute: null,
    endMinute: null,
    webSearchPrice: null,
    webSearchPreviewPrice: null,
  };
  if (outputKind === 'image') return prices.imagePrice == null ? [] : [base];
  if (preset === 'none') return [base];
  const doubled = {
    inputPrice: scalePrice(prices.inputPrice, 2n),
    outputPrice: scalePrice(prices.outputPrice, 2n),
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
        outputPrice: scalePrice(prices.outputPrice, 3n, 2n),
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
function perImagePrice(output: Record<string, unknown>): string | null {
  if (output.unit !== 'image') return null;
  try {
    return sourcePrice(output.price);
  } catch {
    return null;
  }
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
const capacity = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;

const officialProviderAliases: Record<string, string[]> = {
  google: ['google-vertex'],
  alibaba: [
    'alibaba-cn',
    'alibaba-coding-plan',
    'alibaba-coding-plan-cn',
    'alibaba-token-plan',
    'alibaba-token-plan-cn',
  ],
  moonshotai: ['moonshotai-cn'],
  minimax: ['minimax-cn', 'minimax-coding-plan', 'minimax-coding-plan-cn'],
  zhipuai: ['zhipuai-cn', 'zai', 'zai-coding-plan'],
};
const modelAlias = (name: string) => name.toLowerCase().split('/').at(-1) ?? '';
const canonicalPublisher = (model: Record<string, unknown>) =>
  typeof model.canonical_id === 'string' ? model.canonical_id.match(/^([a-z0-9-]+)\/.+/)?.[1] : undefined;

function officialMatcher(providers: Record<string, unknown>) {
  const publishers = new Map<string, Set<string>>();
  // Some official entries omit canonical_id; other providers can identify
  // the same model. Do not infer a publisher when their metadata disagrees.
  for (const provider of Object.values(providers)) {
    for (const raw of Object.values(record(record(provider).models))) {
      const model = record(raw);
      const publisher = canonicalPublisher(model);
      if (!publisher || typeof model.id !== 'string') continue;
      for (const alias of [model.id.toLowerCase(), modelAlias(model.id), modelAlias(String(model.canonical_id))]) {
        const owners = publishers.get(alias) ?? new Set<string>();
        owners.add(publisher);
        publishers.set(alias, owners);
      }
    }
  }
  return (providerId: string, model: Record<string, unknown>) => {
    const owners = publishers.get(String(model.id).toLowerCase()) ?? publishers.get(modelAlias(String(model.id)));
    const publisher = canonicalPublisher(model) ?? (owners?.size === 1 ? [...owners][0] : undefined);
    return Boolean(publisher && (providerId === publisher || officialProviderAliases[publisher]?.includes(providerId)));
  };
}

export async function fetchModelsDev(signal: AbortSignal): Promise<SourceModel[]> {
  const response = await fetch('https://models.dev/experimental/v2.0/api.json', {
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (!response.ok) throw new Error('无法读取 models.dev，请稍后重试');
  const providers = record(await response.json());
  const isOfficial = officialMatcher(providers);
  const models = new Map<string, SourceModel>();
  for (const [providerId, raw] of Object.entries(providers)) {
    if (providerId.length > 128) continue;
    const provider = record(raw);
    const providerName = typeof provider.name === 'string' && provider.name ? provider.name.slice(0, 256) : providerId;
    for (const rawModel of Object.values(record(provider.models))) {
      const model = record(rawModel);
      const name = model.id;
      if (typeof name !== 'string' || name.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_./:-]*$/.test(name)) continue;
      if (model.type !== 'image' && model.type !== 'chat' && model.type !== 'decision') continue;
      const outputKind = model.type === 'image' ? 'image' : 'text';
      const cost = record(model.cost);
      const textCost = record(cost.text);
      const input = record(textCost.input);
      const output = record(textCost.output);
      const cache = record(input.cache);
      const imageOutput = record(record(cost.image).output);
      const limit = record(model.limit);
      try {
        const inputPrice =
          outputKind === 'text' && (!input.unit || input.unit === 'token') ? sourcePrice(input.price) : null;
        const outputPrice =
          outputKind === 'text' && (!output.unit || output.unit === 'token') ? sourcePrice(output.price) : null;
        if (outputKind === 'text' && (inputPrice === null || outputPrice === null)) continue;
        const cacheWrite = typeof cache.write === 'object' ? Object.values(record(cache.write))[0] : cache.write;
        const key = JSON.stringify([providerId, name]);
        models.set(key, {
          key,
          providerId,
          providerName,
          official: isOfficial(providerId, model),
          name,
          displayName: typeof model.name === 'string' && model.name ? model.name.slice(0, 256) : name,
          ...(outputKind === 'image'
            ? { outputKind, inputTokenLimit: null, outputTokenLimit: null }
            : {
                outputKind,
                inputTokenLimit: capacity(limit.input, capacity(limit.context, 1_000_000)),
                outputTokenLimit: capacity(limit.output, 128_000),
              }),
          prices: {
            inputPrice,
            outputPrice,
            imagePrice: outputKind === 'image' ? perImagePrice(imageOutput) : null,
            cacheReadPrice: outputKind === 'text' ? sourcePrice(cache.read) : null,
            cacheWritePrice: outputKind === 'text' ? sourcePrice(cacheWrite) : null,
          },
        });
      } catch {
        // An invalid remote entry must not prevent selecting other models.
      }
    }
  }
  if (!models.size) throw new Error('models.dev 未返回可导入的模型');
  return [...models.values()].sort(
    (a, b) =>
      Number(b.official) - Number(a.official) ||
      a.name.localeCompare(b.name) ||
      a.providerName.localeCompare(b.providerName),
  );
}
