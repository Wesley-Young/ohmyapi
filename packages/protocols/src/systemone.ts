import { GatewayError } from './errors.ts';
import { bearerHeaders, openAIErrorBody } from './openai.ts';
import type { ApiProtocol, UsageReader } from './types.ts';
import { count, versionedUrl, withBodyModel } from './util.ts';

const path = '/v1/systemone';

/** TypeSafe 用请求头开启图像资源、Box 问题和长上下文，按客户端的设置转发给上游。 */
const featureHeaders = ['typesafe-danger-zone-images', 'typesafe-danger-zone-long-context'];

/**
 * System One 只返回非流式 JSON，用量只有输入和输出两项，没有缓存明细。
 * OpenRouter 等聚合服务附加的 cost 等字段不参与结算。
 */
const usageReader: UsageReader = {
  inputKey: 'input_tokens',
  outputKey: 'output_tokens',
  envelope: (data) => data,
  terminal: () => false,
  finalizes: (_data, complete, hasUsage) => hasUsage && complete,
  completesOnDone: true,
  merge: (previous, next) => ({ ...previous, ...next }),
  normalize(raw) {
    const input = count(raw.input_tokens);
    const output = count(raw.output_tokens);
    if (
      (raw.input_tokens !== undefined && input === undefined) ||
      (raw.output_tokens !== undefined && output === undefined)
    )
      return { valid: false, unknownCosts: false };
    return {
      valid: true,
      unknownCosts: false,
      input,
      output,
      read: 0n,
      write: 0n,
      image: 0n,
      inputIncludesCache: true,
    };
  },
};

/**
 * TypeSafe System One 决策接口（`POST /v1/systemone`），TypeSafe、OpenRouter、Venice 等服务提供同样的请求和响应结构。
 * state 和问题内容都是业务数据，计费准入不遍历其中的内容；图像通过 assets 提交，费用计入上游报告的输入 Token。
 */
export const systemOneProtocol: ApiProtocol = {
  endpoint: path,
  family: 'systemone',
  routes: [path],
  apiKeyHeaders: [],
  target(_request, body) {
    if (typeof body.model !== 'string' || !body.model || body.model.length > 128)
      throw new GatewayError(400, 'invalid_request', 'A model name is required');
    if (body.stream !== undefined && body.stream !== false)
      throw new GatewayError(400, 'invalid_request', 'System One does not support streaming');
    return { model: body.model, streaming: false };
  },
  withModel: withBodyModel,
  reasoningEffort: () => undefined,
  withReasoningEffort: () => undefined,
  errorBody: openAIErrorBody,
  request: {
    // 决策模型只输出每个问题的答案，请求中没有输出上限。
    outputLimit: { fields: [], required: false, minimum: 1 },
    imageType: 'image',
    messages: () => [],
    contentRoots: () => [],
    toolKind: () => undefined,
    search: {},
  },
  upstream: {
    url: (baseUrl) => versionedUrl(baseUrl, path),
    headers(request, credential) {
      const headers = bearerHeaders(credential);
      for (const name of featureHeaders) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      return headers;
    },
  },
  responseFeatures: { searchOutputItems: false, serverTools: false },
  observeOutput: () => {},
  createUsageReader: () => usageReader,
  // 没有提示缓存；报告了输入用量即可确认缓存命中为 0。
  cacheReadTokens: (raw) => (raw.input_tokens === undefined ? undefined : 0),
  reasoningTokens: () => undefined,
};
