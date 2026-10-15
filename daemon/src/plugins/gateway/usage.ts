import { safeErrorMessage } from '../../core/logging.ts';
import { type ApiProtocol, protocolFor, type UsageReader } from '../../protocols/index.ts';
import { reportedCacheReadTokens } from '../billing/cache-usage.ts';
import type { SearchRequest } from '../billing/search.ts';
import type { Endpoint, Usage, UsageEstimate } from '../database/schema/index.ts';
import { SearchUsageCollector } from './search-usage.ts';
import { StreamUsageEstimate } from './usage-estimate.ts';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : undefined;
const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
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

/** 仅保留用量元数据和脱敏后的错误消息；字段结构由端点协议解析。 */
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
  private readonly protocol: ApiProtocol;
  private readonly reader: UsageReader;
  constructor(endpoint: Endpoint) {
    this.endpoint = endpoint;
    this.protocol = protocolFor(endpoint);
    this.reader = this.protocol.createUsageReader();
  }

  configureSearch(request: SearchRequest) {
    this.search.configure(request);
  }

  /** 按请求体配置协议需要关注的用量项，例如 Messages 的压缩轮次。 */
  configureRequest(body: ObjectValue) {
    this.reader.configure?.(body);
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
      this.reader.blocksDisconnectEstimate?.() ||
      !this.estimate.started ||
      !this.estimate.input
    )
      return;
    const raw = this.reportedUsage;
    const { inputKey, outputKey } = this.reader;
    const reportedInput = count(raw[inputKey]);
    // 缓存命中无法从请求内容估算，缺少上游输入及缓存报告时交给人工核对。
    if (reportedInput === undefined || reportedCacheReadTokens(this.endpoint, raw) === null) return;
    const tail = this.estimate.output.count();
    const output = (this.reportedOutput ?? 0n) + tail;
    if (output > BigInt(Number.MAX_SAFE_INTEGER)) return;
    const searchSource = this.search.estimate(this.protocol.responseFeatures);
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
    const { reader } = this;
    this.estimate.observe(this.protocol, data);
    const envelope = reader.envelope(data);
    if (data.error || data.type === 'error' || reader.failed?.(data, envelope)) this.failed = true;
    const upstreamError = data.error ?? envelope.error;
    const message =
      typeof upstreamError === 'string'
        ? upstreamError
        : (object(upstreamError)?.message ??
          (['error', 'response.error'].includes(String(data.type)) ? data.message : undefined));
    if (typeof message === 'string') this.errorMessage = safeErrorMessage(message);
    if (reader.terminal(data, envelope)) this.complete = true;
    const upstreamId = reader.upstreamId ? reader.upstreamId(envelope) : envelope.id;
    if (typeof upstreamId === 'string') this.upstreamId = upstreamId.slice(0, 256);
    const usage = object(reader.usage ? reader.usage(envelope) : envelope.usage);
    if (usage) {
      const reportedInput = count(usage[reader.inputKey]);
      const reportedOutput = count(usage[reader.outputKey]);
      if (reportedInput !== undefined || reportedOutput !== undefined) this.estimate.started = true;
      if (reportedOutput !== undefined) {
        if (this.reportedOutput !== undefined && reportedOutput < this.reportedOutput) this.malformed = true;
        this.reportedOutput = reportedOutput;
        this.estimate.output.reset();
      }
    }
    this.search.observe(this.protocol.responseFeatures, data, envelope, usage, this.complete);
    this.syncSearchUsage();
    if (usage) this.normalize(reader.merge(this.reportedUsage, usage));
    if (this.usage && !this.invalid && reader.finalizes(data, this.complete, usage !== undefined))
      this.finalUsage = true;
  }

  /** 收到 [DONE] 或非流式响应结束；只有以此为完成标志的协议生效。 */
  done() {
    if (!this.reader.completesOnDone) return;
    this.complete = true;
    if (this.usage && !this.invalid) this.finalUsage = true;
  }

  private normalize(raw: ObjectValue) {
    this.reportedUsage = usageNumbers(raw);
    const normalized = this.reader.normalize(raw);
    if (normalized.unknownCosts) this.unknownCosts = true;
    if (!normalized.valid) return this.rejectUsage();
    const { input, output, read, write, image, inputIncludesCache } = normalized;
    if (
      input !== undefined &&
      (image > (inputIncludesCache ? input : input + read + write) || (inputIncludesCache && input < read + write))
    )
      return this.rejectUsage();
    this.invalid = this.search.invalid;
    if (input === undefined || output === undefined) {
      this.usage = undefined;
      return;
    }
    this.usage = {
      inputTokens: inputIncludesCache ? input - read - write : input,
      outputTokens: output,
      cacheReadTokens: read,
      cacheWriteTokens: write,
      contextTokens: inputIncludesCache ? input : input + read + write,
      webSearchCalls: this.search.webSearchCalls,
      webSearchPreviewCalls: this.search.webSearchPreviewCalls,
      rawUsage: normalized.extraRaw ? { ...usageNumbers(raw), ...normalized.extraRaw } : usageNumbers(raw),
    };
  }

  private rejectUsage() {
    this.invalid = true;
    this.malformed = true;
    this.usage = undefined;
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
  private readonly onEvent?: (value: unknown) => void;
  constructor(collector: UsageCollector, maxEventBytes: number, onEvent?: (value: unknown) => void) {
    this.onEvent = onEvent;
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
          const value: unknown = JSON.parse(raw);
          this.collector.observe(value);
          this.onEvent?.(value);
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
