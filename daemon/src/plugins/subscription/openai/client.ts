import { GatewayError } from '../../gateway/errors.js';
import type { OpenAICredentials } from './credentials.js';

export const clientId = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const redirectUri = 'http://localhost:1455/auth/callback';
export const codexBaseUrl = 'https://chatgpt.com/backend-api/codex';
export const fallbackCodexClientVersion = '0.162.0';

export async function latestCodexClientVersion(): Promise<string> {
  try {
    const response = await fetch('https://registry.npmjs.org/@openai%2Fcodex/latest', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      return fallbackCodexClientVersion;
    }
    const metadata = await readJson(response, 256 * 1024);
    const version = metadata && typeof metadata === 'object' && 'version' in metadata ? metadata.version : undefined;
    if (typeof version === 'string' && version.length <= 64 && /^\d+\.\d+\.\d+$/.test(version)) return version;
  } catch {
    // npmjs 不可用时继续拉取模型，避免版本查询阻断渠道配置。
  }
  return fallbackCodexClientVersion;
}

export function accountHeaders(
  credentials: OpenAICredentials,
  accept: 'text/event-stream' | 'application/json' = 'text/event-stream',
  clientVersion = fallbackCodexClientVersion,
) {
  return new Headers({
    authorization: `Bearer ${credentials.accessToken}`,
    'chatgpt-account-id': credentials.accountId,
    'content-type': 'application/json',
    accept,
    'OpenAI-Beta': 'responses=experimental',
    originator: 'codex_cli_rs',
    'user-agent': `codex_cli_rs/${clientVersion}`,
    version: clientVersion,
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

export async function exchangeToken(body: Record<string, string>, signal?: AbortSignal) {
  const response = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: clientId, ...body }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
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
