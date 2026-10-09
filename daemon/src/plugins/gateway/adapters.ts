import type { ChannelType } from '../catalog/channel-types.js';
import type { CredentialVault, Endpoint } from '../catalog/service.js';
import type { channels } from '../database/schema/catalog.js';
import { openAIAdapter } from '../subscription/openai/adapter.js';
import type { SubscriptionService } from '../subscription/service.js';
import { GatewayError } from './errors.js';
import { upstreamBody, upstreamHeaders, upstreamUrl } from './protocol.js';
import { type ForwardResponseOptions, forwardResponse } from './response.js';

type PrepareRequestOptions = {
  channel: typeof channels.$inferSelect;
  request: Request;
  endpoint: Endpoint;
  parsed: Record<string, unknown>;
  bytes: Buffer<ArrayBuffer>;
  vault: CredentialVault;
  signal: AbortSignal;
};

type PreparedRequest = {
  url: string;
  headers: Headers;
  body: Buffer<ArrayBuffer>;
  release?: () => void;
  onResponse?: (response: Response) => Promise<void>;
};
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

export function channelAdapter(type: ChannelType, subscription: SubscriptionService): ChannelAdapter {
  if (type === 'subscription') return openAIAdapter(subscription);
  const adapter = adapters[type];
  if (!adapter) throw new GatewayError(503, 'channel_type_unsupported', 'This channel type is not available yet');
  return adapter;
}
