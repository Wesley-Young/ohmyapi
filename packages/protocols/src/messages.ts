import { GatewayError } from './errors.ts';
import type { ApiProtocol, Data, UsageReader } from './types.ts';
import { bodyTarget, count, hasUnpricedMedia, isFunctionTool, messageObjects, object, versionedUrl } from './util.ts';

const path = '/v1/messages';
const maxUsageIterations = 1_000;
type CompactionUsage = { iterations: bigint; input: bigint; output: bigint; read: bigint; write: bigint };

/** 压缩轮次的用量只在 usage.iterations 中报告，不计入顶层用量。 */
class MessagesUsageReader implements UsageReader {
  readonly inputKey = 'input_tokens';
  readonly outputKey = 'output_tokens';
  readonly completesOnDone = false;
  private compaction?: CompactionUsage;
  private iterationsInvalid = false;
  private unknownIterations = false;
  private summaryRequested = false;
  private compactionRequested = false;

  configure(body: Data) {
    const edits = object(body.context_management)?.edits;
    this.summaryRequested = body.compaction != null;
    this.compactionRequested =
      this.summaryRequested ||
      (Array.isArray(edits) && edits.some((edit) => String(object(edit)?.type).startsWith('compact_')));
  }

  envelope(data: Data) {
    return object(data.message) ?? data;
  }

  terminal(data: Data) {
    return data.type === 'message_stop' || ((!data.type || data.type === 'message') && Boolean(data.stop_reason));
  }

  // message_delta 的用量是累计值，给出 stop_reason 后不再变化；message_stop 只是收尾标记。
  reportsFinalUsage(data: Data) {
    return data.type === 'message_delta' && object(data.delta)?.stop_reason != null;
  }

  // 按需压缩的摘要消耗只出现在 iterations 中，缺失时不能按顶层的 0 用量结算。
  finalizes(_data: Data, complete: boolean) {
    return complete && (!this.summaryRequested || this.compaction !== undefined);
  }

  merge(previous: Data, next: Data) {
    return { ...previous, ...next };
  }

  // 压缩轮次可能在请求中途发生，顶层用量无法反映摘要消耗。
  blocksDisconnectEstimate() {
    return this.compactionRequested || Boolean(this.compaction?.iterations);
  }

  normalize(raw: Data) {
    this.observeIterations(raw.iterations);
    const compaction = this.compaction;
    const reportedInput = count(raw.input_tokens);
    const reportedOutput = count(raw.output_tokens);
    const input = reportedInput === undefined ? undefined : reportedInput + (compaction?.input ?? 0n);
    const output = reportedOutput === undefined ? undefined : reportedOutput + (compaction?.output ?? 0n);
    const details = object(raw.input_tokens_details);
    const unknownCosts = this.unknownIterations || hasUnpricedMedia(raw, details);
    const reportedRead = raw.cache_read_input_tokens === undefined ? 0n : count(raw.cache_read_input_tokens);
    const reportedWrite = raw.cache_creation_input_tokens === undefined ? 0n : count(raw.cache_creation_input_tokens);
    const read = reportedRead === undefined ? undefined : reportedRead + (compaction?.read ?? 0n);
    const write = reportedWrite === undefined ? undefined : reportedWrite + (compaction?.write ?? 0n);
    const image = details?.image_tokens === undefined ? 0n : count(details.image_tokens);
    if (
      this.iterationsInvalid ||
      (raw.input_tokens !== undefined && input === undefined) ||
      (raw.output_tokens !== undefined && output === undefined) ||
      read === undefined ||
      write === undefined ||
      image === undefined
    )
      return { valid: false as const, unknownCosts };
    return {
      valid: true as const,
      unknownCosts,
      input,
      output,
      read,
      write,
      image,
      inputIncludesCache: false,
      // 原始 iterations 为数组，不会保留在原始用量中，单独记录压缩轮次合计以便核对账单。
      extraRaw: compaction?.iterations
        ? {
            compaction_iterations: {
              count: Number(compaction.iterations),
              input_tokens: Number(compaction.input),
              output_tokens: Number(compaction.output),
              cache_read_input_tokens: Number(compaction.read),
              cache_creation_input_tokens: Number(compaction.write),
            },
          }
        : undefined,
    };
  }

  /** 流式事件中的 iterations 为累计值，以最近一次报告为准。 */
  private observeIterations(value: unknown) {
    if (value == null) return;
    if (!Array.isArray(value) || value.length > maxUsageIterations) {
      this.iterationsInvalid = true;
      return;
    }
    const total: CompactionUsage = { iterations: 0n, input: 0n, output: 0n, read: 0n, write: 0n };
    for (const entry of value) {
      const item = object(entry);
      if (typeof item?.type !== 'string') {
        this.iterationsInvalid = true;
        return;
      }
      // message 轮次已计入顶层用量。
      if (item.type === 'message') continue;
      // advisor、fallback 等轮次按其他模型计价，交给人工核对。
      if (item.type !== 'compaction') {
        this.unknownIterations = true;
        continue;
      }
      const input = count(item.input_tokens);
      const output = count(item.output_tokens);
      const read = item.cache_read_input_tokens == null ? 0n : count(item.cache_read_input_tokens);
      const write = item.cache_creation_input_tokens == null ? 0n : count(item.cache_creation_input_tokens);
      if (input === undefined || output === undefined || read === undefined || write === undefined) {
        this.iterationsInvalid = true;
        return;
      }
      total.iterations++;
      total.input += input;
      total.output += output;
      total.read += read;
      total.write += write;
    }
    this.compaction = total;
  }
}

export const messagesProtocol: ApiProtocol = {
  endpoint: path,
  family: 'messages',
  routes: [path],
  apiKeyHeaders: ['x-api-key'],
  target: (_request, body) => bodyTarget(body),
  reasoningEffort: (body) => object(body.output_config)?.effort,
  session: { family: path, candidates: (_request, body) => [object(body.metadata)?.user_id] },
  errorBody: ({ type, message, id }) => ({ type: 'error', error: { type, message }, request_id: id }),
  request: {
    outputLimit: { fields: ['max_tokens'], required: true, minimum: 1 },
    imageType: 'image',
    messages: messageObjects,
    contentRoots: (body) => [body.system, ...messageObjects(body).map((message) => message.content)],
    toolKind(tool) {
      if (isFunctionTool(tool)) return 'client';
      if (typeof tool.type === 'string' && /^web_search_\d{8}$/.test(tool.type) && tool.name === 'web_search')
        return 'webSearch';
      if (
        tool.type === undefined &&
        typeof tool.name === 'string' &&
        tool.input_schema &&
        typeof tool.input_schema === 'object'
      )
        return 'client';
    },
    search: { perToolLimit: 'max_uses' },
    serverSearchBlock: (block) =>
      (block.type === 'server_tool_use' && block.name === 'web_search') || block.type === 'web_search_tool_result',
  },
  upstream: {
    url: (baseUrl) => versionedUrl(baseUrl, path),
    headers(request, credential) {
      const headers = new Headers({ 'x-api-key': credential });
      const version = request.headers.get('anthropic-version') ?? '2023-06-01';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(version))
        throw new GatewayError(400, 'invalid_version', 'Invalid anthropic-version');
      headers.set('anthropic-version', version);
      const beta = request.headers.get('anthropic-beta');
      if (beta) headers.set('anthropic-beta', beta);
      return headers;
    },
  },
  responseFeatures: { searchOutputItems: false, serverTools: true },
  observeOutput(data, sink) {
    if (data.type === 'message_start' && object(data.message)) sink.start();
    const block = object(data.content_block);
    if (data.type === 'content_block_start' && block) {
      sink.start();
      if (block.type === 'text') sink.append(block.text);
      if (block.type === 'thinking') sink.append(block.thinking, true);
      if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        sink.append(block.name);
        const input = object(block.input);
        if (input && Object.keys(input).length) sink.append(JSON.stringify(input));
      }
    }
    const delta = object(data.delta);
    if (data.type === 'content_block_delta' && delta) {
      sink.start();
      if (delta.type === 'text_delta') sink.append(delta.text);
      if (delta.type === 'thinking_delta') sink.append(delta.thinking, true);
      if (delta.type === 'input_json_delta') sink.append(delta.partial_json);
    }
  },
  createUsageReader: () => new MessagesUsageReader(),
  cacheReadTokens: (raw) => raw.cache_read_input_tokens,
  reasoningTokens: (raw) => {
    const details = object(raw.output_tokens_details);
    return details?.reasoning_tokens ?? details?.thinking_tokens;
  },
};
