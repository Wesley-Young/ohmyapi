import type { Endpoint } from '../catalog/service.js';

export const imageInputTypes: Record<Endpoint, string> = {
  '/v1/chat/completions': 'image_url',
  '/v1/responses': 'input_image',
  '/v1/responses/compact': 'input_image',
  '/v1/messages': 'image',
};

/** 只遍历协议内容，工具定义和业务对象保持原样。 */
export function* requestContentBlocks(body: Record<string, unknown>, endpoint: Endpoint) {
  const stack: unknown[] = [];
  if (endpoint.startsWith('/v1/responses')) stack.push(body.input);
  else {
    if (endpoint === '/v1/messages') stack.push(body.system);
    if (Array.isArray(body.messages)) {
      for (const message of body.messages) {
        if (message && typeof message === 'object' && !Array.isArray(message)) stack.push(message.content);
      }
    }
  }
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
