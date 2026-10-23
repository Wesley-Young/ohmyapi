import { GatewayError } from '@ohmyapi/protocols';

import { promisify } from 'node:util';
import { brotliDecompress, gunzip, inflate, zstdDecompress } from 'node:zlib';

type Decoder = (bytes: NonSharedBuffer, options: { maxOutputLength: number }) => Promise<NonSharedBuffer>;

/** 请求体支持的 Content-Encoding。 */
const decoders = new Map<string, Decoder>([
  ['gzip', promisify(gunzip)],
  ['x-gzip', promisify(gunzip)],
  ['deflate', promisify(inflate)],
  ['br', promisify(brotliDecompress)],
  ['zstd', promisify(zstdDecompress)],
]);

/** 按 Content-Encoding 取得解压步骤，编码不受支持时在读取请求体之前拒绝。 */
function contentDecoders(req: Request) {
  return (req.headers.get('content-encoding') ?? '')
    .split(',')
    .map((encoding) => encoding.trim().toLowerCase())
    .filter((encoding) => encoding && encoding !== 'identity')
    .map((encoding) => {
      const decode = decoders.get(encoding);
      if (!decode)
        throw new GatewayError(415, 'unsupported_content_encoding', `Content-Encoding ${encoding} is not supported`);
      return { encoding, decode };
    });
}

/** Content-Encoding 按编码顺序列出，逆序解压；解压后的大小同样受 `maxBodyBytes` 限制。 */
async function decodeBody(raw: NonSharedBuffer, steps: ReturnType<typeof contentDecoders>, maxBodyBytes: number) {
  let bytes = raw;
  for (const { encoding, decode } of steps.toReversed()) {
    try {
      bytes = await decode(bytes, { maxOutputLength: maxBodyBytes });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE')
        throw new GatewayError(413, 'request_too_large', 'Request body exceeds the gateway limit');
      throw new GatewayError(400, 'invalid_content_encoding', `Request body is not valid ${encoding} data`);
    }
  }
  return bytes;
}

/**
 * 读取 JSON 请求体：按 Content-Encoding 解压（gzip、deflate、br、zstd），限制大小，
 * 响应取消和超时信号，要求请求体为对象。返回解析结果和解压后的字节，这些字节用于原样转发。
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
  const steps = contentDecoders(req);
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
  const bytes = await decodeBody(Buffer.concat(chunks), steps, maxBodyBytes);
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
