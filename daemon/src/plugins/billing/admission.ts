import { type ApiProtocol, GatewayError, protocolFor, valueAt } from '@ohmyapi/protocols';

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

/**
 * 确认结算时能为搜索调用计价：受理时刻生效的规则都需配置本次使用的搜索单价，
 * 避免请求执行后因单价缺失转入人工核对。其余用量的单价由默认规则保证。
 */
export function assertSearchPriced(price: LockedPrice, search: SearchRequest) {
  if (!search.kind) return;
  const matchesTime = ruleTimeMatcher(price.receivedAt);
  const missing = price.rules.some(
    (r) =>
      matchesTime(r) &&
      (search.kind === 'webSearchPreview' ? r.webSearchPreviewPriceMicros : r.webSearchPriceMicros) === null,
  );
  if (missing)
    throw new GatewayError(503, 'search_price_missing', 'Configure the web search price before using search');
}

export function validateBillableRequest(body: Record<string, unknown>, endpoint: Endpoint, outputLimit: number) {
  const protocol = protocolFor(endpoint);
  const { fields, required, minimum: suppliedMinimum } = protocol.request.outputLimit;
  const supplied = fields.filter((field) => valueAt(body, field) != null);
  const defaultOutput = !required && supplied.length === 0;
  if (!defaultOutput && supplied.length !== 1)
    throw new GatewayError(400, 'output_limit_required', `Provide exactly one output limit: ${fields.join(' or ')}`);
  // 缺省上限只记录在价格快照中，上游请求保留缺省值或 null。
  const output = defaultOutput ? outputLimit : valueAt(body, supplied[0]);
  const minimum = defaultOutput ? 1 : suppliedMinimum;
  if (typeof output !== 'number' || !Number.isSafeInteger(output) || output < minimum || output > outputLimit)
    throw new GatewayError(
      400,
      'invalid_output_limit',
      `Output limit must be an integer between ${minimum} and ${outputLimit}`,
    );
  // 多个候选（n、candidateCount）和文件输入的用量都由上游计入报告，按报告结算。
  const { request } = protocol;
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
  // 音视频按其他单价计费，托管工具按次收费，价格规则无法表达。
  const forbidden = new Set(['audio', 'input_audio', 'output_audio', 'video', 'computer_use']);
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
        'Audio, video and hosted tools are not supported for billing',
      );
  }
  return output;
}
