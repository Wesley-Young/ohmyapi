import type { Endpoint } from '../catalog/service.js';
import { GatewayError } from './errors.js';

export function upstreamBody(
  endpoint: Endpoint,
  parsed: Record<string, unknown>,
  bytes: Buffer<ArrayBuffer>,
): Buffer<ArrayBuffer> {
  if (endpoint !== '/v1/chat/completions' || parsed.stream !== true) return bytes;
  const options = parsed.stream_options;
  if (options != null && (typeof options !== 'object' || Array.isArray(options)))
    throw new GatewayError(400, 'invalid_request', 'stream_options must be an object');
  // 保留其他流式选项，并主动请求结算所需的 usage。
  parsed.stream_options = { ...(options as Record<string, unknown> | undefined), include_usage: true };
  return Buffer.from(JSON.stringify(parsed));
}

export function upstreamHeaders(req: Request, endpoint: Endpoint, streaming: boolean, credential: string): Headers {
  const headers = new Headers({
    'content-type': 'application/json',
    accept: streaming ? 'text/event-stream' : 'application/json',
  });
  if (endpoint === '/v1/messages') {
    headers.set('x-api-key', credential);
    const version = req.headers.get('anthropic-version') ?? '2023-06-01';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(version))
      throw new GatewayError(400, 'invalid_version', 'Invalid anthropic-version');
    headers.set('anthropic-version', version);
    const beta = req.headers.get('anthropic-beta');
    if (beta) headers.set('anthropic-beta', beta);
  } else headers.set('authorization', `Bearer ${credential}`);
  if (endpoint === '/v1/responses' || endpoint === '/v1/responses/compact') {
    for (const name of [
      'session_id',
      'session-id',
      'conversation_id',
      'thread_id',
      'thread-id',
      'x-codex-turn-state',
      'x-codex-turn-metadata',
      'x-codex-beta-features',
    ]) {
      const value = req.headers.get(name);
      if (value && value.length <= 8192) headers.set(name, value);
    }
  }
  return headers;
}

export function upstreamUrl(baseUrl: string, endpoint: Endpoint): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}${base.endsWith('/v1') ? endpoint.slice(3) : endpoint}`;
}

export function responseHeaders(upstream: Headers, requestId: string): Headers {
  const headers = new Headers({ 'x-request-id': requestId, 'cache-control': 'no-store' });
  for (const name of [
    'content-type',
    'x-codex-turn-state',
    'x-reasoning-included',
    'retry-after',
    'x-ratelimit-limit-requests',
    'x-ratelimit-remaining-requests',
    'x-ratelimit-reset-requests',
  ]) {
    const value = upstream.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}
