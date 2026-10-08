import type { Endpoint } from '../catalog/service.js';
import { GatewayError } from '../gateway/errors.js';
import { ruleTimeMatcher } from '../pricing/rules.js';
import type { LockedPrice } from '../pricing/service.js';
import { imageInputTypes, requestContentBlocks } from './content.js';
import { type SearchRequest, searchRequest, searchToolKind } from './search.js';

function isBillableTool(value: unknown, endpoint: Endpoint): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const tool = value as Record<string, unknown>;
  if (tool.type === 'function' || tool.type === 'custom') return true;
  if (searchToolKind(tool, endpoint)) return true;
  if (endpoint === '/v1/responses' && tool.type === 'namespace')
    return (
      typeof tool.name === 'string' &&
      tool.name.length > 0 &&
      Array.isArray(tool.tools) &&
      tool.tools.every(
        (child) =>
          child &&
          typeof child === 'object' &&
          !Array.isArray(child) &&
          (child.type === 'function' || child.type === 'custom'),
      )
    );
  return (
    endpoint === '/v1/messages' &&
    tool.type === undefined &&
    typeof tool.name === 'string' &&
    Boolean(tool.input_schema) &&
    typeof tool.input_schema === 'object'
  );
}

/** Reserve against estimated usage and the most expensive reachable rule at receipt. */
export function reservationAmount(
  price: LockedPrice,
  inputTokens: number,
  outputTokens: number,
  search: SearchRequest,
) {
  let numerator = 0n;
  const matchesTime = ruleTimeMatcher(price.receivedAt);
  for (const r of price.rules.filter(matchesTime)) {
    if (r.contextMin !== null && r.contextMin > BigInt(inputTokens)) continue;
    let inputPrice = 0n;
    for (const p of [r.inputPriceMicros, r.cacheReadPriceMicros, r.cacheWritePriceMicros])
      if (p !== null && p > inputPrice) inputPrice = p;
    const searchPrice = search.kind === 'webSearchPreview' ? r.webSearchPreviewPriceMicros : r.webSearchPriceMicros;
    if (search.kind && searchPrice === null)
      throw new GatewayError(503, 'search_price_missing', 'Configure the web search price before using search');
    const candidate =
      (BigInt(inputTokens) * inputPrice +
        BigInt(outputTokens) * r.outputPriceMicros +
        BigInt(search.estimatedCalls) * (searchPrice ?? 0n) * 1000n) *
      price.multiplierMicros;
    if (candidate > numerator) numerator = candidate;
  }
  const amount = (numerator + 999_999_999_999n) / 1_000_000_000_000n;
  if (amount > 9_223_372_036_854_775_807n)
    throw new GatewayError(400, 'reservation_overflow', 'The configured reservation exceeds the supported amount');
  return amount;
}

export function validateBillableRequest(body: Record<string, unknown>, endpoint: Endpoint, outputLimit: number) {
  const fields =
    endpoint === '/v1/responses'
      ? ['max_output_tokens']
      : endpoint === '/v1/messages'
        ? ['max_tokens']
        : ['max_completion_tokens', 'max_tokens'];
  const supplied = fields.filter((field) => body[field] != null);
  const defaultOutput = endpoint !== '/v1/messages' && supplied.length === 0;
  if (!defaultOutput && supplied.length !== 1)
    throw new GatewayError(400, 'output_limit_required', `Provide exactly one output limit: ${fields.join(' or ')}`);
  // 缺省上限只用于预占估算，保留上游请求中的缺省值或 null。
  const output = defaultOutput ? outputLimit : body[supplied[0]];
  const minimum = endpoint === '/v1/responses' && !defaultOutput ? 16 : 1;
  if (typeof output !== 'number' || !Number.isSafeInteger(output) || output < minimum || output > outputLimit)
    throw new GatewayError(
      400,
      'invalid_output_limit',
      `Output limit must be an integer between ${minimum} and ${outputLimit}`,
    );
  if (body.n !== undefined && body.n !== 1)
    throw new GatewayError(400, 'unsupported_billing_mode', 'Only one completion per request is supported');
  searchRequest(body, endpoint);
  for (const field of ['previous_response_id', 'conversation', 'prompt', 'audio', 'prediction'])
    if (body[field] !== undefined && body[field] !== null)
      throw new GatewayError(400, 'unsupported_billing_mode', `${field} is not supported for billing`);
  if (body.modalities !== undefined && (!Array.isArray(body.modalities) || body.modalities.some((m) => m !== 'text')))
    throw new GatewayError(400, 'unsupported_billing_mode', 'Only text modalities are supported');
  if (body.tools !== undefined && body.tools !== null && !Array.isArray(body.tools))
    throw new GatewayError(400, 'invalid_request', 'tools must be an array');
  if (Array.isArray(body.tools) && body.tools.some((tool) => !isBillableTool(tool, endpoint)))
    throw new GatewayError(
      400,
      'unsupported_billing_mode',
      'Only client tools and web search tools are supported for billing',
    );
  const forbidden = new Set([
    'audio',
    'input_audio',
    'output_audio',
    'file',
    'input_file',
    'document',
    'video',
    'computer_use',
  ]);
  if (endpoint !== '/v1/responses' && Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (message && typeof message === 'object' && !Array.isArray(message) && message.audio != null)
        throw new GatewayError(400, 'unsupported_billing_mode', 'Audio messages are not supported for billing');
    }
  }
  // 按协议检查消息、内容块和工具结果，schema、examples 与业务数据保持原样。
  for (const object of requestContentBlocks(body, endpoint)) {
    if (
      ['image', 'image_url', 'input_image'].includes(String(object.type)) &&
      object.type !== imageInputTypes[endpoint]
    )
      throw new GatewayError(
        400,
        'invalid_request',
        `Use ${imageInputTypes[endpoint]} for image inputs on ${endpoint}`,
      );
    if (
      (typeof object.type === 'string' && forbidden.has(object.type)) ||
      (object.type === 'server_tool_use' && (endpoint !== '/v1/messages' || object.name !== 'web_search')) ||
      (object.type === 'web_search_tool_result' && endpoint !== '/v1/messages')
    )
      throw new GatewayError(
        400,
        'unsupported_billing_mode',
        'Audio, files, video and hosted tools are not supported for billing',
      );
  }
  return output;
}
