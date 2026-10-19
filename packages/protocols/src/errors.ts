/** 网关协议错误：携带 HTTP 状态和兼容 OpenAI/Anthropic 的错误代码。 */
export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
