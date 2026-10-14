import { z } from 'zod';

import { GatewayError } from '../../../core/errors.ts';
import type { OutboundFetch } from '../../outbound/index.ts';
import { readJson } from '../openai/client.ts';
import { planValue } from '../plan.ts';
import { type ClaudeCredentials, claudeCredentialsSchema, parseClaudeCredentials } from './credentials.ts';

export const claudeBaseUrl = 'https://api.anthropic.com';
export const clientId = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const redirectUri = 'http://localhost:54545/callback';
const tokenUrl = 'https://platform.claude.com/v1/oauth/token';
const oauthHeaders = {
  accept: 'application/json, text/plain, */*',
  'content-type': 'application/json',
  'user-agent': 'axios/1.15.2',
  'accept-encoding': 'gzip, deflate, br',
  connection: 'close',
};
export const scope = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

async function fetchOAuthJson(path: string, access: string, request: OutboundFetch, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(20_000);
  const response = await request(`${claudeBaseUrl}${path}`, {
    headers: { ...oauthHeaders, authorization: `Bearer ${access}`, 'cache-control': 'no-cache' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Claude OAuth 账户查询失败（HTTP ${response.status}）`);
  }
  return readJson(response);
}

async function fetchOAuthProfile(access: string, request: OutboundFetch, signal?: AbortSignal) {
  const profile = z
    .object({
      account: z.object({ uuid: z.uuid(), email: z.string().optional() }),
      organization: z.object({ uuid: z.string().optional() }).optional(),
    })
    .parse(await fetchOAuthJson('/api/oauth/profile', access, request, signal));
  return {
    account_uuid: profile.account.uuid,
    email: z.email().safeParse(profile.account.email).data,
    organization_uuid: z.uuid().safeParse(profile.organization?.uuid).data,
  };
}

/**
 * profile 中 organization_type 区分 Pro / Max / Team 等，rate_limit_tier 才包含 Max 的倍数
 *（如 default_claude_max_5x），因此 Max 优先返回 rate_limit_tier。
 */
export async function fetchClaudePlan(access: string, request: OutboundFetch, signal?: AbortSignal) {
  const profile = z
    .object({
      organization: z
        .object({ organization_type: z.string().nullish(), rate_limit_tier: z.string().nullish() })
        .nullish(),
    })
    .parse(await fetchOAuthJson('/api/oauth/profile', access, request, signal));
  const tier = planValue(profile.organization?.rate_limit_tier);
  return tier?.includes('max') ? tier : planValue(profile.organization?.organization_type);
}

export async function exchangeClaudeCode(
  code: string,
  state: string,
  verifier: string,
  request: OutboundFetch,
  signal: AbortSignal,
) {
  const response = await request(tokenUrl, {
    method: 'POST',
    headers: oauthHeaders,
    // 对齐 CPA 捕获的 CC 授权码兑换字段顺序。
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      state,
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Claude OAuth 授权码兑换失败（HTTP ${response.status}）`);
  }
  const value = z
    .object({
      access_token: claudeCredentialsSchema.shape.accessToken,
      refresh_token: claudeCredentialsSchema.shape.refreshToken,
      expires_in: z.number().positive(),
    })
    .passthrough()
    .parse(await readJson(response));
  // 有效期固定在兑换时，重试账户查询时复用同一份令牌。
  return { ...value, expiresAt: new Date(Date.now() + value.expires_in * 1000).toISOString(), expires_in: undefined };
}

export async function completeClaudeOAuthCredentials(
  tokens: Awaited<ReturnType<typeof exchangeClaudeCode>>,
  request: OutboundFetch,
  signal: AbortSignal,
) {
  // 对齐 CPA：依次查询 profile 和 roles；附属查询失败时仍可使用兑换响应中的账户信息。
  const profile = await fetchOAuthProfile(tokens.access_token, request, signal).catch(() => undefined);
  await fetchOAuthJson('/api/oauth/claude_cli/roles', tokens.access_token, request, signal).catch(() => {});
  return parseClaudeCredentials({ ...tokens, ...profile });
}

export async function importClaudeCredentials(value: unknown, request: OutboundFetch) {
  const raw = value as Record<string, unknown>;
  if (!raw || typeof raw !== 'object') throw new Error('无效凭据');
  const tokens = (raw.claudeAiOauth ?? raw) as Record<string, unknown>;
  if (raw.accountId || raw.account_uuid || (raw.account as Record<string, unknown> | undefined)?.uuid)
    return parseClaudeCredentials(raw);
  const access = tokens.accessToken ?? tokens.access_token;
  if (typeof access !== 'string' || !/^[\x21-\x7e]+$/.test(access) || !access.includes('sk-ant-oat'))
    throw new Error('需要 Claude OAuth 访问令牌');
  return parseClaudeCredentials({ ...raw, ...(await fetchOAuthProfile(access, request)) });
}

export class ClaudeRefreshError extends GatewayError {
  readonly retryAt: Date;
  constructor(status: number, headers: Headers) {
    super(502, 'subscription_refresh_failed', `Claude token exchange failed (HTTP ${status})`);
    const raw = headers.get('retry-after');
    const delay = raw
      ? Number.isFinite(Number(raw))
        ? Number(raw) * 1000
        : Date.parse(raw) - Date.now()
      : Number(headers.get('retry-after-ms') ?? 5000);
    this.retryAt = new Date(Date.now() + (Number.isFinite(delay) ? Math.max(5000, Math.min(delay, 300_000)) : 5000));
  }
}

export async function refreshClaudeToken(previous: ClaudeCredentials, request: OutboundFetch, signal: AbortSignal) {
  let response: Response;
  try {
    response = await request(tokenUrl, {
      method: 'POST',
      headers: oauthHeaders,
      body: JSON.stringify({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: previous.refreshToken,
        scope,
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      redirect: 'error',
    });
  } catch {
    // 对齐 CPA：传输结果不确定时，旧 refresh token 可能已被消费。
    throw new GatewayError(
      502,
      'subscription_refresh_uncertain',
      'Token rotation result is unknown; import current credentials before retrying',
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 400 || response.status === 401)
      throw new GatewayError(
        401,
        'subscription_reauthorization_required',
        `Claude token exchange failed (HTTP ${response.status})`,
      );
    throw new ClaudeRefreshError(response.status, response.headers);
  }
  try {
    return parseClaudeCredentials(await readJson(response), previous);
  } catch {
    throw new GatewayError(
      502,
      'subscription_refresh_uncertain',
      'Token rotation response could not be saved; import current credentials',
    );
  }
}
