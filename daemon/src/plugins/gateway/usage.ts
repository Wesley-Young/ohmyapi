import { type ApiProtocol, protocolFor, type UsageReader } from '@ohmyapi/protocols';
import type { ResponseObserver } from '@ohmyapi/relay';

import { safeErrorMessage } from '../../core/logging.ts';
import { reportedCacheReadTokens } from '../billing/cache-usage.ts';
import { tokenEstimateMethod } from '../billing/estimation.ts';
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
export class UsageCollector implements ResponseObserver {
  usage?: Usage;
  upstreamId?: string;
  errorMessage?: string;
  complete = false;
  finalUsage = false;
  unknownCosts = false;
  failed = false;
  invalid = false;
  observationIncomplete = false;
  /** 上游报告过用量对象，包括无法解析的用量。 */
  usageSeen = false;
  usageEstimate?: UsageEstimate;
  readonly estimate = new StreamUsageEstimate();
  private reportedUsage: ObjectValue = {};
  private reportedOutput?: bigint;
  private malformedUsage = false;
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

  malformed(error: unknown) {
    this.invalid = true;
    this.malformedUsage = true;
    this.errorMessage = safeErrorMessage(error);
  }

  truncated() {
    this.observationIncomplete = true;
  }

  get searchIncomplete() {
    return this.search.incomplete;
  }

  /** 响应中出现过搜索调用或结果。 */
  get searchObserved() {
    return this.search.observed;
  }

  estimateDisconnected() {
    if (
      this.usageEstimate ||
      (this.finalUsage && !this.searchIncomplete) ||
      this.invalid ||
      this.malformedUsage ||
      this.unknownCosts ||
      this.observationIncomplete ||
      this.failed ||
      this.reader.blocksDisconnectEstimate?.() ||
      !this.estimate.started
    )
      return;
    const raw = this.reportedUsage;
    const { inputKey, outputKey } = this.reader;
    const reportedInput = count(raw[inputKey]);
    // 输入和缓存命中以上游报告为准，缺少报告时交给人工核对。
    if (reportedInput === undefined || reportedCacheReadTokens(this.endpoint, raw) === null) return;
    const tail = this.estimate.output.count();
    const output = (this.reportedOutput ?? 0n) + tail;
    if (output > BigInt(Number.MAX_SAFE_INTEGER)) return;
    const searchSource = this.search.estimate(this.protocol.responseFeatures);
    this.normalize({
      ...raw,
      [inputKey]: Number(reportedInput),
      [outputKey]: Number(output),
    });
    if (!this.usage || this.invalid || this.unknownCosts) return;
    // 合成用量用于计价，rawUsage 仍只保存真实的上游报告。
    this.usage.rawUsage = usageNumbers(raw);
    this.finalUsage = false;
    this.usageEstimate = {
      method: tokenEstimateMethod,
      reason: 'client_disconnected',
      inputSource: 'upstream',
      outputSource:
        this.reportedOutput === undefined
          ? 'observed_estimate'
          : tail > 0n
            ? 'upstream_with_observed_tail'
            : 'upstream',
      reportedOutputTokens: this.reportedOutput?.toString() ?? null,
      observedTailTokens: tail.toString(),
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

  event(value: unknown) {
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
    const final = this.complete || reader.reportsFinalUsage?.(data) === true;
    const upstreamId = reader.upstreamId ? reader.upstreamId(envelope) : envelope.id;
    if (typeof upstreamId === 'string') this.upstreamId = upstreamId.slice(0, 256);
    const usage = object(reader.usage ? reader.usage(envelope) : envelope.usage);
    if (usage) {
      this.usageSeen = true;
      const reportedInput = count(usage[reader.inputKey]);
      const reportedOutput = count(usage[reader.outputKey]);
      if (reportedInput !== undefined || reportedOutput !== undefined) this.estimate.started = true;
      if (reportedOutput !== undefined) {
        if (this.reportedOutput !== undefined && reportedOutput < this.reportedOutput) this.malformedUsage = true;
        this.reportedOutput = reportedOutput;
        this.estimate.output.reset();
      }
    }
    this.search.observe(this.protocol.responseFeatures, data, envelope, usage, final);
    this.syncSearchUsage();
    if (usage) this.normalize(reader.merge(this.reportedUsage, usage));
    if (this.usage && !this.invalid && reader.finalizes(data, final, usage !== undefined)) this.finalUsage = true;
  }

  /** SSE 正常读到结尾；以 [DONE] 为完成标志的协议缺少 [DONE] 时，结尾同样表示不会再有用量。 */
  streamEnded() {
    this.done();
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
    this.malformedUsage = true;
    this.usage = undefined;
  }
}
