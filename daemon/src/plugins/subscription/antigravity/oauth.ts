import { AppError } from '../../../core/errors.ts';
import type { OutboundFetch } from '../../outbound/index.ts';
import { clientId, exchangeAntigravityCode, redirectUri, scope } from './client.ts';
import { type AntigravityCredentials, completeAntigravityCredentials } from './credentials.ts';

import { createHash, randomBytes } from 'node:crypto';

function parseCallback(callbackUrl: string) {
  const url = new URL(callbackUrl);
  if (`${url.origin}${url.pathname}` !== redirectUri || url.username || url.password)
    throw new AppError('bad_request', '请粘贴完整的 localhost:51121/oauth-callback 授权回调地址');
  const codes = url.searchParams.getAll('code');
  const states = url.searchParams.getAll('state');
  if (url.searchParams.has('error') || codes.length !== 1 || states.length !== 1 || !codes[0] || !states[0])
    throw new AppError('bad_request', '授权未完成，请重新授权');
  return { code: codes[0], state: states[0] };
}

/** Google OAuth（PKCE）。授权码只兑换一次，账号信息查询失败时可复用兑换结果重试。 */
export class AntigravityOAuth {
  private readonly abort = new AbortController();
  private readonly sessions = new Map<
    string,
    {
      actorId: string;
      verifier: string;
      expiresAt: number;
      code?: string;
      tokens?: ReturnType<typeof exchangeAntigravityCode>;
      credentials?: Promise<AntigravityCredentials>;
    }
  >();

  prune() {
    for (const [state, entry] of this.sessions) if (entry.expiresAt <= Date.now()) this.sessions.delete(state);
  }

  start(actorId: string) {
    this.prune();
    if (this.sessions.size >= 500) throw new AppError('too_many_requests', '授权会话过多，请稍后重试');
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    this.sessions.set(state, { actorId, verifier, expiresAt: Date.now() + 30 * 60_000 });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      access_type: 'offline',
      client_id: clientId,
      // 每次都请求同意，确保返回 refresh token。
      prompt: 'consent',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope,
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.toString() };
  }

  async complete(actorId: string, callbackUrl: string, request: OutboundFetch) {
    const { code, state } = parseCallback(callbackUrl);
    const entry = this.sessions.get(state);
    if (!entry || entry.actorId !== actorId || entry.expiresAt <= Date.now())
      throw new AppError('bad_request', '授权会话无效或已过期，请重新授权');
    if (entry.code && entry.code !== code)
      throw new AppError('bad_request', '授权回调不匹配，请使用同一次授权的完整回调地址');
    entry.code = code;
    entry.tokens ??= exchangeAntigravityCode(code, entry.verifier, request, this.abort.signal).catch((error) => {
      this.sessions.delete(state);
      throw new AppError(
        'bad_request',
        error instanceof Error && error.message.includes('refresh token')
          ? error.message
          : 'Google 授权码兑换失败，请检查出站代理并重新授权',
      );
    });
    entry.credentials ??= entry.tokens
      .then((tokens) => completeAntigravityCredentials(tokens, request, this.abort.signal))
      .catch((error) => {
        entry.credentials = undefined;
        if (error instanceof AppError) throw error;
        throw new AppError('bad_request', 'Google 账号信息获取失败，请检查出站代理后重试保存');
      });
    return entry.credentials;
  }

  consume(actorId: string, callbackUrl: string) {
    const { state } = parseCallback(callbackUrl);
    if (this.sessions.get(state)?.actorId === actorId) this.sessions.delete(state);
  }

  dispose() {
    this.abort.abort();
    this.sessions.clear();
  }
}
