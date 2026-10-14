import { GatewayError } from '../../../core/errors.js';
import { formatEvent } from '../../../core/logging.js';
import { type ForwardResponseOptions, forwardResponse } from '../../gateway/response.js';
import { readJson } from '../openai/client.js';
import type { ClaudeSession } from './session.js';
import { object, restoreTools } from './tools.js';

export async function forwardClaudeResponse(
  options: ForwardResponseOptions,
  reverse: Map<string, string>,
  session: ClaudeSession,
) {
  const upstream = options.upstream;
  if (!upstream.ok || !upstream.body) return forwardResponse(options);
  const headers = new Headers(upstream.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  const requestId = upstream.headers.get('request-id') ?? upstream.headers.get('x-request-id');
  const isSse = headers.get('content-type')?.includes('text/event-stream');
  if (!isSse) {
    const data = object(await readJson(upstream, options.config.maxUsageBodyBytes));
    if (!data) throw new GatewayError(502, 'invalid_response', 'Claude returned invalid JSON');
    restoreTools(data, reverse);
    if (typeof data.id === 'string' && data.stop_reason) session.commit(data.id, requestId);
    return forwardResponse({
      ...options,
      upstream: new Response(JSON.stringify(data), { status: upstream.status, headers }),
    });
  }
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '',
    lines: string[] = [],
    size = 0,
    completed = false,
    failed = false,
    messageId = '';
  const dispatch = (controller: TransformStreamDefaultController<Uint8Array>) => {
    const data = lines
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data) {
      const event = object(JSON.parse(data));
      if (!event) throw new Error('Invalid Claude SSE event');
      restoreTools(event, reverse);
      if (event.type === 'message_start') messageId = String(object(event.message)?.id ?? '');
      if (event.type === 'error') failed = true;
      if (event.type === 'message_stop') {
        completed = true;
        if (!failed && messageId) session.commit(messageId, requestId);
      }
      const first = lines.findIndex((l) => l.startsWith('data:'));
      lines = lines.filter((l) => !l.startsWith('data:'));
      lines.splice(first, 0, formatEvent('data:', event));
    }
    controller.enqueue(encoder.encode(`${lines.join('\n')}\n\n`));
    lines = [];
    size = 0;
  };
  const consume = (controller: TransformStreamDefaultController<Uint8Array>, flush = false) => {
    for (;;) {
      const match = /\r\n|\r|\n/.exec(pending);
      if (!match || (!flush && match[0] === '\r' && match.index === pending.length - 1)) break;
      const line = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      size += Buffer.byteLength(line);
      if (size > options.config.maxUsageEventBytes) throw new Error('Claude SSE event exceeds limit');
      if (!line) dispatch(controller);
      else lines.push(line);
      if (completed || failed) {
        pending = '';
        lines = [];
        return;
      }
    }
    if (size + Buffer.byteLength(pending) > options.config.maxUsageEventBytes)
      throw new Error('Claude SSE event exceeds limit');
  };
  const transformed = upstream.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (completed || failed) return;
        pending += decoder.decode(chunk, { stream: true });
        consume(controller);
      },
      flush(controller) {
        pending += decoder.decode();
        consume(controller, true);
        if (pending || lines.length || (!completed && !failed))
          throw new Error('Claude stream ended before message_stop');
      },
    }),
  );
  return forwardResponse({
    ...options,
    stopAtTerminal: true,
    upstream: new Response(transformed, { status: upstream.status, headers }),
  });
}
