import { GatewayError } from '../../core/errors.js';
import type { CredentialVault } from '../../core/vault.js';
import type { Endpoint } from '../catalog/service.js';
import type { ChannelType, channels } from '../database/schema/catalog.js';
import { claudeAdapter } from '../subscription/claude/adapter.js';
import { openAIAdapter } from '../subscription/openai/adapter.js';
import type { SubscriptionService } from '../subscription/service.js';
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
  subscription: SubscriptionService,
): Promise<ChannelAdapter> {
  const type = channel.type;
  if (type === 'subscription') {
    if (!channel.subscriptionAccountId)
      throw new GatewayError(503, 'subscription_unavailable', 'Bind a subscription account first');
    const provider = await subscription.provider(channel.subscriptionAccountId);
    if (provider === 'claude') return claudeAdapter(subscription);
    if (provider === 'openai') return openAIAdapter(subscription);
    throw new GatewayError(503, 'subscription_unavailable', 'Unsupported subscription provider');
  }
  const adapter = adapters[type];
  if (!adapter) throw new GatewayError(503, 'channel_type_unsupported', 'This channel type is not available yet');
  return adapter;
}
