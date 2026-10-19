import { GatewayError } from '@ohmyapi/protocols';

/**
 * 读取 JSON 请求体：限制大小，响应取消和超时信号，要求请求体为对象。
 * 返回解析结果和原始字节，原始字节用于原样转发。
 */
export async function readJsonBody(
  req: Request,
  signal: AbortSignal,
  stats: { bytes: number },
  progress: () => void,
  maxBodyBytes: number,
) {
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    throw new GatewayError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  const reader = req.body?.getReader();
  if (!reader) throw new GatewayError(400, 'invalid_request', 'JSON body is required');
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength) progress();
      size += value.byteLength;
      stats.bytes = size;
      if (size > maxBodyBytes) {
        await reader.cancel();
        throw new GatewayError(413, 'request_too_large', 'Request body exceeds the gateway limit');
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  if (signal.aborted) {
    const message = 'Request body was not completed before admission';
    if (signal.reason === 'body_idle_timeout')
      throw new GatewayError(408, 'body_idle_timeout', 'Request body upload stalled');
    if (signal.reason === 'body_timeout') throw new GatewayError(408, 'body_timeout', message);
    throw new GatewayError(400, 'request_cancelled', message);
  }
  const bytes = Buffer.concat(chunks);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new GatewayError(400, 'invalid_json', 'Invalid JSON body');
  }
  // 模型和流式选项由端点协议解析，请求体至少是一个对象。
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new GatewayError(400, 'invalid_request', 'A model name and a boolean stream option are required');
  return { parsed, bytes };
}
