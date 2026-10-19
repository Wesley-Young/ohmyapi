import { type RelayLimits, type RelayOutcome, type RequestLifecycle, relayResponse } from '@ohmyapi/relay';

import type { GatewayConfig } from '../../config.ts';
import type { Endpoint } from '../database/schema/index.ts';
import type { UsageCollector } from './usage.ts';

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

/** 网关配置中转发响应使用的超时和用量观察容量。 */
export const relayLimits = (config: GatewayConfig): RelayLimits => ({
  streamIdleTimeoutMs: config.streamIdleTimeoutMs,
  maxEventBytes: config.maxUsageEventBytes,
  maxBodyBytes: config.maxUsageBodyBytes,
});

/** 转发上游响应，由 UsageCollector 观察用量，结束时判断上游是否执行了请求。 */
export function forwardResponse(options: ForwardResponseOptions): Promise<Response> {
  const { upstream, collector } = options;
  if (upstream.status < 300 || upstream.status >= 400)
    collector.upstreamId = (upstream.headers.get('x-request-id') ?? upstream.headers.get('request-id'))?.slice(0, 256);
  return relayResponse({
    upstream,
    streaming: options.streaming,
    lifecycle: options.lifecycle,
    limits: relayLimits(options.config),
    observer: collector,
    onChunk: options.onCheckpoint,
    terminal: options.stopAtTerminal
      ? () => (collector.failed ? 'failed' : collector.complete ? 'completed' : undefined)
      : undefined,
    onError: options.onError,
    onFinish: (outcome) => {
      const { noExecution, errorCode } = settle(outcome, options);
      return options.onFinish(noExecution, errorCode);
    },
  });
}

function settle(
  { kind, ended, errorCode, contentType }: RelayOutcome,
  { upstream, collector, estimateOnDisconnect }: ForwardResponseOptions,
): { noExecution?: NoExecution; errorCode?: string } {
  if (kind === 'redirect') return { noExecution: 'redirect', errorCode };
  // 空响应直接完成收尾；失败状态的空响应没有执行。
  if (kind === 'empty') return { noExecution: upstream.ok ? undefined : 'http_error', errorCode };
  const isSse = kind === 'sse';
  // 分块传输只有收到结束标记才会正常结束，流在此之后不会再有用量。
  if (ended && isSse && upstream.ok) collector.streamEnded();
  if (estimateOnDisconnect !== false && isSse && upstream.ok && errorCode === 'client_disconnected')
    collector.estimateDisconnected();
  const noCharges =
    !collector.usageSeen && !collector.observationIncomplete && !collector.unknownCosts && !collector.searchObserved;
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
  return { noExecution, errorCode: notApiResponse ? (errorCode ?? 'unexpected_response_type') : errorCode };
}
