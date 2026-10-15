import { GatewayError } from '../../../core/errors.ts';
import { codexRequestHeaders } from '../../../protocols/index.ts';
import type { ChannelAdapter } from '../../gateway/adapters.ts';
import type { SubscriptionRuntime } from '../runtime.ts';
import { accountHeaders, codexBaseUrl } from './client.ts';
import { prepareBody } from './request.ts';
import { forwardOpenAIResponse } from './response.ts';
import { prepareSession } from './session.ts';

export function openAIAdapter(service: SubscriptionRuntime): ChannelAdapter {
  return {
    async prepareRequest({ channel, endpoint, parsed, request, signal }) {
      const body = prepareBody(parsed, endpoint);
      if (!channel.subscriptionAccountId)
        throw new GatewayError(503, 'subscription_unavailable', 'Bind a subscription account first');
      const sessionHeaders = codexRequestHeaders(request);
      prepareSession(sessionHeaders, body, parsed, request, channel.id, endpoint);
      const id = channel.subscriptionAccountId;
      const lease = await service.acquire(id, signal);
      if (signal.aborted) {
        lease.release();
        throw new GatewayError(400, 'request_cancelled', 'Request was cancelled before forwarding');
      }
      const headers = accountHeaders(
        lease.credentials,
        endpoint === '/v1/responses/compact' ? 'application/json' : 'text/event-stream',
      );
      for (const [name, value] of sessionHeaders) headers.set(name, value);
      return {
        url: `${codexBaseUrl}${endpoint === '/v1/responses/compact' ? '/responses/compact' : '/responses'}`,
        headers,
        body: Buffer.from(JSON.stringify(body)),
        release: lease.release,
        // Codex 不接受请求中的输出上限，按模型上限预占。
        usesModelOutputLimit: true,
        onResponse: (response) =>
          service.reportStatus(id, response.status, response.headers, lease.credentials.accessToken),
      };
    },
    forwardResponse: forwardOpenAIResponse,
  };
}
