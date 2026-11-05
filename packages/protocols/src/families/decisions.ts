import { GatewayError } from '../errors.ts';
import type { ApiProtocol, UsageReader } from '../types.ts';
import { bodyTarget, object, versionedUrl, withBodyModel } from '../util.ts';
import { bearerHeaders, mergeDetails, openAIErrorBody, openAIUsage } from './openai-shared.ts';

const path = '/v1/decisions';
const detailsKey = 'input_tokens_details';
const usageReader: UsageReader = {
  inputKey: 'input_tokens',
  outputKey: 'output_tokens',
  envelope: (data) => data,
  terminal: () => false,
  finalizes: (_data, complete, hasUsage) => hasUsage && complete,
  completesOnDone: true,
  merge: mergeDetails(detailsKey),
  normalize: (raw) => openAIUsage(raw, 'input_tokens', 'output_tokens', detailsKey),
};

/** OpenAI Decisions 返回类型化答案；计费策略由使用方决定，协议保留真实输出用量。 */
export const decisionsProtocol: ApiProtocol = {
  endpoint: path,
  family: 'decisions',
  routes: [path],
  apiKeyHeaders: [],
  target(_request, body) {
    const target = bodyTarget(body);
    if (target.streaming) throw new GatewayError(400, 'invalid_request', 'Decisions does not support streaming');
    return target;
  },
  withModel: withBodyModel,
  reasoningEffort: () => undefined,
  withReasoningEffort: () => undefined,
  errorBody: openAIErrorBody,
  request: {
    outputLimit: { fields: [], required: false, minimum: 1 },
    imageType: 'input_image',
    messages: () => [],
    // 只遍历协议内容，不深入 input_json.data、选项或评分等级中的业务数据。
    contentRoots: (body) => [
      body.input,
      ...(Array.isArray(body.questions) ? body.questions.map((question) => object(question)?.instructions) : []),
    ],
    toolKind: () => undefined,
    search: {},
  },
  upstream: {
    url: (baseUrl) => versionedUrl(baseUrl, path),
    headers: (_request, credential) => bearerHeaders(credential),
  },
  responseFeatures: { searchOutputItems: false, serverTools: false },
  observeOutput: () => {},
  createUsageReader: () => usageReader,
  cacheReadTokens: (raw) => object(raw[detailsKey])?.cached_tokens,
  reasoningTokens: (raw) => object(raw.output_tokens_details)?.reasoning_tokens,
};
