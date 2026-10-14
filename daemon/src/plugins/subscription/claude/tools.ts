import { GatewayError } from '../../../core/errors.js';
import { words } from './words.js';

import { createHmac } from 'node:crypto';

export type Data = Record<string, unknown>;
export function object(value: unknown): Data | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : undefined;
}
export const objects = (value: unknown): Data[] =>
  Array.isArray(value) ? value.flatMap((v) => (object(v) ? [v as Data] : [])) : [];
const serverTool = (tool: Data) =>
  /^(advisor_|agent_toolset_|bash_|code_execution_|computer_|memory_|text_editor_|tool_search_tool_|web_fetch_|web_search_)/.test(
    String(tool.type ?? ''),
  );
const mcpName = (name: string) => name.length <= 64 && /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(name);

// 对齐 CPA helps/claude_mcp_alias.go 的 HMAC 域、词表索引和语义后缀。
function alias(secret: string, name: string, attempt: number) {
  const digest = (purpose: string, original: string) =>
    createHmac('sha256', secret).update(`cpa-claude-mcp-alias-v2\0${purpose}\0${original}`).digest();
  const server = digest('server', '');
  const tool = digest('tool', name);
  const prefix = `mcp__${words[server.readUInt16BE(0) % words.length]}_${words[server.readUInt16BE(2) % words.length]}__${words[(tool.readUInt16BE(0) + attempt) % words.length]}_`;
  const limit = 64 - prefix.length;
  let semantic = '';
  let separator = false;
  for (const char of name) {
    if (!/[A-Za-z0-9_-]/.test(char)) {
      separator = semantic.length > 0;
      continue;
    }
    if (separator && semantic.length + 1 < limit) semantic += '_';
    separator = false;
    if (semantic.length >= limit) break;
    semantic += char;
  }
  return prefix + (semantic.replace(/^[_-]+|[_-]+$/g, '') || 'tool');
}

function rewriteBlock(block: Data, names: Map<string, string>) {
  if (block.type === 'tool_use' && typeof block.name === 'string') block.name = names.get(block.name) ?? block.name;
  if (block.type === 'tool_reference' && typeof block.tool_name === 'string')
    block.tool_name = names.get(block.tool_name) ?? block.tool_name;
  if (['tool_result', 'tool_search_tool_result'].includes(String(block.type))) {
    for (const part of objects(block.content)) rewriteBlock(part, names);
    for (const part of objects(object(block.content)?.tool_references)) rewriteBlock(part, names);
  }
}

export function remapTools(body: Data, secret: string) {
  const declarations = objects(body.tools);
  const reserved = new Set([
    'web_search',
    'code_execution',
    'text_editor',
    'computer',
    ...declarations.map((t) => String(t.name)),
  ]);
  const forward = new Map<string, string>();
  for (const tool of declarations) {
    if (serverTool(tool)) continue;
    const name = String(tool.name ?? '');
    if (!name) throw new GatewayError(400, 'invalid_tool', 'Tool name is required');
    if (!mcpName(name) && !forward.has(name)) {
      let replacement = '';
      for (let attempt = 0; attempt < words.length; attempt++) {
        const candidate = alias(secret, name, attempt);
        if (!reserved.has(candidate)) {
          replacement = candidate;
          break;
        }
      }
      if (!replacement) throw new GatewayError(400, 'invalid_tool', 'Tool aliases exhausted');
      forward.set(name, replacement);
      reserved.add(replacement);
    }
    tool.name = forward.get(name) ?? name;
    delete tool.type;
  }
  const choice = object(body.tool_choice);
  if (choice?.type === 'tool' && typeof choice.name === 'string') choice.name = forward.get(choice.name) ?? choice.name;
  for (const message of objects(body.messages))
    for (const block of objects(message.content)) rewriteBlock(block, forward);
  return new Map([...forward].map(([name, replacement]) => [replacement, name]));
}

export function restoreTools(event: Data, reverse: Map<string, string>) {
  for (const block of objects(event.content)) rewriteBlock(block, reverse);
  const block = object(event.content_block);
  if (block) rewriteBlock(block, reverse);
  const message = object(event.message);
  if (message) for (const part of objects(message.content)) rewriteBlock(part, reverse);
}
