import { type Disposable, serviceToken } from '@fraqjs/kernel';
import { and, asc, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';

import type { readGatewayConfig } from '../../config.js';
import { createLogSampler, type EventLogger, errorDetails } from '../../logging.js';
import { validateBillableRequest } from '../billing/admission.js';
import { formatMoney } from '../billing/conventions.js';
import { searchRequest } from '../billing/search.js';
import type { BillingService } from '../billing/service.js';
import type { CredentialVault, Endpoint } from '../catalog/service.js';
import type { Database } from '../database/client.js';
import {
  apiKeyChannels,
  apiKeyModelGrants,
  apiKeys,
  effectiveChannelModels as channelAvailableModels,
  effectiveChannelEndpoints as channelEndpoints,
  channels,
  models,
  priceRules,
  requestAttempts,
  requests,
  requestUsage,
  userChannelGrants,
  users,
} from '../database/schema/index.js';
import type { PricingService } from '../pricing/service.js';
import { availableSubscription } from '../subscription/availability.js';
import type { SubscriptionService } from '../subscription/service.js';
import { pageSize } from '../users/service.js';
import { channelAdapter } from './adapters.js';
import { ForwardBillingSession } from './billing-session.js';
import { cacheReadForDisplay } from './cache-usage.js';
import { GatewayError } from './errors.js';
import { RequestLifecycle } from './lifecycle.js';
import { selectExecutionChannel } from './routing.js';

import { randomUUID } from 'node:crypto';

type Config = ReturnType<typeof readGatewayConfig>;
export class GatewayService implements Disposable {
  static readonly token = serviceToken<GatewayService>('ohmyapi/gateway');
  private readonly limits = new Map<string, { active: number; count: number; reset: number }>();
  private readonly db: Database;
  private readonly vault: CredentialVault;
  private readonly subscription: SubscriptionService;
  readonly config: Config;
  private readonly logger: EventLogger;
  private readonly sampleLog = createLogSampler();
  private readonly pricing: PricingService;
  private readonly billing: BillingService;
  private stopping = false;
  private disposal?: Promise<void>;
  private readonly running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  constructor(
    db: Database,
    pricing: PricingService,
    billing: BillingService,
    vault: CredentialVault,
    subscription: SubscriptionService,
    config: Config,
    logger: EventLogger,
  ) {
    this.db = db;
    this.pricing = pricing;
    this.billing = billing;
    this.vault = vault;
    this.subscription = subscription;
    this.config = config;
    this.logger = logger;
  }

  dispose() {
    this.stopping = true;
    this.disposal ??= (async () => {
      const entries = [...this.running.values()];
      this.logger.info(`网关停止转发 ${JSON.stringify({ activeRequests: entries.length })}`);
      for (const e of entries) e.abort.abort('server_shutdown');
      await Promise.allSettled(entries.map((e) => e.done));
    })();
    return this.disposal;
  }

  error(endpoint: Endpoint | '/v1/models', status: number, code: string, message: string, id: string) {
    if (code === 'method_not_allowed' && this.sampleLog(code))
      this.logger.warn(
        `网关请求被拒绝 ${JSON.stringify({ requestId: id, endpoint, httpStatus: status, errorCode: code, errorMessage: message })}`,
      );
    const type =
      status === 401
        ? 'authentication_error'
        : status === 403
          ? 'permission_error'
          : status === 429
            ? 'rate_limit_error'
            : status >= 500
              ? 'api_error'
              : 'invalid_request_error';
    return Response.json(
      endpoint === '/v1/messages'
        ? { type: 'error', error: { type, message }, request_id: id }
        : { error: { type, code, message, param: null } },
      {
        status,
        headers: {
          'x-request-id': id,
          'cache-control': 'no-store',
          ...(status === 429 ? { 'retry-after': '60' } : {}),
        },
      },
    );
  }

  private acquire(userId: string) {
    const now = Date.now();
    for (const [key, entry] of this.limits) if (!entry.active && entry.reset <= now) this.limits.delete(key);
    const entry = this.limits.get(userId) ?? { active: 0, count: 0, reset: now + 60_000 };
    if (entry.reset <= now) {
      entry.count = 0;
      entry.reset = now + 60_000;
    }
    if (
      entry.active >= this.config.maxConcurrent ||
      entry.count >= this.config.requestsPerMinute ||
      this.limits.size >= 10_000
    )
      throw new GatewayError(429, 'rate_limit_exceeded', 'User request limit exceeded');
    entry.active++;
    entry.count++;
    this.limits.set(userId, entry);
    return () => {
      entry.active--;
    };
  }

  private async identify(req: Request, endpoint: Endpoint | '/v1/models') {
    const authorization = req.headers.get('authorization');
    const bearer = authorization?.match(/^Bearer (sk-[A-Za-z0-9_-]{43})$/i)?.[1];
    const headerKey = endpoint === '/v1/messages' ? req.headers.get('x-api-key') : null;
    if ((authorization && !bearer) || (bearer && headerKey && bearer !== headerKey))
      throw new GatewayError(401, 'invalid_api_key', 'Invalid API Key');
    const token = bearer ?? headerKey;
    if (!token || !/^sk-[A-Za-z0-9_-]{43}$/.test(token))
      throw new GatewayError(401, 'invalid_api_key', 'An API Key is required');
    const [identity] = await this.db
      .select({ key: apiKeys, user: users, channelId: apiKeyChannels.channelId })
      .from(apiKeys)
      .innerJoin(users, eq(apiKeys.userId, users.id))
      .leftJoin(apiKeyChannels, eq(apiKeyChannels.apiKeyId, apiKeys.id))
      .where(
        and(
          eq(apiKeys.key, token),
          isNull(apiKeys.revokedAt),
          isNull(apiKeys.deletedAt),
          or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
          eq(users.status, 'active'),
          isNull(users.deletedAt),
        ),
      );
    if (!identity) throw new GatewayError(401, 'invalid_api_key', 'Invalid or expired API Key');
    return identity;
  }

  async listModels(req: Request): Promise<Response> {
    const id = randomUUID();
    const startedAt = Date.now();
    try {
      if (this.stopping) throw new GatewayError(503, 'server_stopping', 'Gateway is stopping');
      const identity = await this.identify(req, '/v1/models');
      if (!identity.channelId)
        throw new GatewayError(403, 'channel_unbound', 'Bind this legacy API Key to a channel before using it');
      const [channel] = await this.db
        .select({ isPublic: channels.isPublic, type: channels.type })
        .from(channels)
        .where(
          and(
            eq(channels.id, identity.channelId),
            eq(channels.enabled, true),
            isNull(channels.deletedAt),
            availableSubscription(),
          ),
        );
      if (!channel) throw new GatewayError(503, 'channel_unavailable', 'The API Key channel is unavailable');
      if (channel.type !== 'aggregate') channelAdapter(channel.type, this.subscription);
      const available = await this.db
        .selectDistinct({ name: models.name, createdAt: models.createdAt })
        .from(models)
        .innerJoin(channelAvailableModels, eq(channelAvailableModels.modelId, models.id))
        .innerJoin(channelEndpoints, eq(channelEndpoints.channelId, channelAvailableModels.channelId))
        .innerJoin(priceRules, and(eq(priceRules.modelId, models.id), eq(priceRules.kind, 'default')))
        .leftJoin(
          apiKeyModelGrants,
          and(eq(apiKeyModelGrants.modelId, models.id), eq(apiKeyModelGrants.apiKeyId, identity.key.id)),
        )
        .leftJoin(
          userChannelGrants,
          and(
            eq(userChannelGrants.channelId, channelAvailableModels.channelId),
            eq(userChannelGrants.userId, identity.user.id),
          ),
        )
        .where(
          and(
            eq(channelAvailableModels.channelId, identity.channelId),
            eq(models.enabled, true),
            isNull(models.deletedAt),
            identity.key.restrictModels ? eq(apiKeyModelGrants.apiKeyId, identity.key.id) : undefined,
            identity.user.role !== 'admin' && !channel.isPublic
              ? eq(userChannelGrants.userId, identity.user.id)
              : undefined,
          ),
        )
        .orderBy(models.name);
      return Response.json(
        {
          object: 'list',
          data: available.map((model) => ({
            id: model.name,
            object: 'model',
            created: Math.floor(model.createdAt.getTime() / 1000),
            owned_by: 'ohmyapi',
          })),
        },
        { headers: { 'x-request-id': id, 'cache-control': 'no-store' } },
      );
    } catch (error) {
      const failure =
        error instanceof GatewayError
          ? error
          : new GatewayError(502, 'gateway_error', 'Unable to list available models');
      if (failure.status >= 500 || this.sampleLog(failure.code))
        this.logger[failure.status >= 500 ? 'error' : 'warn'](
          `网关模型列表请求失败 ${JSON.stringify({
            requestId: id,
            endpoint: '/v1/models',
            httpStatus: failure.status,
            errorCode: failure.code,
            durationMs: Date.now() - startedAt,
            ...errorDetails(error),
          })}`,
        );
      return this.error('/v1/models', failure.status, failure.code, failure.message, id);
    }
  }

  private async body(req: Request, signal: AbortSignal, stats: { bytes: number }) {
    if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
      throw new GatewayError(415, 'unsupported_media_type', 'Content-Type must be application/json');
    const reader = req.body?.getReader();
    if (!reader) throw new GatewayError(400, 'invalid_request', 'JSON body is required');
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        stats.bytes = size;
        if (size > this.config.maxBodyBytes) {
          await reader.cancel();
          throw new GatewayError(413, 'request_too_large', 'Request body exceeds the gateway limit');
        }
        chunks.push(value);
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
    if (signal.aborted)
      throw new GatewayError(
        signal.reason === 'body_timeout' ? 408 : 400,
        signal.reason === 'body_timeout' ? 'body_timeout' : 'request_cancelled',
        'Request body was not completed before admission',
      );
    const bytes = Buffer.concat(chunks);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new GatewayError(400, 'invalid_json', 'Invalid JSON body');
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      typeof parsed.model !== 'string' ||
      !parsed.model ||
      parsed.model.length > 128 ||
      (parsed.stream !== undefined && typeof parsed.stream !== 'boolean')
    )
      throw new GatewayError(400, 'invalid_request', 'A model name and a boolean stream option are required');
    // Async/background Responses retrieval is outside this synchronous gateway's scope.
    if (parsed.background === true)
      throw new GatewayError(400, 'unsupported_mode', 'Background responses are not supported');
    return { parsed, bytes };
  }

  private async resolveRoute(
    identity: Awaited<ReturnType<GatewayService['identify']>>,
    requestedModel: string,
    endpoint: Endpoint,
    details: { modelName?: string; upstreamTimeoutMs?: number },
  ) {
    const [model] = await this.db
      .select({
        id: models.id,
        name: models.name,
        inputTokenLimit: models.inputTokenLimit,
        outputTokenLimit: models.outputTokenLimit,
      })
      .from(models)
      .where(and(eq(models.name, requestedModel), eq(models.enabled, true), isNull(models.deletedAt)));
    if (!model) throw new GatewayError(404, 'model_not_found', 'Unknown or disabled model');
    details.modelName = model.name;
    const [keyGrant] = !identity.key.restrictModels
      ? [{ modelId: model.id }]
      : await this.db
          .select()
          .from(apiKeyModelGrants)
          .where(and(eq(apiKeyModelGrants.apiKeyId, identity.key.id), eq(apiKeyModelGrants.modelId, model.id)));
    if (!keyGrant) throw new GatewayError(403, 'model_forbidden', 'API Key does not authorize this model');

    if (!identity.channelId)
      throw new GatewayError(403, 'channel_unbound', 'Bind this legacy API Key to a channel before using it');
    const [route] = await this.db
      .select({ channel: channels, override: channelAvailableModels.multiplierMicros })
      .from(channels)
      .innerJoin(channelAvailableModels, eq(channelAvailableModels.channelId, channels.id))
      .innerJoin(channelEndpoints, eq(channelEndpoints.channelId, channels.id))
      .where(
        and(
          eq(channels.id, identity.channelId),
          eq(channels.enabled, true),
          isNull(channels.deletedAt),
          eq(channelAvailableModels.modelId, model.id),
          eq(channelEndpoints.endpoint, endpoint),
        ),
      );
    if (!route)
      throw new GatewayError(
        503,
        'channel_unavailable',
        'The API Key channel does not provide this model and endpoint',
      );
    details.upstreamTimeoutMs = route.channel.timeoutMs;

    if (identity.user.role !== 'admin' && !route.channel.isPublic) {
      const [grant] = await this.db
        .select({ channelId: userChannelGrants.channelId })
        .from(userChannelGrants)
        .where(and(eq(userChannelGrants.userId, identity.user.id), eq(userChannelGrants.channelId, route.channel.id)));
      if (!grant) throw new GatewayError(403, 'channel_forbidden', 'Channel is not authorized for this user');
    }
    return { model, ...route };
  }

  async forward(req: Request, endpoint: Endpoint): Promise<Response> {
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
    const finish = (errorCode?: string) => {
      const result = session.summary(errorCode);
      return lifecycle.finish(
        () => session.finish(result),
        () => session.log(result),
      );
    };

    try {
      if (this.stopping) throw new GatewayError(503, 'server_stopping', 'Gateway is stopping');
      this.billing.assertReady();
      const identity = await this.identify(req, endpoint);
      session.userId = identity.user.id;
      session.channelId = identity.channelId ?? undefined;
      lifecycle.releaseCapacity = this.acquire(identity.user.id);

      const { parsed, bytes } = await lifecycle.withBodyTimeout(this.config.bodyTimeoutMs, () =>
        this.body(req, abort.signal, session.bodyStats),
      );
      const streaming = parsed.stream === true;
      session.streaming = streaming;

      // 完整请求体通过校验后入库，后续模型或渠道拒绝仍保留记录。
      await this.db.insert(requests).values({
        id,
        receivedAt,
        userId: identity.user.id,
        apiKeyId: identity.key.id,
        channelId: identity.channelId,
        requestedModel: parsed.model as string,
        endpoint,
        streaming,
      });
      session.recorded = true;
      const { model, channel, override } = await this.resolveRoute(identity, parsed.model as string, endpoint, session);
      const executionChannel = await selectExecutionChannel(this.db, this.subscription, channel, parsed, endpoint);
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
      const adapter = channelAdapter(executionChannel.type, this.subscription);
      const lockedPrice = await this.pricing.lock(
        model.id,
        receivedAt,
        override ?? channel.multiplierMicros,
        override === null ? 'channel' : 'model',
      );
      if (!lockedPrice) throw new GatewayError(503, 'price_missing', 'No price is configured for this model');
      const requestedOutputLimit = validateBillableRequest(parsed, endpoint, model.outputTokenLimit);
      const outputLimit = executionChannel.type === 'subscription' ? model.outputTokenLimit : requestedOutputLimit;
      session.collector.configureSearch(searchRequest(parsed, endpoint));
      const timeoutMs = Math.min(channel.timeoutMs, executionChannel.timeoutMs);
      session.upstreamTimeoutMs = timeoutMs;
      lifecycle.setTimeout('upstream_timeout', timeoutMs);
      lifecycle.syncClientAbort();
      const prepared = await adapter.prepareRequest({
        channel: executionChannel,
        request: req,
        endpoint,
        parsed,
        bytes,
        vault: this.vault,
        signal: abort.signal,
      });

      lifecycle.releaseUpstream = prepared.release;
      const { url, body, headers } = prepared;
      if (executionChannel.subscriptionAccountId)
        await this.db
          .update(requests)
          .set({ subscriptionAccountId: executionChannel.subscriptionAccountId })
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
        body: parsed,
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
      const upstream = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: abort.signal,
        redirect: 'manual',
      });
      if (prepared.onResponse) await prepared.onResponse(upstream).catch(() => {});
      session.httpStatus = upstream.status;
      session.upstreamStatus = upstream.status;
      return await adapter.forwardResponse({
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

  async list(userId: string | undefined, page: number, reviewOnly = false) {
    const rows = await this.db
      .select({
        request: requests,
        username: users.username,
        usage: requestUsage,
        channelName: channels.name,
        channelType: channels.type,
      })
      .from(requests)
      .innerJoin(users, eq(requests.userId, users.id))
      .leftJoin(channels, eq(requests.channelId, channels.id))
      .leftJoin(requestUsage, eq(requests.id, requestUsage.requestId))
      .where(
        and(
          userId ? eq(requests.userId, userId) : undefined,
          reviewOnly ? and(eq(requests.status, 'needs_review'), eq(requests.billingEnabled, true)) : undefined,
        ),
      )
      .orderBy(desc(requests.receivedAt), desc(requests.id))
      .limit(pageSize + 1)
      .offset(page * pageSize);
    const pageRows = rows.slice(0, pageSize);
    const attempts =
      userId === undefined && pageRows.length > 0
        ? await this.db
            .select({
              id: requestAttempts.id,
              requestId: requestAttempts.requestId,
              channelId: requestAttempts.channelId,
              channelName: requestAttempts.channelName,
            })
            .from(requestAttempts)
            .where(
              inArray(
                requestAttempts.requestId,
                pageRows.map(({ request }) => request.id),
              ),
            )
            .orderBy(asc(requestAttempts.sequence))
        : [];
    return {
      currency: this.pricing.currency,
      hasMore: rows.length > pageSize,
      items: pageRows.map(({ request: r, username, usage: u, channelName, channelType }) => ({
        id: r.id,
        username,
        model: r.requestedModel,
        endpoint: r.endpoint,
        channelId: r.channelId,
        channelName,
        channelType,
        executionChannels: attempts
          .filter((attempt) => attempt.requestId === r.id)
          .map(({ id, channelId, channelName }) => ({ id, channelId, channelName })),
        status: r.status,
        billingEnabled: r.billingEnabled,
        usageFinal: r.usageFinal,
        usageEstimate: r.usageEstimate,
        reservedAmount: formatMoney(r.reservedMicros),
        heldAmount: formatMoney(r.heldMicros),
        chargedAmount: r.chargedMicros === null ? null : formatMoney(r.chargedMicros),
        quotedAmount: r.quotedMicros === null ? null : formatMoney(r.quotedMicros),
        pricing: r.pricingSnapshot,
        streaming: r.streaming,
        httpStatus: r.httpStatus,
        receivedAt: r.receivedAt.toISOString(),
        durationMs: r.finishedAt ? r.finishedAt.getTime() - r.receivedAt.getTime() : null,
        errorCode: r.errorCode,
        upstreamRequestId: r.upstreamRequestId,
        usage: u
          ? {
              input: u.inputTokens.toString(),
              output: u.outputTokens.toString(),
              cacheRead: cacheReadForDisplay(r.endpoint, r.usageFinal, u.rawUsage, u.cacheReadTokens),
              cacheWrite: u.cacheWriteTokens.toString(),
              context: u.contextTokens.toString(),
              webSearchCalls: u.webSearchCalls.toString(),
              webSearchPreviewCalls: u.webSearchPreviewCalls.toString(),
            }
          : null,
      })),
    };
  }
}
