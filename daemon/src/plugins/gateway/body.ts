import { GatewayError } from '../../core/errors.js';

/**
 * 读取并校验 JSON 请求体：限制大小，响应取消和超时信号，要求包含模型名称。
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
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof parsed.model !== 'string' ||
    !parsed.model ||
    parsed.model.length > 128 ||
    (parsed.stream !== undefined && typeof parsed.stream !== 'boolean')
  )
    throw new GatewayError(400, 'invalid_request', 'A model name and a boolean stream option are required');
  // Async/background Responses retrieval is outside this synchronous gateway's scope.
  if (parsed.background === true)
    throw new GatewayError(400, 'unsupported_mode', 'Background responses are not supported');
  return { parsed, bytes };
}
