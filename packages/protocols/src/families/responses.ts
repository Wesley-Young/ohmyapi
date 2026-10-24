import type { ApiProtocol, UsageReader } from '../types.ts';
import { bodyTarget, isFunctionTool, object, versionedUrl, withBodyModel } from '../util.ts';
import { bearerHeaders, mergeDetails, openAIErrorBody, openAIUsage } from './openai-shared.ts';

const detailsKey = 'input_tokens_details';
const terminalStatuses = new Set(['completed', 'incomplete', 'failed', 'cancelled', 'canceled']);
const terminalEvents = new Set([
  'response.completed',
  'response.done',
  'response.incomplete',
  'response.failed',
  'response.cancelled',
  'response.canceled',
]);
const outputDeltaEvents = new Set([
  'response.output_text.delta',
  'response.function_call_arguments.delta',
  'response.reasoning_summary_text.delta',
  'response.reasoning_text.delta',
  'response.refusal.delta',
  'response.custom_tool_call_input.delta',
]);

/** Codex 客户端的请求头：按协议命名空间保留新增能力头，鉴权、Cookie 和传输层字段由出站请求单独处理。 */
export function codexRequestHeaders(request: Request): Headers {
  const headers = new Headers();
  const connectionHeaders = new Set(
    (request.headers.get('connection') ?? '').split(',').map((name) => name.trim().toLowerCase()),
  );
  for (const [name, value] of request.headers) {
    if (connectionHeaders.has(name)) continue;
    if (
      name.startsWith('x-codex-') ||
      name.startsWith('x-openai-internal-codex-') ||
      [
        'session_id',
        'session-id',
        'conversation_id',
        'thread_id',
        'thread-id',
        'openai-beta',
        'accept-language',
      ].includes(name)
    )
      headers.set(name, value);
  }
  return headers;
}

function usageReader(compact: boolean): UsageReader {
  return {
    inputKey: 'input_tokens',
    outputKey: 'output_tokens',
    envelope: (data) => object(data.response) ?? data,
    failed: (data, envelope) =>
      data.type === 'response.failed' ||
      data.type === 'response.error' ||
      Boolean(envelope.error) ||
      envelope.status === 'failed',
    terminal: (data, envelope) =>
      (compact && data.object === 'response.compaction') ||
      terminalEvents.has(String(data.type)) ||
      terminalStatuses.has(String(envelope.status)),
    finalizes: (_data, complete, hasUsage) => hasUsage && complete,
    completesOnDone: false,
    merge: mergeDetails(detailsKey),
    normalize: (raw) => openAIUsage(raw, 'input_tokens', 'output_tokens', detailsKey),
  };
}

function responsesProtocol(compact: boolean): ApiProtocol {
  const path = compact ? '/v1/responses/compact' : '/v1/responses';
  const reader = usageReader(compact);
  return {
    endpoint: path,
    family: 'responses',
    routes: [path],
    apiKeyHeaders: [],
    target: (_request, body) => bodyTarget(body),
    withModel: withBodyModel,
    reasoningEffort: (body) => object(body.reasoning)?.effort,
    withReasoningEffort(body, effort) {
      const reasoning = object(body.reasoning);
      return typeof reasoning?.effort === 'string' ? { ...body, reasoning: { ...reasoning, effort } } : undefined;
    },
    session: {
      family: 'responses',
      candidates(request, body) {
        const metadata = object(body.client_metadata);
        return [
          body.prompt_cache_key,
          request.headers.get('session_id'),
          request.headers.get('session-id'),
          request.headers.get('conversation_id'),
          request.headers.get('thread_id'),
          request.headers.get('thread-id'),
          metadata?.session_id,
          metadata?.conversation_id,
          metadata?.thread_id,
        ];
      },
    },
    errorBody: openAIErrorBody,
    request: {
      outputLimit: { fields: ['max_output_tokens'], required: false, minimum: 16 },
      imageType: 'input_image',
      messages: () => [],
      contentRoots: (body) => [body.input],
      toolKind(tool) {
        if (isFunctionTool(tool)) return 'client';
        if (typeof tool.type === 'string') {
          if (/^web_search(?:_\d{4}_\d{2}_\d{2})?$/.test(tool.type)) return 'webSearch';
          if (/^web_search_preview(?:_\d{4}_\d{2}_\d{2})?$/.test(tool.type)) return 'webSearchPreview';
        }
        if (
          tool.type === 'namespace' &&
          typeof tool.name === 'string' &&
          tool.name.length > 0 &&
          Array.isArray(tool.tools) &&
          tool.tools.every((child) => {
            const value = object(child);
            return value !== undefined && isFunctionTool(value);
          })
        )
          return 'client';
      },
      search: { requestLimit: 'max_tool_calls' },
    },
    upstream: {
      url: (baseUrl) => versionedUrl(baseUrl, path),
      headers(request, credential) {
        const headers = bearerHeaders(credential);
        for (const [name, value] of codexRequestHeaders(request)) headers.set(name, value);
        return headers;
      },
    },
    responseFeatures: { searchOutputItems: true, serverTools: false },
    observeOutput(data, sink) {
      const type = String(data.type);
      if (['response.created', 'response.in_progress'].includes(type) && object(data.response)) sink.start();
      if (outputDeltaEvents.has(type) && typeof data.delta === 'string') {
        sink.start();
        sink.append(data.delta, type === 'response.reasoning_text.delta');
      }
      const item = object(data.item);
      if (type === 'response.output_item.added' && item) {
        sink.start();
        if (item.type === 'function_call' || item.type === 'custom_tool_call') sink.append(item.name);
      }
      const response = object(data.response);
      // 只有终止事件携带完整输出时，用它补足此前没有观察到的生成内容。
      if (!terminalEvents.has(type) || !Array.isArray(response?.output) || sink.hasOutput) return;
      for (const value of response.output) {
        const output = object(value);
        if (!output) continue;
        sink.start();
        if (output.type === 'function_call') {
          sink.append(output.name);
          sink.append(output.arguments);
        }
        if (output.type === 'custom_tool_call') {
          sink.append(output.name);
          sink.append(output.input);
        }
        const content = Array.isArray(output.content) ? output.content : output.summary;
        if (Array.isArray(content)) {
          for (const part of content) {
            const block = object(part);
            sink.append(block?.text);
            sink.append(block?.refusal);
          }
        }
      }
    },
    createUsageReader: () => reader,
    cacheReadTokens: (raw) => object(raw[detailsKey])?.cached_tokens,
    reasoningTokens: (raw) => {
      const details = object(raw.output_tokens_details);
      return details?.reasoning_tokens ?? details?.thinking_tokens;
    },
  };
}

export const responses = responsesProtocol(false);
export const responsesCompact = responsesProtocol(true);
