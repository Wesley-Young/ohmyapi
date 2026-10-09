import type { ChannelAdapter } from '../../gateway/adapters.js';
import { GatewayError } from '../../gateway/errors.js';
import type { SubscriptionService } from '../service.js';
import { accountHeaders, codexBaseUrl } from './client.js';
import { prepareBody } from './request.js';
import { forwardOpenAIResponse } from './response.js';

import { createHash } from 'node:crypto';

export function openAIAdapter(service: SubscriptionService): ChannelAdapter {
  return {
    async prepareRequest({ channel, endpoint, parsed, request, signal }) {
      const body = prepareBody(parsed, endpoint);
      if (typeof body.prompt_cache_key === 'string')
        body.prompt_cache_key = createHash('sha256')
          .update(`${channel.id}:${request.headers.get('authorization')}:${body.prompt_cache_key}`)
          .digest('hex');
      if (!channel.subscriptionAccountId)
        throw new GatewayError(503, 'subscription_unavailable', 'Bind a subscription account first');
      const id = channel.subscriptionAccountId;
      const lease = await service.acquire(id, signal);
      if (signal.aborted) {
        lease.release();
        throw new GatewayError(400, 'request_cancelled', 'Request was cancelled before forwarding');
      }
      return {
        url: `${codexBaseUrl}${endpoint === '/v1/responses/compact' ? '/responses/compact' : '/responses'}`,
        headers: accountHeaders(lease.credentials),
        body: Buffer.from(JSON.stringify(body)),
        release: lease.release,
        onResponse: (response) =>
          service.reportStatus(id, response.status, response.headers, lease.credentials.accessToken),
      };
    },
    forwardResponse: forwardOpenAIResponse,
  };
}
