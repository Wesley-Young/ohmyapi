import type { ModelInfo } from './types.ts';

/** OpenAI 和 Anthropic 客户端共用的模型列表路径。 */
export const modelListPath = '/v1/models';

/**
 * `/v1/models` 的响应体，按请求头选择格式。与 New API 一致：同时带 x-api-key 和 anthropic-version 时返回
 * Anthropic 格式，其余返回 OpenAI 格式；owner 是 OpenAI 格式中的 owned_by。
 */
export function modelListBody(request: Request, models: readonly ModelInfo[], owner: string): unknown {
  if (request.headers.get('x-api-key') && request.headers.get('anthropic-version'))
    return {
      data: models.map((model) => ({
        type: 'model',
        id: model.name,
        display_name: model.name,
        created_at: model.createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      })),
      has_more: false,
      first_id: models[0]?.name ?? null,
      last_id: models.at(-1)?.name ?? null,
    };
  return {
    object: 'list',
    data: models.map((model) => ({
      id: model.name,
      object: 'model',
      created: Math.floor(model.createdAt.getTime() / 1000),
      owned_by: owner,
    })),
  };
}
