type Data = Record<string, unknown>;
const object = (value: unknown): Data | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : undefined;

/**
 * Antigravity 的目录中，部分 Gemini 模型只以思考档位变体出现（如 gemini-3.8-flash-high），没有规范名称。
 * 对外只暴露规范名称，转发时按请求的 thinkingConfig 选择变体；这些名称不进入网关和计费。
 */
const variants = ['low', 'medium', 'high', 'tiered'] as const;
type Level = 'low' | 'medium' | 'high';

/** 变体对应的规范名称；不是 Gemini 思考档位变体时返回 undefined。 */
function canonicalName(name: string) {
  if (!name.startsWith('gemini-')) return undefined;
  const suffix = variants.find((variant) => name.endsWith(`-${variant}`));
  return suffix ? name.slice(0, -suffix.length - 1) : undefined;
}

/** 上游目录转换为对外的模型名称：思考档位变体合并为规范名称。 */
export function publicModelNames(names: Iterable<string>) {
  return [...new Set([...names].map((name) => canonicalName(name) ?? name))].sort();
}

const budgetLowMax = 1024;
const budgetMediumMax = 8192;

/**
 * 请求期望的思考档位，阈值与 sub2api 一致：thinkingLevel 优先（minimal 视为 low）；
 * thinkingBudget 为 -1（动态）取 high，0–1024 取 low，1025–8192 取 medium，更大取 high；
 * 未设置时取 high，与 Gemini 3 默认的动态思考一致。请求体已统一为 lowerCamelCase。
 */
export function thinkingLevel(body: Data): Level {
  const config = object(object(body.generationConfig)?.thinkingConfig);
  const level = typeof config?.thinkingLevel === 'string' ? config.thinkingLevel.trim().toLowerCase() : '';
  if (level === 'minimal' || level === 'low') return 'low';
  if (level === 'medium' || level === 'high') return level;
  const budget = config?.thinkingBudget;
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0) return 'high';
  return budget <= budgetLowMax ? 'low' : budget <= budgetMediumMax ? 'medium' : 'high';
}

/**
 * 选择发往上游的模型名：目录中有该名称时原样使用；否则按期望档位选择变体，
 * 缺少该档位时按 high、medium、low、tiered 的顺序降级。目录未知或没有变体时原样转发。
 */
export function upstreamModel(model: string, catalog: ReadonlySet<string> | undefined, level: Level) {
  if (!catalog || catalog.has(model)) return model;
  const order = [level, ...(['high', 'medium', 'low', 'tiered'] as const).filter((item) => item !== level)];
  for (const variant of order) if (catalog.has(`${model}-${variant}`)) return `${model}-${variant}`;
  return model;
}

/**
 * 每个账号的上游模型目录，缓存 10 分钟；查询失败时 30 秒内不再重试，期间按原名转发。
 * 同一账号的并发查询合并为一次。
 */
export class AntigravityModelCatalog {
  private readonly entries = new Map<string, { expiresAt: number; task: Promise<ReadonlySet<string> | undefined> }>();

  get(id: string, load: () => Promise<string[]>) {
    const now = Date.now();
    const cached = this.entries.get(id);
    if (cached && cached.expiresAt > now) return cached.task;
    const entry = {
      expiresAt: Number.POSITIVE_INFINITY,
      task: load().then(
        (names) => {
          entry.expiresAt = Date.now() + 10 * 60_000;
          return new Set(names) as ReadonlySet<string>;
        },
        () => {
          entry.expiresAt = Date.now() + 30_000;
          return undefined;
        },
      ),
    };
    this.entries.set(id, entry);
    if (this.entries.size > 10_000) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined && oldest !== id) this.entries.delete(oldest);
    }
    return entry.task;
  }

  /** 已经拿到完整目录时（如管理页面拉取模型）直接更新缓存。 */
  set(id: string, names: string[]) {
    this.entries.set(id, { expiresAt: Date.now() + 10 * 60_000, task: Promise.resolve(new Set(names)) });
  }

  invalidate(id: string) {
    this.entries.delete(id);
  }
}
