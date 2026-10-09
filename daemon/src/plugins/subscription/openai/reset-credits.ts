import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { accountHeaders, readJson } from './client.js';
import type { OpenAICredentials } from './credentials.js';
import type { OpenAITokens } from './tokens.js';

const creditsUrl = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const creditsSchema = z.object({
  credits: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        reset_type: z.string(),
        status: z.string(),
        is_supported_by_plan: z.boolean().optional(),
        expires_at: z.string().nullish(),
      }),
    )
    .max(1000),
});
const resultSchema = z.object({
  code: z.string(),
  windows_reset: z.number().int().nonnegative(),
});

async function readCredits(credentials: OpenAICredentials) {
  const response = await fetch(creditsUrl, {
    headers: accountHeaders(credentials, 'application/json'),
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('获取重置卡失败');
  }
  const payload = creditsSchema.parse(await readJson(response));
  const credits = payload.credits
    .filter((credit) => credit.reset_type === 'codex_rate_limits' && credit.status === 'available')
    .map((credit) => {
      const expiration = credit.expires_at ? Date.parse(credit.expires_at) : Number.NaN;
      const expiresAt = Number.isFinite(expiration) ? new Date(expiration).toISOString() : null;
      const supported = credit.is_supported_by_plan !== false;
      return { id: credit.id, expiresAt, supported, usable: supported && expiration > Date.now() };
    })
    .sort((a, b) => (a.expiresAt ?? '').localeCompare(b.expiresAt ?? ''));
  return { credits, availableCount: credits.filter((credit) => credit.usable).length };
}

export class OpenAIResetCredits {
  private readonly consuming = new Set<string>();

  async list(tokens: OpenAITokens, id: string) {
    try {
      return await readCredits(await tokens.get(id));
    } catch {
      throw new TRPCError({ code: 'BAD_GATEWAY', message: '获取 OpenAI 重置卡失败，请刷新查询或检查账号凭据' });
    }
  }

  async consume(tokens: OpenAITokens, id: string, creditId: string, redeemRequestId: string) {
    if (this.consuming.has(id))
      throw new TRPCError({ code: 'CONFLICT', message: '该账号正在使用重置卡，请等待操作完成' });
    this.consuming.add(id);
    try {
      const credentials = await tokens.get(id);
      const snapshot = await readCredits(credentials).catch(() => {
        throw new TRPCError({ code: 'BAD_GATEWAY', message: '无法确认重置卡状态，尚未提交使用请求，请刷新查询' });
      });
      if (!snapshot.credits.some((credit) => credit.id === creditId && credit.usable))
        throw new TRPCError({ code: 'BAD_REQUEST', message: '所选重置卡已使用、已过期或当前套餐不可用，请刷新查询' });
      if (snapshot.credits.find((credit) => credit.usable)?.id !== creditId)
        throw new TRPCError({ code: 'CONFLICT', message: '最近到期的可用重置卡已变化，请刷新查询后重新确认' });
      try {
        // 固定选中的卡和兑换标识，不自动重试，也不回退到由上游选择另一张卡。
        const response = await fetch(`${creditsUrl}/consume`, {
          method: 'POST',
          headers: accountHeaders(credentials, 'application/json'),
          body: JSON.stringify({ credit_id: creditId, redeem_request_id: redeemRequestId }),
          signal: AbortSignal.timeout(20_000),
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('上游未确认重置结果');
        }
        const result = resultSchema.parse(await readJson(response));
        if (result.code !== 'ok' && result.code !== 'success') throw new Error('上游未确认重置结果');
        return { windowsReset: result.windows_reset };
      } catch {
        throw new TRPCError({
          code: 'BAD_GATEWAY',
          message: '使用结果未确认，请先刷新重置卡和额度。再次提交只会尝试使用同一张卡',
        });
      }
    } finally {
      this.consuming.delete(id);
    }
  }
}
