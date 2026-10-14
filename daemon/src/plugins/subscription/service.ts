import { type Disposable, serviceToken } from '@fraqjs/kernel';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';

import { GatewayError } from '../../core/errors.js';
import type { CredentialVault } from '../../core/vault.js';
import type { AuthService, Principal } from '../auth/service.js';
import { channelProxy } from '../catalog/proxy.js';
import type { Database, Transaction } from '../database/client.js';
import { adminAuditLogs, channels, subscriptionAccounts } from '../database/schema/index.js';
import { type OutboundHttp, proxyUrlInput } from '../outbound/index.js';
import { fetchClaudeModels } from './claude/catalog.js';
import { importClaudeCredentials } from './claude/client.js';
import { type ClaudeCredentials, claudeCredentialsSchema } from './claude/credentials.js';
import { ClaudeOAuth } from './claude/oauth.js';
import { ClaudeQuota } from './claude/quota.js';
import { claudeRateLimit } from './claude/ratelimit.js';
import { ClaudeSessions } from './claude/session.js';
import { ClaudeTokens } from './claude/tokens.js';
import { SubscriptionConcurrency } from './concurrency.js';
import { estimateCycleUsage } from './cycle.js';
import { accountHeaders, codexBaseUrl, latestCodexClientVersion, readJson } from './openai/client.js';
import { credentialsSchema, type OpenAICredentials, parseCredentials } from './openai/credentials.js';
import { OpenAIOAuth } from './openai/oauth.js';
import { OpenAIQuota } from './openai/quota.js';
import { OpenAIResetCredits } from './openai/reset-credits.js';
import { OpenAITokens } from './openai/tokens.js';

const credentialInput = z.object({
  provider: z.enum(['openai', 'claude']).default('openai'),
  credentials: z.string().min(1).max(60000).optional(),
  callbackUrl: z.url().max(8192).optional(),
});
export const subscriptionInput = credentialInput
  .extend({ maxConcurrent: z.number().int().min(1).max(100).default(5) })
  .refine((input) => !(input.credentials && input.callbackUrl), '请选择一种接入方式');
export const fetchSubscriptionModelsInput = credentialInput
  .extend({ channelId: z.uuid().optional(), proxyUrl: proxyUrlInput })
  .refine((input) => !(input.credentials && input.callbackUrl), '请选择一种接入方式');

export class SubscriptionService implements Disposable {
  static readonly token = serviceToken<SubscriptionService>('ohmyapi/subscription');
  readonly concurrency = new SubscriptionConcurrency();
  readonly tokens: OpenAITokens;
  readonly claudeTokens: ClaudeTokens;
  readonly claudeSessions = new ClaudeSessions();
  private readonly oauth = new OpenAIOAuth();
  private readonly claudeOAuth = new ClaudeOAuth();
  private readonly openaiQuota = new OpenAIQuota();
  private readonly claudeQuota = new ClaudeQuota();
  private readonly openaiResetCredits = new OpenAIResetCredits();
  private refreshing = false;
  private stopped = false;

  private readonly db: Database;
  private readonly auth: AuthService;
  private readonly vault: CredentialVault;
  private readonly outbound: OutboundHttp;
  constructor(deps: { db: Database; auth: AuthService; vault: CredentialVault; outbound: OutboundHttp }) {
    this.db = deps.db;
    this.auth = deps.auth;
    this.vault = deps.vault;
    this.outbound = deps.outbound;
    this.tokens = new OpenAITokens(deps.db, deps.vault, deps.outbound);
    this.claudeTokens = new ClaudeTokens(deps.db, deps.vault, deps.outbound);
  }

  /** 定期清理过期的授权会话，并提前刷新即将过期的订阅令牌。 */
  async maintain() {
    this.oauth.prune();
    this.claudeOAuth.prune();
    await this.refreshExpiring().catch(() => {});
  }

  accountEmail(encrypted: string, provider = 'openai'): string | null {
    try {
      // 已保存的旧凭据可从 access_token 读取邮箱，后续刷新会写入 email。
      const raw = JSON.parse(this.vault.decrypt(encrypted));
      return (provider === 'claude' ? claudeCredentialsSchema.parse(raw) : parseCredentials(raw)).email ?? null;
    } catch {
      return null;
    }
  }

  consumeAuthorization(principal: Principal, callbackUrl: string, provider: 'openai' | 'claude') {
    (provider === 'claude' ? this.claudeOAuth : this.oauth).consume(principal.user.id, callbackUrl);
  }

  async prepareCredentials(principal: Principal, input: z.infer<typeof credentialInput>, proxyUrl: string | null) {
    await this.auth.authorized(principal, { admin: true }, async () => {});
    if (input.callbackUrl) {
      try {
        const oauth = input.provider === 'claude' ? this.claudeOAuth : this.oauth;
        return await oauth.complete(principal.user.id, input.callbackUrl, this.outbound.forProxy(proxyUrl));
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'BAD_REQUEST', message: '授权失败，请重新授权并粘贴完整回调地址' });
      }
    }
    if (input.provider === 'claude') {
      if (!input.credentials) return;
      try {
        return await importClaudeCredentials(JSON.parse(input.credentials), this.outbound.forProxy(proxyUrl));
      } catch {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Claude 凭据无效；需要 OAuth 令牌、有效期及 account_uuid，缺少账号信息时将通过代理查询',
        });
      }
    }
    if (input.credentials) {
      try {
        return parseCredentials(JSON.parse(input.credentials));
      } catch {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: '凭据格式无效，需要 access_token、账号 ID 和有效期；支持 Codex auth.json',
        });
      }
    }
  }

  async saveAccount(
    tx: Transaction,
    input: { id?: string; name: string; enabled: boolean; maxConcurrent: number; provider: 'openai' | 'claude' },
    credentials?: OpenAICredentials | ClaudeCredentials,
  ) {
    const [existing] = input.id
      ? await tx
          .select()
          .from(subscriptionAccounts)
          .where(and(eq(subscriptionAccounts.id, input.id), isNull(subscriptionAccounts.deletedAt)))
          .for('update')
      : [];
    if (existing && existing.provider !== input.provider)
      throw new TRPCError({ code: 'BAD_REQUEST', message: '订阅平台不可更改，请新建渠道' });
    if (input.id && !existing) throw new TRPCError({ code: 'NOT_FOUND', message: '订阅账号不存在' });
    if (!existing && !credentials) throw new TRPCError({ code: 'BAD_REQUEST', message: '请导入凭据或完成授权' });
    if (
      existing &&
      credentials &&
      (existing.accountId !== credentials.accountId || existing.userId !== credentials.userId)
    )
      throw new TRPCError({ code: 'BAD_REQUEST', message: '新凭据属于其他账号，请新建订阅渠道' });
    if (credentials) {
      if (existing) {
        const raw = JSON.parse(this.vault.decrypt(existing.credentialEncrypted));
        const saved =
          existing.provider === 'claude' ? claudeCredentialsSchema.parse(raw) : credentialsSchema.parse(raw);
        credentials = {
          ...credentials,
          ...('deviceId' in saved ? { deviceId: saved.deviceId } : {}),
          refreshToken: credentials.refreshToken ?? saved.refreshToken,
          email:
            credentials.email ??
            saved.email ??
            this.accountEmail(existing.credentialEncrypted, existing.provider) ??
            undefined,
        };
      }
      const [duplicate] = await tx
        .select({ id: subscriptionAccounts.id })
        .from(subscriptionAccounts)
        .where(
          and(
            eq(subscriptionAccounts.provider, input.provider),
            eq(subscriptionAccounts.accountId, credentials.accountId),
            eq(subscriptionAccounts.userId, credentials.userId),
            isNull(subscriptionAccounts.deletedAt),
          ),
        );
      if (duplicate && duplicate.id !== input.id)
        throw new TRPCError({ code: 'CONFLICT', message: '该订阅账号已存在，请编辑对应订阅渠道' });
    }
    const values = {
      name: input.name,
      provider: input.provider,
      enabled: input.enabled,
      maxConcurrent: input.maxConcurrent,
      ...(credentials
        ? {
            accountId: credentials.accountId,
            userId: credentials.userId,
            credentialEncrypted: this.vault.encrypt(JSON.stringify(credentials)),
            expiresAt: new Date(credentials.expiresAt),
            errorCode: null,
            cooldownUntil: null,
            modelCooldowns: {},
          }
        : {}),
    };
    let row: { id: string };
    if (existing) {
      [row] = await tx
        .update(subscriptionAccounts)
        .set(values)
        .where(eq(subscriptionAccounts.id, existing.id))
        .returning({ id: subscriptionAccounts.id });
    } else {
      if (!credentials) throw new TRPCError({ code: 'BAD_REQUEST', message: '请导入凭据或完成授权' });
      const [created] = await tx
        .insert(subscriptionAccounts)
        .values({
          ...values,
          accountId: credentials.accountId,
          userId: credentials.userId,
          credentialEncrypted: this.vault.encrypt(JSON.stringify(credentials)),
          expiresAt: new Date(credentials.expiresAt),
        })
        .onConflictDoNothing()
        .returning({ id: subscriptionAccounts.id });
      if (!created) throw new TRPCError({ code: 'CONFLICT', message: '该订阅账号已存在，请编辑对应订阅渠道' });
      row = created;
    }
    this.openaiQuota.invalidate(row.id);
    this.claudeQuota.invalidate(row.id);
    return row.id;
  }

  async startOAuth(principal: Principal, provider: 'openai' | 'claude' = 'openai') {
    return this.auth.authorized(principal, { admin: true }, async () =>
      (provider === 'claude' ? this.claudeOAuth : this.oauth).start(principal.user.id),
    );
  }
  async refresh(principal: Principal, channelId: string) {
    const id = await this.accountForChannel(principal, channelId);
    try {
      await ((await this.provider(id)) === 'claude' ? this.claudeTokens : this.tokens).get(id, true);
      this.openaiQuota.invalidate(id);
      this.claudeQuota.invalidate(id);
    } catch {
      throw new TRPCError({ code: 'BAD_REQUEST', message: '刷新失败，请检查账号状态或重新授权' });
    }
    return { success: true };
  }
  async openAIQuota(principal: Principal, channelId: string, force = false) {
    const id = await this.providerAccountForChannel(principal, channelId, 'openai');
    return this.openaiQuota.get(this.tokens, id, force);
  }
  async claudeUsage(principal: Principal, channelId: string, force = false) {
    const id = await this.providerAccountForChannel(principal, channelId, 'claude');
    return this.claudeQuota.get(this.claudeTokens, id, force);
  }
  async listOpenAIResetCredits(principal: Principal, channelId: string) {
    const id = await this.providerAccountForChannel(principal, channelId, 'openai');
    return this.openaiResetCredits.list(this.tokens, id);
  }
  async consumeOpenAIResetCredit(
    principal: Principal,
    input: { channelId: string; creditId: string; redeemRequestId: string },
  ) {
    const id = await this.providerAccountForChannel(principal, input.channelId, 'openai');
    try {
      const result = await this.openaiResetCredits.consume(this.tokens, id, input.creditId, input.redeemRequestId);
      // 上游已完成的兑换不因本地状态更新失败而被报告为使用失败。
      const cooldownCleared =
        result.windowsReset > 0
          ? await this.db
              .update(subscriptionAccounts)
              .set({ cooldownUntil: null })
              .where(eq(subscriptionAccounts.id, id))
              .then(
                () => true,
                () => false,
              )
          : true;
      return { ...result, cooldownCleared };
    } finally {
      this.openaiQuota.invalidate(id);
    }
  }
  /**
   * 当前 7d 周期的等效 API 费用估算。周期起点取上游 resetsAt − 7d；Claude 续费等提前重置
   * 由管理员填写，落在当前上游周期内时取较晚者。上游额度不可用时退回最近 7 天。
   */
  async cycleUsage(principal: Principal, channelId: string) {
    const id = await this.accountForChannel(principal, channelId);
    const [account] = await this.db
      .select({
        provider: subscriptionAccounts.provider,
        enabled: subscriptionAccounts.enabled,
        cycleResetAt: subscriptionAccounts.cycleResetAt,
      })
      .from(subscriptionAccounts)
      .where(and(eq(subscriptionAccounts.id, id), isNull(subscriptionAccounts.deletedAt)));
    if (!account?.enabled || (account.provider !== 'openai' && account.provider !== 'claude'))
      throw new TRPCError({ code: 'BAD_REQUEST', message: '渠道未启用或已删除' });
    const quota = await (account.provider === 'claude'
      ? this.claudeQuota.get(this.claudeTokens, id)
      : this.openaiQuota.get(this.tokens, id)
    ).catch(() => null);
    const now = new Date();
    const week = 7 * 24 * 60 * 60 * 1000;
    const resetsAt = quota?.sevenDay?.resetsAt ? new Date(quota.sevenDay.resetsAt) : null;
    const upstream = resetsAt !== null && resetsAt.getTime() > now.getTime();
    let startsAt = new Date((upstream ? resetsAt.getTime() : now.getTime()) - week);
    let source: 'upstream' | 'manual' | 'rolling' = upstream ? 'upstream' : 'rolling';
    const manual = account.provider === 'claude' ? account.cycleResetAt : null;
    const manualActive = !!manual && manual.getTime() > startsAt.getTime() && manual.getTime() <= now.getTime();
    if (manual && manualActive) {
      startsAt = manual;
      source = 'manual';
    }
    const usage = await estimateCycleUsage(this.db, id, startsAt, now);
    const usedPercent = upstream ? (quota?.sevenDay?.usedPercent ?? null) : null;
    // 已用比例过低时取整误差会被放大，不推算整个周期的额度。
    const projectedAmount =
      usedPercent !== null && usedPercent >= 5 ? ((Number(usage.amount) * 100) / usedPercent).toFixed(6) : null;
    return {
      provider: account.provider,
      startsAt: startsAt.toISOString(),
      resetsAt: upstream ? resetsAt.toISOString() : null,
      source,
      manualResetAt: manual?.toISOString() ?? null,
      manualResetActive: manualActive,
      usedPercent,
      projectedAmount,
      ...usage,
    };
  }
  async setCycleReset(principal: Principal, input: { channelId: string; resetAt: string | null }) {
    const id = await this.accountForChannel(principal, input.channelId);
    const resetAt = input.resetAt ? new Date(input.resetAt) : null;
    if (resetAt && resetAt.getTime() > Date.now() + 60_000)
      throw new TRPCError({ code: 'BAD_REQUEST', message: '重置时刻不能晚于当前时间' });
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [account] = await tx
        .select({ provider: subscriptionAccounts.provider, cycleResetAt: subscriptionAccounts.cycleResetAt })
        .from(subscriptionAccounts)
        .where(and(eq(subscriptionAccounts.id, id), isNull(subscriptionAccounts.deletedAt)))
        .for('update');
      if (account?.provider !== 'claude')
        throw new TRPCError({ code: 'BAD_REQUEST', message: '仅 Claude 订阅需要手动填写重置时刻' });
      await tx.update(subscriptionAccounts).set({ cycleResetAt: resetAt }).where(eq(subscriptionAccounts.id, id));
      await tx.insert(adminAuditLogs).values({
        actorId: actor.id,
        action: 'subscription.cycle_reset',
        targetType: 'subscription_account',
        targetId: id,
        metadata: {
          previous: account.cycleResetAt?.toISOString() ?? null,
          resetAt: resetAt?.toISOString() ?? null,
        },
      });
      return { success: true };
    });
  }
  private async providerAccountForChannel(principal: Principal, channelId: string, provider: 'openai' | 'claude') {
    const id = await this.accountForChannel(principal, channelId);
    const [account] = await this.db
      .select({ provider: subscriptionAccounts.provider, enabled: subscriptionAccounts.enabled })
      .from(subscriptionAccounts)
      .where(and(eq(subscriptionAccounts.id, id), isNull(subscriptionAccounts.deletedAt)));
    if (account?.provider !== provider || !account.enabled)
      throw new TRPCError({ code: 'BAD_REQUEST', message: '订阅平台不匹配，或渠道未启用、已删除' });
    return id;
  }
  private async accountForChannel(principal: Principal, channelId: string) {
    return this.auth.authorized(principal, { admin: true }, async (tx) => {
      const [channel] = await tx
        .select({ accountId: channels.subscriptionAccountId })
        .from(channels)
        .where(and(eq(channels.id, channelId), eq(channels.type, 'subscription'), isNull(channels.deletedAt)));
      if (!channel?.accountId) throw new TRPCError({ code: 'NOT_FOUND', message: '订阅渠道不存在' });
      return channel.accountId;
    });
  }

  async removeAccount(tx: Transaction, id: string) {
    const [row] = await tx
      .select()
      .from(subscriptionAccounts)
      .where(and(eq(subscriptionAccounts.id, id), isNull(subscriptionAccounts.deletedAt)))
      .for('update');
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: '订阅账号不存在' });
    if (this.concurrency.active(id)) throw new TRPCError({ code: 'CONFLICT', message: '请等待该渠道请求结束后再删除' });
    await tx
      .update(subscriptionAccounts)
      .set({ deletedAt: new Date(), enabled: false })
      .where(eq(subscriptionAccounts.id, id));
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

  async provider(id: string) {
    const [row] = await this.db
      .select({ provider: subscriptionAccounts.provider })
      .from(subscriptionAccounts)
      .where(and(eq(subscriptionAccounts.id, id), isNull(subscriptionAccounts.deletedAt)));
    if (!row) throw new GatewayError(503, 'subscription_unavailable', 'The subscription account is unavailable');
    return row.provider;
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

  async models(principal: Principal, input: z.infer<typeof fetchSubscriptionModelsInput>) {
    const id = input.channelId ? await this.accountForChannel(principal, input.channelId) : undefined;
    const provider = id ? await this.provider(id) : input.provider;
    if (provider !== input.provider)
      throw new TRPCError({ code: 'BAD_REQUEST', message: '订阅平台与已保存渠道不匹配' });
    const proxyUrl = await channelProxy(this.auth, this.vault, principal, input.channelId, input.proxyUrl);
    const request = this.outbound.forProxy(proxyUrl);
    const provided = await this.prepareCredentials(principal, input, proxyUrl);
    if (!provided && !id)
      throw new TRPCError({ code: 'BAD_REQUEST', message: '请先导入凭据或完成 OAuth 授权，再拉取模型' });
    if (provided && new Date(provided.expiresAt).getTime() <= Date.now())
      throw new TRPCError({ code: 'BAD_REQUEST', message: '凭据已过期，请重新授权或导入新凭据' });
    try {
      const tokens = provider === 'claude' ? this.claudeTokens : this.tokens;
      const credentials = provided ?? (id ? await tokens.get(id, false, proxyUrl) : undefined);
      if (!credentials) throw new Error('缺少订阅凭据');
      if (provider === 'claude') return await fetchClaudeModels(claudeCredentialsSchema.parse(credentials), request);
      const clientVersion = await latestCodexClientVersion(request);
      const response = await request(`${codexBaseUrl}/models?client_version=${clientVersion}`, {
        headers: accountHeaders(credentials, 'application/json', clientVersion),
        signal: AbortSignal.timeout(20_000),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('获取模型失败');
      }
      const parsed = z
        .object({ models: z.array(z.object({ slug: z.string() })).max(1000) })
        .parse(await readJson(response));
      return {
        names: [
          ...new Set(
            parsed.models.map((m) => m.slug).filter((name) => /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,127}$/.test(name)),
          ),
        ].sort(),
        ignored: 0,
      };
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      throw new TRPCError({ code: 'BAD_REQUEST', message: '获取订阅模型失败，请检查账号和出站代理，或手动添加模型' });
    }
  }

  private async refreshExpiring() {
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
    this.oauth.dispose();
    this.claudeOAuth.dispose();
    this.openaiQuota.dispose();
    this.claudeQuota.dispose();
    await Promise.all([this.tokens.dispose(), this.claudeTokens.dispose()]);
  }
}
