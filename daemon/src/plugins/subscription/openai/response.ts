import { GatewayError } from '../../gateway/errors.js';
import { responseHeaders } from '../../gateway/protocol.js';
import { type ForwardResponseOptions, forwardResponse } from '../../gateway/response.js';
import { SseObserver } from '../../gateway/usage.js';

async function normalizeEventStream(options: ForwardResponseOptions): Promise<Response> {
  const { upstream, lifecycle, config } = options;
  const contentType = upstream.headers.get('content-type');
  if (upstream.body && contentType?.toLowerCase().includes('text/event-stream')) return upstream;
  const unexpected = () =>
    new GatewayError(
      502,
      'unexpected_response_type',
      `OpenAI subscription expected SSE (HTTP ${upstream.status}, Content-Type: ${contentType ?? 'missing'}, body: ${upstream.body ? 'present' : 'empty'})`,
    );
  if (!upstream.body) throw unexpected();

  // 部分订阅响应缺少 Content-Type；只检查有限前缀中的 SSE 行，并保留已读取的原始字节。
  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  const limit = 8192;
  let size = 0;
  let prefix = '';
  let detected = false;
  try {
    while (size < limit) {
      lifecycle.setTimeout('upstream_idle_timeout', config.streamIdleTimeoutMs);
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      const sample = value.subarray(0, limit - size);
      size += sample.byteLength;
      prefix += decoder.decode(sample, { stream: true });
      if (/(?:^|[\r\n])(?:event|data):[^\r\n]*[\r\n]/.test(prefix)) {
        detected = true;
        break;
      }
      if (/^\s*(?:<|\{|\[)/.test(prefix)) break;
    }
    if (!detected) throw unexpected();
  } catch (error) {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    throw error;
  }
  const headers = new Headers(upstream.headers);
  headers.set('content-type', 'text/event-stream');
  headers.delete('content-length');
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      reader.releaseLock();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const buffered = chunks.shift();
      if (buffered) {
        controller.enqueue(buffered);
        return;
      }
      try {
        const { value, done } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
}

export async function forwardOpenAIResponse(options: ForwardResponseOptions): Promise<Response> {
  options = { ...options, estimateOnDisconnect: false };
  if (!options.upstream.ok || options.endpoint === '/v1/responses/compact') return forwardResponse(options);
  const upstream = await normalizeEventStream(options);
  options = { ...options, upstream };
  const { streaming, lifecycle, collector, config } = options;
  if (streaming) return forwardResponse({ ...options, stopAtTerminal: true });
  let terminal: Record<string, unknown> | undefined;
  const observer = new SseObserver(collector, config.maxUsageEventBytes, (value) => {
    if (!value || typeof value !== 'object') return;
    const event = value as Record<string, unknown>;
    if (
      ['response.completed', 'response.done', 'response.failed', 'response.incomplete', 'response.cancelled'].includes(
        String(event.type),
      ) &&
      event.response &&
      typeof event.response === 'object'
    )
      terminal = event.response as Record<string, unknown>;
  });
  const reader = upstream.body?.getReader();
  if (!reader) throw new GatewayError(502, 'empty_response', 'OpenAI subscription returned an empty response');
  let bytes = 0;
  try {
    lifecycle.setTimeout('upstream_idle_timeout', config.streamIdleTimeoutMs);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        observer.finish();
        break;
      }
      lifecycle.setTimeout('upstream_idle_timeout', config.streamIdleTimeoutMs);
      bytes += value.byteLength;
      if (bytes > config.maxUsageBodyBytes)
        throw new GatewayError(502, 'response_too_large', 'Non-streaming response exceeds the gateway limit');
      observer.push(value);
      await options.onCheckpoint();
      if (terminal) break;
    }
    if (lifecycle.abort.signal.aborted)
      throw new GatewayError(502, 'upstream_disconnected', 'Upstream response was interrupted');
    if (!terminal) throw new GatewayError(502, 'usage_not_final', 'Upstream response ended without a terminal event');
    if (collector.failed)
      throw new GatewayError(502, 'upstream_error', collector.errorMessage ?? 'OpenAI response failed');
    const headers = responseHeaders(upstream.headers, lifecycle.id);
    headers.set('content-type', 'application/json');
    await reader.cancel().catch(() => {});
    await options.onFinish(false, lifecycle.clientDisconnected ? 'client_disconnected' : undefined);
    return new Response(JSON.stringify(terminal), { status: 200, headers });
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
