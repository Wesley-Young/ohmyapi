import { GatewayError } from './errors.ts';
import { bearerHeaders, mergeDetails, openAIErrorBody, openAIUsage } from './openai.ts';
import type { ApiProtocol, UsageReader } from './types.ts';
import { bodyTarget, isFunctionTool, messageObjects, object, versionedUrl, withBodyModel } from './util.ts';

const path = '/v1/chat/completions';
const detailsKey = 'prompt_tokens_details';

const usageReader: UsageReader = {
  inputKey: 'prompt_tokens',
  outputKey: 'completion_tokens',
  envelope: (data) => data,
  // Chat Completions 没有终止事件，以 [DONE]、非流式完成对象或末尾的空 choices 用量块为准。
  terminal: () => false,
  finalizes: (data, complete, hasUsage) =>
    hasUsage &&
    (complete || data.object === 'chat.completion' || (Array.isArray(data.choices) && data.choices.length === 0)),
  completesOnDone: true,
  merge: mergeDetails(detailsKey),
  normalize: (raw) => openAIUsage(raw, 'prompt_tokens', 'completion_tokens', detailsKey),
};

export const chatProtocol: ApiProtocol = {
  endpoint: path,
  family: 'chat',
  routes: [path],
  apiKeyHeaders: [],
  target: (_request, body) => bodyTarget(body),
  withModel: withBodyModel,
  reasoningEffort: (body) => body.reasoning_effort ?? object(body.reasoning)?.effort,
  // 与 reasoningEffort 读取同一个字段：reasoning_effort 优先，其次 reasoning.effort。
  withReasoningEffort(body, effort) {
    if (body.reasoning_effort !== undefined && body.reasoning_effort !== null)
      return typeof body.reasoning_effort === 'string' ? { ...body, reasoning_effort: effort } : undefined;
    const reasoning = object(body.reasoning);
    return typeof reasoning?.effort === 'string' ? { ...body, reasoning: { ...reasoning, effort } } : undefined;
  },
  errorBody: openAIErrorBody,
  request: {
    outputLimit: { fields: ['max_completion_tokens', 'max_tokens'], required: false, minimum: 1 },
    imageType: 'image_url',
    messages: messageObjects,
    contentRoots: (body) => messageObjects(body).map((message) => message.content),
    toolKind: (tool) => (isFunctionTool(tool) ? 'client' : undefined),
    search: {
      implicit(body) {
        const model = typeof body.model === 'string' ? body.model : '';
        const searchModel = /(?:^|-)search-(preview|api)(?:-\d{4}-\d{2}-\d{2})?$/.exec(model);
        if (searchModel || body.web_search_options != null)
          return searchModel?.[1] === 'preview' ? 'webSearchPreview' : 'webSearch';
      },
    },
  },
  upstream: {
    url: (baseUrl) => versionedUrl(baseUrl, path),
    headers: (_request, credential) => bearerHeaders(credential),
    body(parsed, bytes) {
      if (parsed.stream !== true) return bytes;
      const options = parsed.stream_options;
      if (options != null && (typeof options !== 'object' || Array.isArray(options)))
        throw new GatewayError(400, 'invalid_request', 'stream_options must be an object');
      // 保留其他流式选项，并主动请求结算所需的 usage。
      parsed.stream_options = { ...(options as Record<string, unknown> | undefined), include_usage: true };
      return Buffer.from(JSON.stringify(parsed));
    },
  },
  responseFeatures: { searchOutputItems: false, serverTools: false },
  observeOutput(data, sink) {
    if (!Array.isArray(data.choices)) return;
    for (const choice of data.choices) {
      const delta = object(object(choice)?.delta);
      if (!delta) continue;
      sink.start();
      sink.append(delta.content);
      sink.append(delta.refusal);
      sink.append(delta.reasoning_content ?? delta.reasoning, true);
      const legacy = object(delta.function_call);
      sink.append(legacy?.name);
      sink.append(legacy?.arguments);
      if (Array.isArray(delta.tool_calls)) {
        for (const tool of delta.tool_calls) {
          const call = object(object(tool)?.function);
          sink.append(call?.name);
          sink.append(call?.arguments);
        }
      }
    }
  },
  createUsageReader: () => usageReader,
  cacheReadTokens: (raw) => object(raw[detailsKey])?.cached_tokens,
  reasoningTokens: (raw) => {
    const details = object(raw.completion_tokens_details);
    return details?.reasoning_tokens ?? details?.thinking_tokens;
  },
};
