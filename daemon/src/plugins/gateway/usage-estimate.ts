import type { ApiProtocol, OutputSink } from '@ohmyapi/protocols';

import { OutputTokenEstimate } from '../billing/estimation.ts';

/** 只在内存中观察已生成内容，持久化时保留计数和来源。 */
export class StreamUsageEstimate implements OutputSink {
  started = false;
  readonly output = new OutputTokenEstimate();
  /** 首末非空内容事件的到达时间，正文、推理和工具调用都计入。 */
  firstOutputAt?: number;
  lastOutputAt?: number;
  private eventAt = 0;
  /** Full reasoning text was streamed; summaries do not count because they omit most reasoning tokens. */
  reasoningStreamed = false;
  hasOutput = false;

  start() {
    this.started = true;
  }

  append(value: unknown, reasoning = false) {
    if (typeof value === 'string' && value.length) {
      this.hasOutput = true;
      this.firstOutputAt ??= this.eventAt;
      this.lastOutputAt = this.eventAt;
      if (reasoning) this.reasoningStreamed = true;
    }
    this.output.append(value);
  }

  observe(protocol: ApiProtocol, data: Record<string, unknown>) {
    this.eventAt = Date.now();
    const hadOutput = this.hasOutput;
    protocol.observeOutput(data, this);
    return !hadOutput && this.hasOutput;
  }
}
