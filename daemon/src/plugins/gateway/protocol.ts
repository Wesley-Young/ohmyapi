import { openAIErrorBody, protocolFor } from '../../protocols/index.ts';
import type { Endpoint } from '../database/schema/index.ts';

/** 只记录短小的小写强度标识，避免把客户端任意字符串写入请求记录。 */
export function reasoningEffort(endpoint: Endpoint, body: Record<string, unknown>): string | null {
  const value = protocolFor(endpoint).reasoningEffort(body);
  if (typeof value !== 'string') return null;
  const effort = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,15}$/.test(effort) ? effort : null;
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

/** 按端点协议格式化错误；模型列表使用 OpenAI 格式。 */
export function errorResponse(
  endpoint: Endpoint | '/v1/models',
  status: number,
  code: string,
  message: string,
  id: string,
): Response {
  const type =
    status === 401
      ? 'authentication_error'
      : status === 403
        ? 'permission_error'
        : status === 429
          ? 'rate_limit_error'
          : status >= 500
            ? 'api_error'
            : 'invalid_request_error';
  const details = { status, type, code, message, id };
  return Response.json(
    endpoint === '/v1/models' ? openAIErrorBody(details) : protocolFor(endpoint).errorBody(details),
    {
      status,
      headers: {
        'x-request-id': id,
        'cache-control': 'no-store',
        ...(status === 429 ? { 'retry-after': '60' } : {}),
      },
    },
  );
}
