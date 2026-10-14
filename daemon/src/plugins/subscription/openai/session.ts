import type { Endpoint } from '../../database/schema/index.ts';
import { requestSession } from '../../gateway/session.ts';

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
  // 缓存标识跟随子渠道和会话，切换用户、API Key 或刷新 OAuth 凭据后保持稳定。
  const scope = (value: string) =>
    createHash('sha256')
      .update(JSON.stringify([channelId, value]))
      .digest('hex');
  const seed = requestSession(request, parsed, endpoint)?.value;
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
    if (typeof value !== 'string') return undefined;
    try {
      const parsedValue = record(JSON.parse(value));
      if (!parsedValue) return undefined;
      return JSON.stringify(scopeMetadata(parsedValue)).replace(
        /[^\x20-\x7e]/g,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
      );
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
  for (const name of ['session-id', 'thread_id', 'thread-id', 'x-codex-installation-id', 'x-codex-window-id']) {
    const value = text(headers.get(name));
    if (value) headers.set(name, scope(value));
  }
  const turn = turnMetadata(headers.get('x-codex-turn-metadata'));
  if (turn) headers.set('x-codex-turn-metadata', turn);
  const model = text(body.model);
  if (
    (!headers.has('x-codex-routing-hint') ||
      body.model !== parsed.model ||
      body.service_tier !== parsed.service_tier) &&
    /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,127}$/.test(model)
  ) {
    const tier = text(body.service_tier);
    headers.set(
      'x-codex-routing-hint',
      `model=${model}${['priority', 'flex', 'ultrafast'].includes(tier) ? `;tier=${tier}` : ''}`,
    );
  }
}
