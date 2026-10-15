import type { Endpoint } from './endpoints.ts';

export type Data = Record<string, unknown>;

/** 同一协议族共享请求和响应结构，例如 Responses 与 compact。 */
export type ProtocolFamily = 'chat' | 'responses' | 'messages';

export type SearchKind = 'webSearch' | 'webSearchPreview';
/** 客户端执行的工具，或按调用次数计费的搜索工具。 */
export type ToolKind = 'client' | SearchKind;

/** 一次请求调用的模型和响应方式。 */
export type RequestTarget = { model: string; streaming: boolean };

export type ErrorDetails = { status: number; type: string; code: string; message: string; id: string };

/** 接收流式生成内容，用于估算输出 Token 和首字时间。 */
export interface OutputSink {
  readonly hasOutput: boolean;
  /** 上游已开始生成响应。 */
  start(): void;
  append(value: unknown, reasoning?: boolean): void;
}

/**
 * 协议报告的用量。input 和 output 缺失时用量不完整；valid 为 false 表示字段存在但无法解析。
 * inputIncludesCache 表示输入总量是否已包含缓存读写部分。
 */
export type NormalizedUsage =
  | { valid: false; unknownCosts: boolean }
  | {
      valid: true;
      unknownCosts: boolean;
      input?: bigint;
      output?: bigint;
      read: bigint;
      write: bigint;
      image: bigint;
      inputIncludesCache: boolean;
      /** 附加到原始用量中的合计数据，便于核对账单。 */
      extraRaw?: Data;
    };

/** 按请求创建，读取响应事件中的状态和用量；只保存计数，不保存内容。 */
export interface UsageReader {
  readonly inputKey: string;
  readonly outputKey: string;
  /** 根据请求体配置需要关注的用量项。 */
  configure?(body: Data): void;
  /** 事件中承载 id、usage 和状态的对象。 */
  envelope(data: Data): Data;
  /** 协议特有的失败标记；error 字段和 error 事件由调用方统一处理。 */
  failed?(data: Data, envelope: Data): boolean;
  terminal(data: Data, envelope: Data): boolean;
  /** 当前事件之后已有用量是否为最终用量。complete 为累计的完成状态，hasUsage 表示本事件带有用量。 */
  finalizes(data: Data, complete: boolean, hasUsage: boolean): boolean;
  /** 收到 [DONE] 或非流式响应结束时即视为完成。 */
  readonly completesOnDone: boolean;
  /** 合并此前报告的用量和本事件的用量。 */
  merge(previous: Data, next: Data): Data;
  normalize(raw: Data): NormalizedUsage;
  /** 用量包含请求中途的额外轮次，断连时无法从顶层用量估算。 */
  blocksDisconnectEstimate?(): boolean;
}

export interface ApiProtocol {
  readonly endpoint: Endpoint;
  readonly family: ProtocolFamily;

  // 入站请求

  /** 网关注册的 POST 路由，支持 Hono 路径参数。 */
  readonly routes: readonly string[];
  /** 除 Authorization: Bearer 外接受 API Key 的请求头。 */
  readonly apiKeyHeaders: readonly string[];
  target(request: Request, body: Data, params: Readonly<Record<string, string>>): RequestTarget;
  /** 请求中的推理强度原值，由调用方校验格式。 */
  reasoningEffort(body: Data): unknown;
  /** 会话标识的候选值，按优先级排列；family 区分不同协议的会话空间。 */
  readonly session?: { readonly family: string; candidates(request: Request, body: Data): unknown[] };
  errorBody(error: ErrorDetails): unknown;

  // 计费准入

  readonly request: {
    readonly outputLimit: {
      readonly fields: readonly string[];
      readonly required: boolean;
      /** 客户端显式提供上限时的最小值。 */
      readonly minimum: number;
    };
    readonly imageType: string;
    /** 消息数组中的对象。 */
    messages(body: Data): Data[];
    /** 内容遍历的起点，按顺序入栈。 */
    contentRoots(body: Data): unknown[];
    toolKind(tool: Data): ToolKind | undefined;
    readonly search: {
      /** 每个搜索工具声明调用次数上限的字段。 */
      readonly perToolLimit?: string;
      /** 请求级工具调用次数上限的字段，存在时覆盖按工具累计的值。 */
      readonly requestLimit?: string;
      /** 通过模型或请求选项隐式启用的搜索；只有支持 web_search_options 的协议提供。 */
      implicit?(body: Data): SearchKind | undefined;
    };
    /** 协议定义的服务端搜索内容块（服务端搜索调用或结果）。 */
    serverSearchBlock?(block: Data): boolean;
  };

  // API 渠道上游

  readonly upstream: {
    url(baseUrl: string, target: RequestTarget): string;
    /** 鉴权和协议相关的请求头；Content-Type 与 Accept 由调用方设置。 */
    headers(request: Request, credential: string): Headers;
    body?(parsed: Data, bytes: Buffer<ArrayBuffer>): Buffer<ArrayBuffer>;
  };

  // 响应观察

  readonly responseFeatures: {
    /** 输出项中的 web_search_call 按调用计数。 */
    readonly searchOutputItems: boolean;
    /** 内容块中的服务端工具调用和搜索结果。 */
    readonly serverTools: boolean;
  };
  observeOutput(data: Data, sink: OutputSink): void;
  createUsageReader(): UsageReader;
  /** 原始用量中的缓存读取 Token 原值。 */
  cacheReadTokens(raw: Data): unknown;
  /** 原始用量中的推理 Token 原值。 */
  reasoningTokens(raw: Data): unknown;
}
