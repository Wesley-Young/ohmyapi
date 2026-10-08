import type { Endpoint } from '../catalog/service.js';
import { GatewayError } from '../gateway/errors.js';

export const maxSearchCalls = 10_000;
export type SearchKind = 'webSearch' | 'webSearchPreview';
export type SearchRequest = {
  kind?: SearchKind;
  implicit: boolean;
  estimatedCalls: number;
};

export function searchToolKind(tool: Record<string, unknown>, endpoint: Endpoint): SearchKind | undefined {
  if (typeof tool.type !== 'string') return;
  if (endpoint === '/v1/responses') {
    if (/^web_search(?:_\d{4}_\d{2}_\d{2})?$/.test(tool.type)) return 'webSearch';
    if (/^web_search_preview(?:_\d{4}_\d{2}_\d{2})?$/.test(tool.type)) return 'webSearchPreview';
  }
  if (endpoint === '/v1/messages' && /^web_search_\d{8}$/.test(tool.type) && tool.name === 'web_search')
    return 'webSearch';
}

function callLimit(value: unknown, name: string) {
  if (value == null) return 1;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maxSearchCalls)
    throw new GatewayError(400, 'invalid_search_limit', `${name} must be an integer between 1 and ${maxSearchCalls}`);
  return value;
}

export function searchRequest(body: Record<string, unknown>, endpoint: Endpoint): SearchRequest {
  if (body.enable_search === true)
    throw new GatewayError(400, 'unsupported_billing_mode', 'Vendor enable_search billing is not supported');
  const model = typeof body.model === 'string' ? body.model : '';
  const searchModel = /(?:^|-)search-(preview|api)(?:-\d{4}-\d{2}-\d{2})?$/.exec(model);
  if (body.web_search_options != null) {
    if (endpoint !== '/v1/chat/completions')
      throw new GatewayError(400, 'invalid_request', 'web_search_options is only supported for Chat Completions');
    if (typeof body.web_search_options !== 'object' || Array.isArray(body.web_search_options))
      throw new GatewayError(400, 'invalid_request', 'web_search_options must be an object');
  }
  if (endpoint === '/v1/chat/completions' && (searchModel || body.web_search_options != null))
    return {
      kind: searchModel?.[1] === 'preview' ? 'webSearchPreview' : 'webSearch',
      implicit: true,
      estimatedCalls: 1,
    };

  const tools = Array.isArray(body.tools) ? body.tools : [];
  let kind: SearchKind | undefined;
  let estimatedCalls = 0;
  for (const value of tools) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const tool = value as Record<string, unknown>;
    const candidate = searchToolKind(tool, endpoint);
    if (!candidate) continue;
    if (kind && candidate !== kind)
      throw new GatewayError(400, 'invalid_request', 'Use one web search tool variant per request');
    kind = candidate;
    estimatedCalls += endpoint === '/v1/messages' ? callLimit(tool.max_uses, 'max_uses') : 1;
  }
  if (kind && endpoint === '/v1/responses') estimatedCalls = callLimit(body.max_tool_calls, 'max_tool_calls');
  if (estimatedCalls > maxSearchCalls)
    throw new GatewayError(400, 'invalid_search_limit', `Combined search limits must not exceed ${maxSearchCalls}`);
  return { kind, implicit: false, estimatedCalls };
}
