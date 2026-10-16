import type { GatewayConfig } from '../../config.ts';
import { GatewayError } from '../../core/errors.ts';
import { safeErrorMessage } from '../../core/logging.ts';
import type { Endpoint } from '../database/schema/index.ts';
import type { RequestLifecycle } from './lifecycle.ts';
import { responseHeaders } from './protocol.ts';
import { SseObserver, type UsageCollector } from './usage.ts';

/**
 * 上游没有执行请求或明确不收费的依据：
 * - redirect：上游返回重定向，请求没有被处理。
 * - http_error：失败的 HTTP 状态，响应完整读取后没有任何用量。
 * - error_event：流式响应以错误事件结束，此前没有用量、生成内容或搜索调用。
 * - not_api_response：成功状态但返回 HTML 页面，通常是地址配置错误。
 * 适配器可能改写状态码，基于 HTTP 状态的依据由调用方按上游的真实状态复核。
 */
export type NoExecution = 'redirect' | 'http_error' | 'error_event' | 'not_api_response';

export type ForwardResponseOptions = {
  upstream: Response;
  endpoint: Endpoint;
  streaming: boolean;
  lifecycle: RequestLifecycle;
  collector: UsageCollector;
  config: GatewayConfig;
  onCheckpoint: () => Promise<void>;
  onFinish: (noExecution: NoExecution | undefined, errorCode?: string) => Promise<void>;
  onError: (error: unknown) => void;
  stopAtTerminal?: boolean;
  estimateOnDisconnect?: boolean;
};

export async function forwardResponse(options: ForwardResponseOptions): Promise<Response> {
  const { upstream, streaming, lifecycle, collector, config, onCheckpoint, onFinish, onError } = options;
  const { id, abort } = lifecycle;
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel();
    await onFinish('redirect', 'upstream_redirect');
    throw new GatewayError(502, 'upstream_redirect', 'Upstream redirects are not supported');
  }
  const headers = responseHeaders(upstream.headers, id);
  collector.upstreamId = (upstream.headers.get('x-request-id') ?? upstream.headers.get('request-id'))?.slice(0, 256);

  // 空响应直接完成计费收尾；失败状态的空响应没有执行。
  if (!upstream.body) {
    await onFinish(upstream.ok ? undefined : 'http_error', 'empty_response');
    return new Response(null, { status: upstream.status, headers });
  }

  // 根据实际响应类型观察用量，转发字节保持原样。
  const contentType = upstream.headers.get('content-type')?.toLowerCase() ?? '';
  const isSse = contentType.includes('text/event-stream');
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
  let drainTask: Promise<void> | undefined;
  let clientClosed = false;
  let responseController: ReadableStreamDefaultController<Uint8Array>;
  const abortReason = () => (typeof abort.signal.reason === 'string' ? abort.signal.reason : 'upstream_disconnected');
  // 读取任务停止后汇总已收到的数据，再执行一次性计费收尾。ended 表示上游响应正常读到结尾。
  const finalizeResponse = (errorCode?: string, ended = false): Promise<void> => {
    responseFinalization ??= (async () => {
      observer?.finish(errorCode === 'client_disconnected' && !ended);
      // 分块传输只有收到结束标记才会正常结束，流在此之后不会再有用量。
      if (ended && isSse && upstream.ok) collector.streamEnded();
      if (options.estimateOnDisconnect !== false && isSse && upstream.ok && errorCode === 'client_disconnected')
        collector.estimateDisconnected();
      if (!isSse && !collector.observationIncomplete) {
        try {
          collector.observe(JSON.parse(Buffer.concat(jsonChunks).toString('utf8')));
          collector.done();
        } catch (error) {
          collector.invalid = true;
          collector.errorMessage = safeErrorMessage(error);
        }
      }
      const noCharges =
        !collector.usageSeen &&
        !collector.observationIncomplete &&
        !collector.unknownCosts &&
        !collector.searchObserved;
      const notApiResponse = noCharges && ended && upstream.ok && !isSse && contentType.startsWith('text/html');
      const noExecution: NoExecution | undefined = !noCharges
        ? undefined
        : !upstream.ok && (ended || (collector.failed && !collector.invalid))
          ? 'http_error'
          : notApiResponse
            ? 'not_api_response'
            : isSse && collector.failed && !collector.invalid && !collector.estimate.hasOutput
              ? 'error_event'
              : undefined;
      reader.releaseLock();
      await onFinish(noExecution, notApiResponse ? (errorCode ?? 'unexpected_response_type') : errorCode);
    })();
    return responseFinalization;
  };
  const failClient = () => {
    if (clientClosed) return;
    clientClosed = true;
    responseController.error(new Error('Upstream stream interrupted'));
  };
  const closeClient = () => {
    if (clientClosed) return;
    clientClosed = true;
    responseController.close();
  };
  const stopResponse = () => {
    stoppingResponse ??= (async () => {
      await reader.cancel().catch(() => {});
      await pullTask;
      await finalizeResponse(abortReason());
      failClient();
    })();
    return stoppingResponse;
  };
  const readNext = async () => {
    try {
      const { value, done } = await reader.read();
      if (done) {
        const ended = !abort.signal.aborted;
        await finalizeResponse(
          !ended
            ? abortReason()
            : !upstream.ok
              ? 'upstream_http_error'
              : streaming !== isSse
                ? 'unexpected_response_type'
                : lifecycle.clientDisconnected
                  ? 'client_disconnected'
                  : undefined,
          ended,
        );
        if (abort.signal.aborted) failClient();
        else closeClient();
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
      if (!abort.signal.aborted && !clientClosed && !lifecycle.clientDisconnected) responseController.enqueue(value);
      if (options.stopAtTerminal && (collector.complete || collector.failed)) {
        await reader.cancel().catch(() => {});
        await finalizeResponse(
          collector.failed ? 'upstream_error' : lifecycle.clientDisconnected ? 'client_disconnected' : undefined,
        );
        if (!abort.signal.aborted) closeClient();
      }
    } catch (error) {
      onError(error);
      abort.abort(abort.signal.reason ?? 'upstream_disconnected');
      failClient();
    }
  };
  const drain = () => {
    if (drainTask || responseFinalization || stoppingResponse) return;
    failClient();
    drainTask = (async () => {
      // 复用正在进行的读取，避免下游 pull 与后台收尾同时消费上游。
      await pullTask;
      while (!responseFinalization && !stoppingResponse && !abort.signal.aborted) {
        pullTask = readNext();
        await pullTask;
      }
    })().catch(onError);
  };
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      responseController = controller;
    },
    pull: () => {
      if (responseFinalization || stoppingResponse || drainTask) return drainTask;
      pullTask = readNext();
      return pullTask;
    },
    cancel: () => {
      clientClosed = true;
      lifecycle.disconnectClient();
      if (abort.signal.aborted) return stopResponse();
      drain();
    },
  });
  lifecycle.watchResponse(stopResponse);
  lifecycle.watchClientDisconnect(drain);
  return new Response(stream, { status: upstream.status, headers });
}
