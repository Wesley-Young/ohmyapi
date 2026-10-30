import { type OutputSink, protocolFor } from '@ohmyapi/protocols';

import type { Endpoint } from '../database/schema/index.ts';

import { createHash } from 'node:crypto';

export type ModerationTurn = { role: 'user' | 'assistant'; text: string };

/** 送审的会话快照：系统提示和按顺序排列的对话，工具结果和推理内容不送审。 */
export type ModerationContent = { system: string; turns: ModerationTurn[]; images: number; truncated: boolean };

type Data = Record<string, unknown>;
const object = (value: unknown): Data | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : undefined;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined ? [] : [value]);

const turnChars = 8000;
const systemChars = 4000;
const outputChars = 4000;

/** 保留开头和结尾，中间以省略标记代替。 */
function clip(text: string, max: number) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.75);
  return `${text.slice(0, head)}\n…\n${text.slice(text.length - (max - head))}`;
}

const imageTypes = new Set(['image', 'image_url', 'input_image']);
const toolCallTypes = new Set(['tool_use', 'server_tool_use', 'function_call', 'custom_tool_call']);
const textTypes = new Set(['text', 'input_text', 'output_text']);

/** 收集内容块中的文本；图像只计数，工具调用只记名称，工具结果和推理内容跳过。 */
function collect(value: unknown, parts: string[], counter: { images: number }) {
  if (typeof value === 'string') {
    if (value.trim()) parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, parts, counter);
    return;
  }
  const block = object(value);
  if (!block || block.thought === true) return;
  const type = typeof block.type === 'string' ? block.type : undefined;
  if ((type && imageTypes.has(type)) || block.inlineData || block.fileData) {
    counter.images++;
    return;
  }
  const call = type && toolCallTypes.has(type) ? block : object(block.functionCall);
  if (call) {
    if (typeof call.name === 'string') parts.push(`[tool call: ${call.name.slice(0, 64)}]`);
    return;
  }
  if ((type === undefined || textTypes.has(type)) && typeof block.text === 'string' && block.text.trim())
    parts.push(block.text);
}

function textOf(value: unknown, counter: { images: number }) {
  const parts: string[] = [];
  collect(value, parts, counter);
  return parts.join('\n');
}

/** 从请求体中取出系统提示和对话；不支持的协议返回 undefined。 */
export function requestContent(endpoint: Endpoint, body: Data): ModerationContent | undefined {
  const family = protocolFor(endpoint).family;
  const counter = { images: 0 };
  const system: string[] = [];
  const turns: ModerationTurn[] = [];
  const push = (role: string | undefined, value: unknown) => {
    const text = textOf(value, counter);
    if (!text) return;
    if (role === 'system' || role === 'developer') system.push(text);
    else if (role === 'user' || role === 'assistant' || role === 'model')
      turns.push({ role: role === 'user' ? 'user' : 'assistant', text: clip(text, turnChars) });
  };
  if (family === 'chat') {
    for (const message of list(body.messages).map(object)) {
      if (!message) continue;
      push(typeof message.role === 'string' ? message.role : undefined, [
        message.content,
        ...list(message.tool_calls).map((call) => ({ type: 'function_call', ...object(object(call)?.function) })),
      ]);
    }
  } else if (family === 'messages') {
    push('system', body.system);
    for (const message of list(body.messages).map(object))
      if (message) push(typeof message.role === 'string' ? message.role : undefined, message.content);
  } else if (family === 'responses') {
    push('system', body.instructions);
    if (typeof body.input === 'string') push('user', body.input);
    else
      for (const item of list(body.input).map(object)) {
        if (!item) continue;
        if (item.type === 'message' || (item.type === undefined && item.role))
          push(typeof item.role === 'string' ? item.role : undefined, item.content);
        else if (typeof item.type === 'string' && toolCallTypes.has(item.type)) push('assistant', item);
      }
  } else if (family === 'gemini') {
    push('system', object(body.systemInstruction)?.parts);
    for (const content of list(body.contents).map(object))
      if (content) push(content.role === 'model' ? 'model' : 'user', content.parts);
  } else return undefined;
  if (!turns.some((turn) => turn.role === 'user')) return undefined;
  return { system: clip(system.join('\n\n'), systemChars), turns, images: counter.images, truncated: false };
}

/** 会话开头（系统提示和第一条用户输入）的指纹；客户端没有提供会话标识时用于识别同一会话。 */
export function contentFingerprint(content: ModerationContent) {
  const first = content.turns.find((turn) => turn.role === 'user');
  return createHash('sha256')
    .update(JSON.stringify([content.system, first?.text ?? '']))
    .digest('hex');
}

const turnKey = (turn: ModerationTurn) => `${turn.role}\0${turn.text}`;

/**
 * 合并同一会话的快照。新请求通常带有完整历史，以新请求为准；
 * 客户端压缩或截断历史后不再出现的早期用户输入保留在前面。
 */
export function mergeContent(previous: ModerationContent, next: ModerationContent): ModerationContent {
  const present = new Set(next.turns.map(turnKey));
  const dropped = previous.turns.filter((turn) => turn.role === 'user' && !present.has(turnKey(turn)));
  return {
    system: next.system || previous.system,
    turns: [...dropped, ...next.turns],
    images: Math.max(previous.images, next.images),
    truncated: previous.truncated || next.truncated,
  };
}

export const contentChars = (content: ModerationContent) =>
  content.system.length + content.turns.reduce((sum, turn) => sum + turn.text.length, 0);

/**
 * 按字符上限裁剪，保留最近的内容：依次移除最早的模型输出、缩短系统提示、移除最早的用户输入。
 * 不包含输出时移除全部模型输出。
 */
export function fitContent(content: ModerationContent, maxChars: number, includeOutput: boolean): ModerationContent {
  let turns = includeOutput ? [...content.turns] : content.turns.filter((turn) => turn.role === 'user');
  let { system } = content;
  let truncated = content.truncated;
  const total = () => system.length + turns.reduce((sum, turn) => sum + turn.text.length, 0);
  while (total() > maxChars) {
    const index = turns.findIndex((turn, i) => turn.role === 'assistant' && i < turns.length - 1);
    if (index < 0) break;
    turns.splice(index, 1);
    truncated = true;
  }
  if (total() > maxChars && system.length > 1000) {
    system = clip(system, 1000);
    truncated = true;
  }
  while (total() > maxChars && turns.length > 1) {
    turns = turns.slice(1);
    truncated = true;
  }
  if (total() > maxChars) {
    turns = turns.map((turn) => ({ ...turn, text: clip(turn.text, Math.max(1000, maxChars - system.length)) }));
    truncated = true;
  }
  return { system, turns, images: content.images, truncated };
}

/** 在内存中收集模型输出的开头部分，用于送审；推理内容不收集。 */
export class OutputCapture implements OutputSink {
  hasOutput = false;
  private text = '';

  start() {}

  append(value: unknown, reasoning = false) {
    if (reasoning || typeof value !== 'string' || !value) return;
    this.hasOutput = true;
    if (this.text.length < outputChars) this.text += value.slice(0, outputChars - this.text.length);
  }

  get output() {
    return this.text.trim();
  }
}
