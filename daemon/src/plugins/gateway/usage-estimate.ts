import { OutputTokenEstimate, type ReservationEstimate } from '../billing/estimation.js';
import type { Endpoint } from '../catalog/service.js';

type Data = Record<string, unknown>;
const object = (value: unknown): Data | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : undefined;

/** 只在内存中观察已生成内容，持久化时保留计数和来源。 */
export class StreamUsageEstimate {
  started = false;
  readonly output = new OutputTokenEstimate();
  input?: Pick<ReservationEstimate, 'inputContentTokens' | 'inputImageCount' | 'settlementImageTokens'>;
  private hasOutput = false;

  private append(value: unknown) {
    if (typeof value === 'string' && value.length) this.hasOutput = true;
    this.output.append(value);
  }

  observe(endpoint: Endpoint, data: Data) {
    if (endpoint === '/v1/responses') {
      const type = String(data.type);
      if (['response.created', 'response.in_progress'].includes(type) && object(data.response)) this.started = true;
      if (
        [
          'response.output_text.delta',
          'response.function_call_arguments.delta',
          'response.reasoning_summary_text.delta',
          'response.reasoning_text.delta',
          'response.refusal.delta',
          'response.custom_tool_call_input.delta',
        ].includes(type) &&
        typeof data.delta === 'string'
      ) {
        this.started = true;
        this.append(data.delta);
      }
      const item = object(data.item);
      if (type === 'response.output_item.added' && item) {
        this.started = true;
        if (item.type === 'function_call' || item.type === 'custom_tool_call') this.append(item.name);
      }
      const response = object(data.response);
      if (
        [
          'response.completed',
          'response.done',
          'response.incomplete',
          'response.failed',
          'response.cancelled',
          'response.canceled',
        ].includes(type) &&
        Array.isArray(response?.output) &&
        !this.hasOutput
      ) {
        for (const value of response.output) {
          const output = object(value);
          if (!output) continue;
          this.started = true;
          if (output.type === 'function_call') {
            this.append(output.name);
            this.append(output.arguments);
          }
          if (output.type === 'custom_tool_call') {
            this.append(output.name);
            this.append(output.input);
          }
          const content = Array.isArray(output.content) ? output.content : output.summary;
          if (Array.isArray(content)) {
            for (const part of content) {
              const block = object(part);
              this.append(block?.text);
              this.append(block?.refusal);
            }
          }
        }
      }
    } else if (endpoint === '/v1/messages') {
      if (data.type === 'message_start' && object(data.message)) this.started = true;
      const block = object(data.content_block);
      if (data.type === 'content_block_start' && block) {
        this.started = true;
        if (block.type === 'text') this.append(block.text);
        if (block.type === 'thinking') this.append(block.thinking);
        if (block.type === 'tool_use' || block.type === 'server_tool_use') {
          this.append(block.name);
          const input = object(block.input);
          if (input && Object.keys(input).length) this.append(JSON.stringify(input));
        }
      }
      const delta = object(data.delta);
      if (data.type === 'content_block_delta' && delta) {
        this.started = true;
        if (delta.type === 'text_delta') this.append(delta.text);
        if (delta.type === 'thinking_delta') this.append(delta.thinking);
        if (delta.type === 'input_json_delta') this.append(delta.partial_json);
      }
    } else if (Array.isArray(data.choices)) {
      for (const choice of data.choices) {
        const delta = object(object(choice)?.delta);
        if (!delta) continue;
        this.started = true;
        this.append(delta.content);
        this.append(delta.refusal);
        this.append(delta.reasoning_content ?? delta.reasoning);
        const legacy = object(delta.function_call);
        this.append(legacy?.name);
        this.append(legacy?.arguments);
        if (Array.isArray(delta.tool_calls)) {
          for (const tool of delta.tool_calls) {
            const call = object(object(tool)?.function);
            this.append(call?.name);
            this.append(call?.arguments);
          }
        }
      }
    }
  }
}
