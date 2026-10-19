/** 转发上游响应时的超时和观察容量。 */
export type RelayLimits = {
  /** 流式响应两次收到数据之间的最长间隔。 */
  streamIdleTimeoutMs: number;
  /** 解析单个 SSE 事件的字节上限；超出的事件照常转发，但不解析。 */
  maxEventBytes: number;
  /** 解析非流式响应体的字节上限；超出时照常转发，但不解析。 */
  maxBodyBytes: number;
};

/** 接收从上游响应中解析出的内容。转发给客户端的字节保持原样。 */
export interface ResponseObserver {
  /** SSE 事件的 data，或非流式响应体，按 JSON 解析后的值。 */
  event(value: unknown): void;
  /** 收到 SSE 的 `[DONE]`，或非流式响应体解析完成。 */
  done(): void;
  /** SSE 事件或响应体不是合法的 JSON，或 event 抛出了错误。 */
  malformed(error: unknown): void;
  /** SSE 事件或响应体超出观察容量，这部分内容没有解析。 */
  truncated(): void;
}

/**
 * 上游响应的形态：
 * - redirect：重定向，响应体已丢弃。
 * - empty：没有响应体。
 * - sse：Content-Type 为 text/event-stream。
 * - json：其余响应，按 JSON 解析。
 */
export type ResponseKind = 'redirect' | 'empty' | 'sse' | 'json';

/** 响应结束时的情况，供调用方决定计费、记录等收尾。 */
export type RelayOutcome = {
  kind: ResponseKind;
  /** 上游响应体正常读到结尾，没有被取消或中断。 */
  ended: boolean;
  /**
   * 响应没有正常完成的原因：
   * - upstream_redirect、empty_response：见 kind。
   * - upstream_http_error：上游返回失败的 HTTP 状态。
   * - unexpected_response_type：流式设置与响应类型不一致。
   * - upstream_error：terminal 报告上游以失败结束。
   * - client_disconnected：客户端断开后，响应在后台读完。
   * - 其余为 RequestLifecycle 中止请求的原因，例如 upstream_idle_timeout。
   */
  errorCode?: string;
  /** 上游响应的 Content-Type，小写；没有时为空字符串。 */
  contentType: string;
};
