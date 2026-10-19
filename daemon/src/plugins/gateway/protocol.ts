import { protocolFor } from '@ohmyapi/protocols';

import type { Endpoint } from '../database/schema/index.ts';

/** 只记录短小的小写强度标识，避免把客户端任意字符串写入请求记录。 */
export function reasoningEffort(endpoint: Endpoint, body: Record<string, unknown>): string | null {
  const value = protocolFor(endpoint).reasoningEffort(body);
  if (typeof value !== 'string') return null;
  const effort = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,15}$/.test(effort) ? effort : null;
}
