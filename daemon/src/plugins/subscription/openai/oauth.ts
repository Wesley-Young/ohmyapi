import { TRPCError } from '@trpc/server';

import { clientId, exchangeToken, redirectUri } from './client.js';
import { parseCredentials } from './credentials.js';

import { createHash, randomBytes } from 'node:crypto';

export class OpenAIOAuth {
  private readonly sessions = new Map<string, { actorId: string; verifier: string; expiresAt: number }>();

  start(actorId: string) {
    for (const [state, entry] of this.sessions) if (entry.expiresAt <= Date.now()) this.sessions.delete(state);
    if (this.sessions.size >= 500)
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: '授权会话过多，请稍后重试' });
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    this.sessions.set(state, { actorId, verifier, expiresAt: Date.now() + 30 * 60_000 });
    const url = new URL('https://auth.openai.com/oauth/authorize');
    url.search = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: 'openid profile email offline_access',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
    }).toString();
    return { url: url.toString() };
  }

  async complete(actorId: string, callbackUrl: string) {
    const url = new URL(callbackUrl);
    if (`${url.origin}${url.pathname}` !== redirectUri)
      throw new TRPCError({ code: 'BAD_REQUEST', message: '请粘贴完整的 localhost:1455 授权回调地址' });
    const state = url.searchParams.get('state') ?? '';
    const entry = this.sessions.get(state);
    if (!entry || entry.actorId !== actorId || entry.expiresAt <= Date.now())
      throw new TRPCError({ code: 'BAD_REQUEST', message: '授权会话无效或已过期，请重新授权' });
    const code = url.searchParams.get('code');
    if (!code || url.searchParams.has('error')) throw new TRPCError({ code: 'BAD_REQUEST', message: '授权未完成' });
    this.sessions.delete(state);
    return parseCredentials(
      await exchangeToken({
        grant_type: 'authorization_code',
        code,
        code_verifier: entry.verifier,
        redirect_uri: redirectUri,
      }),
    );
  }

  dispose() {
    this.sessions.clear();
  }
}
