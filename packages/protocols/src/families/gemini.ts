import { GatewayError } from '../errors.ts';
import type { ApiProtocol, Data, ModelInfo, NormalizedUsage, SearchActivity, UsageReader } from '../types.ts';
import { count, object } from '../util.ts';

import { createHash } from 'node:crypto';

const endpoint = '/v1beta/generateContent';
const methods = ['generateContent', 'streamGenerateContent', 'countTokens'];

/**
 * 请求中已知的 proto 消息层级。Google 的 JSON 映射同时接受 lowerCamelCase 和 snake_case 字段名；
 * 这些层级的字段名统一为 lowerCamelCase，未列出的值（函数参数、JSON Schema、工具返回等业务数据）保持原样。
 */
type Spec = { readonly [field: string]: Spec | readonly [Spec] };
const fields: Spec = {};
const part: Spec = {
  inlineData: fields,
  fileData: fields,
  functionCall: fields,
  functionResponse: fields,
  executableCode: fields,
  codeExecutionResult: fields,
  toolCall: fields,
  toolResponse: fields,
  videoMetadata: fields,
  mediaResolution: fields,
};
const content: Spec = { parts: [part] };
const generateRequest: Spec = {
  contents: [content],
  systemInstruction: content,
  tools: [
    {
      functionDeclarations: [fields],
      googleSearch: { searchTypes: fields, timeRangeFilter: fields },
      googleSearchRetrieval: fields,
      codeExecution: fields,
      urlContext: fields,
    },
  ],
  toolConfig: { functionCallingConfig: fields },
  generationConfig: { thinkingConfig: fields, imageConfig: fields },
  safetySettings: [fields],
};
// countTokens 可以在 generateContentRequest 中携带完整的生成请求。
const requestSpec: Spec = { ...generateRequest, generateContentRequest: generateRequest };

const camelCase = (key: string) => key.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());

function canonical(value: unknown, spec: Spec): unknown {
  const source = object(value);
  if (!source) return value;
  const result: Data = {};
  for (const [key, child] of Object.entries(source)) {
    const name = camelCase(key);
    if (Object.hasOwn(result, name))
      throw new GatewayError(400, 'invalid_request', `Field ${name} is specified more than once`);
    const nested = spec[name];
    result[name] =
      nested === undefined
        ? child
        : Array.isArray(nested)
          ? Array.isArray(child)
            ? child.map((item) => canonical(item, nested[0]))
            : child
          : canonical(child, nested as Spec);
  }
  return result;
}

/** Gemini 接受的占位签名：跳过思考签名校验。 */
const dummyThoughtSignature = 'skip_thought_signature_validator';

/** 路径中的模型名：只含字母、数字、下划线、连字符和点，且不全是点。 */
export const isPathModel = (name: string) => /^[A-Za-z0-9_.-]{1,128}$/.test(name) && !/^\.+$/.test(name);

/**
 * 发往上游前修正历史内容：移除 parts 为空的消息（上游不接受）；为缺少签名的 functionCall 补占位签名；
 * 前 foreignHistory 条内容来自其他上游，其中的签名在当前上游无效，替换为占位签名。
 * 条数按客户端请求中的 contents 计算，与移除空消息无关。不需要修正时返回 undefined。
 */
export function repairGeminiHistory(parsed: Data, foreignHistory: number): Data | undefined {
  if (!Array.isArray(parsed.contents)) return undefined;
  let changed = false;
  const contents = parsed.contents.flatMap((item, index): unknown[] => {
    const entry = object(item);
    if (!entry || !Array.isArray(entry.parts)) return [item];
    if (!entry.parts.length) {
      changed = true;
      return [];
    }
    let partsChanged = false;
    const parts = entry.parts.map((value) => {
      const part = object(value);
      if (!part) return value;
      const signature = part.thoughtSignature;
      const missing = object(part.functionCall) && (typeof signature !== 'string' || !signature.trim());
      const foreign = index < foreignHistory && signature !== undefined && signature !== dummyThoughtSignature;
      if (!missing && !foreign) return value;
      partsChanged = true;
      return { ...part, thoughtSignature: dummyThoughtSignature };
    });
    if (!partsChanged) return [item];
    changed = true;
    return [{ ...entry, parts }];
  });
  return changed ? { ...parsed, contents } : undefined;
}

const geminiCliTmpDir = /\/\.gemini\/tmp\/([A-Fa-f0-9]{64})/;

/** 会话标识：Gemini CLI 的用户标识与项目临时目录哈希，其次是首条用户内容的摘要。 */
function sessionCandidates(request: Request, body: Data): unknown[] {
  const contents = Array.isArray(body.contents) ? body.contents : [];
  const firstUser = contents.find((item) => object(item)?.role !== 'model');
  // Gemini CLI 在系统指令或首条用户内容中写入项目临时目录。
  const tmpDir = geminiCliTmpDir.exec(JSON.stringify([body.systemInstruction, firstUser]) ?? '')?.[1];
  const cliUser = request.headers.get('x-gemini-api-privileged-user-id')?.trim();
  return [
    tmpDir && (cliUser ? `cli:${cliUser}:${tmpDir.toLowerCase()}` : `cli:${tmpDir.toLowerCase()}`),
    firstUser && `content:${createHash('sha256').update(JSON.stringify(firstUser)).digest('hex')}`,
  ];
}

/** HTTP 状态对应的 google.rpc.Code 名称。 */
function rpcStatus(status: number) {
  const known: Record<number, string> = {
    400: 'INVALID_ARGUMENT',
    401: 'UNAUTHENTICATED',
    403: 'PERMISSION_DENIED',
    404: 'NOT_FOUND',
    408: 'DEADLINE_EXCEEDED',
    409: 'ABORTED',
    413: 'INVALID_ARGUMENT',
    429: 'RESOURCE_EXHAUSTED',
    499: 'CANCELLED',
    501: 'UNIMPLEMENTED',
    503: 'UNAVAILABLE',
    504: 'DEADLINE_EXCEEDED',
  };
  return known[status] ?? (status >= 500 ? 'INTERNAL' : 'FAILED_PRECONDITION');
}

const generationConfig = (body: Data) => object(body.generationConfig);

/** usageMetadata 中按模态拆分的 Token 数；格式错误时返回 undefined。 */
function modalityCounts(value: unknown): Record<string, bigint> | undefined {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.length > 32) return undefined;
  const result: Record<string, bigint> = {};
  for (const entry of value) {
    const item = object(entry);
    const modality = item?.modality;
    const tokens = item?.tokenCount === undefined ? 0n : count(item.tokenCount);
    if (typeof modality !== 'string' || !/^[A-Z_]{1,32}$/.test(modality) || tokens === undefined) return undefined;
    result[modality] = (result[modality] ?? 0n) + tokens;
  }
  return result;
}

const numbers = (counts: Record<string, bigint>) =>
  Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)]));

/** Gemini 省略为 0 的用量字段；promptTokenCount 已包含缓存命中的 Token，思考 Token 按输出计费。 */
function normalizeUsage(raw: Data): NormalizedUsage {
  const optional = (value: unknown) => (value === undefined ? 0n : count(value));
  const prompt = count(raw.promptTokenCount);
  const candidates = optional(raw.candidatesTokenCount);
  const thoughts = optional(raw.thoughtsTokenCount);
  const cached = optional(raw.cachedContentTokenCount);
  const toolUse = optional(raw.toolUsePromptTokenCount);
  const promptDetails = modalityCounts(raw.promptTokensDetails);
  const candidateDetails = modalityCounts(raw.candidatesTokensDetails);
  if (
    (raw.promptTokenCount !== undefined && prompt === undefined) ||
    candidates === undefined ||
    thoughts === undefined ||
    cached === undefined ||
    toolUse === undefined ||
    !promptDetails ||
    !candidateDetails
  )
    return { valid: false, unknownCosts: false };
  // 内置工具的提示 Token、音视频输入以及非文本输出按其他价格计费，交给人工核对。
  const unknownCosts =
    toolUse > 0n ||
    (promptDetails.AUDIO ?? 0n) > 0n ||
    (promptDetails.VIDEO ?? 0n) > 0n ||
    Object.entries(candidateDetails).some(([modality, tokens]) => modality !== 'TEXT' && tokens > 0n);
  return {
    valid: true,
    unknownCosts,
    input: prompt,
    output: prompt === undefined ? undefined : candidates + thoughts,
    read: cached,
    write: 0n,
    image: promptDetails.IMAGE ?? 0n,
    inputIncludesCache: true,
    // 原始用量只保留数值，按模态的明细数组转为对象后保存。
    extraRaw: {
      ...(Object.keys(promptDetails).length ? { promptTokensDetails: numbers(promptDetails) } : {}),
      ...(Object.keys(candidateDetails).length ? { candidatesTokensDetails: numbers(candidateDetails) } : {}),
    },
  };
}

const candidatesOf = (data: Data) => (Array.isArray(data.candidates) ? data.candidates : []);

const usageReader: UsageReader = {
  inputKey: 'promptTokenCount',
  outputKey: 'candidatesTokenCount',
  envelope: (data) => data,
  usage: (envelope) => envelope.usageMetadata,
  upstreamId: (envelope) => envelope.responseId,
  // 候选给出结束原因，或提示词被拦截时响应结束。
  terminal: (data) =>
    candidatesOf(data).some((candidate) => object(candidate)?.finishReason != null) ||
    object(data.promptFeedback)?.blockReason != null,
  finalizes: (_data, complete, hasUsage) => hasUsage && complete,
  completesOnDone: false,
  // 每个事件的 usageMetadata 都是截至当前的完整用量。
  merge: (_previous, next) => next,
  normalize: normalizeUsage,
};

function modelEntry(model: ModelInfo) {
  return {
    name: `models/${model.name}`,
    baseModelId: model.name,
    version: '',
    displayName: model.name,
    inputTokenLimit: model.inputTokenLimit,
    outputTokenLimit: model.outputTokenLimit,
    supportedGenerationMethods: methods,
  };
}

/**
 * 支持函数声明和 Google 网页搜索，每个工具对象只声明一种工具。
 * 图片搜索、代码执行、URL 上下文等内置工具按其他方式计费。
 */
function geminiToolKind(tool: Data) {
  const entries = Object.entries(tool);
  if (entries.length !== 1) return undefined;
  const [[key, value]] = entries;
  if (key === 'functionDeclarations' && Array.isArray(value)) return 'client';
  const search = object(value);
  if (key !== 'googleSearch' || !search) return undefined;
  // searchTypes 缺省时只启用网页搜索。
  const types = search.searchTypes;
  if (types !== undefined && !Object.keys(object(types) ?? { invalid: true }).every((type) => type === 'webSearch'))
    return undefined;
  return 'webSearch';
}

/**
 * Google 按模型执行的搜索查询计费，查询列在候选的 groundingMetadata 中。
 * 开启 includeServerSideToolInvocations 时，响应内容还包含服务端的 toolCall，用来发现缺少查询报告的搜索。
 */
function searchActivity(data: Data): SearchActivity | undefined {
  const activity: SearchActivity = { queries: [], calls: 0, unknownCosts: false };
  let found = false;
  for (const value of candidatesOf(data)) {
    const candidate = object(value);
    if (!candidate) continue;
    if (candidate.groundingMetadata !== undefined) {
      found = true;
      const grounding = object(candidate.groundingMetadata);
      const queries = grounding?.webSearchQueries;
      // 格式错误时加入非字符串的值，由调用方判定为无效。
      if (Array.isArray(queries)) activity.queries.push(...queries);
      else if (!grounding || queries !== undefined) activity.queries.push(null);
      const images = grounding?.imageSearchQueries;
      if (images !== undefined && (!Array.isArray(images) || images.length > 0)) activity.unknownCosts = true;
    }
    const parts = object(candidate.content)?.parts;
    for (const item of Array.isArray(parts) ? parts : []) {
      const part = object(item);
      const invocation = object(part?.toolCall) ?? object(part?.toolResponse);
      if (!invocation) continue;
      found = true;
      if (invocation.toolType !== 'GOOGLE_SEARCH_WEB') activity.unknownCosts = true;
      else if (part?.toolCall) activity.calls += 1;
    }
  }
  return found ? activity : undefined;
}

/** inlineData 和 fileData 没有 type 字段，按 MIME 类型归类。 */
function partType(part: Data): unknown {
  const media = object(part.inlineData) ?? object(part.fileData);
  if (!media) return part.type;
  const mime = typeof media.mimeType === 'string' ? media.mimeType.toLowerCase() : '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

export const geminiProtocol: ApiProtocol = {
  endpoint,
  family: 'gemini',
  routes: ['/v1beta/models/:action'],
  // x-api-key 兼容按 Anthropic 习惯配置的客户端。
  apiKeyHeaders: ['x-goog-api-key', 'x-api-key'],
  apiKeyQuery: ['key'],
  rejectedApiKeyQuery: ['api_key'],
  target(request, _body, params) {
    const match = /^(.+):([A-Za-z]+)$/.exec(params.action ?? '');
    if (!match) throw new GatewayError(404, 'not_found', 'Use models/{model}:generateContent');
    const [, model, method] = match;
    if (!methods.includes(method))
      throw new GatewayError(404, 'unsupported_method', `${method} is not supported by this gateway`);
    if (!isPathModel(model))
      throw new GatewayError(400, 'invalid_request', 'Model names may contain only letters, digits, _, - and .');
    // countTokens 不产生费用，不计费转发。
    if (method === 'countTokens') return { model, streaming: false, operation: method, unbilled: true };
    const streaming = method === 'streamGenerateContent';
    if (streaming && new URL(request.url).searchParams.get('alt') !== 'sse')
      throw new GatewayError(400, 'invalid_request', 'streamGenerateContent requires alt=sse');
    return { model, streaming, operation: method };
  },
  // 模型名位于路径中；countTokens 携带的完整生成请求中的 model 一并改写。
  withModel(target, body, model) {
    const inner = object(body.generateContentRequest);
    return {
      target: { ...target, model },
      body:
        inner && typeof inner.model === 'string'
          ? { ...body, generateContentRequest: { ...inner, model: `models/${model}` } }
          : undefined,
    };
  },
  canonicalBody: (body) => canonical(body, requestSpec) as Data,
  session: {
    family: endpoint,
    candidates: sessionCandidates,
    historyLength: (body) => (Array.isArray(body.contents) ? body.contents.length : 0),
  },
  reasoningEffort: (body) => object(generationConfig(body)?.thinkingConfig)?.thinkingLevel,
  withReasoningEffort(body, effort) {
    const config = generationConfig(body);
    const thinking = object(config?.thinkingConfig);
    const level = thinking?.thinkingLevel;
    if (!config || !thinking || typeof level !== 'string') return undefined;
    // 保持客户端的大小写写法（如 HIGH）。
    const thinkingLevel = level === level.toUpperCase() ? effort.toUpperCase() : effort;
    return { ...body, generationConfig: { ...config, thinkingConfig: { ...thinking, thinkingLevel } } };
  },
  errorBody: ({ status, code, message }) => ({
    error: {
      code: status,
      message,
      status: rpcStatus(status),
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: code.toUpperCase(), domain: 'ohmyapi' }],
    },
  }),
  modelList: {
    path: '/v1beta/models',
    // 名称无法放入 Gemini 路径的模型不能通过本协议调用，不在列表中展示。
    list: (models) => ({ models: models.filter((model) => isPathModel(model.name)).map(modelEntry) }),
    get: modelEntry,
  },
  request: {
    outputLimit: { fields: ['generationConfig.maxOutputTokens'], required: false, minimum: 1 },
    imageType: 'image',
    messages: () => [],
    contentRoots: (body) => [
      object(body.systemInstruction)?.parts,
      ...(Array.isArray(body.contents) ? body.contents.map((content) => object(content)?.parts) : []),
    ],
    blockType: partType,
    outputModalities(body) {
      const modalities = generationConfig(body)?.responseModalities;
      return Array.isArray(modalities)
        ? modalities.map((value) => (typeof value === 'string' ? value.toLowerCase() : value))
        : modalities;
    },
    toolKind: geminiToolKind,
    search: {},
  },
  upstream: {
    url(baseUrl, target) {
      const base = baseUrl.replace(/\/+$/, '').replace(/\/v1beta$/, '');
      const method = target.streaming ? 'streamGenerateContent?alt=sse' : (target.operation ?? 'generateContent');
      return `${base}/v1beta/models/${encodeURIComponent(target.model)}:${method}`;
    },
    headers: (_request, credential) => new Headers({ 'x-goog-api-key': credential }),
    body(parsed, bytes, context) {
      const repaired = repairGeminiHistory(parsed, context.foreignHistory);
      return repaired ? Buffer.from(JSON.stringify(repaired)) : bytes;
    },
  },
  responseFeatures: {
    searchOutputItems: false,
    serverTools: false,
    searchActivity,
  },
  observeOutput(data, sink) {
    for (const value of candidatesOf(data)) {
      const candidate = object(value);
      if (!candidate) continue;
      sink.start();
      const parts = object(candidate.content)?.parts;
      if (!Array.isArray(parts)) continue;
      for (const item of parts) {
        const part = object(item);
        if (!part) continue;
        sink.append(part.text, part.thought === true);
        const call = object(part.functionCall);
        if (call) {
          sink.append(call.name);
          if (call.args !== undefined) sink.append(JSON.stringify(call.args));
        }
        // 服务端工具调用的参数由模型生成，计入输出。
        const toolCall = object(part.toolCall);
        if (toolCall?.args !== undefined) sink.append(JSON.stringify(toolCall.args));
      }
    }
  },
  createUsageReader: () => usageReader,
  // Gemini 省略为 0 的字段；报告了输入用量即可确认缓存命中数。
  cacheReadTokens: (raw) => raw.cachedContentTokenCount ?? (raw.promptTokenCount === undefined ? undefined : 0),
  reasoningTokens: (raw) => raw.thoughtsTokenCount,
};
