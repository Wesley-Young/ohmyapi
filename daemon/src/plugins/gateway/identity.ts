import { GatewayError } from '../../core/errors.ts';
import type { Database } from '../database/client.ts';
import { apiKeyPattern, findKeyIdentity } from '../keys/access.ts';

/** Authorization 之外接受 API Key 的位置，以及明确不接受的查询参数。 */
export type ApiKeySources = {
  headers: readonly string[];
  query?: readonly string[];
  rejectedQuery?: readonly string[];
};

/**
 * 从 Authorization 或协议约定的请求头、查询参数解析 API Key，返回有效的 Key、所属用户及绑定渠道。
 * 例如 Messages 和模型列表同时服务 Anthropic 客户端，接受 x-api-key；Gemini 客户端使用 x-goog-api-key 或 key 参数。
 * 多处同时提供 Key 时必须一致。
 */
export async function identifyApiKey(db: Database, req: Request, sources: ApiKeySources) {
  const query = sources.query?.length || sources.rejectedQuery?.length ? new URL(req.url).searchParams : undefined;
  const rejected = sources.rejectedQuery?.find((name) => query?.has(name));
  if (rejected)
    throw new GatewayError(
      400,
      'unsupported_api_key_location',
      `Query parameter ${rejected} is not supported; send the API Key in a header or a supported query parameter`,
    );
  const authorization = req.headers.get('authorization');
  const bearer = authorization?.match(/^Bearer (sk-[A-Za-z0-9_-]{43})$/i)?.[1];
  if (authorization && !bearer) throw new GatewayError(401, 'invalid_api_key', 'Invalid API Key');
  const supplied = new Set(
    [
      bearer,
      ...sources.headers.map((name) => req.headers.get(name)),
      ...(sources.query ?? []).map((name) => query?.get(name)),
    ].filter((value): value is string => Boolean(value)),
  );
  if (supplied.size > 1) throw new GatewayError(401, 'invalid_api_key', 'Invalid API Key');
  const [token] = supplied;
  if (!token || !apiKeyPattern.test(token)) throw new GatewayError(401, 'invalid_api_key', 'An API Key is required');
  const identity = await findKeyIdentity(db, token);
  if (!identity) throw new GatewayError(401, 'invalid_api_key', 'Invalid or expired API Key');
  return identity;
}
