import { type Disposable, serviceToken } from '@fraqjs/kernel';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';

import type { AuthService, Principal, Transaction } from '../auth/service.js';
import type { CredentialVault } from '../catalog/vault.js';
import { channels, subscriptionAccounts } from '../database/schema/index.js';
import { GatewayError } from '../gateway/errors.js';
import { SubscriptionConcurrency } from './concurrency.js';
import { accountHeaders, codexBaseUrl, latestCodexClientVersion, readJson } from './openai/client.js';
import { credentialsSchema, type OpenAICredentials, parseCredentials } from './openai/credentials.js';
import { OpenAIOAuth } from './openai/oauth.js';
import { OpenAIQuota } from './openai/quota.js';
import { OpenAIResetCredits } from './openai/reset-credits.js';
import { OpenAITokens } from './openai/tokens.js';

const credentialInput = z.object({
  credentials: z.string().min(1).max(60000).optional(),
  callbackUrl: z.url().max(8192).optional(),
});
export const subscriptionInput = credentialInput
  .extend({ maxConcurrent: z.number().int().min(1).max(100).default(5) })
  .refine((input) => !(input.credentials && input.callbackUrl), '请选择一种接入方式');
export const fetchSubscriptionModelsInput = credentialInput
  .extend({ channelId: z.uuid().optional() })
  .refine((input) => !(input.credentials && input.callbackUrl), '请选择一种接入方式');

export class SubscriptionService implements Disposable {
  static readonly token = serviceToken<SubscriptionService>('ohmyapi/subscription');
  readonly concurrency = new SubscriptionConcurrency();
  readonly tokens: OpenAITokens;
  private readonly oauth = new OpenAIOAuth();
  private readonly openaiQuota = new OpenAIQuota();
  private readonly openaiResetCredits = new OpenAIResetCredits();
  private readonly timer: ReturnType<typeof setInterval>;
  private refreshing = false;
  private stopped = false;

  private readonly auth: AuthService;
  private readonly vault: CredentialVault;
  constructor(auth: AuthService, vault: CredentialVault) {
    this.auth = auth;
    this.vault = vault;
    this.tokens = new OpenAITokens(auth.db, vault);
    this.timer = setInterval(() => {
      this.oauth.prune();
      void this.refreshExpiring().catch(() => {});
    }, 30_000);
    this.timer.unref();
  }

  accountEmail(encrypted: string): string | null {
    try {
      // 已保存的旧凭据可从 access_token 读取邮箱，后续刷新会写入 email。
      return parseCredentials(JSON.parse(this.vault.decrypt(encrypted))).email ?? null;
    } catch {
      return null;
    }
  }

  consumeAuthorization(principal: Principal, callbackUrl: string) {
    this.oauth.consume(principal.user.id, callbackUrl);
  }

  async prepareCredentials(principal: Principal, input: z.infer<typeof credentialInput>) {
    await this.auth.authorized(principal, { admin: true }, async () => {});
    if (input.callbackUrl) {
      try {
        return await this.oauth.complete(principal.user.id, input.callbackUrl);
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'BAD_REQUEST', message: '授权失败，请重新授权并粘贴完整回调地址' });
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
    input: { id?: string; name: string; enabled: boolean; maxConcurrent: number },
    credentials?: OpenAICredentials,
  ) {
    const [existing] = input.id
      ? await tx
          .select()
          .from(subscriptionAccounts)
          .where(and(eq(subscriptionAccounts.id, input.id), isNull(subscriptionAccounts.deletedAt)))
          .for('update')
      : [];
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
        const saved = credentialsSchema.parse(JSON.parse(this.vault.decrypt(existing.credentialEncrypted)));
        credentials = {
          ...credentials,
          refreshToken: credentials.refreshToken ?? saved.refreshToken,
          email: credentials.email ?? saved.email ?? this.accountEmail(existing.credentialEncrypted) ?? undefined,
        };
      }
      const [duplicate] = await tx
        .select({ id: subscriptionAccounts.id })
        .from(subscriptionAccounts)
        .where(
          and(
            eq(subscriptionAccounts.accountId, credentials.accountId),
            eq(subscriptionAccounts.userId, credentials.userId),
            isNull(subscriptionAccounts.deletedAt),
          ),
        );
      if (duplicate && duplicate.id !== input.id)
        throw new TRPCError({ code: 'CONFLICT', message: '该 OpenAI 账号已存在，请编辑对应订阅渠道' });
    }
    const values = {
      name: input.name,
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
      if (!created) throw new TRPCError({ code: 'CONFLICT', message: '该 OpenAI 账号已存在，请编辑对应订阅渠道' });
      row = created;
    }
    this.openaiQuota.invalidate(row.id);
    return row.id;
  }

  async startOAuth(principal: Principal) {
    return this.auth.authorized(principal, { admin: true }, async () => this.oauth.start(principal.user.id));
  }
  async refresh(principal: Principal, channelId: string) {
    const id = await this.accountForChannel(principal, channelId);
    try {
      await this.tokens.get(id, true);
      this.openaiQuota.invalidate(id);
    } catch {
      throw new TRPCError({ code: 'BAD_REQUEST', message: '刷新失败，请检查账号状态或重新授权' });
    }
    return { success: true };
  }
  async openAIQuota(principal: Principal, channelId: string, force = false) {
    const id = await this.openAIAccountForChannel(principal, channelId);
    return this.openaiQuota.get(this.tokens, id, force);
  }
  async listOpenAIResetCredits(principal: Principal, channelId: string) {
    const id = await this.openAIAccountForChannel(principal, channelId);
    return this.openaiResetCredits.list(this.tokens, id);
  }
  async consumeOpenAIResetCredit(
    principal: Principal,
    input: { channelId: string; creditId: string; redeemRequestId: string },
  ) {
    const id = await this.openAIAccountForChannel(principal, input.channelId);
    try {
      const result = await this.openaiResetCredits.consume(this.tokens, id, input.creditId, input.redeemRequestId);
      // 上游已完成的兑换不因本地状态更新失败而被报告为使用失败。
      const cooldownCleared =
        result.windowsReset > 0
          ? await this.auth.db
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
  private async openAIAccountForChannel(principal: Principal, channelId: string) {
    const id = await this.accountForChannel(principal, channelId);
    const [account] = await this.auth.db
      .select({ provider: subscriptionAccounts.provider, enabled: subscriptionAccounts.enabled })
      .from(subscriptionAccounts)
      .where(and(eq(subscriptionAccounts.id, id), isNull(subscriptionAccounts.deletedAt)));
    if (account?.provider !== 'openai' || !account.enabled)
      throw new TRPCError({ code: 'BAD_REQUEST', message: '该 OpenAI 订阅渠道未启用或已删除' });
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
    const [row] = await this.auth.db
      .select()
      .from(subscriptionAccounts)
      .where(and(eq(subscriptionAccounts.id, id), isNull(subscriptionAccounts.deletedAt)));
    if (this.stopped || !row?.enabled || row.errorCode === 'subscription_reauthorization_required')
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

  async reportStatus(id: string, status: number, headers: Headers, accessToken: string) {
    if (status !== 401 && status !== 429) return;
    const [current] = await this.auth.db.select().from(subscriptionAccounts).where(eq(subscriptionAccounts.id, id));
    if (
      !current ||
      credentialsSchema.parse(JSON.parse(this.vault.decrypt(current.credentialEncrypted))).accessToken !== accessToken
    )
      return;
    const raw = headers.get('retry-after');
    const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : raw ? (Date.parse(raw) - Date.now()) / 1000 : 60;
    await this.auth.db
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
    const provided = await this.prepareCredentials(principal, input);
    if (!provided && !id)
      throw new TRPCError({ code: 'BAD_REQUEST', message: '请先导入凭据或完成 OAuth 授权，再拉取模型' });
    if (provided && new Date(provided.expiresAt).getTime() <= Date.now())
      throw new TRPCError({ code: 'BAD_REQUEST', message: '凭据已过期，请重新授权或导入新凭据' });
    try {
      const credentials = provided ?? (id ? await this.tokens.get(id) : undefined);
      if (!credentials) throw new Error('缺少订阅凭据');
      const clientVersion = await latestCodexClientVersion();
      const response = await fetch(`${codexBaseUrl}/models?client_version=${clientVersion}`, {
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
    } catch {
      throw new TRPCError({ code: 'BAD_REQUEST', message: '获取订阅模型失败，请检查账号或手动添加模型' });
    }
  }

  private async refreshExpiring() {
    if (this.refreshing || this.stopped) return;
    this.refreshing = true;
    try {
      const rows = await this.auth.db
        .select({ id: subscriptionAccounts.id })
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
        await this.tokens.get(row.id).catch(() => {});
      }
    } finally {
      this.refreshing = false;
    }
  }
  async dispose() {
    this.stopped = true;
    clearInterval(this.timer);
    this.oauth.dispose();
    this.openaiQuota.dispose();
    await this.tokens.dispose();
  }
}
