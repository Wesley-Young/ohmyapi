import { GatewayError } from '../../core/errors.ts';
import { protocolFor, type SearchKind } from '../../protocols/index.ts';
import type { Endpoint } from '../database/schema/index.ts';
import { maxSearchCalls } from '../pricing/rules.ts';

export type SearchRequest = {
  kind?: SearchKind;
  implicit: boolean;
  estimatedCalls: number;
};

function callLimit(value: unknown, name: string) {
  if (value == null) return 1;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maxSearchCalls)
    throw new GatewayError(400, 'invalid_search_limit', `${name} must be an integer between 1 and ${maxSearchCalls}`);
  return value;
}

export function searchRequest(body: Record<string, unknown>, endpoint: Endpoint): SearchRequest {
  const { request } = protocolFor(endpoint);
  const search = request.search;
  if (body.enable_search === true)
    throw new GatewayError(400, 'unsupported_billing_mode', 'Vendor enable_search billing is not supported');
  if (body.web_search_options != null) {
    if (!search.implicit)
      throw new GatewayError(400, 'invalid_request', 'web_search_options is only supported for Chat Completions');
    if (typeof body.web_search_options !== 'object' || Array.isArray(body.web_search_options))
      throw new GatewayError(400, 'invalid_request', 'web_search_options must be an object');
  }
  const implicit = search.implicit?.(body);
  if (implicit) return { kind: implicit, implicit: true, estimatedCalls: 1 };

  const tools = Array.isArray(body.tools) ? body.tools : [];
  let kind: SearchKind | undefined;
  let estimatedCalls = 0;
  for (const value of tools) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const tool = value as Record<string, unknown>;
    const candidate = request.toolKind(tool);
    if (!candidate || candidate === 'client') continue;
    if (kind && candidate !== kind)
      throw new GatewayError(400, 'invalid_request', 'Use one web search tool variant per request');
    kind = candidate;
    estimatedCalls += search.perToolLimit ? callLimit(tool[search.perToolLimit], search.perToolLimit) : 1;
  }
  if (kind && search.requestLimit) estimatedCalls = callLimit(body[search.requestLimit], search.requestLimit);
  if (estimatedCalls > maxSearchCalls)
    throw new GatewayError(400, 'invalid_search_limit', `Combined search limits must not exceed ${maxSearchCalls}`);
  return { kind, implicit: false, estimatedCalls };
}
