import { z } from 'zod';

import { AppError } from '../../core/errors.ts';
import type { OutboundFetch } from '../outbound/index.ts';
import { modelName } from './schemas.ts';

/** 模型列表的请求格式：OpenAI 用 Bearer 鉴权，Anthropic 用 x-api-key 和 anthropic-version。 */
type ModelListFormat = 'openai' | 'anthropic';

/** 拉取过程的诊断信息：失败时据此记录停在哪一步。 */
export type UpstreamModelsTrace = { stage: string; format: ModelListFormat; httpStatus?: number; bytes: number };

const formatHeaders = (format: ModelListFormat, credential: string): Record<string, string> =>
  format === 'openai'
    ? { authorization: `Bearer ${credential}` }
    : { 'x-api-key': credential, 'anthropic-version': '2023-06-01' };

/** OpenAI 和 Anthropic 的列表都把模型放在 data[].id；Anthropic 用 has_more 和 last_id 分页，列表为空时 last_id 为 null。 */
const modelPage = z.object({
  data: z.array(z.object({ id: z.string() })).max(1000),
  has_more: z.boolean().optional(),
  last_id: z.string().nullable().optional(),
});

/** OpenAI 格式的请求在这些步骤失败时，上游可能只支持 Anthropic 格式。 */
const fallbackStages = new Set(['http_error', 'parse_models', 'empty_models']);

/**
 * 从 OpenAI 或 Anthropic 兼容的上游拉取模型列表。先按 OpenAI 格式请求；上游返回错误、无法识别的列表或空列表时，
 * 再按 Anthropic 格式请求。两种格式的请求头不同时发送，因为同时提供两种格式的上游按请求头选择响应格式。
 * 两次都失败时报告 OpenAI 格式的错误。限制响应大小和模型数量，跳过名称格式无效的模型。
 */
export async function fetchUpstreamModels(
  request: OutboundFetch,
  baseUrl: string,
  credential: string,
  signal: AbortSignal,
  trace: UpstreamModelsTrace,
) {
  try {
    return await fetchModelList(request, baseUrl, credential, signal, trace, 'openai');
  } catch (error) {
    if (!(error instanceof AppError) || !fallbackStages.has(trace.stage)) throw error;
    const first = { ...trace };
    try {
      Object.assign(trace, { stage: 'fetch', httpStatus: undefined, bytes: 0 });
      return await fetchModelList(request, baseUrl, credential, signal, trace, 'anthropic');
    } catch (fallbackError) {
      if (!(fallbackError instanceof AppError)) throw fallbackError;
      Object.assign(trace, first);
      throw error;
    }
  }
}

/** 按一种格式拉取模型列表，支持 after_id 分页。 */
async function fetchModelList(
  request: OutboundFetch,
  baseUrl: string,
  credential: string,
  signal: AbortSignal,
  trace: UpstreamModelsTrace,
  format: ModelListFormat,
) {
  trace.format = format;
  const base = baseUrl.replace(/\/+$/, '');
  const url = new URL(base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`);
  const names = new Set<string>();
  const cursors = new Set<string>();
  let ignored = 0;
  for (;;) {
    trace.stage = 'fetch';
    const response = await request(url, {
      headers: formatHeaders(format, credential),
      signal,
      redirect: 'error',
    });
    trace.httpStatus = response.status;
    if (!response.ok) {
      trace.stage = 'http_error';
      await response.body?.cancel();
      throw new AppError(
        'bad_request',
        response.status === 404
          ? '上游不支持模型列表，请手动添加模型'
          : `获取模型失败，上游返回 HTTP ${response.status}，请检查地址和凭据`,
      );
    }
    trace.stage = 'read_body';
    const reader = response.body?.getReader();
    if (!reader) throw new AppError('bad_request', '上游返回了空的模型列表');
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        trace.bytes += value.byteLength;
        if (trace.bytes > 2 * 1024 * 1024) {
          trace.stage = 'response_too_large';
          throw new AppError('bad_request', '上游模型列表过大');
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    trace.stage = 'parse_models';
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      body = undefined;
    }
    const page = modelPage.safeParse(body);
    if (!page.success) throw new AppError('bad_request', '上游模型列表格式无效，请手动添加模型');
    for (const model of page.data.data) {
      const parsed = modelName.safeParse(model.id);
      if (parsed.success) names.add(parsed.data);
      else ignored++;
    }
    trace.stage = 'model_limit';
    if (names.size > 1000) throw new AppError('bad_request', '每个渠道最多添加 1000 个模型');
    if (!page.data.has_more) break;
    const cursor = page.data.last_id;
    trace.stage = 'pagination';
    if (!cursor || cursors.has(cursor)) throw new AppError('bad_request', '上游模型列表分页无效');
    cursors.add(cursor);
    url.searchParams.set('after_id', cursor);
  }
  trace.stage = 'empty_models';
  if (!names.size) throw new AppError('bad_request', '上游未返回有效模型，请手动添加模型');
  return { names: [...names].sort(), ignored };
}
