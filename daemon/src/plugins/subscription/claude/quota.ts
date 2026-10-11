import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { readJson } from '../openai/client.js';
import { claudeBaseUrl } from './client.js';
import { claudeCodeVersion } from './request.js';
import type { ClaudeTokens } from './tokens.js';

const windowSchema = z.object({
  utilization: z.number().nonnegative(),
  resets_at: z.string().nullish(),
});
const usageSchema = z
  .object({ five_hour: windowSchema.nullish(), seven_day: windowSchema.nullish() })
  .refine((value) => value.five_hour !== undefined || value.seven_day !== undefined);

async function fetchQuota(tokens: ClaudeTokens, id: string, signal: AbortSignal) {
  const { credentials, request } = await tokens.authorize(id);
  const response = await request(`${claudeBaseUrl}/api/oauth/usage`, {
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      authorization: `Bearer ${credentials.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'user-agent': `claude-code/${claudeCodeVersion}`,
    },
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Claude 用量查询失败（HTTP ${response.status}）`);
  }
  const usage = usageSchema.parse(await readJson(response));
  const normalize = (window: z.infer<typeof windowSchema> | null | undefined) => {
    if (!window) return null;
    const resetMs = window.resets_at ? Date.parse(window.resets_at) : Number.NaN;
    return {
      // usage 接口已经返回百分比；响应头中的 utilization 才是 0–1 比例。
      usedPercent: window.utilization,
      resetsAt: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null,
    };
  };
  return {
    fiveHour: normalize(usage.five_hour),
    sevenDay: normalize(usage.seven_day),
    fetchedAt: new Date().toISOString(),
  };
}

export class ClaudeQuota {
  private readonly cache = new Map<string, { expiresAt: number; task: ReturnType<typeof fetchQuota> }>();
  private readonly abort = new AbortController();

  get(tokens: ClaudeTokens, id: string, force = false) {
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
          throw new TRPCError({ code: 'BAD_GATEWAY', message: '获取 Claude 用量失败，请检查出站代理或账号凭据后重试' });
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
