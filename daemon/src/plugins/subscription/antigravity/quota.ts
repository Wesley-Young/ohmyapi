import { AppError } from '../../../core/errors.ts';
import { isGeminiPathModel } from '../../../protocols/index.ts';
import type { OutboundFetch } from '../../outbound/index.ts';
import type { PlanCache } from '../plan.ts';
import { fetchAntigravityGeminiQuota, fetchAntigravityModels, loadAntigravityAccount } from './client.ts';
import type { AntigravityCredentials } from './credentials.ts';
import { publicModelNames } from './models.ts';
import type { AntigravityTokens } from './tokens.ts';

async function fetchQuota(
  tokens: AntigravityTokens,
  id: string,
  signal: AbortSignal,
  plans: PlanCache,
  force: boolean,
) {
  const { credentials, request } = await tokens.authorize(id);
  const plan =
    force || !plans.has(id)
      ? loadAntigravityAccount(credentials.accessToken, request, signal).then(
          (account) => {
            plans.set(id, account.plan);
          },
          () => {
            plans.set(id, null);
          },
        )
      : undefined;
  const quota = await fetchAntigravityGeminiQuota(
    credentials.accessToken,
    credentials.projectId as string,
    request,
    signal,
  );
  await plan;
  return { ...quota, fetchedAt: new Date().toISOString(), plan: plans.get(id) ?? null };
}

/** Gemini 额度池的 5h 与 7d 额度，缓存 60 秒；失败结果缓存 15 秒，避免频繁请求上游。 */
export class AntigravityQuota {
  private readonly cache = new Map<string, { expiresAt: number; task: ReturnType<typeof fetchQuota> }>();
  private readonly plans: PlanCache = new Map();
  private readonly abort = new AbortController();

  get(tokens: AntigravityTokens, id: string, force = false) {
    const now = Date.now();
    for (const [key, entry] of this.cache) if (entry.expiresAt <= now) this.cache.delete(key);
    const cached = this.cache.get(id);
    if (cached && (!force || cached.expiresAt === Number.POSITIVE_INFINITY)) return cached.task;
    const entry = {
      expiresAt: Number.POSITIVE_INFINITY,
      task: fetchQuota(tokens, id, this.abort.signal, this.plans, force)
        .then((quota) => {
          entry.expiresAt = Date.now() + 60_000;
          return quota;
        })
        .catch(() => {
          entry.expiresAt = Date.now() + 15_000;
          throw new AppError('bad_gateway', '获取 Antigravity 额度失败，请检查出站代理或账号状态后重试');
        }),
    };
    this.cache.set(id, entry);
    return entry.task;
  }

  invalidate(id: string) {
    this.cache.delete(id);
    this.plans.delete(id);
  }

  dispose() {
    this.abort.abort();
    this.cache.clear();
    this.plans.clear();
  }
}

/** 账号可调用的模型；名称需能放入 Gemini 路径。 */
export async function antigravityModelNames(credentials: AntigravityCredentials, request: OutboundFetch) {
  if (!credentials.projectId)
    throw new AppError('bad_request', '该 Google 账号尚未开通 Antigravity，请先在官方客户端完成初始化');
  const models = await fetchAntigravityModels(
    credentials.accessToken,
    credentials.projectId,
    request,
    AbortSignal.timeout(30_000),
  );
  const upstream = models.map((model) => model.name);
  // 思考档位变体合并为规范名称，转发时再按请求选择变体。
  const merged = publicModelNames(upstream);
  const names = merged.filter(isGeminiPathModel);
  return { names, ignored: merged.length - names.length, upstream };
}
