import { protocolFor, type RequestTarget } from '@ohmyapi/protocols';

import type { Endpoint } from '../database/schema/index.ts';

type UpstreamRequest = { target: RequestTarget; parsed: Record<string, unknown>; bytes: Buffer<ArrayBuffer> };

/**
 * 按执行渠道配置的上游名称改写请求，未配置时原样返回。请求体中有模型名时重新序列化，
 * 适配器、计费估算和发往上游的字节都使用改写后的请求。
 */
export function mapUpstreamModel(
  endpoint: Endpoint,
  request: UpstreamRequest,
  upstreamModel: string | null,
): UpstreamRequest {
  if (upstreamModel === null || upstreamModel === request.target.model) return request;
  const { target, body } = protocolFor(endpoint).withModel(request.target, request.parsed, upstreamModel);
  return body ? { target, parsed: body, bytes: Buffer.from(JSON.stringify(body)) } : { ...request, target };
}

/** 只记录短小的小写强度标识，避免把客户端任意字符串写入请求记录。 */
export function reasoningEffort(endpoint: Endpoint, body: Record<string, unknown>): string | null {
  const value = protocolFor(endpoint).reasoningEffort(body);
  if (typeof value !== 'string') return null;
  const effort = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,15}$/.test(effort) ? effort : null;
}
