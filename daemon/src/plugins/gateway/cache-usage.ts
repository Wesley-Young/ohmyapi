import type { Endpoint } from '../catalog/service.js';

export function reportedCacheReadTokens(endpoint: Endpoint, raw: Record<string, unknown>): string | null {
  const details = raw[endpoint === '/v1/chat/completions' ? 'prompt_tokens_details' : 'input_tokens_details'];
  const value =
    endpoint === '/v1/messages'
      ? raw.cache_read_input_tokens
      : details && typeof details === 'object' && 'cached_tokens' in details
        ? details.cached_tokens
        : undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}

export function cacheReadForDisplay(endpoint: Endpoint, final: boolean, raw: Record<string, unknown>, tokens: bigint) {
  return final ? tokens.toString() : reportedCacheReadTokens(endpoint, raw);
}
