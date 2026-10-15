import { protocolFor } from '../../protocols/index.ts';
import type { Endpoint } from '../database/schema/index.ts';

/** 请求的会话标识，按协议约定的候选字段取第一个非空值。 */
export function requestSession(request: Request, body: Record<string, unknown>, endpoint: Endpoint) {
  const session = protocolFor(endpoint).session;
  if (!session) return undefined;
  for (const raw of session.candidates(request, body)) {
    if (typeof raw !== 'string' || raw.length > 4096) continue;
    const value = raw.trim();
    if (value) return { family: session.family, value };
  }
  return undefined;
}
