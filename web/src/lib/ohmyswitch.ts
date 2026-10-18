import type { Endpoint } from './endpoints';

/**
 * ohmyswitch 能导入的端点，按推荐顺序排列，导入页默认选第一个。ohmyswitch 把供应商应用到开源 Harness，
 * 不涉及 Claude Code，所以 Messages 也可以使用。Responses 和 Messages 原生支持推理和工具调用，排在前面；
 * Chat Completions 兼容面最广，作为退路；DeepSeek Harness 不支持 Gemini，排在最后。
 */
const ohmyswitchEndpoints = [
  '/v1/responses',
  '/v1/messages',
  '/v1/chat/completions',
  '/v1beta/generateContent',
] as const satisfies readonly Endpoint[];

/** 渠道提供的端点中 ohmyswitch 能导入的部分，按推荐顺序排列。 */
export const ohmyswitchEndpointsOf = (endpoints: readonly Endpoint[]) =>
  ohmyswitchEndpoints.filter((endpoint) => endpoints.includes(endpoint));

/** ohmyswitch 接受的链接长度上限。 */
const maxLinkLength = 64 * 1024;

/** 生成 `ohmyswitch://provider/import` 链接；超出长度上限时返回 undefined。 */
export function buildOhmyswitchUrl(input: {
  name: string;
  /** 接入点的根地址，不带末尾斜杠。 */
  baseUrl: string;
  endpoints: readonly Endpoint[];
  apiKey: string;
  /** 取图标的网页地址。 */
  iconUrl: string;
  models: readonly string[];
}) {
  const params = new URLSearchParams({ name: input.name.trim(), baseUrl: input.baseUrl });
  for (const endpoint of ohmyswitchEndpointsOf(input.endpoints)) params.append('endpoint', endpoint);
  params.set('apiKey', input.apiKey);
  params.set('iconUrl', input.iconUrl);
  for (const model of input.models) params.append('model', model);
  const url = `ohmyswitch://provider/import?${params.toString()}`;
  return url.length <= maxLinkLength ? url : undefined;
}
