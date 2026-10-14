import { type Disposable, serviceToken } from '@fraqjs/kernel';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';

import { GatewayError } from '../../core/errors.ts';
import type { CredentialVault } from '../../core/vault.ts';
import type { Database } from '../database/client.ts';
import { type channels, type Endpoint, subscriptionAccounts } from '../database/schema/index.ts';
import type { ChannelAdapter, SubscriptionChannels } from '../gateway/adapters.ts';
import type { OutboundHttp } from '../outbound/index.ts';
import { claudeAdapter } from './claude/adapter.ts';
import { claudeCredentialsSchema } from './claude/credentials.ts';
import { claudeRateLimit } from './claude/ratelimit.ts';
import { ClaudeSessions } from './claude/session.ts';
import { ClaudeTokens } from './claude/tokens.ts';
import { SubscriptionConcurrency } from './concurrency.ts';
import { openAIAdapter } from './openai/adapter.ts';
import { credentialsSchema } from './openai/credentials.ts';
import { OpenAITokens } from './openai/tokens.ts';
import { providerSupports } from './providers.ts';

/**
 * 订阅渠道的运行时：为网关提供适配器，管理账号并发、令牌和会话，并根据上游响应记录限流与失效。
 */
export class SubscriptionRuntime implements Disposable, SubscriptionChannels {
  static readonly token = serviceToken<SubscriptionRuntime>('ohmyapi/subscription-runtime');
  readonly concurrency = new SubscriptionConcurrency();
  readonly tokens: OpenAITokens;
  readonly claudeTokens: ClaudeTokens;
  readonly claudeSessions = new ClaudeSessions();
  private refreshing = false;
  private stopped = false;

  private readonly db: Database;
  private readonly vault: CredentialVault;
  constructor(deps: { db: Database; vault: CredentialVault; outbound: OutboundHttp }) {
    this.db = deps.db;
    this.vault = deps.vault;
    this.tokens = new OpenAITokens(deps.db, deps.vault, deps.outbound);
    this.claudeTokens = new ClaudeTokens(deps.db, deps.vault, deps.outbound);
  }

  async adapterFor(channel: typeof channels.$inferSelect): Promise<ChannelAdapter> {
    if (!channel.subscriptionAccountId)
      throw new GatewayError(503, 'subscription_unavailable', 'Bind a subscription account first');
    const provider = await this.provider(channel.subscriptionAccountId);
    if (provider === 'claude') return claudeAdapter(this);
    if (provider === 'openai') return openAIAdapter(this);
    throw new GatewayError(503, 'subscription_unavailable', 'Unsupported subscription provider');
  }

  supportsEndpoint(provider: string, endpoint: Endpoint) {
    return providerSupports(provider, endpoint);
  }

  activeRequests(accountId: string) {
    return this.concurrency.active(accountId);
  }

  async provider(id: string) {
    const [row] = await this.db
      .select({ provider: subscriptionAccounts.provider })
      .from(subscriptionAccounts)
      .where(and(eq(subscriptionAccounts.id, id), isNull(subscriptionAccounts.deletedAt)));
    if (!row) throw new GatewayError(503, 'subscription_unavailable', 'The subscription account is unavailable');
    return row.provider;
  }

  async acquire(id: string, signal: AbortSignal) {
    const [row] = await this.db
      .select()
      .from(subscriptionAccounts)
      .where(and(eq(subscriptionAccounts.id, id), isNull(subscriptionAccounts.deletedAt)));
    if (this.stopped || !row?.enabled || row.provider !== 'openai' || row.errorCode)
      throw new GatewayError(503, 'subscription_unavailable', 'The subscription account is unavailable');
    if (row.cooldownUntil && row.cooldownUntil.getTime() > Date.now())
      throw new GatewayError(429, 'subscription_rate_limited', 'The subscription account is cooling down');
    const release = this.concurrency.acquire(id, row.maxConcurrent);
    const cancelled = () => new GatewayError(400, 'request_cancelled', 'Request was cancelled before forwarding');
    let onAbort = () => {};
    try {
      if (signal.aborted) throw cancelled();
      const credentials = await Promise.race([
        this.tokens.get(id),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(cancelled());
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      return { credentials, release };
    } catch (error) {
      release();
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async acquireClaude(id: string, signal: AbortSignal, model: string, proxyUrl: string | null) {
    const [row] = await this.db
      .select()
      .from(subscriptionAccounts)
      .where(and(eq(subscriptionAccounts.id, id), isNull(subscriptionAccounts.deletedAt)));
    if (this.stopped || !row?.enabled || row.provider !== 'claude' || row.errorCode)
      throw new GatewayError(503, 'subscription_unavailable', 'The Claude account is unavailable');
    if ((row.cooldownUntil?.getTime() ?? 0) > Date.now() || Date.parse(row.modelCooldowns[model] ?? '') > Date.now())
      throw new GatewayError(429, 'subscription_rate_limited', 'The Claude account or model is cooling down');
    const release = this.concurrency.acquire(id, row.maxConcurrent);
    const cancelled = () => new GatewayError(400, 'request_cancelled', 'Request cancelled before forwarding');
    let onAbort = () => {};
    try {
      if (signal.aborted) throw cancelled();
      const credentials = await Promise.race([
        this.claudeTokens.get(id, false, proxyUrl),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(cancelled());
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      return { credentials, release };
    } catch (error) {
      release();
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async reportClaudeStatus(id: string, model: string, response: Response, accessToken: string) {
    let errorBody = '';
    if (response.status === 429) {
      const reader = response.clone().body?.getReader();
      if (reader) {
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (size < 16_384) {
            const { value, done } = await reader.read();
            if (done) break;
            const part = value.subarray(0, 16_384 - size);
            chunks.push(part);
            size += part.byteLength;
          }
          errorBody = Buffer.concat(chunks).toString('utf8');
        } finally {
          // tee 的另一个分支由响应转发消费，不能等待此分支取消完成。
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
    }
    const limit = claudeRateLimit(response.headers, response.status, errorBody);
    if (response.status !== 401 && !limit) return;
    const [row] = await this.db.select().from(subscriptionAccounts).where(eq(subscriptionAccounts.id, id));
    if (
      row?.provider !== 'claude' ||
      claudeCredentialsSchema.parse(JSON.parse(this.vault.decrypt(row.credentialEncrypted))).accessToken !== accessToken
    )
      return;
    const values =
      response.status === 401
        ? { errorCode: 'subscription_reauthorization_required' }
        : limit?.modelOnly
          ? {
              modelCooldowns: sql`jsonb_set(${subscriptionAccounts.modelCooldowns}, ARRAY[${model}]::text[], to_jsonb(greatest(${subscriptionAccounts.modelCooldowns}->>${model}, ${limit.until.toISOString()}::text)))`,
            }
          : {
              cooldownUntil: sql`greatest(${subscriptionAccounts.cooldownUntil}, ${limit?.until.toISOString()}::timestamptz)`,
            };
    await this.db
      .update(subscriptionAccounts)
      .set(values)
      .where(
        and(eq(subscriptionAccounts.id, id), eq(subscriptionAccounts.credentialEncrypted, row.credentialEncrypted)),
      );
  }

  async reportStatus(id: string, status: number, headers: Headers, accessToken: string) {
    if (status !== 401 && status !== 429) return;
    const [current] = await this.db.select().from(subscriptionAccounts).where(eq(subscriptionAccounts.id, id));
    if (
      !current ||
      credentialsSchema.parse(JSON.parse(this.vault.decrypt(current.credentialEncrypted))).accessToken !== accessToken
    )
      return;
    const raw = headers.get('retry-after');
    const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : raw ? (Date.parse(raw) - Date.now()) / 1000 : 60;
    await this.db
      .update(subscriptionAccounts)
      .set(
        status === 401
          ? { errorCode: 'subscription_reauthorization_required' }
          : {
              cooldownUntil: new Date(
                Date.now() + (Number.isFinite(seconds) ? Math.max(1, Math.min(seconds, 86400)) : 60) * 1000,
              ),
            },
      )
      .where(
        and(eq(subscriptionAccounts.id, id), eq(subscriptionAccounts.credentialEncrypted, current.credentialEncrypted)),
      );
  }

  /** 提前刷新即将过期的订阅令牌。 */
  async refreshExpiringTokens() {
    if (this.refreshing || this.stopped) return;
    this.refreshing = true;
    try {
      const rows = await this.db
        .select({ id: subscriptionAccounts.id, provider: subscriptionAccounts.provider })
        .from(subscriptionAccounts)
        .where(
          and(
            eq(subscriptionAccounts.enabled, true),
            isNull(subscriptionAccounts.deletedAt),
            isNull(subscriptionAccounts.errorCode),
            lt(subscriptionAccounts.expiresAt, new Date(Date.now() + 60_000)),
          ),
        )
        .limit(100);
      for (const row of rows) {
        if (this.stopped) break;
        await (row.provider === 'claude' ? this.claudeTokens : this.tokens).get(row.id).catch(() => {});
      }
    } finally {
      this.refreshing = false;
    }
  }

  async dispose() {
    this.stopped = true;
    await Promise.all([this.tokens.dispose(), this.claudeTokens.dispose()]);
  }
}
