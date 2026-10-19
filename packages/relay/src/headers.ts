/** 转发给客户端的上游响应头：内容类型、Codex 会话状态和限流提示，其余不转发。 */
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
