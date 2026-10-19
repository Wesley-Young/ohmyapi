import type { ApiProtocol, OutputSink } from '@ohmyapi/protocols';

import { OutputTokenEstimate } from '../billing/estimation.ts';

/** 只在内存中观察已生成内容，持久化时保留计数和来源。 */
export class StreamUsageEstimate implements OutputSink {
  started = false;
  readonly output = new OutputTokenEstimate();
  /** Epoch milliseconds of the first non-empty generated content, including reasoning and tool calls. */
  firstOutputAt?: number;
  /** Full reasoning text was streamed; summaries do not count because they omit most reasoning tokens. */
  reasoningStreamed = false;
  hasOutput = false;

  start() {
    this.started = true;
  }

  append(value: unknown, reasoning = false) {
    if (typeof value === 'string' && value.length) {
      this.hasOutput = true;
      this.firstOutputAt ??= Date.now();
      if (reasoning) this.reasoningStreamed = true;
    }
    this.output.append(value);
  }

  observe(protocol: ApiProtocol, data: Record<string, unknown>) {
    protocol.observeOutput(data, this);
  }
}
