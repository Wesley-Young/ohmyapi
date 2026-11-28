import { z } from 'zod';

import { AppError } from '../../../core/errors.ts';
import { readJson } from '../openai/client.ts';
import { planValue } from '../plan.ts';
import type { SubscriptionRuntime } from '../runtime.ts';

const numeric = z
  .union([z.number(), z.string().trim().min(1)])
  .transform(Number)
  .pipe(z.number());
const limitSchema = z.object({
  type: z.string(),
  unit: numeric.nullish(),
  percentage: numeric.pipe(z.number().min(0).max(100)).nullish(),
  nextResetTime: z.union([z.number(), z.string()]).nullish(),
});
const limitsSchema = z.array(limitSchema);
const upstreamEmail = z.string().trim().pipe(z.email().max(254)).nullable().catch(null);
const quotaData = z.union([
  z.object({ level: z.string().nullish(), email: upstreamEmail, limits: limitsSchema }),
  limitsSchema.transform((limits) => ({ level: null, email: null, limits })),
]);

function parseQuota(body: unknown) {
  if (Array.isArray(body)) return quotaData.parse(body);
  const envelope = z
    .object({ success: z.literal(true).optional(), email: upstreamEmail, data: z.unknown().optional() })
    .parse(body);
  const data = quotaData.parse(envelope.data ?? body);
  return { ...data, email: data.email ?? envelope.email };
}

function resetTime(value: z.infer<typeof limitSchema>['nextResetTime']) {
  if (!value) return null;
  const milliseconds = typeof value === 'number' || /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) && milliseconds > 0 ? date.toISOString() : null;
}

async function fetchQuota(runtime: SubscriptionRuntime, id: string, signal: AbortSignal) {
  const { apiKey, request } = await runtime.zhipuAccount(id);
  const response = await request('https://open.bigmodel.cn/api/monitor/usage/quota/limit', {
    headers: { authorization: apiKey, accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`智谱额度查询失败（HTTP ${response.status}）`);
  }
  const data = parseQuota(await readJson(response));
  // V2 返回 TOKENS_LIMIT，V3 积分套餐返回 CREDIT_LIMIT。两版均以上游已用百分比展示。
  const windowFor = (unit: number) => {
    const matches = data.limits.filter((limit) => limit.unit === unit && limit.percentage != null);
    const limit =
      matches.find((item) => item.type === 'TOKENS_LIMIT') ?? matches.find((item) => item.type === 'CREDIT_LIMIT');
    return limit?.percentage == null
      ? null
      : { usedPercent: limit.percentage, resetsAt: resetTime(limit.nextResetTime) };
  };
  return {
    fiveHour: windowFor(3),
    sevenDay: windowFor(6),
    plan: planValue(data.level?.trim().replace(/\s+/g, '-')),
    // 两代套餐可返回相同的 level；周限使用 TOKENS_LIMIT 的个人套餐为 V2。
    tokenPlan:
      data.limits.some((limit) => limit.type === 'TOKENS_LIMIT' && limit.unit === 6) &&
      !data.limits.some((limit) => limit.type === 'CREDIT_LIMIT'),
    email: data.email,
    fetchedAt: new Date().toISOString(),
  };
}

export class ZhipuQuota {
  private readonly cache = new Map<string, { expiresAt: number; task: ReturnType<typeof fetchQuota> }>();
  private readonly abort = new AbortController();

  get(runtime: SubscriptionRuntime, id: string, force = false) {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
    const cached = this.cache.get(id);
    if (cached && (!force || cached.expiresAt === Infinity)) return cached.task;
    const entry = {
      expiresAt: Infinity,
      task: fetchQuota(runtime, id, this.abort.signal)
        .then((quota) => {
          entry.expiresAt = Date.now() + 60_000;
          return quota;
        })
        .catch(() => {
          entry.expiresAt = Date.now() + 15_000;
          throw new AppError('bad_gateway', '获取智谱套餐额度失败，请检查 API Key 和出站代理');
        }),
    };
    this.cache.set(id, entry);
    return entry.task;
  }

  invalidate(id: string) {
    this.cache.delete(id);
  }

  dispose() {
    this.abort.abort();
    this.cache.clear();
  }
}
