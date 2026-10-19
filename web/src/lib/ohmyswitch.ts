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

/** 运行 oms 命令的终端。 */
export const omsShells = [
  { id: 'posix', label: 'macOS / Linux' },
  { id: 'powershell', label: 'PowerShell' },
] as const;

export type OmsShell = (typeof omsShells)[number]['id'];

/** 按浏览器所在的系统选择终端：Windows 用 PowerShell，其余用 POSIX shell。 */
export const defaultOmsShell = (): OmsShell => (navigator.userAgent.includes('Windows') ? 'powershell' : 'posix');

/** POSIX shell 中的一个词：只含安全字符时原样保留，否则用单引号括起。 */
const posixWord = (value: string) =>
  /^[\w@+:,./-][\w@+=:,./-]*$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * PowerShell 中的一个参数：只含字母、数字和 `_=-` 时原样保留，否则整体用单引号括起。含 `.` 的裸词会被
 * PowerShell 拆开传给外部程序，所以也要括起。PowerShell 把弯单引号也当作单引号，同样需要双写转义。
 */
const powershellQuote = (value: string) => `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`;
const powershellWord = (value: string) => (/^[\w=-]+$/.test(value) ? value : powershellQuote(value));

/**
 * Windows PowerShell 5.1 把参数传给外部程序时不转义其中的 `"`，参数末尾的 `\` 也会吞掉补上的引号，
 * 含这些字符的值无法原样传给 oms。
 */
const powershellPassable = (value: string) => !value.includes('"') && !value.endsWith('\\');

/** Windows 进程命令行的长度上限是 32767 个字符，留出 node 和 oms 路径的余量。 */
const maxWindowsCommandLength = 30_000;

export type OmsCommand = { command: string } | { error: 'unpassable-name' | 'too-long' };

/**
 * 生成添加供应商的 oms 命令。oms 不接受命令行上的 API Key，所以 Key 经标准输入传入；
 * 参数一律写成 `--flag=value`，值以 `-` 开头时也能正确解析。
 */
export function buildOmsCommand(provider: OhmyswitchProvider, shell: OmsShell): OmsCommand {
  const name = provider.name.trim();
  const options: [flag: string, value?: string][] = [
    ['--name', name],
    ['--base-url', provider.baseUrl],
    ['--endpoint', cliEndpointNames[provider.endpoint]],
    ['--api-key-stdin'],
    ['--icon-url', provider.iconUrl],
    ...provider.models.map((model): [string, string] => ['--model', model]),
  ];
  if (shell === 'posix') {
    const words = options.map(([flag, value]) => (value === undefined ? flag : `${flag}=${posixWord(value)}`));
    return { command: `printf '%s' ${posixWord(provider.apiKey)} | oms provider add ${words.join(' ')}` };
  }
  if (!powershellPassable(name)) return { error: 'unpassable-name' };
  const words = options.map(([flag, value]) => powershellWord(value === undefined ? flag : `${flag}=${value}`));
  // A bare word at the start would run as a command, so the piped key is always quoted.
  const command = `${powershellQuote(provider.apiKey)} | oms provider add ${words.join(' ')}`;
  return command.length > maxWindowsCommandLength ? { error: 'too-long' } : { command };
}
