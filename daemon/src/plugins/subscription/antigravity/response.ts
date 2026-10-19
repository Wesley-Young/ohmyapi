import { GatewayError } from '@ohmyapi/protocols';

import { type ForwardResponseOptions, forwardResponse } from '../../gateway/response.ts';

type Data = Record<string, unknown>;
const object = (value: unknown): Data | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : undefined;

const rpcStatus: Record<number, string> = {
  400: 'INVALID_ARGUMENT',
  404: 'NOT_FOUND',
  429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL',
  502: 'UNAVAILABLE',
  503: 'UNAVAILABLE',
  504: 'DEADLINE_EXCEEDED',
};

/** 上游状态与客户端看到的错误信息。 */
export type AntigravityResponseContext = {
  projectId: string;
  /** 记录账号失效或模型限流；retryAfterMs 来自上游的重试提示。 */
  report: (status: number, retryAfterMs: number | undefined) => Promise<void>;
};

/** 按 SSE 规则拆分事件，返回每个事件的 data；单个事件超过上限时报错。 */
async function* sseData(body: ReadableStream<Uint8Array>, maxEventBytes: number): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let match = /\r\n|\r|\n/.exec(buffer);
      while (match) {
        const line = buffer.slice(0, match.index);
        // 行尾的 \r 可能与下一块的 \n 组成 CRLF，留到下一块再判断。
        if (match[0] === '\r' && match.index === buffer.length - 1 && !done) break;
        buffer = buffer.slice(match.index + match[0].length);
        if (line === '') {
          if (data.length) yield data.join('\n');
          data = [];
          size = 0;
        } else if (line.startsWith('data:')) {
          size += line.length;
          if (size > maxEventBytes) throw new GatewayError(502, 'usage_observation_limit', 'Upstream event too large');
          data.push(line.slice(5).replace(/^ /, ''));
        }
        match = /\r\n|\r|\n/.exec(buffer);
      }
      if (buffer.length > maxEventBytes)
        throw new GatewayError(502, 'usage_observation_limit', 'Upstream event too large');
      if (done) break;
    }
    if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''));
    if (data.length) yield data.join('\n');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** v1internal 的事件把 Gemini 响应放在 response 字段中；错误事件保持原样。 */
function unwrap(raw: string): Data {
  const event = object(JSON.parse(raw));
  if (!event) throw new GatewayError(502, 'invalid_response', 'Antigravity returned an invalid event');
  return object(event.response) ?? event;
}

const textOnly = (part: Data) =>
  Object.keys(part).every((key) => ['text', 'thought', 'thoughtSignature'].includes(key));

/** 将流式事件合并为一个 generateContent 响应：拼接相邻的同类文本，保留函数调用和签名，取最后的结束原因与用量。 */
function aggregate(events: Data[]) {
  const result: Data = {};
  const candidates: Data[] = [];
  for (const event of events) {
    if (event.error) return { error: event, status: 502 };
    for (const key of ['responseId', 'modelVersion', 'createTime', 'usageMetadata', 'promptFeedback'])
      if (event[key] !== undefined) result[key] = event[key];
    const list = Array.isArray(event.candidates) ? event.candidates : [];
    list.forEach((value, position) => {
      const candidate = object(value);
      if (!candidate) return;
      const index = typeof candidate.index === 'number' ? candidate.index : position;
      if (!Number.isSafeInteger(index) || index < 0 || index > 16) return;
      candidates[index] ??= { content: { role: 'model', parts: [] } };
      const target = candidates[index];
      for (const [key, field] of Object.entries(candidate)) if (key !== 'content') target[key] = field;
      const content = object(candidate.content);
      const parts = (object(target.content) as Data).parts as Data[];
      if (typeof content?.role === 'string') (target.content as Data).role = content.role;
      for (const item of Array.isArray(content?.parts) ? content.parts : []) {
        const part = object(item);
        if (!part) continue;
        const last = parts.at(-1);
        if (
          last &&
          typeof last.text === 'string' &&
          typeof part.text === 'string' &&
          textOnly(last) &&
          textOnly(part) &&
          Boolean(last.thought) === Boolean(part.thought) &&
          last.thoughtSignature === undefined
        ) {
          last.text += part.text;
          if (part.thoughtSignature !== undefined) last.thoughtSignature = part.thoughtSignature;
        } else parts.push({ ...part });
      }
    });
  }
  return { body: { ...result, candidates: candidates.filter(Boolean) }, status: 200 };
}

/** 解析 Google 错误中的重试提示：RetryInfo.retryDelay、ErrorInfo 的 quotaResetDelay 或 Retry-After。 */
function retryAfterMs(error: Data | undefined, headers: Headers) {
  const duration = (value: unknown) => {
    if (typeof value !== 'string') return undefined;
    let total = 0;
    let matched = false;
    for (const [, amount, unit] of value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
      matched = true;
      total += Number(amount) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit as 'ms' | 's' | 'm' | 'h'];
    }
    return matched && Number.isFinite(total) ? total : undefined;
  };
  for (const item of Array.isArray(error?.details) ? error.details : []) {
    const detail = object(item);
    const delay = duration(detail?.retryDelay) ?? duration(object(detail?.metadata)?.quotaResetDelay);
    if (delay !== undefined) return delay;
  }
  const header = headers.get('retry-after');
  if (header && /^\d+$/.test(header)) return Number(header) * 1000;
  return undefined;
}

async function readText(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value.subarray(0, limit - size));
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 失败响应只返回状态和脱敏后的消息；上游的 401/403 是账号问题，对客户端表现为 502。 */
async function errorResponse(options: ForwardResponseOptions, context: AntigravityResponseContext) {
  const { upstream } = options;
  const text = await readText(upstream, 65_536).catch(() => '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {}
  const root = Array.isArray(parsed) ? parsed[0] : parsed;
  const error = object(object(root)?.error) ?? object(object(object(root)?.response)?.error);
  await context.report(upstream.status, retryAfterMs(error, upstream.headers)).catch(() => {});
  const status = upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status;
  const upstreamMessage = typeof error?.message === 'string' ? error.message : '';
  const message = (
    upstream.status === 401 || upstream.status === 403
      ? 'The Antigravity account was rejected by the upstream service'
      : upstreamMessage || `Antigravity returned HTTP ${upstream.status}`
  )
    .replaceAll(context.projectId, '[project]')
    .slice(0, 1000);
  const headers = new Headers({ 'content-type': 'application/json' });
  const retry = upstream.headers.get('retry-after');
  if (retry) headers.set('retry-after', retry);
  return forwardResponse({
    ...options,
    upstream: new Response(
      JSON.stringify({
        error: {
          code: status,
          message,
          status:
            (typeof error?.status === 'string' && status === upstream.status ? error.status : undefined) ??
            rpcStatus[status] ??
            'UNKNOWN',
        },
      }),
      { status, headers },
    ),
  });
}

export async function forwardAntigravityResponse(options: ForwardResponseOptions, context: AntigravityResponseContext) {
  const { upstream, config } = options;
  if (upstream.status >= 300 && upstream.status < 400) return forwardResponse(options);
  if (!upstream.ok) return errorResponse(options, context);
  if (!upstream.body) return forwardResponse(options);
  const headers = new Headers(upstream.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  const events = sseData(upstream.body, config.maxUsageEventBytes);
  if (!options.streaming) {
    // 上游统一使用流式接口；非流式请求在网关合并后返回，合并内容受用量观察容量限制。
    const collected: Data[] = [];
    let size = 0;
    for await (const raw of events) {
      size += raw.length;
      if (size > config.maxUsageBodyBytes)
        throw new GatewayError(502, 'response_too_large', 'Antigravity response exceeds the gateway limit');
      collected.push(unwrap(raw));
    }
    const merged = aggregate(collected);
    headers.set('content-type', 'application/json');
    return forwardResponse({
      ...options,
      upstream: new Response(JSON.stringify('error' in merged ? merged.error : merged.body), {
        status: merged.status,
        headers,
      }),
    });
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = await events.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(`data: ${JSON.stringify(unwrap(next.value))}\n\n`));
      },
      async cancel() {
        await events.return(undefined);
      },
    },
    { highWaterMark: 0 },
  );
  headers.set('content-type', 'text/event-stream; charset=utf-8');
  return forwardResponse({ ...options, upstream: new Response(stream, { status: upstream.status, headers }) });
}
