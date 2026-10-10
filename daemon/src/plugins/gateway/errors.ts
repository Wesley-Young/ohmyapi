export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const requestErrors: Record<string, string> = {
  aggregate_unavailable: '聚合渠道当前没有可执行请求的子渠道。',
  aggregate_request_unsupported: '当前子渠道无法保留本次请求的参数，请调整参数或使用兼容的 API 渠道。',
  subscription_unavailable: '订阅账号未启用、已删除或需要重新授权。',
  subscription_reauthorization_required: '订阅凭据已失效，请重新授权或导入凭据。',
  subscription_refresh_failed: '订阅令牌刷新失败，请稍后重试。',
  subscription_concurrency_exceeded: '订阅账号已达到并发上限，请稍后重试。',
  subscription_rate_limited: '订阅账号正在限流冷却，请稍后重试。',
  response_too_large: '非流式响应超过大小限制，请使用流式请求。',
  usage_missing: '上游未返回可用于计费的用量信息。',
  usage_not_final: '上游未返回完整的最终用量，无法确认费用。',
  invalid_usage: '上游用量格式或计数无效，无法确认费用。',
  unsupported_usage: '上游报告了当前计费规则未覆盖的用量或工具费用。',
  usage_observation_limit: '上游响应或事件超出用量观察容量，无法确认完整用量。',
  upstream_error: '上游返回错误，无法确认完整用量。',
  upstream_http_error: '上游返回失败的 HTTP 状态，无法确认完整费用。',
  upstream_timeout: '等待上游响应超时。',
  upstream_idle_timeout: '上游流式响应长时间未返回数据，连接超时。',
  upstream_disconnected: '上游连接中断，响应未完整接收。',
  client_disconnected: '客户端断开连接，响应未完整接收。',
  request_cancelled: '请求已取消。',
  server_shutdown: '服务关闭导致请求中断。',
  process_interrupted: '服务恢复时发现请求中断，缺少可确认的最终用量。',
  empty_response: '上游返回空响应。',
  unexpected_response_type: '上游响应类型与请求的流式设置不一致。',
  upstream_redirect: '上游返回了网关不支持的重定向。',
  gateway_error: '网关调用上游失败。',
  billing_processing_failed: '计费处理失败，需要人工核对。',
  price_unconfigured: '保存的价格快照无法计算该请求的费用。',
};

export function requestErrorMessage(code: string | null | undefined) {
  return code ? requestErrors[code] : undefined;
}
