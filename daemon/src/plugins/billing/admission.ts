import { GatewayError } from '../../core/errors.ts';
import { type ApiProtocol, protocolFor, valueAt } from '../../protocols/index.ts';
import type { Endpoint } from '../database/schema/index.ts';
import { matchRule } from '../pricing/rules.ts';
import type { LockedPrice } from '../pricing/service.ts';
import { requestContentBlocks } from './content.ts';
import { type SearchRequest, searchRequest } from './search.ts';

/** 计费只支持客户端执行的工具和按次计价的搜索工具。 */
function isBillableTool(value: unknown, protocol: ApiProtocol): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return protocol.request.toolKind(value as Record<string, unknown>) !== undefined;
}

/** 预占采用的预期用量，见 ReservationEstimate。 */
export type ReservationUsage = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
};

/**
 * 按预期用量和结算时会命中的规则计算预占。不加余量，实际费用可以超过预占。
 * 未配置的缓存单价按输入单价估算；使用搜索时按一次调用估算。
 */
export function reservationAmount(price: LockedPrice, usage: ReservationUsage, search: SearchRequest) {
  const context = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const r = matchRule(price.rules, price.receivedAt, BigInt(context));
  if (!r) throw new GatewayError(503, 'price_missing', 'No price rule matches this request');
  const searchPrice = search.kind === 'webSearchPreview' ? r.webSearchPreviewPriceMicros : r.webSearchPriceMicros;
  if (search.kind && searchPrice === null)
    throw new GatewayError(503, 'search_price_missing', 'Configure the web search price before using search');
  const searchCalls = search.kind ? BigInt(Math.min(search.estimatedCalls, 1)) : 0n;
  const numerator =
    (BigInt(usage.inputTokens) * r.inputPriceMicros +
      BigInt(usage.cacheReadTokens) * (r.cacheReadPriceMicros ?? r.inputPriceMicros) +
      BigInt(usage.cacheWriteTokens) * (r.cacheWritePriceMicros ?? r.inputPriceMicros) +
      BigInt(usage.outputTokens) * r.outputPriceMicros +
      searchCalls * (searchPrice ?? 0n) * 1000n) *
    price.multiplierMicros;
  const amount = (numerator + 999_999_999_999n) / 1_000_000_000_000n;
  if (amount > 9_223_372_036_854_775_807n)
    throw new GatewayError(400, 'reservation_overflow', 'The configured reservation exceeds the supported amount');
  return amount;
}

export function validateBillableRequest(body: Record<string, unknown>, endpoint: Endpoint, outputLimit: number) {
  const protocol = protocolFor(endpoint);
  const { fields, required, minimum: suppliedMinimum } = protocol.request.outputLimit;
  const supplied = fields.filter((field) => valueAt(body, field) != null);
  const defaultOutput = !required && supplied.length === 0;
  if (!defaultOutput && supplied.length !== 1)
    throw new GatewayError(400, 'output_limit_required', `Provide exactly one output limit: ${fields.join(' or ')}`);
  // 缺省上限只用于预占估算，保留上游请求中的缺省值或 null。
  const output = defaultOutput ? outputLimit : valueAt(body, supplied[0]);
  const minimum = defaultOutput ? 1 : suppliedMinimum;
  if (typeof output !== 'number' || !Number.isSafeInteger(output) || output < minimum || output > outputLimit)
    throw new GatewayError(
      400,
      'invalid_output_limit',
      `Output limit must be an integer between ${minimum} and ${outputLimit}`,
    );
  const { request } = protocol;
  const choices = request.choiceCount ? request.choiceCount(body) : body.n;
  if (choices !== undefined && choices !== 1)
    throw new GatewayError(400, 'unsupported_billing_mode', 'Only one completion per request is supported');
  searchRequest(body, endpoint);
  for (const field of ['previous_response_id', 'conversation', 'prompt', 'audio', 'prediction'])
    if (body[field] !== undefined && body[field] !== null)
      throw new GatewayError(400, 'unsupported_billing_mode', `${field} is not supported for billing`);
  const modalities = request.outputModalities ? request.outputModalities(body) : body.modalities;
  if (modalities !== undefined && (!Array.isArray(modalities) || modalities.some((m) => m !== 'text')))
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
  if (request.messages(body).some((message) => message.audio != null))
    throw new GatewayError(400, 'unsupported_billing_mode', 'Audio messages are not supported for billing');
  // 按协议检查消息、内容块和工具结果，schema、examples 与业务数据保持原样。
  const { imageType, serverSearchBlock } = request;
  for (const object of requestContentBlocks(body, endpoint)) {
    const type = request.blockType ? request.blockType(object) : object.type;
    if (['image', 'image_url', 'input_image'].includes(String(type)) && type !== imageType)
      throw new GatewayError(400, 'invalid_request', `Use ${imageType} for image inputs on ${endpoint}`);
    if (
      (typeof type === 'string' && forbidden.has(type)) ||
      ((type === 'server_tool_use' || type === 'web_search_tool_result') && !serverSearchBlock?.(object))
    )
      throw new GatewayError(
        400,
        'unsupported_billing_mode',
        'Audio, files, video and hosted tools are not supported for billing',
      );
  }
  return output;
}
