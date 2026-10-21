import { type Disposable, serviceToken } from '@fraqjs/kernel';
import {
  GatewayError,
  type ModelInfo,
  modelListBody,
  modelListPath,
  protocolFor,
  type RequestTarget,
} from '@ohmyapi/protocols';
import { errorResponse, RequestLifecycle, readJsonBody, requestNotSent, responseHeaders } from '@ohmyapi/relay';
import { and, eq } from 'drizzle-orm';

import type { GatewayConfig } from '../../config.ts';
import { createLogSampler, type EventLogger, errorDetails, formatEvent } from '../../core/logging.ts';
import type { CredentialVault } from '../../core/vault.ts';
import { validateBillableRequest } from '../billing/admission.ts';
import { searchRequest } from '../billing/search.ts';
import type { BillingService } from '../billing/service.ts';
import type { ChannelConcurrency } from '../catalog/concurrency.ts';
import type { Database } from '../database/client.ts';
import { activeChannel, availableSubscription } from '../database/query.ts';
import type { Endpoint } from '../database/schema/index.ts';
import { channels, requestAttempts, requests } from '../database/schema/index.ts';
import type { KeyIdentity } from '../keys/access.ts';
import type { OutboundHttp } from '../outbound/index.ts';
import type { PricingService } from '../pricing/service.ts';
import { channelAdapter, type SubscriptionChannels } from './adapters.ts';
import { type AffinitySelection, ChannelAffinity } from './affinity.ts';
import { ForwardBillingSession } from './billing-session.ts';
import { type ApiKeySources, identifyApiKey } from './identity.ts';
import { availableModels } from './models.ts';
import { reasoningEffort } from './protocol.ts';
import { UserRateLimiter } from './rate-limit.ts';
import { resolveEntryRoute, selectExecutionChannel } from './routing.ts';

import { randomUUID } from 'node:crypto';

/**
 * 聚合渠道按会话选择成员；此前没有确认过的成员，或本次换了成员时，会话历史可能来自其他上游。
 * 非聚合渠道始终由同一渠道执行。
 */
const foreignHistory = (affinity: AffinitySelection | undefined, channelId: string) =>
  affinity !== undefined && affinity.previous?.channelId !== channelId;

/** 选择渠道时占用的名额与适配器占用的上游资源一起释放；两者可能是同一个释放函数，重复调用没有副作用。 */
const releaseBoth = (reservation?: () => void, release?: () => void) => () => {
  reservation?.();
  release?.();
};

/**
 * 网关请求流程：鉴权与限流 → 读取请求体 → 入库 → 解析路由 → 锁定价格 → 预占 → 转发 → 收尾计费。
 * 平滑停止时拒绝新请求，等待进行中的请求自然结束；强制停止时中止进行中的请求，并等待其完成计费收尾。
 */
export class GatewayService implements Disposable {
  static readonly token = serviceToken<GatewayService>('ohmyapi/gateway');
  private readonly affinity = new ChannelAffinity();
  private readonly db: Database;
  private readonly pricing: PricingService;
  private readonly billing: BillingService;
  private readonly vault: CredentialVault;
  private readonly subscriptions: SubscriptionChannels;
  private readonly concurrency: ChannelConcurrency;
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
    concurrency: ChannelConcurrency;
    outbound: OutboundHttp;
    config: GatewayConfig;
    logger: EventLogger;
  }) {
    this.db = deps.db;
    this.pricing = deps.pricing;
    this.billing = deps.billing;
    this.vault = deps.vault;
    this.subscriptions = deps.subscriptions;
    this.concurrency = deps.concurrency;
    this.outbound = deps.outbound;
    this.config = deps.config;
    this.logger = deps.logger;
    this.rateLimiter = new UserRateLimiter(deps.config);
  }

  get activeRequests() {
    return this.running.size;
  }

  /** 拒绝新请求，等待进行中的请求自然结束并完成计费收尾。 */
  async drain() {
    this.stopping = true;
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()].map((e) => e.done));
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

  error(endpoint: Endpoint | typeof modelListPath, status: number, code: string, message: string, id: string) {
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

  /** OpenAI 和 Anthropic 客户端共用的模型列表，按请求头选择响应格式。 */
  listModels(req: Request): Promise<Response> {
    return this.serveModels(req, modelListPath, { headers: ['x-api-key'] }, undefined, (available, id) =>
      Response.json(modelListBody(req, available, 'ohmyapi'), {
        headers: { 'x-request-id': id, 'cache-control': 'no-store' },
      }),
    );
  }

  /** 协议自带的模型接口：未指定 name 时返回列表，否则返回单个模型。 */
  protocolModels(req: Request, endpoint: Endpoint, name?: string): Promise<Response> {
    const protocol = protocolFor(endpoint);
    const format = protocol.modelList;
    if (!format) throw new Error(`${endpoint} does not provide a model list`);
    return this.serveModels(
      req,
      endpoint,
      { headers: protocol.apiKeyHeaders, query: protocol.apiKeyQuery, rejectedQuery: protocol.rejectedApiKeyQuery },
      endpoint,
      (available, id) => {
        const model = name === undefined ? undefined : available.find((item) => item.name === name);
        if (name !== undefined && !model)
          throw new GatewayError(404, 'model_not_found', 'Unknown or unavailable model');
        return Response.json(model ? format.get(model) : format.list(available), {
          headers: { 'x-request-id': id, 'cache-control': 'no-store' },
        });
      },
    );
  }

  private async serveModels(
    req: Request,
    errorEndpoint: Endpoint | typeof modelListPath,
    sources: ApiKeySources,
    endpoint: Endpoint | undefined,
    respond: (available: ModelInfo[], id: string) => Response,
  ): Promise<Response> {
    const id = randomUUID();
    const startedAt = Date.now();
    try {
      if (this.stopping) throw new GatewayError(503, 'server_stopping', 'Gateway is stopping');
      const identity = await identifyApiKey(this.db, req, sources);
      if (!identity.channelId)
        throw new GatewayError(403, 'channel_unbound', 'Bind this legacy API Key to a channel before using it');
      const [channel] = await this.db
        .select()
        .from(channels)
        .where(and(eq(channels.id, identity.channelId), activeChannel(), availableSubscription()));
      if (!channel) throw new GatewayError(503, 'channel_unavailable', 'The API Key channel is unavailable');
      if (channel.type !== 'aggregate') await channelAdapter(channel, this.subscriptions);
      const available = await availableModels(
        this.db,
        { ...identity, channelId: identity.channelId },
        channel,
        endpoint,
      );
      return respond(available, id);
    } catch (error) {
      const failure =
        error instanceof GatewayError
          ? error
          : new GatewayError(502, 'gateway_error', 'Unable to list available models');
      if (failure.status >= 500 || this.sampleLog(failure.code))
        this.logger[failure.status >= 500 ? 'error' : 'warn'](
          formatEvent('网关模型列表请求失败', {
            requestId: id,
            endpoint: errorEndpoint,
            httpStatus: failure.status,
            errorCode: failure.code,
            durationMs: Date.now() - startedAt,
            ...errorDetails(error),
          }),
        );
      return this.error(errorEndpoint, failure.status, failure.code, failure.message, id);
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
      const identity = await identifyApiKey(this.db, req, {
        headers: protocol.apiKeyHeaders,
        query: protocol.apiKeyQuery,
        rejectedQuery: protocol.rejectedApiKeyQuery,
      });
      session.userId = identity.user.id;
      session.channelId = identity.channelId ?? undefined;
      lifecycle.releaseCapacity = this.rateLimiter.acquire(identity.user.id);

      const received = await lifecycle.withBodyTimeout(
        this.config.bodyTimeoutMs,
        this.config.bodyIdleTimeoutMs,
        (progress) => readJsonBody(req, abort.signal, session.bodyStats, progress, this.config.maxBodyBytes),
      );
      const { bytes } = received;
      const target = protocol.target(req, received.parsed, params);
      // 计费和路由读取统一写法后的请求体，上游仍收到原始字节。
      const parsed = protocol.canonicalBody ? protocol.canonicalBody(received.parsed) : received.parsed;
      if (target.unbilled) {
        session.unbilled = true;
        session.modelName = target.model;
        return await this.relayUnbilled({ req, endpoint, target, parsed, bytes, identity, lifecycle, session, finish });
      }
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
      const {
        channel: executionChannel,
        affinity,
        release: reservation,
      } = await selectExecutionChannel(
        this.db,
        this.subscriptions,
        this.concurrency,
        channel,
        parsed,
        target.model,
        endpoint,
        req,
        this.affinity,
        identity.user.id,
      );
      // 选择时占用的并发名额在请求收尾时释放，失败时同样释放。
      lifecycle.releaseUpstream = reservation;
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
        foreignHistory: foreignHistory(affinity, executionChannel.id),
        parsed,
        bytes,
        vault: this.vault,
        signal: abort.signal,
        reservation,
      });

      lifecycle.releaseUpstream = releaseBoth(reservation, prepared.release);
      const outputLimit = prepared.usesModelOutputLimit ? model.outputTokenLimit : requestedOutputLimit;
      const { url, body, headers } = prepared;
      const request = this.outbound.forProxy(
        executionChannel.proxyUrlEncrypted ? this.vault.decrypt(executionChannel.proxyUrlEncrypted) : null,
      );
      // 适配器可能改写推理强度（如强制工具调用时移除），记录实际发往上游的值。
      const effectiveEffort = prepared.billingBody ? reasoningEffort(endpoint, prepared.billingBody) : requestedEffort;
      await this.billing.reserve({
        requestId: id,
        userId: identity.user.id,
        modelId: model.id,
        channelId: channel.id,
        subscriptionAccountId: executionChannel.subscriptionAccountId,
        reasoningEffort: effectiveEffort,
        price: lockedPrice,
        outputLimit,
        body: prepared.billingBody ?? parsed,
        endpoint,
      });
      lifecycle.syncClientAbort();
      if (abort.signal.aborted)
        throw new GatewayError(400, 'request_cancelled', 'Request was cancelled before forwarding');
      await this.billing.forwarding(id, attemptId);

      lifecycle.setTimeout('upstream_timeout', timeoutMs);
      lifecycle.syncClientAbort();
      if (abort.signal.aborted)
        throw new GatewayError(400, 'request_cancelled', 'Request was cancelled before forwarding');
      // 客户端断开后继续读取上游以取得最终用量。
      lifecycle.retainUpstreamOnDisconnect(
        executionChannel.type === 'subscription' ? 60_000 : this.config.disconnectDrainTimeoutMs,
      );
      session.dispatched = true;
      let upstream: Response;
      try {
        upstream = await request(url, {
          method: 'POST',
          headers,
          body,
          signal: abort.signal,
          redirect: 'manual',
        });
      } catch (error) {
        if (requestNotSent(error)) session.notSent = true;
        throw error;
      }
      if (prepared.onResponse) await prepared.onResponse(upstream).catch(() => {});
      session.httpStatus = upstream.status;
      session.upstreamStatus = upstream.status;
      const upstreamFailed = !upstream.ok;
      return await (prepared.forwardResponse ?? adapter.forwardResponse)({
        upstream,
        endpoint,
        streaming,
        lifecycle,
        collector: session.collector,
        config: this.config,
        onCheckpoint: () => session.checkpoint(),
        onFinish: (noExecution, errorCode) => {
          // 适配器可能把上游的成功响应改写为失败状态（如合并后的错误事件），按状态判断时只采用上游的真实状态。
          session.safeRejection =
            noExecution !== undefined &&
            (upstreamFailed || (noExecution !== 'http_error' && noExecution !== 'redirect'));
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
          : session.notSent
            ? new GatewayError(502, 'upstream_unreachable', 'Unable to connect to the upstream service')
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

  /** 不计费的辅助操作：校验路由和权限后转发，不写入请求记录，也不预占余额。 */
  private async relayUnbilled(options: {
    req: Request;
    endpoint: Endpoint;
    target: RequestTarget;
    parsed: Record<string, unknown>;
    bytes: Buffer<ArrayBuffer>;
    identity: KeyIdentity;
    lifecycle: RequestLifecycle;
    session: ForwardBillingSession;
    finish: (errorCode?: string) => Promise<void>;
  }): Promise<Response> {
    const { req, endpoint, target, parsed, bytes, identity, lifecycle, session, finish } = options;
    const { id, abort } = lifecycle;
    const { channel } = await resolveEntryRoute(this.db, identity, target.model, endpoint, session);
    const {
      channel: executionChannel,
      affinity,
      release: reservation,
    } = await selectExecutionChannel(
      this.db,
      this.subscriptions,
      this.concurrency,
      channel,
      parsed,
      target.model,
      endpoint,
      req,
      this.affinity,
      identity.user.id,
    );
    lifecycle.releaseUpstream = reservation;
    session.executionChannelId = executionChannel.id;
    const adapter = await channelAdapter(executionChannel, this.subscriptions);
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
      foreignHistory: foreignHistory(affinity, executionChannel.id),
      parsed,
      bytes,
      vault: this.vault,
      signal: abort.signal,
      reservation,
    });
    lifecycle.releaseUpstream = releaseBoth(reservation, prepared.release);
    const request = this.outbound.forProxy(
      executionChannel.proxyUrlEncrypted ? this.vault.decrypt(executionChannel.proxyUrlEncrypted) : null,
    );
    if (abort.signal.aborted)
      throw new GatewayError(400, 'request_cancelled', 'Request was cancelled before forwarding');
    session.dispatched = true;
    const upstream = await request(prepared.url, {
      method: 'POST',
      headers: prepared.headers,
      body: prepared.body,
      signal: abort.signal,
      redirect: 'manual',
    });
    if (prepared.onResponse) await prepared.onResponse(upstream).catch(() => {});
    session.httpStatus = upstream.status;
    session.upstreamStatus = upstream.status;
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      throw new GatewayError(502, 'upstream_redirect', 'Upstream redirects are not supported');
    }
    // 订阅渠道的错误响应可能包含账号信息，只返回状态；账号失效（401/403）对客户端表现为 502。
    if (!upstream.ok && executionChannel.type === 'subscription') {
      await upstream.body?.cancel();
      await finish('upstream_http_error');
      const status = upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status;
      return this.error(endpoint, status, 'upstream_http_error', `Upstream returned HTTP ${upstream.status}`, id);
    }
    // 辅助操作的响应很小，完整读取后再返回，便于在收尾前释放上游连接。
    const declared = Number(upstream.headers.get('content-length'));
    if (declared > this.config.maxUsageBodyBytes) {
      await upstream.body?.cancel();
      throw new GatewayError(502, 'upstream_response_too_large', 'Upstream response is too large');
    }
    const content = await upstream.arrayBuffer();
    if (content.byteLength > this.config.maxUsageBodyBytes)
      throw new GatewayError(502, 'upstream_response_too_large', 'Upstream response is too large');
    await finish(upstream.ok ? undefined : 'upstream_http_error');
    return new Response(content, { status: upstream.status, headers: responseHeaders(upstream.headers, id) });
  }
}
