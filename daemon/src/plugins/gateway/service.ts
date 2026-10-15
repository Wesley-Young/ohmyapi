import { type Disposable, serviceToken } from '@fraqjs/kernel';
import { and, eq } from 'drizzle-orm';

import type { GatewayConfig } from '../../config.ts';
import { GatewayError } from '../../core/errors.ts';
import { createLogSampler, type EventLogger, errorDetails, formatEvent } from '../../core/logging.ts';
import type { CredentialVault } from '../../core/vault.ts';
import { protocolFor } from '../../protocols/index.ts';
import { validateBillableRequest } from '../billing/admission.ts';
import { searchRequest } from '../billing/search.ts';
import type { BillingService } from '../billing/service.ts';
import type { Database } from '../database/client.ts';
import { activeChannel, availableSubscription } from '../database/query.ts';
import type { Endpoint } from '../database/schema/index.ts';
import { channels, requestAttempts, requests } from '../database/schema/index.ts';
import type { OutboundHttp } from '../outbound/index.ts';
import type { PricingService } from '../pricing/service.ts';
import { channelAdapter, type SubscriptionChannels } from './adapters.ts';
import { type AffinitySelection, ChannelAffinity } from './affinity.ts';
import { ForwardBillingSession } from './billing-session.ts';
import { readJsonBody } from './body.ts';
import { identifyApiKey } from './identity.ts';
import { RequestLifecycle } from './lifecycle.ts';
import { availableModels, modelListResponse } from './models.ts';
import { errorResponse, reasoningEffort } from './protocol.ts';
import { UserRateLimiter } from './rate-limit.ts';
import { resolveEntryRoute, selectExecutionChannel } from './routing.ts';

import { randomUUID } from 'node:crypto';

/**
 * 网关请求流程：鉴权与限流 → 读取请求体 → 入库 → 解析路由 → 锁定价格 → 预占 → 转发 → 收尾计费。
 * 停止时中止所有进行中的请求并等待其完成计费收尾。
 */
export class GatewayService implements Disposable {
  static readonly token = serviceToken<GatewayService>('ohmyapi/gateway');
  private readonly affinity = new ChannelAffinity();
  private readonly db: Database;
  private readonly pricing: PricingService;
  private readonly billing: BillingService;
  private readonly vault: CredentialVault;
  private readonly subscriptions: SubscriptionChannels;
  private readonly outbound: OutboundHttp;
  private readonly config: GatewayConfig;
  private readonly logger: EventLogger;
  private readonly sampleLog = createLogSampler();
  private readonly rateLimiter: UserRateLimiter;
  private stopping = false;
  private disposal?: Promise<void>;
  private readonly running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  constructor(deps: {
    db: Database;
    pricing: PricingService;
    billing: BillingService;
    vault: CredentialVault;
    subscriptions: SubscriptionChannels;
    outbound: OutboundHttp;
    config: GatewayConfig;
    logger: EventLogger;
  }) {
    this.db = deps.db;
    this.pricing = deps.pricing;
    this.billing = deps.billing;
    this.vault = deps.vault;
    this.subscriptions = deps.subscriptions;
    this.outbound = deps.outbound;
    this.config = deps.config;
    this.logger = deps.logger;
    this.rateLimiter = new UserRateLimiter(deps.config);
  }

  dispose() {
    this.stopping = true;
    this.disposal ??= (async () => {
      const entries = [...this.running.values()];
      this.logger.info(formatEvent('网关停止转发', { activeRequests: entries.length }));
      for (const e of entries) e.abort.abort('server_shutdown');
      await Promise.allSettled(entries.map((e) => e.done));
    })();
    return this.disposal;
  }

  error(endpoint: Endpoint | '/v1/models', status: number, code: string, message: string, id: string) {
    if (code === 'method_not_allowed' && this.sampleLog(code))
      this.logger.warn(
        formatEvent('网关请求被拒绝', {
          requestId: id,
          endpoint,
          httpStatus: status,
          errorCode: code,
          errorMessage: message,
        }),
      );
    return errorResponse(endpoint, status, code, message, id);
  }

  async listModels(req: Request): Promise<Response> {
    const id = randomUUID();
    const startedAt = Date.now();
    try {
      if (this.stopping) throw new GatewayError(503, 'server_stopping', 'Gateway is stopping');
      const identity = await identifyApiKey(this.db, req, ['x-api-key']);
      if (!identity.channelId)
        throw new GatewayError(403, 'channel_unbound', 'Bind this legacy API Key to a channel before using it');
      const [channel] = await this.db
        .select()
        .from(channels)
        .where(and(eq(channels.id, identity.channelId), activeChannel(), availableSubscription()));
      if (!channel) throw new GatewayError(503, 'channel_unavailable', 'The API Key channel is unavailable');
      if (channel.type !== 'aggregate') await channelAdapter(channel, this.subscriptions);
      const available = await availableModels(this.db, { ...identity, channelId: identity.channelId }, channel);
      return modelListResponse(req, available, id);
    } catch (error) {
      const failure =
        error instanceof GatewayError
          ? error
          : new GatewayError(502, 'gateway_error', 'Unable to list available models');
      if (failure.status >= 500 || this.sampleLog(failure.code))
        this.logger[failure.status >= 500 ? 'error' : 'warn'](
          formatEvent('网关模型列表请求失败', {
            requestId: id,
            endpoint: '/v1/models',
            httpStatus: failure.status,
            errorCode: failure.code,
            durationMs: Date.now() - startedAt,
            ...errorDetails(error),
          }),
        );
      return this.error('/v1/models', failure.status, failure.code, failure.message, id);
    }
  }

  /** params 为路由中的路径参数，由端点协议解析请求目标。 */
  async forward(req: Request, endpoint: Endpoint, params: Readonly<Record<string, string>> = {}): Promise<Response> {
    const protocol = protocolFor(endpoint);
    const lifecycle = new RequestLifecycle(req, () => this.running.delete(lifecycle.id));
    const { id, receivedAt, abort } = lifecycle;
    this.running.set(id, lifecycle);
    const session = new ForwardBillingSession({
      id,
      receivedAt,
      endpoint,
      config: this.config,
      billing: this.billing,
      db: this.db,
      logger: this.logger,
      sampleLog: this.sampleLog,
    });
    let binding: { selection: AffinitySelection; channelId: string } | undefined;
    const finish = (errorCode?: string) => {
      const result = session.summary(errorCode);
      return lifecycle.finish(
        () => {
          if (
            binding &&
            !result.errorCode &&
            session.dispatched &&
            (session.upstreamStatus ?? 0) >= 200 &&
            (session.upstreamStatus ?? 0) < 300
          ) {
            this.affinity.remember(binding.selection, binding.channelId);
          }
          return session.finish(result);
        },
        () => session.log(result),
      );
    };

    try {
      if (this.stopping) throw new GatewayError(503, 'server_stopping', 'Gateway is stopping');
      if (protocol.family === 'messages' && /^claude-(?:cli|code)\//i.test(req.headers.get('user-agent')?.trim() ?? ''))
        throw new GatewayError(
          403,
          'client_not_allowed',
          '此端点不支持 Claude Code 客户端，请在其他兼容 Anthropic Messages 的客户端中使用。',
        );
      this.billing.assertReady();
      const identity = await identifyApiKey(this.db, req, protocol.apiKeyHeaders);
      session.userId = identity.user.id;
      session.channelId = identity.channelId ?? undefined;
      lifecycle.releaseCapacity = this.rateLimiter.acquire(identity.user.id);

      const { parsed, bytes } = await lifecycle.withBodyTimeout(
        this.config.bodyTimeoutMs,
        this.config.bodyIdleTimeoutMs,
        (progress) => readJsonBody(req, abort.signal, session.bodyStats, progress, this.config.maxBodyBytes),
      );
      const target = protocol.target(req, parsed, params);
      // Async/background Responses retrieval is outside this synchronous gateway's scope.
      if (parsed.background === true)
        throw new GatewayError(400, 'unsupported_mode', 'Background responses are not supported');
      const streaming = target.streaming;
      session.streaming = streaming;
      const requestedEffort = reasoningEffort(endpoint, parsed);

      // 完整请求体通过校验后入库，后续模型或渠道拒绝仍保留记录。
      await this.db.insert(requests).values({
        id,
        receivedAt,
        userId: identity.user.id,
        apiKeyId: identity.key.id,
        channelId: identity.channelId,
        requestedModel: target.model,
        endpoint,
        streaming,
        reasoningEffort: requestedEffort,
      });
      session.recorded = true;
      const { model, channel } = await resolveEntryRoute(this.db, identity, target.model, endpoint, session);
      const { channel: executionChannel, affinity } = await selectExecutionChannel(
        this.db,
        this.subscriptions,
        channel,
        parsed,
        target.model,
        endpoint,
        req,
        this.affinity,
        identity.user.id,
      );
      if (affinity) binding = { selection: affinity, channelId: executionChannel.id };
      session.executionChannelId = executionChannel.id;
      const attemptId = randomUUID();
      await this.db.insert(requestAttempts).values({
        id: attemptId,
        requestId: id,
        sequence: 1,
        channelId: executionChannel.id,
        channelName: executionChannel.name,
        channelType: executionChannel.type,
        subscriptionAccountId: executionChannel.subscriptionAccountId,
      });
      session.attemptId = attemptId;
      const adapter = await channelAdapter(executionChannel, this.subscriptions);
      const lockedPrice = await this.pricing.lockRoute(model.id, receivedAt, channel.id, executionChannel.id);
      if (!lockedPrice) throw new GatewayError(503, 'price_missing', 'No price is configured for this model');
      const requestedOutputLimit = validateBillableRequest(parsed, endpoint, model.outputTokenLimit);
      session.collector.configureSearch(searchRequest(parsed, endpoint));
      session.collector.configureRequest(parsed);
      const timeoutMs = Math.min(channel.timeoutMs, executionChannel.timeoutMs);
      session.upstreamTimeoutMs = timeoutMs;
      lifecycle.setTimeout('upstream_timeout', timeoutMs);
      lifecycle.syncClientAbort();
      const prepared = await adapter.prepareRequest({
        userId: identity.user.id,
        channel: executionChannel,
        request: req,
        endpoint,
        target,
        parsed,
        bytes,
        vault: this.vault,
        signal: abort.signal,
      });

      lifecycle.releaseUpstream = prepared.release;
      const outputLimit = prepared.usesModelOutputLimit ? model.outputTokenLimit : requestedOutputLimit;
      const { url, body, headers } = prepared;
      const request = this.outbound.forProxy(
        executionChannel.proxyUrlEncrypted ? this.vault.decrypt(executionChannel.proxyUrlEncrypted) : null,
      );
      // 适配器可能改写推理强度（如强制工具调用时移除），记录实际发往上游的值。
      const effectiveEffort = prepared.billingBody ? reasoningEffort(endpoint, prepared.billingBody) : requestedEffort;
      if (executionChannel.subscriptionAccountId || effectiveEffort !== requestedEffort)
        await this.db
          .update(requests)
          .set({
            subscriptionAccountId: executionChannel.subscriptionAccountId ?? undefined,
            reasoningEffort: effectiveEffort,
          })
          .where(eq(requests.id, id));
      const reservation = await this.billing.reserve({
        requestId: id,
        userId: identity.user.id,
        keyId: identity.key.id,
        modelId: model.id,
        channelId: channel.id,
        executionChannel,
        price: lockedPrice,
        inputLimit: model.inputTokenLimit,
        outputLimit,
        body: prepared.billingBody ?? parsed,
        endpoint,
      });
      session.collector.estimate.input = reservation.estimate;
      lifecycle.syncClientAbort();
      if (abort.signal.aborted)
        throw new GatewayError(400, 'request_cancelled', 'Request was cancelled before forwarding');
      await this.billing.forwarding(id, attemptId, {
        channelId: channel.id,
        modelId: model.id,
        endpoint,
        executionChannel,
      });

      lifecycle.setTimeout('upstream_timeout', timeoutMs);
      lifecycle.syncClientAbort();
      if (abort.signal.aborted)
        throw new GatewayError(400, 'request_cancelled', 'Request was cancelled before forwarding');
      if (executionChannel.type === 'subscription') lifecycle.retainUpstreamOnDisconnect(60_000);
      session.dispatched = true;
      const upstream = await request(url, {
        method: 'POST',
        headers,
        body,
        signal: abort.signal,
        redirect: 'manual',
      });
      if (prepared.onResponse) await prepared.onResponse(upstream).catch(() => {});
      session.httpStatus = upstream.status;
      session.upstreamStatus = upstream.status;
      return await (prepared.forwardResponse ?? adapter.forwardResponse)({
        upstream,
        endpoint,
        streaming,
        lifecycle,
        collector: session.collector,
        config: this.config,
        onCheckpoint: () => session.checkpoint(),
        onFinish: (safeRejection, errorCode) => {
          session.safeRejection = safeRejection;
          return finish(errorCode);
        },
        onError: (error) => {
          session.failureDetails = errorDetails(error);
        },
      });
    } catch (error) {
      session.failureDetails = errorDetails(error);
      const failure =
        error instanceof GatewayError
          ? error
          : new GatewayError(
              abort.signal.reason === 'upstream_timeout' ? 504 : 502,
              abort.signal.reason === 'upstream_timeout' ? 'upstream_timeout' : 'gateway_error',
              'Unable to complete the upstream request',
            );
      session.httpStatus = failure.status;
      await finish(failure.code);
      return this.error(endpoint, failure.status, failure.code, failure.message, id);
    }
  }
}
