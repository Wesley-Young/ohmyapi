import { z } from 'zod';

import { AppError } from '../../core/errors.ts';
import type { OutboundFetch } from '../outbound/index.ts';
import { modelName } from './schemas.ts';

/** 拉取过程的诊断信息：失败时据此记录停在哪一步。 */
export type UpstreamModelsTrace = { stage: string; httpStatus?: number; bytes: number };

/**
 * 从 OpenAI 或 Anthropic 兼容的上游拉取模型列表，支持 after_id 分页。
 * 限制响应大小和模型数量，跳过名称格式无效的模型。
 */
export async function fetchUpstreamModels(
  request: OutboundFetch,
  baseUrl: string,
  credential: string,
  signal: AbortSignal,
  trace: UpstreamModelsTrace,
) {
  const base = baseUrl.replace(/\/+$/, '');
  const url = new URL(base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`);
  const names = new Set<string>();
  const cursors = new Set<string>();
  let ignored = 0;
  for (;;) {
    trace.stage = 'fetch';
    const response = await request(url, {
      headers: {
        authorization: `Bearer ${credential}`,
        'x-api-key': credential,
        'anthropic-version': '2023-06-01',
      },
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
    const page = z
      .object({
        data: z.array(z.object({ id: z.string() })).max(1000),
        has_more: z.boolean().optional(),
        last_id: z.string().optional(),
      })
      .safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!page.success) throw new AppError('bad_request', '上游模型列表格式无效，请手动添加模型');
    for (const model of page.data.data) {
      const parsed = modelName.safeParse(model.id);
      if (parsed.success) names.add(parsed.data);
      else ignored++;
    }
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
  trace.stage = 'empty_models';
  if (!names.size) throw new AppError('bad_request', '上游未返回有效模型，请手动添加模型');
  return { names: [...names].sort(), ignored };
}
