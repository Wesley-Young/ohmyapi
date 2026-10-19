import type { Endpoint } from './endpoints';

/**
 * ohmyswitch 能导入的端点，按推荐顺序排列。ohmyswitch 把供应商应用到开源 Harness，不涉及 Claude Code，
 * 所以 Messages 也可以使用，并且排在最前；DeepSeek Harness 不支持 Gemini，排在最后。
 */
const ohmyswitchEndpoints = [
  '/v1/messages',
  '/v1/responses',
  '/v1/chat/completions',
  '/v1beta/generateContent',
] as const satisfies readonly Endpoint[];

export type OhmyswitchEndpoint = (typeof ohmyswitchEndpoints)[number];

/** 渠道提供的端点中 ohmyswitch 能导入的部分，按推荐顺序排列。 */
export const ohmyswitchEndpointsOf = (endpoints: readonly Endpoint[]) =>
  ohmyswitchEndpoints.filter((endpoint) => endpoints.includes(endpoint));

export interface OhmyswitchProvider {
  name: string;
  /** 接入点的根地址，不带末尾斜杠。 */
  baseUrl: string;
  /** 选用的端点。 */
  endpoint: OhmyswitchEndpoint;
  /** 渠道提供的全部可导入端点，按推荐顺序排列。 */
  endpoints: readonly OhmyswitchEndpoint[];
  apiKey: string;
  /** 取图标的网页地址。 */
  iconUrl: string;
  models: readonly string[];
}

/** ohmyswitch 接受的链接长度上限。 */
const maxLinkLength = 64 * 1024;

/**
 * 生成 `ohmyswitch://provider/import` 链接；超出长度上限时返回 undefined。
 * 选用的端点排在第一个，ohmyswitch 的导入页默认选中它，其余端点仍可在导入页中改选。
 */
export function buildOhmyswitchUrl(provider: OhmyswitchProvider) {
  const params = new URLSearchParams({ name: provider.name.trim(), baseUrl: provider.baseUrl });
  for (const endpoint of [provider.endpoint, ...provider.endpoints.filter((item) => item !== provider.endpoint)])
    params.append('endpoint', endpoint);
  params.set('apiKey', provider.apiKey);
  params.set('iconUrl', provider.iconUrl);
  for (const model of provider.models) params.append('model', model);
  const url = `ohmyswitch://provider/import?${params.toString()}`;
  return url.length <= maxLinkLength ? url : undefined;
}

/** oms 命令行中端点的简写。 */
const cliEndpointNames = {
  '/v1/messages': 'messages',
  '/v1/responses': 'responses',
  '/v1/chat/completions': 'chat',
  '/v1beta/generateContent': 'gemini',
} satisfies Record<OhmyswitchEndpoint, string>;

/** POSIX shell 中的一个词：只含安全字符时原样保留，否则用单引号括起。 */
const shellWord = (value: string) =>
  /^[\w@+:,./-][\w@+=:,./-]*$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * 生成 POSIX shell 中添加供应商的 oms 命令。oms 不接受命令行上的 API Key，所以 Key 经标准输入传入；
 * 参数一律写成 `--flag=value`，值以 `-` 开头时也能正确解析。
 */
export function buildOmsCommand(provider: OhmyswitchProvider) {
  const options = [
    `--name=${shellWord(provider.name.trim())}`,
    `--base-url=${shellWord(provider.baseUrl)}`,
    `--endpoint=${cliEndpointNames[provider.endpoint]}`,
    '--api-key-stdin',
    `--icon-url=${shellWord(provider.iconUrl)}`,
    ...provider.models.map((model) => `--model=${shellWord(model)}`),
  ];
  return `printf '%s' ${shellWord(provider.apiKey)} | oms provider add ${options.join(' ')}`;
}
