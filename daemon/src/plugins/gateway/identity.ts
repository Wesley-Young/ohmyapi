import { GatewayError } from '../../core/errors.ts';
import type { Database } from '../database/client.ts';
import type { Endpoint } from '../database/schema/index.ts';
import { apiKeyPattern, findKeyIdentity } from '../keys/access.ts';

/** 从 Authorization 或 x-api-key 解析 API Key，返回有效的 Key、所属用户及绑定渠道。 */
export async function identifyApiKey(db: Database, req: Request, endpoint: Endpoint | '/v1/models') {
  const authorization = req.headers.get('authorization');
  const bearer = authorization?.match(/^Bearer (sk-[A-Za-z0-9_-]{43})$/i)?.[1];
  // Messages 和模型列表同时服务 Anthropic 客户端，接受 x-api-key。
  const headerKey = endpoint === '/v1/messages' || endpoint === '/v1/models' ? req.headers.get('x-api-key') : null;
  if ((authorization && !bearer) || (bearer && headerKey && bearer !== headerKey))
    throw new GatewayError(401, 'invalid_api_key', 'Invalid API Key');
  const token = bearer ?? headerKey;
  if (!token || !apiKeyPattern.test(token)) throw new GatewayError(401, 'invalid_api_key', 'An API Key is required');
  const identity = await findKeyIdentity(db, token);
  if (!identity) throw new GatewayError(401, 'invalid_api_key', 'Invalid or expired API Key');
  return identity;
}
