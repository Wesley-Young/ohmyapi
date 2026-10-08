import { safeErrorMessage } from '../../logging.js';
import type { UsageEstimate } from '../billing/estimation.js';
import type { SearchRequest } from '../billing/search.js';
import type { Endpoint } from '../catalog/service.js';
import { SearchUsageCollector } from './search-usage.js';
import { StreamUsageEstimate } from './usage-estimate.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : undefined;
const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
const responseTerminalStatuses = new Set(['completed', 'incomplete', 'failed', 'cancelled', 'canceled']);
const responseTerminalEvents = new Set([
  'response.completed',
  'response.done',
  'response.incomplete',
  'response.failed',
  'response.cancelled',
  'response.canceled',
]);
// Keep numeric usage metadata only. Discard text, arrays and unbounded provider extensions.
function usageNumbers(raw: ObjectValue, depth = 0): ObjectValue {
  const result: ObjectValue = {};
  for (const [key, value] of Object.entries(raw).slice(0, 100)) {
    if (key.length > 128) continue;
    if (count(value) !== undefined) result[key] = value;
    else if (depth < 2) {
      const nested = object(value);
      if (nested) result[key] = usageNumbers(nested, depth + 1);
    }
  }
  return result;
}
export type Usage = {
  inputTokens: bigint;
  outputTokens: bigint;
  cacheReadTokens: bigint;
  cacheWriteTokens: bigint;
  contextTokens: bigint;
  webSearchCalls: bigint;
  webSearchPreviewCalls: bigint;
  rawUsage: ObjectValue;
};

/** 仅保留用量元数据和脱敏后的错误消息。 */
export class UsageCollector {
  usage?: Usage;
  upstreamId?: string;
  errorMessage?: string;
  complete = false;
  finalUsage = false;
  unknownCosts = false;
  failed = false;
  invalid = false;
  observationIncomplete = false;
  usageEstimate?: UsageEstimate;
  readonly estimate = new StreamUsageEstimate();
  private reportedUsage: ObjectValue = {};
  private reportedOutput?: bigint;
  private malformed = false;
  private readonly search = new SearchUsageCollector();
  private readonly endpoint: Endpoint;
  constructor(endpoint: Endpoint) {
    this.endpoint = endpoint;
  }

  configureSearch(request: SearchRequest) {
    this.search.configure(request);
  }

  markInvalid(error: unknown) {
    this.invalid = true;
    this.malformed = true;
    this.errorMessage = safeErrorMessage(error);
  }

  get searchIncomplete() {
    return this.search.incomplete;
  }

  estimateDisconnected() {
    if (
      this.usageEstimate ||
      (this.finalUsage && !this.searchIncomplete) ||
      this.invalid ||
      this.malformed ||
      this.unknownCosts ||
      this.observationIncomplete ||
      this.failed ||
      !this.estimate.started ||
      !this.estimate.input
    )
      return;
    const raw = this.reportedUsage;
    const inputKey = this.endpoint === '/v1/chat/completions' ? 'prompt_tokens' : 'input_tokens';
    const outputKey = this.endpoint === '/v1/chat/completions' ? 'completion_tokens' : 'output_tokens';
    const reportedInput = count(raw[inputKey]);
    const tail = this.estimate.output.count();
    const output = (this.reportedOutput ?? 0n) + tail;
    if (output > BigInt(Number.MAX_SAFE_INTEGER)) return;
    const searchSource = this.search.estimate(this.endpoint);
    this.normalize({
      ...raw,
      [inputKey]:
        reportedInput === undefined
          ? this.estimate.input.inputContentTokens + this.estimate.input.settlementImageTokens
          : Number(reportedInput),
      [outputKey]: Number(output),
    });
    if (!this.usage || this.invalid || this.unknownCosts) return;
    // 合成用量用于计价，rawUsage 仍只保存真实的上游报告。
    this.usage.rawUsage = usageNumbers(raw);
    this.finalUsage = false;
    this.usageEstimate = {
      method: 'o200k_base_v1',
      reason: 'client_disconnected',
      inputSource: reportedInput === undefined ? 'request_estimate' : 'upstream',
      outputSource:
        this.reportedOutput === undefined
          ? 'observed_estimate'
          : tail > 0n
            ? 'upstream_with_observed_tail'
            : 'upstream',
      reportedOutputTokens: this.reportedOutput?.toString() ?? null,
      observedTailTokens: tail.toString(),
      inputImageCount: this.estimate.input.inputImageCount,
      inputImageTokens: reportedInput === undefined ? this.estimate.input.settlementImageTokens : 0,
      imageMethod: 'model_default_1024_v1',
      searchSource,
    };
  }

  private syncSearchUsage() {
    this.invalid ||= this.search.invalid;
    this.unknownCosts ||= this.search.unknownCosts;
    if (this.usage) {
      this.usage.webSearchCalls = this.search.webSearchCalls;
      this.usage.webSearchPreviewCalls = this.search.webSearchPreviewCalls;
    }
  }

  observe(value: unknown) {
    const data = object(value);
    if (!data) return;
    this.estimate.observe(this.endpoint, data);
    if (data.error || data.type === 'error' || data.type === 'response.failed') this.failed = true;
    const envelope =
      this.endpoint === '/v1/responses'
        ? (object(data.response) ?? data)
        : this.endpoint === '/v1/messages'
          ? (object(data.message) ?? data)
          : data;
    const upstreamError = data.error ?? envelope.error;
    const message =
      typeof upstreamError === 'string'
        ? upstreamError
        : (object(upstreamError)?.message ??
          (['error', 'response.error'].includes(String(data.type)) ? data.message : undefined));
    if (typeof message === 'string') this.errorMessage = safeErrorMessage(message);
    if (this.endpoint === '/v1/responses') {
      if (envelope.error || envelope.status === 'failed' || data.type === 'response.error') this.failed = true;
      if (responseTerminalEvents.has(String(data.type)) || responseTerminalStatuses.has(String(envelope.status)))
        this.complete = true;
    }
    if (typeof envelope.id === 'string') this.upstreamId = envelope.id.slice(0, 256);
    const usage = object(envelope.usage);
    if (usage) {
      const reportedInput = count(usage[this.endpoint === '/v1/chat/completions' ? 'prompt_tokens' : 'input_tokens']);
      const reportedOutput = count(
        usage[this.endpoint === '/v1/chat/completions' ? 'completion_tokens' : 'output_tokens'],
      );
      if (reportedInput !== undefined || reportedOutput !== undefined) this.estimate.started = true;
      if (reportedOutput !== undefined) {
        if (this.reportedOutput !== undefined && reportedOutput < this.reportedOutput) this.malformed = true;
        this.reportedOutput = reportedOutput;
        this.estimate.output.reset();
      }
    }
    if (this.endpoint === '/v1/messages') {
      if (data.type === 'message_stop' || ((!data.type || data.type === 'message') && data.stop_reason))
        this.complete = true;
      this.search.observe(this.endpoint, data, envelope, usage, this.complete);
      this.syncSearchUsage();
      if (!usage) {
        if (this.complete && this.usage && !this.invalid) this.finalUsage = true;
        return;
      }
      this.normalize({ ...this.reportedUsage, ...usage });
      if (this.complete && this.usage && !this.invalid) this.finalUsage = true;
    } else {
      this.search.observe(this.endpoint, data, envelope, usage, this.complete);
      this.syncSearchUsage();
      if (usage) {
        const detailsKey = this.endpoint === '/v1/chat/completions' ? 'prompt_tokens_details' : 'input_tokens_details';
        this.normalize({
          ...this.reportedUsage,
          ...usage,
          [detailsKey]: { ...object(this.reportedUsage[detailsKey]), ...object(usage[detailsKey]) },
        });
        if (
          this.usage &&
          !this.invalid &&
          (this.complete ||
            (this.endpoint === '/v1/chat/completions' &&
              (data.object === 'chat.completion' || (Array.isArray(data.choices) && data.choices.length === 0))))
        )
          this.finalUsage = true;
      }
    }
  }

  done() {
    if (this.endpoint === '/v1/chat/completions') {
      this.complete = true;
      if (this.usage && !this.invalid) this.finalUsage = true;
    }
  }

  private normalize(raw: ObjectValue) {
    this.reportedUsage = usageNumbers(raw);
    const isChat = this.endpoint === '/v1/chat/completions';
    const anthropic = this.endpoint === '/v1/messages';
    const input = count(raw[isChat ? 'prompt_tokens' : 'input_tokens']);
    const output = count(raw[isChat ? 'completion_tokens' : 'output_tokens']);
    const details = object(raw[isChat ? 'prompt_tokens_details' : 'input_tokens_details']);
    for (const part of [raw, details, object(raw.completion_tokens_details), object(raw.output_tokens_details)]) {
      if (
        part &&
        ['audio_tokens', 'video_tokens'].some((key) => typeof part[key] === 'number' && (part[key] as number) > 0)
      )
        this.unknownCosts = true;
    }
    // 输入图像已包含在输入总量中；图像输出和未标明方向的图像费用仍需核对。
    for (const part of [raw, object(raw.completion_tokens_details), object(raw.output_tokens_details)]) {
      if (part && typeof part.image_tokens === 'number' && part.image_tokens > 0) this.unknownCosts = true;
    }
    const readValue = anthropic ? raw.cache_read_input_tokens : details?.cached_tokens;
    const writeValue = anthropic ? raw.cache_creation_input_tokens : details?.cache_write_tokens;
    const read = readValue === undefined ? 0n : count(readValue);
    const write = writeValue === undefined ? 0n : count(writeValue);
    const image = details?.image_tokens === undefined ? 0n : count(details.image_tokens);
    if (
      (raw[isChat ? 'prompt_tokens' : 'input_tokens'] !== undefined && input === undefined) ||
      (raw[isChat ? 'completion_tokens' : 'output_tokens'] !== undefined && output === undefined) ||
      read === undefined ||
      write === undefined ||
      image === undefined ||
      (input !== undefined && image > (anthropic ? input + read + write : input)) ||
      (!anthropic && input !== undefined && input < read + write)
    ) {
      this.invalid = true;
      this.malformed = true;
      this.usage = undefined;
      return;
    }
    this.invalid = this.search.invalid;
    if (input === undefined || output === undefined) {
      this.usage = undefined;
      return;
    }
    this.usage = {
      inputTokens: anthropic ? input : input - read - write,
      outputTokens: output,
      cacheReadTokens: read,
      cacheWriteTokens: write,
      contextTokens: anthropic ? input + read + write : input,
      webSearchCalls: this.search.webSearchCalls,
      webSearchPreviewCalls: this.search.webSearchPreviewCalls,
      rawUsage: usageNumbers(raw),
    };
  }
}

/** Bounded incremental SSE observer. The bytes delivered to the client remain untouched. */
export class SseObserver {
  private decoder = new TextDecoder();
  private line = '';
  private lineLength = 0;
  private data: string[] = [];
  private size = 0;
  private skip = false;
  private previousCR = false;
  private readonly collector: UsageCollector;
  private readonly maxEventBytes: number;
  constructor(collector: UsageCollector, maxEventBytes: number) {
    this.collector = collector;
    this.maxEventBytes = maxEventBytes;
  }

  push(chunk: Uint8Array) {
    this.consume(this.decoder.decode(chunk, { stream: true }));
  }

  finish(interrupted = false) {
    // 断连时末尾可能只有半个事件，只用此前已完整解析的事件估算。
    if (interrupted) {
      this.line = '';
      this.data = [];
      return;
    }
    this.consume(this.decoder.decode());
    if (this.line) this.endLine();
    this.event();
  }

  private consume(text: string) {
    let offset = 0;
    const breaks = /[\r\n]/g;
    while (offset < text.length) {
      if (this.previousCR) {
        this.previousCR = false;
        if (text[offset] === '\n') {
          offset++;
          continue;
        }
      }
      breaks.lastIndex = offset;
      const end = breaks.exec(text)?.index ?? text.length;
      const fragment = text.slice(offset, end);
      this.lineLength += fragment.length;
      if (!this.skip) {
        this.size += Buffer.byteLength(fragment, 'utf8');
        if (this.size > this.maxEventBytes) {
          this.skip = true;
          this.line = '';
          this.data = [];
          this.collector.observationIncomplete = true;
        } else this.line += fragment;
      }
      if (end === text.length) break;
      this.previousCR = text[end] === '\r';
      this.endLine();
      offset = end + 1;
    }
  }

  private endLine() {
    if (!this.lineLength) this.event();
    else if (this.line.startsWith('data:')) this.data.push(this.line.slice(5).replace(/^ /, ''));
    this.line = '';
    this.lineLength = 0;
  }

  private event() {
    if (!this.skip && this.data.length) {
      const raw = this.data.join('\n');
      if (raw === '[DONE]') this.collector.done();
      else {
        try {
          this.collector.observe(JSON.parse(raw));
        } catch (error) {
          this.collector.markInvalid(error);
        }
      }
    }
    this.data = [];
    this.size = 0;
    this.skip = false;
  }
}
