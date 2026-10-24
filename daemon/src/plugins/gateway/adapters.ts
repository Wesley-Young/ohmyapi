import { GatewayError, protocolFor, type RequestTarget } from '@ohmyapi/protocols';

import type { CredentialVault } from '../../core/vault.ts';
import type { ChannelType, channels } from '../database/schema/catalog.ts';
import type { Endpoint } from '../database/schema/index.ts';
import { type ForwardResponseOptions, forwardResponse } from './response.ts';

type PrepareRequestOptions = {
  userId: string;
  channel: typeof channels.$inferSelect;
  request: Request;
  endpoint: Endpoint;
  target: RequestTarget;
  /** 会话历史开头产生于其他上游的条数，见 UpstreamContext。 */
  foreignHistory: number;
  parsed: Record<string, unknown>;
  bytes: Buffer<ArrayBuffer>;
  vault: CredentialVault;
  signal: AbortSignal;
  /** 聚合渠道选择订阅成员时已占用的账号并发名额，适配器用它代替重新占用；重复释放没有副作用，网关在请求结束时也会释放。 */
  reservation?: () => void;
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
  /** 未达并发上限时同步占用订阅账号的一个名额，返回释放函数；已满或服务停止时返回 undefined。 */
  reserve(accountId: string, maximum: number): (() => void) | undefined;
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
