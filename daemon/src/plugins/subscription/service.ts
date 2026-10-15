import { type Disposable, serviceToken } from '@fraqjs/kernel';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { AppError, GatewayError } from '../../core/errors.ts';
import type { CredentialVault } from '../../core/vault.ts';
import { recordAudit } from '../auth/audit.ts';
import type { AuthService, Principal } from '../auth/service.ts';
import type { Database, Transaction } from '../database/client.ts';
import type { SubscriptionProvider } from '../database/schema/index.ts';
import { channels, subscriptionAccounts } from '../database/schema/index.ts';
import { channelProxy } from '../outbound/channel-proxy.ts';
import type { OutboundHttp } from '../outbound/index.ts';
import {
  type AntigravityCredentials,
  antigravityCredentialsSchema,
  importAntigravityCredentials,
} from './antigravity/credentials.ts';
import { AntigravityOAuth } from './antigravity/oauth.ts';
import { AntigravityQuota, antigravityModelNames } from './antigravity/quota.ts';
import { fetchClaudeModels } from './claude/catalog.ts';
import { importClaudeCredentials } from './claude/client.ts';
import { type ClaudeCredentials, claudeCredentialsSchema } from './claude/credentials.ts';
import { ClaudeOAuth } from './claude/oauth.ts';
import { ClaudeQuota } from './claude/quota.ts';
import { estimateCycleUsage } from './cycle.ts';
import { accountHeaders, codexBaseUrl, latestCodexClientVersion, readJson } from './openai/client.ts';
import { credentialsSchema, type OpenAICredentials, parseCredentials } from './openai/credentials.ts';
import { OpenAIOAuth } from './openai/oauth.ts';
import { OpenAIQuota } from './openai/quota.ts';
import { OpenAIResetCredits } from './openai/reset-credits.ts';
import type { SubscriptionRuntime } from './runtime.ts';
import type {
  ConsumeResetCreditInput,
  CredentialInput,
  FetchSubscriptionModelsInput,
  SetCycleResetInput,
} from './schemas.ts';

/** 订阅账号管理：接入与授权、额度和重置卡查询、周期用量，以及拉取可用模型。 */
export class SubscriptionService implements Disposable {
  static readonly token = serviceToken<SubscriptionService>('ohmyapi/subscription');
  private readonly oauth = new OpenAIOAuth();
  private readonly claudeOAuth = new ClaudeOAuth();
  private readonly antigravityOAuth = new AntigravityOAuth();
  private readonly antigravityQuota = new AntigravityQuota();
  private readonly openaiQuota = new OpenAIQuota();
  private readonly claudeQuota = new ClaudeQuota();
  private readonly openaiResetCredits = new OpenAIResetCredits();

  private readonly db: Database;
  private readonly auth: AuthService;
  private readonly vault: CredentialVault;
  private readonly outbound: OutboundHttp;
  private readonly runtime: SubscriptionRuntime;
  constructor(deps: {
    db: Database;
    auth: AuthService;
    vault: CredentialVault;
    outbound: OutboundHttp;
    runtime: SubscriptionRuntime;
  }) {
    this.db = deps.db;
    this.auth = deps.auth;
    this.vault = deps.vault;
    this.outbound = deps.outbound;
    this.runtime = deps.runtime;
  }

  /** 定期清理过期的授权会话，并提前刷新即将过期的订阅令牌。 */
  async maintain() {
    this.oauth.prune();
    this.claudeOAuth.prune();
    this.antigravityOAuth.prune();
    await this.runtime.refreshExpiringTokens().catch(() => {});
  }

  /** 订阅账号当前正在执行的请求数，供管理页面展示。 */
  activeRequests(accountId: string) {
    return this.runtime.activeRequests(accountId);
  }

  accountEmail(encrypted: string, provider = 'openai'): string | null {
    try {
      // 已保存的旧凭据可从 access_token 读取邮箱，后续刷新会写入 email。
      const raw = JSON.parse(this.vault.decrypt(encrypted));
      return (
        (provider === 'claude'
          ? claudeCredentialsSchema.parse(raw)
          : provider === 'antigravity'
            ? antigravityCredentialsSchema.parse(raw)
            : parseCredentials(raw)
        ).email ?? null
      );
    } catch {
      return null;
    }
  }

  private oauthFor(provider: SubscriptionProvider) {
    return provider === 'claude' ? this.claudeOAuth : provider === 'antigravity' ? this.antigravityOAuth : this.oauth;
  }

  private invalidateQuota(id: string) {
    this.openaiQuota.invalidate(id);
    this.claudeQuota.invalidate(id);
    this.antigravityQuota.invalidate(id);
    // 更换凭据后账号可用的模型可能变化。
    this.runtime.antigravityModels.invalidate(id);
  }

  consumeAuthorization(principal: Principal, callbackUrl: string, provider: SubscriptionProvider) {
    this.oauthFor(provider).consume(principal.user.id, callbackUrl);
  }

  async prepareCredentials(principal: Principal, input: CredentialInput, proxyUrl: string | null) {
    await this.auth.authorized(principal, { admin: true }, async () => {});
    if (input.callbackUrl) {
      try {
        return await this.oauthFor(input.provider).complete(
          principal.user.id,
          input.callbackUrl,
          this.outbound.forProxy(proxyUrl),
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError('bad_request', '授权失败，请重新授权并粘贴完整回调地址');
      }
    }
    if (input.provider === 'antigravity') {
      if (!input.credentials) return;
      try {
        return await importAntigravityCredentials(
          JSON.parse(input.credentials),
          this.outbound.forProxy(proxyUrl),
          AbortSignal.timeout(60_000),
        );
      } catch (error) {
        throw new AppError(
          'bad_request',
          error instanceof GatewayError && error.code === 'subscription_reauthorization_required'
            ? 'Google 拒绝了该 refresh token，请重新授权'
            : 'Antigravity 凭据无效；需要 refresh_token，并通过出站代理查询 Google 账号',
        );
      }
    }
    if (input.provider === 'claude') {
      if (!input.credentials) return;
      try {
        return await importClaudeCredentials(JSON.parse(input.credentials), this.outbound.forProxy(proxyUrl));
      } catch {
        throw new AppError(
          'bad_request',
          'Claude 凭据无效；需要 OAuth 令牌、有效期及 account_uuid，缺少账号信息时将通过代理查询',
        );
      }
    }
    if (input.credentials) {
      try {
        return parseCredentials(JSON.parse(input.credentials));
      } catch {
        throw new AppError('bad_request', '凭据格式无效，需要 access_token、账号 ID 和有效期；支持 Codex auth.json');
      }
    }
  }

  async saveAccount(
    tx: Transaction,
    input: { id?: string; name: string; enabled: boolean; maxConcurrent: number; provider: SubscriptionProvider },
    credentials?: OpenAICredentials | ClaudeCredentials | AntigravityCredentials,
  ) {
    const [existing] = input.id
      ? await tx
          .select()
          .from(subscriptionAccounts)
          .where(and(eq(subscriptionAccounts.id, input.id), isNull(subscriptionAccounts.deletedAt)))
          .for('update')
      : [];
    if (existing && existing.provider !== input.provider)
      throw new AppError('bad_request', '订阅平台不可更改，请新建渠道');
    if (input.id && !existing) throw new AppError('not_found', '订阅账号不存在');
    if (!existing && !credentials) throw new AppError('bad_request', '请导入凭据或完成授权');
    if (
      existing &&
      credentials &&
      (existing.accountId !== credentials.accountId || existing.userId !== credentials.userId)
    )
      throw new AppError('bad_request', '新凭据属于其他账号，请新建订阅渠道');
    if (credentials) {
      if (existing) {
        const raw = JSON.parse(this.vault.decrypt(existing.credentialEncrypted));
        const saved =
          existing.provider === 'claude'
            ? claudeCredentialsSchema.parse(raw)
            : existing.provider === 'antigravity'
              ? antigravityCredentialsSchema.parse(raw)
              : credentialsSchema.parse(raw);
        credentials = {
          ...credentials,
          ...('deviceId' in saved ? { deviceId: saved.deviceId } : {}),
          ...('projectId' in saved && !('projectId' in credentials && credentials.projectId)
            ? { projectId: saved.projectId }
            : {}),
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
        throw new AppError('conflict', '该订阅账号已存在，请编辑对应订阅渠道');
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
      if (!credentials) throw new AppError('bad_request', '请导入凭据或完成授权');
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
      if (!created) throw new AppError('conflict', '该订阅账号已存在，请编辑对应订阅渠道');
      row = created;
    }
    this.invalidateQuota(row.id);
    return row.id;
  }

  async removeAccount(tx: Transaction, id: string) {
    const [row] = await tx
      .select()
      .from(subscriptionAccounts)
      .where(and(eq(subscriptionAccounts.id, id), isNull(subscriptionAccounts.deletedAt)))
      .for('update');
    if (!row) throw new AppError('not_found', '订阅账号不存在');
    if (this.runtime.concurrency.active(id)) throw new AppError('conflict', '请等待该渠道请求结束后再删除');
    await tx
      .update(subscriptionAccounts)
      .set({ deletedAt: new Date(), enabled: false })
      .where(eq(subscriptionAccounts.id, id));
  }

  async startOAuth(principal: Principal, provider: SubscriptionProvider = 'openai') {
    return this.auth.authorized(principal, { admin: true }, async () =>
      this.oauthFor(provider).start(principal.user.id),
    );
  }

  async refresh(principal: Principal, channelId: string) {
    const id = await this.accountForChannel(principal, channelId);
    try {
      await this.runtime.tokensFor(await this.runtime.provider(id)).get(id, true);
      this.invalidateQuota(id);
    } catch {
      throw new AppError('bad_request', '刷新失败，请检查账号状态或重新授权');
    }
    return { success: true };
  }

  async openAIQuota(principal: Principal, channelId: string, force = false) {
    const id = await this.providerAccountForChannel(principal, channelId, 'openai');
    return this.openaiQuota.get(this.runtime.tokens, id, force);
  }

  async claudeUsage(principal: Principal, channelId: string, force = false) {
    const id = await this.providerAccountForChannel(principal, channelId, 'claude');
    return this.claudeQuota.get(this.runtime.claudeTokens, id, force);
  }

  async antigravityUsage(principal: Principal, channelId: string, force = false) {
    const id = await this.providerAccountForChannel(principal, channelId, 'antigravity');
    return this.antigravityQuota.get(this.runtime.antigravityTokens, id, force);
  }

  /** 按渠道的订阅平台查询额度窗口；Antigravity 返回 Gemini 额度池的窗口。 */
  async quota(principal: Principal, channelId: string) {
    const { id, provider } = await this.enabledAccountForChannel(principal, channelId);
    const quota = await (provider === 'claude'
      ? this.claudeQuota.get(this.runtime.claudeTokens, id)
      : provider === 'antigravity'
        ? this.antigravityQuota.get(this.runtime.antigravityTokens, id)
        : this.openaiQuota.get(this.runtime.tokens, id));
    return {
      provider,
      plan: quota.plan,
      fiveHour: quota.fiveHour,
      sevenDay: quota.sevenDay,
      fetchedAt: quota.fetchedAt,
    };
  }

  async listOpenAIResetCredits(principal: Principal, channelId: string) {
    const id = await this.providerAccountForChannel(principal, channelId, 'openai');
    return this.openaiResetCredits.list(this.runtime.tokens, id);
  }

  async consumeOpenAIResetCredit(principal: Principal, input: ConsumeResetCreditInput) {
    const id = await this.providerAccountForChannel(principal, input.channelId, 'openai');
    try {
      const result = await this.openaiResetCredits.consume(
        this.runtime.tokens,
        id,
        input.creditId,
        input.redeemRequestId,
      );
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
    if (!account?.enabled) throw new AppError('bad_request', '渠道未启用或已删除');
    // Antigravity 以 Gemini 额度池作为账号额度；第三方模型的额度池很少使用，不单独计算。
    const quota = await (account.provider === 'claude'
      ? this.claudeQuota.get(this.runtime.claudeTokens, id)
      : account.provider === 'antigravity'
        ? this.antigravityQuota.get(this.runtime.antigravityTokens, id)
        : this.openaiQuota.get(this.runtime.tokens, id)
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

  async setCycleReset(principal: Principal, input: SetCycleResetInput) {
    const id = await this.accountForChannel(principal, input.channelId);
    const resetAt = input.resetAt ? new Date(input.resetAt) : null;
    if (resetAt && resetAt.getTime() > Date.now() + 60_000)
      throw new AppError('bad_request', '重置时刻不能晚于当前时间');
    return this.auth.authorized(principal, { admin: true }, async (tx, actor) => {
      const [account] = await tx
        .select({ provider: subscriptionAccounts.provider, cycleResetAt: subscriptionAccounts.cycleResetAt })
        .from(subscriptionAccounts)
        .where(and(eq(subscriptionAccounts.id, id), isNull(subscriptionAccounts.deletedAt)))
        .for('update');
      if (account?.provider !== 'claude') throw new AppError('bad_request', '仅 Claude 订阅需要手动填写重置时刻');
      await tx.update(subscriptionAccounts).set({ cycleResetAt: resetAt }).where(eq(subscriptionAccounts.id, id));
      await recordAudit(tx, {
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

  async models(principal: Principal, input: FetchSubscriptionModelsInput) {
    const id = input.channelId ? await this.accountForChannel(principal, input.channelId) : undefined;
    const provider = id ? await this.runtime.provider(id) : input.provider;
    if (provider !== input.provider) throw new AppError('bad_request', '订阅平台与已保存渠道不匹配');
    const proxyUrl = await channelProxy(this.auth, this.vault, principal, input.channelId, input.proxyUrl);
    const request = this.outbound.forProxy(proxyUrl);
    const provided = await this.prepareCredentials(principal, input, proxyUrl);
    if (!provided && !id) throw new AppError('bad_request', '请先导入凭据或完成 OAuth 授权，再拉取模型');
    if (provided && new Date(provided.expiresAt).getTime() <= Date.now())
      throw new AppError('bad_request', '凭据已过期，请重新授权或导入新凭据');
    try {
      if (provider === 'antigravity') {
        const credentials =
          provided ?? (id ? await this.runtime.antigravityTokens.get(id, false, proxyUrl) : undefined);
        const { names, ignored, upstream } = await antigravityModelNames(
          antigravityCredentialsSchema.parse(credentials),
          request,
        );
        // 已保存的账号用最新目录更新变体缓存。
        if (id && !provided) this.runtime.antigravityModels.set(id, upstream);
        return { names, ignored };
      }
      const tokens = provider === 'claude' ? this.runtime.claudeTokens : this.runtime.tokens;
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
      if (error instanceof AppError) throw error;
      throw new AppError('bad_request', '获取订阅模型失败，请检查账号和出站代理，或手动添加模型');
    }
  }

  private async enabledAccountForChannel(principal: Principal, channelId: string) {
    const id = await this.accountForChannel(principal, channelId);
    const [account] = await this.db
      .select({ provider: subscriptionAccounts.provider, enabled: subscriptionAccounts.enabled })
      .from(subscriptionAccounts)
      .where(and(eq(subscriptionAccounts.id, id), isNull(subscriptionAccounts.deletedAt)));
    if (!account?.enabled) throw new AppError('bad_request', '订阅渠道未启用');
    return { id, provider: account.provider };
  }

  private async providerAccountForChannel(principal: Principal, channelId: string, provider: SubscriptionProvider) {
    const account = await this.enabledAccountForChannel(principal, channelId);
    if (account.provider !== provider) throw new AppError('bad_request', '订阅平台不匹配');
    return account.id;
  }

  private async accountForChannel(principal: Principal, channelId: string) {
    return this.auth.authorized(principal, { admin: true }, async (tx) => {
      const [channel] = await tx
        .select({ accountId: channels.subscriptionAccountId })
        .from(channels)
        .where(and(eq(channels.id, channelId), eq(channels.type, 'subscription'), isNull(channels.deletedAt)));
      if (!channel?.accountId) throw new AppError('not_found', '订阅渠道不存在');
      return channel.accountId;
    });
  }

  dispose() {
    this.oauth.dispose();
    this.claudeOAuth.dispose();
    this.antigravityOAuth.dispose();
    this.openaiQuota.dispose();
    this.claudeQuota.dispose();
    this.antigravityQuota.dispose();
  }
}
