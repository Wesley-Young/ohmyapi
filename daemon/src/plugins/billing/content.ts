import { protocolFor } from '@ohmyapi/protocols';

import type { Endpoint } from '../database/schema/index.ts';

/** 只遍历协议内容，工具定义和业务对象保持原样。 */
export function* requestContentBlocks(body: Record<string, unknown>, endpoint: Endpoint) {
  const stack: unknown[] = [...protocolFor(endpoint).request.contentRoots(body)];
  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item)) {
      for (const value of item) stack.push(value);
      continue;
    }
    const block = item as Record<string, unknown>;
    yield block;
    if (block.type === 'message' || block.type === 'tool_result' || (block.type == null && block.role))
      stack.push(block.content);
    if (block.type === 'function_call_output' || block.type === 'custom_tool_call_output') stack.push(block.output);
  }
}
