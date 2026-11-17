import { GatewayError } from '@ohmyapi/protocols';

import type { OutboundFetch } from '../../outbound/index.ts';
import type { OpenAICredentials } from './credentials.ts';

export const clientId = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const redirectUri = 'http://localhost:1455/auth/callback';
export const codexBaseUrl = 'https://chatgpt.com/backend-api/codex';
export const codexClientVersion = '0.169.1';

export function accountHeaders(
  credentials: OpenAICredentials,
  accept: 'text/event-stream' | 'application/json' = 'text/event-stream',
) {
  return new Headers({
    authorization: `Bearer ${credentials.accessToken}`,
    'chatgpt-account-id': credentials.accountId,
    'content-type': 'application/json',
    accept,
    originator: 'codex_cli_rs',
    'user-agent': `codex_cli_rs/${codexClientVersion}`,
    version: codexClientVersion,
  });
}

export async function readJson(response: Response, limit = 2 * 1024 * 1024): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('上游返回空响应');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('上游响应超过大小限制');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function exchangeToken(body: Record<string, string>, signal: AbortSignal, request: OutboundFetch) {
  const response = await request('https://auth.openai.com/oauth/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: clientId, ...body }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new GatewayError(
      response.status === 400 || response.status === 401 ? 401 : 502,
      response.status === 400 || response.status === 401
        ? 'subscription_reauthorization_required'
        : 'subscription_refresh_failed',
      `OpenAI token exchange failed (HTTP ${response.status})`,
    );
  }
  return readJson(response);
}
