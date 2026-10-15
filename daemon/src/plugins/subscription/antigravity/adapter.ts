import { GatewayError } from '../../../core/errors.ts';
import { repairGeminiHistory } from '../../../protocols/index.ts';
import type { ChannelAdapter } from '../../gateway/adapters.ts';
import { forwardResponse } from '../../gateway/response.ts';
import type { SubscriptionRuntime } from '../runtime.ts';
import { antigravityBaseUrl, antigravityUserAgent } from './client.ts';
import { thinkingLevel, upstreamModel } from './models.ts';
import { antigravityCountTokensRequest, antigravityRequest } from './request.ts';
import { forwardAntigravityResponse } from './response.ts';

export function antigravityAdapter(service: SubscriptionRuntime): ChannelAdapter {
  return {
    async prepareRequest({ channel, endpoint, target, foreignHistory, parsed, signal, vault }) {
      if (endpoint !== '/v1beta/generateContent')
        throw new GatewayError(
          400,
          'subscription_endpoint_unsupported',
          'Antigravity subscriptions support Gemini generateContent only',
        );
      const id = channel.subscriptionAccountId;
      if (!id) throw new GatewayError(503, 'subscription_unavailable', 'Bind an Antigravity account first');
      const counting = target.operation === 'countTokens';
      // 先构造请求，格式错误时不占用账号并发。
      const body = counting ? undefined : (repairGeminiHistory(parsed, foreignHistory) ?? parsed);
      const proxy = channel.proxyUrlEncrypted ? vault.decrypt(channel.proxyUrlEncrypted) : null;
      const lease = await service.acquireAntigravity(id, signal, target.model, proxy);
      try {
        const { credentials } = lease;
        const projectId = credentials.projectId as string;
        // 规范模型名在上游可能只有思考档位变体，按请求的 thinkingConfig 选择；网关和计费仍使用规范名称。
        const catalog = await service.antigravityCatalog(id, credentials, proxy);
        const model = upstreamModel(target.model, catalog, thinkingLevel(body ?? parsed));
        const payload = body
          ? antigravityRequest(model, body, projectId)
          : antigravityCountTokensRequest(model, parsed);
        if (signal.aborted) throw new GatewayError(400, 'request_cancelled', 'Request cancelled before forwarding');
        return {
          // 上游统一使用流式接口，非流式请求由网关合并。
          url: counting
            ? `${antigravityBaseUrl}/v1internal:countTokens`
            : `${antigravityBaseUrl}/v1internal:streamGenerateContent?alt=sse`,
          headers: new Headers({
            authorization: `Bearer ${credentials.accessToken}`,
            'content-type': 'application/json',
            accept: counting ? 'application/json' : 'text/event-stream',
            'user-agent': antigravityUserAgent,
          }),
          body: Buffer.from(JSON.stringify(payload)),
          release: lease.release,
          forwardResponse: (options) =>
            forwardAntigravityResponse(options, {
              projectId,
              report: (status, retryAfterMs) =>
                service.reportAntigravityStatus(id, target.model, status, retryAfterMs, credentials.accessToken),
            }),
        };
      } catch (error) {
        lease.release();
        throw error;
      }
    },
    forwardResponse,
  };
}
