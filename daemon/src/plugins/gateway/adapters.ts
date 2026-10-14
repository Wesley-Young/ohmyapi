import { GatewayError } from '../../core/errors.js';
import type { CredentialVault } from '../../core/vault.js';
import type { ChannelType, channels } from '../database/schema/catalog.js';
import type { Endpoint } from '../database/schema/index.js';
import { upstreamBody, upstreamHeaders, upstreamUrl } from './protocol.js';
import { type ForwardResponseOptions, forwardResponse } from './response.js';

type PrepareRequestOptions = {
  userId: string;
  channel: typeof channels.$inferSelect;
  request: Request;
  endpoint: Endpoint;
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
  prepareRequest({ channel, request, endpoint, parsed, bytes, vault }) {
    if (!channel.baseUrl || !channel.credentialEncrypted)
      throw new GatewayError(503, 'channel_unavailable', 'The API channel connection is not configured');
    const body = upstreamBody(endpoint, parsed, bytes);
    const credential = vault.decrypt(channel.credentialEncrypted);
    return {
      url: upstreamUrl(channel.baseUrl, endpoint),
      headers: upstreamHeaders(request, endpoint, parsed.stream === true, credential),
      body,
    };
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
