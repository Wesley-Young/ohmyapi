import type { ChannelAdapter } from '../../gateway/adapters.js';
import { GatewayError } from '../../gateway/errors.js';
import { forwardResponse } from '../../gateway/response.js';
import type { SubscriptionService } from '../service.js';
import { claudeBaseUrl } from './client.js';
import { prepareClaudeRequest, validateClaudeRequest } from './request.js';
import { forwardClaudeResponse } from './response.js';

export function claudeAdapter(service: SubscriptionService): ChannelAdapter {
  return {
    async prepareRequest({ channel, endpoint, parsed, request, signal, vault, userId }) {
      if (endpoint !== '/v1/messages')
        throw new GatewayError(400, 'subscription_endpoint_unsupported', 'Claude subscriptions support Messages only');
      validateClaudeRequest(parsed);
      const id = channel.subscriptionAccountId;
      if (!id) throw new GatewayError(503, 'subscription_unavailable', 'Bind a Claude subscription account first');
      const proxy = channel.proxyUrlEncrypted ? vault.decrypt(channel.proxyUrlEncrypted) : null;
      const lease = await service.acquireClaude(id, signal, String(parsed.model), proxy);
      try {
        const session = service.claudeSessions.begin(id, userId, channel.id, request, parsed);
        const prepared = await prepareClaudeRequest(parsed, request, lease.credentials, session, `${id}:${userId}`);
        if (signal.aborted) throw new GatewayError(400, 'request_cancelled', 'Request cancelled before forwarding');
        return {
          url: `${claudeBaseUrl}/v1/messages?beta=true`,
          headers: prepared.headers,
          body: prepared.body,
          billingBody: prepared.billingBody,
          release: lease.release,
          onResponse: (response: Response) =>
            service.reportClaudeStatus(id, String(parsed.model), response, lease.credentials.accessToken),
          forwardResponse: (options) => forwardClaudeResponse(options, prepared.reverse, session),
        };
      } catch (error) {
        lease.release();
        throw error;
      }
    },
    forwardResponse,
  };
}
