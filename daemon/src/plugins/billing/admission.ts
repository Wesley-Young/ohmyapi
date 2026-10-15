import { GatewayError } from '../../core/errors.ts';
import { type ApiProtocol, protocolFor } from '../../protocols/index.ts';
import type { Endpoint } from '../database/schema/index.ts';
import { ruleTimeMatcher } from '../pricing/rules.ts';
import type { LockedPrice } from '../pricing/service.ts';
import { requestContentBlocks } from './content.ts';
import { type SearchRequest, searchRequest } from './search.ts';

/** 计费只支持客户端执行的工具和按次计价的搜索工具。 */
function isBillableTool(value: unknown, protocol: ApiProtocol): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return protocol.request.toolKind(value as Record<string, unknown>) !== undefined;
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
  const protocol = protocolFor(endpoint);
  const { fields, required, minimum: suppliedMinimum } = protocol.request.outputLimit;
  const supplied = fields.filter((field) => body[field] != null);
  const defaultOutput = !required && supplied.length === 0;
  if (!defaultOutput && supplied.length !== 1)
    throw new GatewayError(400, 'output_limit_required', `Provide exactly one output limit: ${fields.join(' or ')}`);
  // 缺省上限只用于预占估算，保留上游请求中的缺省值或 null。
  const output = defaultOutput ? outputLimit : body[supplied[0]];
  const minimum = defaultOutput ? 1 : suppliedMinimum;
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
  if (Array.isArray(body.tools) && body.tools.some((tool) => !isBillableTool(tool, protocol)))
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
  if (protocol.request.messages(body).some((message) => message.audio != null))
    throw new GatewayError(400, 'unsupported_billing_mode', 'Audio messages are not supported for billing');
  // 按协议检查消息、内容块和工具结果，schema、examples 与业务数据保持原样。
  const { imageType, serverSearchBlock } = protocol.request;
  for (const object of requestContentBlocks(body, endpoint)) {
    if (['image', 'image_url', 'input_image'].includes(String(object.type)) && object.type !== imageType)
      throw new GatewayError(400, 'invalid_request', `Use ${imageType} for image inputs on ${endpoint}`);
    if (
      (typeof object.type === 'string' && forbidden.has(object.type)) ||
      ((object.type === 'server_tool_use' || object.type === 'web_search_tool_result') && !serverSearchBlock?.(object))
    )
      throw new GatewayError(
        400,
        'unsupported_billing_mode',
        'Audio, files, video and hosted tools are not supported for billing',
      );
  }
  return output;
}
