import { GatewayError } from '@ohmyapi/protocols';
import { z } from 'zod';

import type { OutboundFetch } from '../../outbound/index.ts';
import { readJson } from '../openai/client.ts';
import { planValue } from '../plan.ts';

// OAuth 公共客户端、v1internal 接口名称与请求外层参考 CLIProxyAPI（见同目录的 LICENSE.CLIProxyAPI）和 apsis。
export const clientId = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const clientSecret = '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';
export const redirectUri = 'http://localhost:51121/oauth-callback';
export const scope = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
].join(' ');
const tokenUrl = 'https://oauth2.googleapis.com/token';
const userInfoUrl = 'https://www.googleapis.com/oauth2/v2/userinfo';
const clientVersion = '2.9.1';
export const antigravityUserAgent = `antigravity/hub/${clientVersion} darwin/arm64`;
/** 生成请求使用 daily 环境；账号元数据接口在 daily 不可用时回退到正式环境。 */
export const antigravityBaseUrl = 'https://daily-cloudcode-pa.googleapis.com';
const metadataBaseUrls = [antigravityBaseUrl, 'https://cloudcode-pa.googleapis.com'];

const tokenSchema = z
  .object({
    access_token: z.string().min(1).max(32768),
    refresh_token: z.string().min(1).max(32768).optional(),
    expires_in: z.number().positive().max(31_536_000),
  })
  .passthrough();
export type AntigravityTokenResponse = z.infer<typeof tokenSchema>;

async function postToken(form: Record<string, string>, request: OutboundFetch, signal: AbortSignal) {
  return request(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...form }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    redirect: 'error',
  });
}

export async function exchangeAntigravityCode(
  code: string,
  verifier: string,
  request: OutboundFetch,
  signal: AbortSignal,
) {
  const response = await postToken(
    { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier },
    request,
    signal,
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Google 授权码兑换失败（HTTP ${response.status}）`);
  }
  const tokens = tokenSchema.parse(await readJson(response));
  if (!tokens.refresh_token) throw new Error('Google 未返回 refresh token，请撤销应用授权后重新授权');
  return { ...tokens, refresh_token: tokens.refresh_token };
}

/**
 * Google 的 refresh token 使用后不会轮换，刷新结果不确定时可以安全重试。
 * 400/401（如 invalid_grant）表示授权已撤销，需要重新授权。
 */
export async function refreshAntigravityToken(refreshToken: string, request: OutboundFetch, signal: AbortSignal) {
  let response: Response;
  try {
    response = await postToken({ grant_type: 'refresh_token', refresh_token: refreshToken }, request, signal);
  } catch {
    throw new GatewayError(502, 'subscription_refresh_failed', 'Google token refresh did not complete');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 400 || response.status === 401)
      throw new GatewayError(
        401,
        'subscription_reauthorization_required',
        `Google token refresh failed (HTTP ${response.status})`,
      );
    throw new GatewayError(502, 'subscription_refresh_failed', `Google token refresh failed (HTTP ${response.status})`);
  }
  try {
    return tokenSchema.parse(await readJson(response));
  } catch {
    throw new GatewayError(502, 'subscription_refresh_failed', 'Google returned an invalid token response');
  }
}

export async function fetchAntigravityUser(accessToken: string, request: OutboundFetch, signal: AbortSignal) {
  const response = await request(userInfoUrl, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Google 账号信息查询失败（HTTP ${response.status}）`);
  }
  const user = z
    .object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), email: z.string().optional() })
    .parse(await readJson(response));
  return { id: user.id, email: z.email().safeParse(user.email).data };
}

/** 调用 v1internal 账号接口；连接失败、408、404、429 和 5xx 时尝试下一个环境。 */
async function internalJson(
  method: string,
  body: unknown,
  accessToken: string,
  request: OutboundFetch,
  signal: AbortSignal,
  limit?: number,
) {
  let failure: Error = new Error(`${method} 请求失败`);
  for (const base of metadataBaseUrls) {
    let response: Response;
    try {
      response = await request(`${base}/v1internal:${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': antigravityUserAgent,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        redirect: 'error',
      });
    } catch (error) {
      if (signal.aborted) throw error;
      failure = new Error(`${method} 连接失败`);
      continue;
    }
    if (response.ok) return readJson(response, limit);
    await response.body?.cancel().catch(() => {});
    failure = new Error(`${method} 失败（HTTP ${response.status}）`);
    if (![404, 408, 429].includes(response.status) && response.status < 500) throw failure;
  }
  throw failure;
}

const projectSchema = z.union([z.string(), z.object({ id: z.string() }).passthrough()]);
const tierSchema = z.union([z.string(), z.object({ id: z.string().optional() }).passthrough()]);
const loadSchema = z
  .object({
    cloudaicompanionProject: projectSchema.nullish(),
    currentTier: tierSchema.nullish(),
    paidTier: tierSchema.nullish(),
  })
  .passthrough();
const tierId = (tier: z.infer<typeof tierSchema> | null | undefined) => (typeof tier === 'string' ? tier : tier?.id);

/** 查询账号的 Antigravity 项目和套餐。未完成 onboarding 的账号没有项目，不自动开通。 */
export async function loadAntigravityAccount(accessToken: string, request: OutboundFetch, signal: AbortSignal) {
  const result = loadSchema.parse(
    await internalJson(
      'loadCodeAssist',
      { metadata: { ideType: 'ANTIGRAVITY', ideVersion: clientVersion, ideName: 'antigravity' } },
      accessToken,
      request,
      signal,
    ),
  );
  const project = result.cloudaicompanionProject;
  const projectId = (typeof project === 'string' ? project : project?.id)?.trim();
  return {
    projectId: projectId && /^[A-Za-z0-9._:-]{1,256}$/.test(projectId) ? projectId : undefined,
    plan: planValue(tierId(result.paidTier) ?? tierId(result.currentTier)),
  };
}

const modelInfoSchema = z.object({ displayName: z.string().max(256).optional() }).passthrough();

/** 账号可用的模型。 */
export async function fetchAntigravityModels(
  accessToken: string,
  projectId: string,
  request: OutboundFetch,
  signal: AbortSignal,
) {
  const result = z
    .object({ models: z.record(z.string(), z.unknown()).default({}) })
    .passthrough()
    .parse(await internalJson('fetchAvailableModels', { project: projectId }, accessToken, request, signal, 8 << 20));
  return Object.entries(result.models)
    .slice(0, 1000)
    .flatMap(([name, raw]) => {
      const info = modelInfoSchema.safeParse(raw);
      return info.success ? [{ name, ...info.data }] : [];
    });
}

/**
 * 额度汇总的接口顺序与官方客户端一致：正式环境对部分账号返回满额的占位数据，daily 环境才是真实额度。
 * 接口与字段参考 cc-status-line（github.com/kinka/cc-status-line）。
 */
const quotaSummaryUrls = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
].map((base) => `${base}/v1internal:retrieveUserQuotaSummary`);

const bucketSchema = z
  .object({
    bucketId: z.string(),
    remainingFraction: z.coerce.number().min(0).max(1).optional(),
    resetTime: z.string().optional(),
  })
  .passthrough();
const quotaSummarySchema = z
  .object({
    groups: z.array(
      z
        .object({ displayName: z.string().optional(), buckets: z.array(z.unknown()).max(100).default([]) })
        .passthrough(),
    ),
  })
  .passthrough();

/**
 * Gemini 额度池的 5 小时与每周额度。所有 Gemini 模型共用这个池；Claude 与 GPT-OSS 等第三方模型共用另一个池，不在此查询。
 * 依次尝试各环境，第一个返回额度分组的响应生效。
 */
export async function fetchAntigravityGeminiQuota(
  accessToken: string,
  projectId: string,
  request: OutboundFetch,
  signal: AbortSignal,
) {
  let failure: Error = new Error('额度查询失败');
  for (const url of quotaSummaryUrls) {
    let response: Response;
    try {
      response = await request(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': antigravityUserAgent,
        },
        body: JSON.stringify({ project: projectId }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        redirect: 'error',
      });
    } catch (error) {
      if (signal.aborted) throw error;
      failure = new Error('额度查询连接失败');
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      failure = new Error(`额度查询失败（HTTP ${response.status}）`);
      continue;
    }
    const summary = quotaSummarySchema.safeParse(await readJson(response).catch(() => undefined));
    if (!summary.success) {
      failure = new Error('额度查询返回了未知格式');
      continue;
    }
    const group = summary.data.groups.find((item) => item.displayName?.toLowerCase().includes('gemini'));
    const buckets = (group?.buckets ?? []).flatMap((item) => {
      const bucket = bucketSchema.safeParse(item);
      return bucket.success ? [bucket.data] : [];
    });
    const window = (bucketId: string) => {
      const bucket = buckets.find((item) => item.bucketId === bucketId);
      if (bucket?.remainingFraction === undefined) return null;
      const resetMs = bucket.resetTime ? Date.parse(bucket.resetTime) : Number.NaN;
      return {
        usedPercent: Math.round((1 - bucket.remainingFraction) * 10_000) / 100,
        resetsAt: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null,
      };
    };
    return { fiveHour: window('gemini-5h'), sevenDay: window('gemini-weekly') };
  }
  throw failure;
}
