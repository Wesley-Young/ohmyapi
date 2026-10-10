import type { Endpoint } from '../../catalog/service.js';

import { createHash } from 'node:crypto';

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

export function prepareSession(
  headers: Headers,
  body: Record<string, unknown>,
  parsed: Record<string, unknown>,
  request: Request,
  channelId: string,
  endpoint: Endpoint,
) {
  // 沿用已有缓存键的隔离方式，同一渠道、Key 和会话在刷新 OAuth 凭据后仍保持稳定。
  const scope = (value: string) =>
    createHash('sha256')
      .update(`${channelId}:${request.headers.get('authorization')}:${value}`)
      .digest('hex');
  const metadata = record(parsed.client_metadata);
  const seed =
    text(parsed.prompt_cache_key) ||
    text(request.headers.get('session_id')) ||
    text(request.headers.get('conversation_id')) ||
    text(metadata?.session_id);
  if (seed) {
    const session = scope(seed);
    headers.set('session_id', session);
    headers.set('conversation_id', session);
    if (endpoint !== '/v1/responses/compact') body.prompt_cache_key = session;
  }
  const scopeMetadata = (value: Record<string, unknown>) => {
    const next = { ...value };
    for (const key of [
      'session_id',
      'conversation_id',
      'thread_id',
      'turn_id',
      'installation_id',
      'window_id',
      'x-codex-installation-id',
      'x-codex-window-id',
    ]) {
      if (text(next[key])) next[key] = scope(text(next[key]));
    }
    return next;
  };
  const turnMetadata = (value: unknown) => {
    if (typeof value !== 'string' || value.length > 8192) return undefined;
    try {
      const parsedValue = record(JSON.parse(value));
      if (!parsedValue) return undefined;
      const encoded = JSON.stringify(scopeMetadata(parsedValue)).replace(
        /[^\x20-\x7e]/g,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
      );
      return encoded.length <= 8192 ? encoded : undefined;
    } catch {
      return undefined;
    }
  };
  const bodyMetadata = record(body.client_metadata);
  if (bodyMetadata) {
    body.client_metadata = scopeMetadata(bodyMetadata);
    const turn = turnMetadata(bodyMetadata['x-codex-turn-metadata']);
    if (turn) (body.client_metadata as Record<string, unknown>)['x-codex-turn-metadata'] = turn;
  }
  for (const name of ['x-codex-turn-state', 'x-codex-beta-features']) {
    const value = request.headers.get(name);
    if (value && value.length <= 8192) headers.set(name, value);
  }
  for (const name of ['x-codex-installation-id', 'x-codex-window-id']) {
    const value = text(request.headers.get(name));
    if (value) headers.set(name, scope(value));
  }
  const turn = turnMetadata(request.headers.get('x-codex-turn-metadata'));
  if (turn) headers.set('x-codex-turn-metadata', turn);
  const model = text(body.model);
  if (/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,127}$/.test(model)) {
    const tier = text(body.service_tier);
    headers.set(
      'x-codex-routing-hint',
      `model=${model}${['priority', 'flex', 'ultrafast'].includes(tier) ? `;tier=${tier}` : ''}`,
    );
  }
}
