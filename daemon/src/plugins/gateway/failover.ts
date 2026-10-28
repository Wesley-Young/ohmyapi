import { GatewayError } from '@ohmyapi/protocols';

/**
 * 上游以这些状态拒绝时没有执行请求，换下一个成员可能成功：鉴权失败、模型不存在、限流和上游故障。
 * 其他 4xx 是请求本身的问题，换成员同样失败。
 */
export function failoverStatus(status: number) {
  return status === 401 || status === 403 || status === 404 || status === 408 || status === 429 || status >= 500;
}

/** 计入熔断的上游状态。404 通常只是某个模型未配置，不代表渠道故障。 */
export function channelFaultStatus(status: number) {
  return (status >= 300 && status < 400) || (status !== 404 && failoverStatus(status));
}

/** 准备阶段（尚未发往上游）的错误中可以换成员重试的：执行渠道限流、不可用或缺少价格。 */
export function failoverError(error: unknown) {
  return error instanceof GatewayError && (error.status === 429 || error.status >= 500);
}

/** 解析 retry-after（秒数或 HTTP 日期），单位毫秒。 */
export function retryAfterMs(headers: Headers) {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const ms = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** 读取错误响应开头的文本用于记录，读到上限后丢弃其余部分。 */
export async function errorSnippet(response: Response, limit = 2048) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, limit).toString('utf8');
}
