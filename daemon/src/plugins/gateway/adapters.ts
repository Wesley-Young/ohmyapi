import { GatewayError } from '../../core/errors.ts';
import type { CredentialVault } from '../../core/vault.ts';
import { protocolFor, type RequestTarget } from '../../protocols/index.ts';
import type { ChannelType, channels } from '../database/schema/catalog.ts';
import type { Endpoint } from '../database/schema/index.ts';
import { type ForwardResponseOptions, forwardResponse } from './response.ts';

type PrepareRequestOptions = {
  userId: string;
  channel: typeof channels.$inferSelect;
  request: Request;
  endpoint: Endpoint;
  target: RequestTarget;
  /** 会话历史可能产生于其他上游，见 UpstreamContext。 */
  foreignHistory: boolean;
  parsed: Record<string, unknown>;
  bytes: Buffer<ArrayBuffer>;
  vault: CredentialVault;
  signal: AbortSignal;
};

type PreparedRequest = {
  billingBody?: Record<string, unknown>;
  forwardResponse?: (options: ForwardResponseOptions) => Promise<Response>;
  url: string;
  headers: Headers;
  body: Buffer<ArrayBuffer>;
  release?: () => void;
  /** 上游不采用请求中的输出上限时，按模型输出上限预占。 */
  usesModelOutputLimit?: boolean;
  onResponse?: (response: Response) => Promise<void>;
};
/** 订阅渠道由订阅模块实现，网关只依赖这一接口。 */
export interface SubscriptionChannels {
  /** 为绑定订阅账号的渠道提供对应平台的适配器。 */
  adapterFor(channel: typeof channels.$inferSelect): Promise<ChannelAdapter>;
  /** 订阅平台是否支持该端点，用于聚合渠道选择成员。 */
  supportsEndpoint(provider: string, endpoint: Endpoint): boolean;
  /** 订阅账号当前正在执行的请求数。 */
  activeRequests(accountId: string): number;
}

export interface ChannelAdapter {
  prepareRequest(options: PrepareRequestOptions): PreparedRequest | Promise<PreparedRequest>;
  // 适配器负责将上游响应和用量交给统一的请求生命周期及计费收尾。
  forwardResponse(options: ForwardResponseOptions): Promise<Response>;
}

const apiAdapter: ChannelAdapter = {
  prepareRequest({ channel, request, endpoint, target, foreignHistory, parsed, bytes, vault }) {
    if (!channel.baseUrl || !channel.credentialEncrypted)
      throw new GatewayError(503, 'channel_unavailable', 'The API channel connection is not configured');
    const { upstream } = protocolFor(endpoint);
    const body = upstream.body ? upstream.body(parsed, bytes, { foreignHistory }) : bytes;
    const credential = vault.decrypt(channel.credentialEncrypted);
    const headers = upstream.headers(request, credential);
    headers.set('content-type', 'application/json');
    headers.set('accept', target.streaming ? 'text/event-stream' : 'application/json');
    return { url: upstream.url(channel.baseUrl, target), headers, body };
  },
  forwardResponse,
};

const adapters: Record<ChannelType, ChannelAdapter | undefined> = {
  api: apiAdapter,
  subscription: undefined,
  aggregate: undefined,
};

export async function channelAdapter(
  channel: typeof channels.$inferSelect,
  subscriptions: SubscriptionChannels,
): Promise<ChannelAdapter> {
  const type = channel.type;
  if (type === 'subscription') return subscriptions.adapterFor(channel);
  const adapter = adapters[type];
  if (!adapter) throw new GatewayError(503, 'channel_type_unsupported', 'This channel type is not available yet');
  return adapter;
}
