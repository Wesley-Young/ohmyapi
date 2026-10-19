import { protocolFor } from '@ohmyapi/protocols';

import type { Endpoint } from '../database/schema/index.ts';

export function reportedCacheReadTokens(endpoint: Endpoint, raw: Record<string, unknown>): string | null {
  const value = protocolFor(endpoint).cacheReadTokens(raw);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}

export function cacheReadForDisplay(endpoint: Endpoint, final: boolean, raw: Record<string, unknown>, tokens: bigint) {
  return final ? tokens.toString() : reportedCacheReadTokens(endpoint, raw);
}
