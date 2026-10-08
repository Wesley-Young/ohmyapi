import type { Endpoint } from '../catalog/service.js';

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
  rawUsage: ObjectValue;
};

/** Observe only usage envelopes; never persist prompts, response bodies or arbitrary event data. */
export class UsageCollector {
  usage?: Usage;
  upstreamId?: string;
  complete = false;
  finalUsage = false;
  unknownCosts = false;
  failed = false;
  invalid = false;
  private anthropic: ObjectValue = {};
  private readonly endpoint: Endpoint;
  constructor(endpoint: Endpoint) {
    this.endpoint = endpoint;
  }

  observe(value: unknown) {
    const data = object(value);
    if (!data) return;
    if (data.error || data.type === 'error' || data.type === 'response.failed') this.failed = true;
    const envelope =
      this.endpoint === '/v1/responses'
        ? (object(data.response) ?? data)
        : this.endpoint === '/v1/messages'
          ? (object(data.message) ?? data)
          : data;
    if (this.endpoint === '/v1/responses') {
      if (envelope.error || envelope.status === 'failed' || data.type === 'response.error') this.failed = true;
      if (responseTerminalEvents.has(String(data.type)) || responseTerminalStatuses.has(String(envelope.status)))
        this.complete = true;
    }
    if (typeof envelope.id === 'string') this.upstreamId = envelope.id.slice(0, 256);
    const usage = object(envelope.usage);
    if (this.endpoint === '/v1/messages') {
      if (data.type === 'message_stop' || ((!data.type || data.type === 'message') && data.stop_reason))
        this.complete = true;
      if (!usage) {
        if (this.complete && this.usage && !this.invalid) this.finalUsage = true;
        return;
      }
      this.anthropic = { ...this.anthropic, ...usage };
      this.normalize(this.anthropic);
      if (this.complete && this.usage && !this.invalid) this.finalUsage = true;
    } else {
      if (usage) {
        this.normalize(usage);
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
    const isChat = this.endpoint === '/v1/chat/completions';
    const anthropic = this.endpoint === '/v1/messages';
    const input = count(raw[isChat ? 'prompt_tokens' : 'input_tokens']);
    const output = count(raw[isChat ? 'completion_tokens' : 'output_tokens']);
    const details = object(raw[isChat ? 'prompt_tokens_details' : 'input_tokens_details']);
    for (const part of [raw, details, object(raw.completion_tokens_details), object(raw.output_tokens_details)]) {
      if (
        part &&
        ['audio_tokens', 'image_tokens', 'video_tokens'].some(
          (key) => typeof part[key] === 'number' && (part[key] as number) > 0,
        )
      )
        this.unknownCosts = true;
    }
    const readValue = anthropic ? raw.cache_read_input_tokens : details?.cached_tokens;
    const writeValue = anthropic ? raw.cache_creation_input_tokens : details?.cache_write_tokens;
    const read = readValue === undefined ? 0n : count(readValue);
    const write = writeValue === undefined ? 0n : count(writeValue);
    if (
      input === undefined ||
      output === undefined ||
      read === undefined ||
      write === undefined ||
      (!anthropic && input < read + write)
    ) {
      this.invalid = true;
      this.usage = undefined;
      return;
    }
    this.invalid = false;
    this.usage = {
      inputTokens: anthropic ? input : input - read - write,
      outputTokens: output,
      cacheReadTokens: read,
      cacheWriteTokens: write,
      contextTokens: anthropic ? input + read + write : input,
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
  constructor(collector: UsageCollector) {
    this.collector = collector;
  }

  push(chunk: Uint8Array) {
    this.consume(this.decoder.decode(chunk, { stream: true }));
  }

  finish() {
    this.consume(this.decoder.decode());
    if (this.line) this.endLine();
    this.event();
  }

  private consume(text: string) {
    for (const char of text) {
      if (char === '\n' && this.previousCR) {
        this.previousCR = false;
        continue;
      }
      this.previousCR = char === '\r';
      if (char === '\r' || char === '\n') this.endLine();
      else {
        this.lineLength++;
        if (this.skip) continue;
        this.line += char;
        if (++this.size > 1024 * 1024) {
          this.skip = true;
          this.line = '';
          this.data = [];
          this.collector.invalid = true;
        }
      }
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
        } catch {
          this.collector.invalid = true;
        }
      }
    }
    this.data = [];
    this.size = 0;
    this.skip = false;
  }
}
