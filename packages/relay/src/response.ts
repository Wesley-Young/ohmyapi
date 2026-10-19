import { GatewayError } from '@ohmyapi/protocols';

import { responseHeaders } from './headers.ts';
import type { RequestLifecycle } from './lifecycle.ts';
import { SseObserver } from './sse.ts';
import type { RelayLimits, RelayOutcome, ResponseKind, ResponseObserver } from './types.ts';

export type RelayResponseOptions = {
  upstream: Response;
  /** 客户端是否请求流式响应；与实际响应类型不一致时以 unexpected_response_type 结束。 */
  streaming: boolean;
  lifecycle: RequestLifecycle;
  limits: RelayLimits;
  observer?: ResponseObserver;
  /** 每收到一块数据，观察者处理之后、转发给客户端之前调用。 */
  onChunk?: () => Promise<void>;
  /** 每块数据转发后检查上游是否已到终止事件；返回值非空时停止读取并结束响应。 */
  terminal?: () => 'completed' | 'failed' | undefined;
  /** 响应结束时调用一次；完成之后客户端的响应才关闭。 */
  onFinish: (outcome: RelayOutcome) => Promise<void>;
  /** 读取上游时出错，随后按上游中断处理。 */
  onError: (error: unknown) => void;
};

/**
 * 把上游响应转发给客户端，转发的字节保持原样，同时交给观察者解析。
 * 客户端断开后，如果 lifecycle 设置了 retainUpstreamOnDisconnect，继续在后台读完上游响应，直到超时；
 * 否则中止读取。重定向不转发，以 GatewayError 拒绝。
 */
export async function relayResponse(options: RelayResponseOptions): Promise<Response> {
  const { upstream, streaming, lifecycle, limits, observer, onChunk, terminal, onFinish, onError } = options;
  const { id, abort } = lifecycle;
  const contentType = upstream.headers.get('content-type')?.toLowerCase() ?? '';
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel();
    await onFinish({ kind: 'redirect', ended: false, errorCode: 'upstream_redirect', contentType });
    throw new GatewayError(502, 'upstream_redirect', 'Upstream redirects are not supported');
  }
  const headers = responseHeaders(upstream.headers, id);

  if (!upstream.body) {
    await onFinish({ kind: 'empty', ended: true, errorCode: 'empty_response', contentType });
    return new Response(null, { status: upstream.status, headers });
  }

  // 根据实际响应类型解析内容，转发字节保持原样。
  const isSse = contentType.includes('text/event-stream');
  const kind: ResponseKind = isSse ? 'sse' : 'json';
  const resetIdleTimeout = () => {
    if (!isSse || abort.signal.aborted) return;
    lifecycle.setTimeout('upstream_idle_timeout', limits.streamIdleTimeoutMs);
  };
  resetIdleTimeout();
  if (isSse) headers.set('x-accel-buffering', 'no');
  const sse = isSse && observer ? new SseObserver(observer, limits.maxEventBytes) : undefined;
  const jsonChunks: Uint8Array[] = [];
  let jsonSize = 0;
  let jsonTruncated = false;
  const reader = upstream.body.getReader();
  let pullTask: Promise<void> | undefined;
  let responseFinalization: Promise<void> | undefined;
  let stoppingResponse: Promise<void> | undefined;
  let drainTask: Promise<void> | undefined;
  let clientClosed = false;
  let responseController: ReadableStreamDefaultController<Uint8Array>;
  const abortReason = () => (typeof abort.signal.reason === 'string' ? abort.signal.reason : 'upstream_disconnected');
  // 读取任务停止后解析已收到的数据，再执行一次性收尾。ended 表示上游响应正常读到结尾。
  const finalizeResponse = (errorCode?: string, ended = false): Promise<void> => {
    responseFinalization ??= (async () => {
      sse?.finish(errorCode === 'client_disconnected' && !ended);
      if (observer && !isSse && !jsonTruncated) {
        try {
          observer.event(JSON.parse(Buffer.concat(jsonChunks).toString('utf8')));
          observer.done();
        } catch (error) {
          observer.malformed(error);
        }
      }
      reader.releaseLock();
      await onFinish({ kind, ended, errorCode, contentType });
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
      sse?.push(value);

      await onChunk?.();

      // 观察容量独立于转发：超出后继续转发，并报告这部分内容没有解析。
      if (observer && !isSse && !jsonTruncated) {
        jsonSize += value.byteLength;
        if (jsonSize <= limits.maxBodyBytes) jsonChunks.push(value);
        else {
          jsonChunks.length = 0;
          jsonTruncated = true;
          observer.truncated();
        }
      }
      if (!abort.signal.aborted && !clientClosed && !lifecycle.clientDisconnected) responseController.enqueue(value);
      const state = terminal?.();
      if (state) {
        await reader.cancel().catch(() => {});
        await finalizeResponse(
          state === 'failed' ? 'upstream_error' : lifecycle.clientDisconnected ? 'client_disconnected' : undefined,
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
