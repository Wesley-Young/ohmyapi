import type { Endpoint } from '../../catalog/service.js';
import { GatewayError } from '../../gateway/errors.js';

import { createHash } from 'node:crypto';

export const openAIEndpoints = ['/v1/responses', '/v1/responses/compact'] as const;

const removedResponseFields = [
  'max_output_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'metadata',
  'user',
  'prompt_cache_retention',
  'safety_identifier',
  'stream_options',
  'truncation',
] as const;

export function supportsAggregateRequest(body: Record<string, unknown>, endpoint: Endpoint) {
  if (endpoint === '/v1/responses/compact')
    return (
      Object.keys(body).every((key) => ['model', 'input', 'instructions', 'stream'].includes(key)) &&
      body.stream !== true
    );
  return (
    endpoint === '/v1/responses' &&
    body.store !== true &&
    removedResponseFields.every((field) => body[field] === undefined || body[field] === null)
  );
}

export function prepareBody(parsed: Record<string, unknown>, endpoint: Endpoint) {
  if (!openAIEndpoints.some((value) => value === endpoint))
    throw new GatewayError(
      400,
      'subscription_endpoint_unsupported',
      'OpenAI subscriptions support Responses and compact only',
    );
  const body = structuredClone(parsed);
  if (typeof body.input === 'string') body.input = [{ role: 'user', content: body.input }];
  if (!Array.isArray(body.input)) throw new GatewayError(400, 'invalid_request', 'input must be a string or an array');
  for (const item of body.input) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new GatewayError(400, 'invalid_request', 'Each input item must be an object');
    if (item.type === 'item_reference')
      throw new GatewayError(
        400,
        'unsupported_billing_mode',
        'Send full input items instead of stored item references',
      );
    if (['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(item.type)) {
      const id = item.call_id ?? item.id;
      if (typeof id !== 'string' || !id) throw new GatewayError(400, 'invalid_request', 'Tool calls require call_id');
      const prefix = item.type.startsWith('custom_') ? 'ctc_' : 'fc_';
      const normalized = id.startsWith(prefix) ? id : `${prefix}${id.replace(/^call_/, '')}`;
      item.call_id =
        normalized.length <= 64 ? normalized : `${prefix}${createHash('sha256').update(id).digest('hex').slice(0, 60)}`;
    }
    // store=false 的多轮请求保留完整内容和加密上下文，移除会触发服务端查找的 ID。
    delete item.id;
    if (item.type === 'reasoning') {
      delete item.call_id;
      item.summary ??= [];
    }
  }
  if (body.instructions != null && typeof body.instructions !== 'string')
    throw new GatewayError(400, 'invalid_request', 'instructions must be a string');
  if (endpoint === '/v1/responses/compact') {
    if (body.stream === true || body.tools != null)
      throw new GatewayError(400, 'invalid_request', 'compact does not accept streaming or tools');
    const allowed = new Set(['model', 'input', 'instructions']);
    for (const key of Object.keys(body)) if (!allowed.has(key)) delete body[key];
    return body;
  }
  body.store = false;
  body.stream = true;
  for (const field of removedResponseFields) delete body[field];
  const instructions: string[] = [];
  for (const item of body.input as Record<string, unknown>[]) {
    if (!item || typeof item !== 'object' || item.role !== 'system') continue;
    if (typeof item.content === 'string') instructions.push(item.content);
    else if (Array.isArray(item.content))
      for (const block of item.content) if (typeof block?.text === 'string') instructions.push(block.text);
    item.role = 'developer';
  }
  body.instructions = [...instructions, body.instructions ?? ''].filter(Boolean).join('\n\n');
  if (body.include != null && (!Array.isArray(body.include) || body.include.some((value) => typeof value !== 'string')))
    throw new GatewayError(400, 'invalid_request', 'include must be an array of strings');
  body.include = [...new Set([...((body.include as string[] | undefined) ?? []), 'reasoning.encrypted_content'])];
  return body;
}
