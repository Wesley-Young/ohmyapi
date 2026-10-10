import type { Endpoint } from '../catalog/service.js';

export function requestSession(request: Request, body: Record<string, unknown>, endpoint: Endpoint) {
  const metadata = endpoint === '/v1/messages' ? body.metadata : body.client_metadata;
  const fields =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : undefined;
  const family = endpoint === '/v1/responses' || endpoint === '/v1/responses/compact' ? 'responses' : endpoint;
  const candidates: unknown[] =
    family === 'responses'
      ? [
          body.prompt_cache_key,
          request.headers.get('session_id'),
          request.headers.get('session-id'),
          request.headers.get('conversation_id'),
          request.headers.get('thread_id'),
          request.headers.get('thread-id'),
          fields?.session_id,
          fields?.conversation_id,
          fields?.thread_id,
        ]
      : endpoint === '/v1/messages'
        ? [fields?.user_id]
        : [];
  for (const raw of candidates) {
    if (typeof raw !== 'string' || raw.length > 4096) continue;
    const value = raw.trim();
    if (value) return { family, value };
  }
  return undefined;
}
