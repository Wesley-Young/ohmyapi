import { serviceToken } from '@fraqjs/kernel';
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';

import { validateBillableRequest } from '../billing/admission.js';
import { formatMoney } from '../billing/conventions.js';
import type { readGatewayConfig } from '../config.js';
import type { Database } from '../db/client.js';
import {
  apiKeyChannels,
  apiKeyModelGrants,
  apiKeys,
  channelAvailableModels,
  channelEndpoints,
  channels,
  models,
  requests,
  requestUsage,
  userModelGrants,
  users,
} from '../db/schema/index.js';
import { GatewayError } from '../gateway/errors.js';
import { SseObserver, UsageCollector } from '../gateway/usage.js';
import type { BillingService, BillingSummary } from './billing.js';
import type { CredentialVault, Endpoint } from './catalog.js';
import type { PricingService } from './pricing.js';
import { pageSize } from './users.js';

import { randomUUID } from 'node:crypto';

type Config = ReturnType<typeof readGatewayConfig>;
export class GatewayService {
  static readonly token = serviceToken<GatewayService>('ohmyapi/gateway');
  private readonly limits = new Map<string, { active: number; count: number; reset: number }>();
  private readonly db: Database;
  private readonly vault: CredentialVault;
  readonly config: Config;
  private readonly logError: (message: string) => void;
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
    config: Config,
    logError: (message: string) => void,
  ) {
    this.db = db;
    this.pricing = pricing;
    this.billing = billing;
    this.vault = vault;
    this.config = config;
    this.logError = logError;
  }
  dispose() {
    this.stopping = true;
    this.disposal ??= (async () => {
      const entries = [...this.running.values()];
      for (const e of entries) e.abort.abort('server_shutdown');
      await Promise.allSettled(entries.map((e) => e.done));
    })();
    return this.disposal;
  }
  error(endpoint: Endpoint, status: number, code: string, message: string, id: string) {
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
  private async identify(req: Request, endpoint: Endpoint) {
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
  private async body(req: Request, signal: AbortSignal) {
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
  async forward(req: Request, endpoint: Endpoint): Promise<Response> {
    const id = randomUUID();
    const receivedAt = new Date();
    let dispatched = false;
    let recorded = false;
    let release: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    let completeRequest: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      completeRequest = resolve;
    });
    this.running.set(id, { abort, done });
    const disconnect = () => abort.abort('client_disconnected');
    req.signal.addEventListener('abort', disconnect, { once: true });
    let finalization: Promise<void> | undefined;
    const onAbort = () => {
      void finish(typeof abort.signal.reason === 'string' ? abort.signal.reason : 'upstream_disconnected');
    };
    const collector = new UsageCollector(endpoint);
    let httpStatus: number | undefined;
    let safeRejection = false;
    const summary = (errorCode?: string): BillingSummary => ({
      usage: collector.usage,
      usageFinal: collector.finalUsage && !collector.invalid && !collector.unknownCosts,
      blockSettlement: collector.invalid || collector.unknownCosts,
      httpStatus,
      upstreamRequestId: collector.upstreamId,
      noExecution: !dispatched || safeRejection,
      errorCode:
        errorCode ??
        (collector.unknownCosts
          ? 'unsupported_usage'
          : collector.failed
            ? 'upstream_error'
            : collector.invalid
              ? 'invalid_usage'
              : !collector.usage
                ? 'usage_missing'
                : !collector.finalUsage
                  ? 'usage_not_final'
                  : undefined),
    });
    const finish = (errorCode?: string): Promise<void> => {
      if (finalization) return finalization;
      if (timer) clearTimeout(timer);
      req.signal.removeEventListener('abort', disconnect);
      abort.signal.removeEventListener('abort', onAbort);
      finalization = (async () => {
        try {
          if (recorded) await this.billing.finish(id, summary(errorCode));
        } catch {
          this.logError(`Billing finalization deferred: ${id}`);
        } finally {
          release?.();
          this.running.delete(id);
          completeRequest();
        }
      })();
      return finalization;
    };
    try {
      if (this.stopping) throw new GatewayError(503, 'server_stopping', 'Gateway is stopping');
      this.billing.assertReady();
      if (!this.config.enabled) throw new GatewayError(503, 'gateway_disabled', 'Gateway is disabled');
      const identity = await this.identify(req, endpoint);
      release = this.acquire(identity.user.id);
      const bodyTimer = setTimeout(() => abort.abort('body_timeout'), 30000);
      let payload: Awaited<ReturnType<GatewayService['body']>>;
      try {
        payload = await this.body(req, abort.signal);
      } finally {
        clearTimeout(bodyTimer);
      }
      const { parsed, bytes } = payload;
      const streaming = parsed.stream === true;
      await this.db.insert(requests).values({
        id,
        receivedAt,
        userId: identity.user.id,
        apiKeyId: identity.key.id,
        requestedModel: parsed.model as string,
        endpoint,
        streaming,
      });
      recorded = true;
      const [model] = await this.db
        .select({ id: models.id, inputTokenLimit: models.inputTokenLimit, outputTokenLimit: models.outputTokenLimit })
        .from(models)
        .where(and(eq(models.name, parsed.model as string), eq(models.enabled, true), isNull(models.deletedAt)));
      if (!model) throw new GatewayError(404, 'model_not_found', 'Unknown or disabled model');
      const [grant] =
        identity.user.role === 'admin'
          ? [{ modelId: model.id }]
          : await this.db
              .select()
              .from(userModelGrants)
              .where(and(eq(userModelGrants.userId, identity.user.id), eq(userModelGrants.modelId, model.id)));
      const [keyGrant] = !identity.key.restrictModels
        ? [{ modelId: model.id }]
        : await this.db
            .select()
            .from(apiKeyModelGrants)
            .where(and(eq(apiKeyModelGrants.apiKeyId, identity.key.id), eq(apiKeyModelGrants.modelId, model.id)));
      if (!grant || !keyGrant)
        throw new GatewayError(403, 'model_forbidden', 'Model is not authorized for this user and API Key');
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
      const lockedPrice = await this.pricing.lock(
        model.id,
        receivedAt,
        route.override ?? route.channel.multiplierMicros,
        route.override === null ? 'channel' : 'model',
      );
      if (!lockedPrice) throw new GatewayError(503, 'price_missing', 'No price is configured for this model');
      const outputLimit = validateBillableRequest(
        parsed,
        bytes.byteLength,
        endpoint,
        model.inputTokenLimit,
        model.outputTokenLimit,
      );
      const credential = this.vault.decrypt(route.channel.credentialEncrypted);
      const headers = new Headers({
        'content-type': 'application/json',
        accept: streaming ? 'text/event-stream' : 'application/json',
      });
      if (endpoint === '/v1/messages') {
        headers.set('x-api-key', credential);
        const version = req.headers.get('anthropic-version') ?? '2023-06-01';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(version))
          throw new GatewayError(400, 'invalid_version', 'Invalid anthropic-version');
        headers.set('anthropic-version', version);
        const beta = req.headers.get('anthropic-beta');
        if (beta) headers.set('anthropic-beta', beta);
      } else headers.set('authorization', `Bearer ${credential}`);
      await this.billing.reserve({
        requestId: id,
        userId: identity.user.id,
        keyId: identity.key.id,
        modelId: model.id,
        channelId: route.channel.id,
        price: lockedPrice,
        inputLimit: model.inputTokenLimit,
        outputLimit,
        body: parsed,
        endpoint,
      });
      if (req.signal.aborted) disconnect();
      if (abort.signal.aborted)
        throw new GatewayError(400, 'request_cancelled', 'Request was cancelled before forwarding');
      await this.billing.forwarding(id);
      timer = setTimeout(() => abort.abort('upstream_timeout'), route.channel.timeoutMs);
      if (req.signal.aborted) disconnect();
      // Base URL accepts both an origin/prefix and an SDK-style .../v1 URL.
      const base = route.channel.baseUrl.replace(/\/+$/, '');
      const target = `${base}${base.endsWith('/v1') ? endpoint.slice(3) : endpoint}`;
      dispatched = true;
      const upstream = await fetch(target, {
        method: 'POST',
        headers,
        body: bytes,
        signal: abort.signal,
        redirect: 'manual',
      });
      httpStatus = upstream.status;
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel();
        throw new GatewayError(502, 'upstream_redirect', 'Upstream redirects are not supported');
      }
      const responseHeaders = new Headers({ 'x-request-id': id, 'cache-control': 'no-store' });
      for (const name of [
        'content-type',
        'retry-after',
        'x-ratelimit-limit-requests',
        'x-ratelimit-remaining-requests',
        'x-ratelimit-reset-requests',
      ]) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders.set(name, value);
      }
      collector.upstreamId = (upstream.headers.get('x-request-id') ?? upstream.headers.get('request-id'))?.slice(
        0,
        256,
      );
      if (!upstream.body) {
        await finish('empty_response');
        return new Response(null, { status: upstream.status, headers: responseHeaders });
      }
      const isSse = upstream.headers.get('content-type')?.toLowerCase().includes('text/event-stream') ?? false;
      if (isSse) responseHeaders.set('x-accel-buffering', 'no');
      const observer = isSse ? new SseObserver(collector) : undefined;
      const jsonChunks: Uint8Array[] = [];
      let jsonSize = 0;
      const reader = upstream.body.getReader();
      abort.signal.addEventListener('abort', onAbort, { once: true });
      let finalCheckpoint = false;
      let blockedCheckpoint = false;
      const stream = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          try {
            const { value, done } = await reader.read();
            if (done) {
              observer?.finish();
              if (!isSse && jsonSize <= 8 * 1024 * 1024) {
                try {
                  collector.observe(JSON.parse(Buffer.concat(jsonChunks).toString('utf8')));
                  if (endpoint === '/v1/chat/completions') collector.done();
                } catch {
                  collector.invalid = true;
                }
              }
              safeRejection =
                !collector.usage &&
                collector.failed &&
                !collector.invalid &&
                [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(upstream.status);
              await finish(
                !upstream.ok ? 'upstream_http_error' : streaming !== isSse ? 'unexpected_response_type' : undefined,
              );
              controller.close();
              reader.releaseLock();
              return;
            }
            observer?.push(value);
            if (!finalCheckpoint && collector.finalUsage && !collector.invalid && !collector.unknownCosts) {
              finalCheckpoint = true;
              try {
                await this.billing.checkpoint(id, summary());
              } catch {
                this.logError(`Final usage checkpoint failed: ${id}`);
              }
            }
            if (!blockedCheckpoint && (collector.invalid || collector.unknownCosts)) {
              blockedCheckpoint = true;
              try {
                await this.billing.checkpoint(id, summary());
              } catch {
                this.logError(`Usage validation checkpoint failed: ${id}`);
              }
            }
            if (!isSse) {
              jsonSize += value.byteLength;
              if (jsonSize <= 8 * 1024 * 1024) jsonChunks.push(value);
              else {
                jsonChunks.length = 0;
                collector.invalid = true;
              }
            }
            controller.enqueue(value);
          } catch {
            abort.abort(abort.signal.reason ?? 'upstream_disconnected');
            await reader.cancel().catch(() => {});
            await finish(typeof abort.signal.reason === 'string' ? abort.signal.reason : 'upstream_disconnected');
            controller.error(new Error('Upstream stream interrupted'));
          }
        },
        cancel: async () => {
          abort.abort('client_disconnected');
          await reader.cancel().catch(() => {});
          await finish('client_disconnected');
        },
      });
      return new Response(stream, { status: upstream.status, headers: responseHeaders });
    } catch (error) {
      const failure =
        error instanceof GatewayError
          ? error
          : new GatewayError(
              abort.signal.reason === 'upstream_timeout' ? 504 : 502,
              abort.signal.reason === 'upstream_timeout' ? 'upstream_timeout' : 'gateway_error',
              'Unable to complete the upstream request',
            );
      httpStatus = failure.status;
      await finish(failure.code);
      return this.error(endpoint, failure.status, failure.code, failure.message, id);
    }
  }
  async list(userId: string | undefined, page: number, reviewOnly = false) {
    const rows = await this.db
      .select({ request: requests, username: users.username, usage: requestUsage })
      .from(requests)
      .innerJoin(users, eq(requests.userId, users.id))
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
    return {
      currency: this.pricing.currency,
      hasMore: rows.length > pageSize,
      items: rows.slice(0, pageSize).map(({ request: r, username, usage: u }) => ({
        id: r.id,
        username,
        model: r.requestedModel,
        endpoint: r.endpoint,
        channelId: r.channelId,
        status: r.status,
        billingEnabled: r.billingEnabled,
        usageFinal: r.usageFinal,
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
              cacheRead: u.cacheReadTokens.toString(),
              cacheWrite: u.cacheWriteTokens.toString(),
              context: u.contextTokens.toString(),
            }
          : null,
      })),
    };
  }
}
