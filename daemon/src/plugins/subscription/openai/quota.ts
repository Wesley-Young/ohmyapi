import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { accountHeaders, readJson } from './client.js';
import type { OpenAITokens } from './tokens.js';

const windowSchema = z.object({
  used_percent: z.number().nonnegative(),
  limit_window_seconds: z.number().int().positive(),
  reset_at: z.number().nonnegative().nullish(),
  reset_after_seconds: z.number().nonnegative().nullish(),
});
const usageSchema = z.object({
  rate_limit: z.object({ primary_window: windowSchema.nullish(), secondary_window: windowSchema.nullish() }).nullable(),
});

async function fetchQuota(tokens: OpenAITokens, id: string, signal: AbortSignal) {
  const credentials = await tokens.get(id);
  const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
    headers: accountHeaders(credentials, 'application/json'),
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('OpenAI 额度查询失败');
  }
  const usage = usageSchema.parse(await readJson(response));
  const now = Date.now();
  const windows = [usage.rate_limit?.primary_window, usage.rate_limit?.secondary_window];
  const windowFor = (seconds: number) => {
    // 部分套餐只提供周限，按窗口长度识别，不能假定 primary_window 就是 5h。
    const window = windows.find((item) => item?.limit_window_seconds === seconds);
    if (!window) return null;
    const resetMs = window.reset_at
      ? window.reset_at * 1000
      : window.reset_after_seconds != null
        ? now + window.reset_after_seconds * 1000
        : null;
    return {
      usedPercent: window.used_percent,
      resetsAt:
        resetMs !== null && Number.isFinite(new Date(resetMs).getTime()) ? new Date(resetMs).toISOString() : null,
    };
  };
  return { fiveHour: windowFor(18_000), sevenDay: windowFor(604_800), fetchedAt: new Date(now).toISOString() };
}

export class OpenAIQuota {
  private readonly cache = new Map<string, { expiresAt: number; task: ReturnType<typeof fetchQuota> }>();
  private readonly abort = new AbortController();

  get(tokens: OpenAITokens, id: string, force = false) {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
    const cached = this.cache.get(id);
    // 主动刷新跳过已完成的缓存，仍复用正在进行的上游查询。
    if (cached && (!force || cached.expiresAt === Number.POSITIVE_INFINITY)) return cached.task;
    const entry = {
      expiresAt: Number.POSITIVE_INFINITY,
      task: fetchQuota(tokens, id, this.abort.signal)
        .then((quota) => {
          entry.expiresAt = Date.now() + 60_000;
          return quota;
        })
        .catch(() => {
          entry.expiresAt = Date.now() + 15_000;
          throw new TRPCError({ code: 'BAD_GATEWAY', message: '获取 OpenAI 额度失败，请稍后重试或检查账号凭据' });
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
