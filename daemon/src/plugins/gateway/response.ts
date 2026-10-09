import type { readGatewayConfig } from '../../config.js';
import { safeErrorMessage } from '../../logging.js';
import type { Endpoint } from '../catalog/service.js';
import { GatewayError } from './errors.js';
import type { RequestLifecycle } from './lifecycle.js';
import { responseHeaders } from './protocol.js';
import { SseObserver, type UsageCollector } from './usage.js';

export type ForwardResponseOptions = {
  upstream: Response;
  endpoint: Endpoint;
  streaming: boolean;
  lifecycle: RequestLifecycle;
  collector: UsageCollector;
  config: ReturnType<typeof readGatewayConfig>;
  onCheckpoint: () => Promise<void>;
  onFinish: (safeRejection: boolean, errorCode?: string) => Promise<void>;
  onError: (error: unknown) => void;
};

export async function forwardResponse(options: ForwardResponseOptions): Promise<Response> {
  const { upstream, endpoint, streaming, lifecycle, collector, config, onCheckpoint, onFinish, onError } = options;
  const { id, abort } = lifecycle;
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel();
    throw new GatewayError(502, 'upstream_redirect', 'Upstream redirects are not supported');
  }
  const headers = responseHeaders(upstream.headers, id);
  collector.upstreamId = (upstream.headers.get('x-request-id') ?? upstream.headers.get('request-id'))?.slice(0, 256);

  // 空响应直接完成计费收尾。
  if (!upstream.body) {
    await onFinish(false, 'empty_response');
    return new Response(null, { status: upstream.status, headers });
  }

  // 根据实际响应类型观察用量，转发字节保持原样。
  const isSse = upstream.headers.get('content-type')?.toLowerCase().includes('text/event-stream') ?? false;
  const resetIdleTimeout = () => {
    if (!isSse || abort.signal.aborted) return;
    lifecycle.setTimeout('upstream_idle_timeout', config.streamIdleTimeoutMs);
  };
  resetIdleTimeout();
  if (isSse) headers.set('x-accel-buffering', 'no');
  const observer = isSse ? new SseObserver(collector, config.maxUsageEventBytes) : undefined;
  const jsonChunks: Uint8Array[] = [];
  let jsonSize = 0;
  const reader = upstream.body.getReader();
  let pullTask: Promise<void> | undefined;
  let responseFinalization: Promise<void> | undefined;
  let stoppingResponse: Promise<void> | undefined;
  let responseController: ReadableStreamDefaultController<Uint8Array>;
  const abortReason = () => (typeof abort.signal.reason === 'string' ? abort.signal.reason : 'upstream_disconnected');
  // 读取任务停止后汇总已收到的数据，再执行一次性计费收尾。
  const finalizeResponse = (errorCode?: string): Promise<void> => {
    responseFinalization ??= (async () => {
      observer?.finish(errorCode === 'client_disconnected');
      if (isSse && upstream.ok && errorCode === 'client_disconnected') collector.estimateDisconnected();
      if (!isSse && !collector.observationIncomplete) {
        try {
          collector.observe(JSON.parse(Buffer.concat(jsonChunks).toString('utf8')));
          if (endpoint === '/v1/chat/completions') collector.done();
        } catch (error) {
          collector.invalid = true;
          collector.errorMessage = safeErrorMessage(error);
        }
      }
      const safeRejection =
        !collector.usage &&
        collector.failed &&
        !collector.invalid &&
        !collector.observationIncomplete &&
        [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(upstream.status);
      reader.releaseLock();
      await onFinish(safeRejection, errorCode);
    })();
    return responseFinalization;
  };
  const stopResponse = () => {
    stoppingResponse ??= (async () => {
      await reader.cancel().catch(() => {});
      await pullTask;
      await finalizeResponse(abortReason());
      responseController.error(new Error('Upstream stream interrupted'));
    })();
    return stoppingResponse;
  };
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      responseController = controller;
    },
    pull: (controller) => {
      if (responseFinalization || stoppingResponse) return;
      pullTask = (async () => {
        try {
          const { value, done } = await reader.read();
          if (done) {
            await finalizeResponse(
              abort.signal.aborted
                ? abortReason()
                : !upstream.ok
                  ? 'upstream_http_error'
                  : streaming !== isSse
                    ? 'unexpected_response_type'
                    : undefined,
            );
            if (abort.signal.aborted) controller.error(new Error('Upstream stream interrupted'));
            else controller.close();
            return;
          }
          resetIdleTimeout();
          observer?.push(value);

          await onCheckpoint();

          // usage 观察容量独立于请求体限制，超限后继续转发并保留待核对状态。
          if (!isSse) {
            jsonSize += value.byteLength;
            if (jsonSize <= config.maxUsageBodyBytes) jsonChunks.push(value);
            else {
              jsonChunks.length = 0;
              collector.observationIncomplete = true;
            }
          }
          if (!abort.signal.aborted) controller.enqueue(value);
        } catch (error) {
          onError(error);
          abort.abort(abort.signal.reason ?? 'upstream_disconnected');
          controller.error(new Error('Upstream stream interrupted'));
        }
      })();
      return pullTask;
    },
    cancel: () => {
      abort.abort('client_disconnected');
      return stopResponse();
    },
  });
  lifecycle.watchResponse(stopResponse);
  return new Response(stream, { status: upstream.status, headers });
}
