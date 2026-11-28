import { type Endpoint, GatewayError, protocolFor } from '@ohmyapi/protocols';

import type { ChannelAdapter } from '../../gateway/adapters.ts';
import { forwardResponse } from '../../gateway/response.ts';
import type { SubscriptionRuntime } from '../runtime.ts';

const urls: Partial<Record<Endpoint, string>> = {
  '/v1/responses': 'https://open.bigmodel.cn/api/v1/responses',
  '/v1/chat/completions': 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
  '/v1/messages': 'https://open.bigmodel.cn/api/anthropic/v1/messages',
};

export function zhipuAdapter(runtime: SubscriptionRuntime): ChannelAdapter {
  return {
    async prepareRequest({ channel, endpoint, request, parsed, bytes, foreignHistory, target, signal, reservation }) {
      const url = urls[endpoint];
      if (!url) throw new GatewayError(400, 'subscription_endpoint_unsupported', 'Unsupported Zhipu endpoint');
      const id = channel.subscriptionAccountId;
      if (!id) throw new GatewayError(503, 'subscription_unavailable', 'Bind a subscription account first');
      const account = await runtime.zhipuAccount(id);
      if (account.errorCode) throw new GatewayError(503, 'subscription_unavailable', 'Replace the Zhipu API key');
      if (account.cooldownUntil && account.cooldownUntil.getTime() > Date.now())
        throw new GatewayError(429, 'subscription_rate_limited', 'The subscription account is cooling down');
      if (signal.aborted) throw new GatewayError(400, 'request_cancelled', 'Request cancelled before forwarding');
      const { upstream } = protocolFor(endpoint);
      const body = upstream.body ? upstream.body(parsed, bytes, { foreignHistory }) : bytes;
      const headers = upstream.headers(request, account.apiKey);
      headers.delete('x-api-key');
      headers.set('authorization', `Bearer ${account.apiKey}`);
      headers.set('content-type', 'application/json');
      headers.set('accept', target.streaming ? 'text/event-stream' : 'application/json');
      return {
        url,
        headers,
        body,
        release: reservation ?? runtime.concurrency.acquire(id, account.maximum),
        onResponse: (response) =>
          runtime.reportCredentialStatus(
            id,
            account.encrypted,
            response.status,
            response.headers,
            'subscription_api_key_invalid',
          ),
      };
    },
    forwardResponse,
  };
}
