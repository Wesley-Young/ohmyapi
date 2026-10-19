import { GatewayError } from '@ohmyapi/protocols';
import { and, eq, isNull } from 'drizzle-orm';

import type { CredentialVault } from '../../../core/vault.ts';
import type { Database } from '../../database/client.ts';
import { channels, subscriptionAccounts } from '../../database/schema/index.ts';
import type { OutboundHttp } from '../../outbound/index.ts';
import { loadAntigravityAccount, refreshAntigravityToken } from './client.ts';
import { type AntigravityCredentials, antigravityCredentialsSchema } from './credentials.ts';

/** 访问令牌在到期前 5 分钟刷新；Google 访问令牌有效期约 1 小时。 */
const refreshMarginMs = 5 * 60_000;

/**
 * Antigravity 账号的访问令牌与项目。同一账号的刷新合并为一次，并在数据库行锁内完成。
 * Google 的 refresh token 不随刷新轮换，刷新失败后可以直接重试。
 */
export class AntigravityTokens {
  private readonly pending = new Map<string, Promise<AntigravityCredentials>>();
  private readonly abort = new AbortController();
  private readonly db: Database;
  private readonly vault: CredentialVault;
  private readonly outbound: OutboundHttp;
  constructor(db: Database, vault: CredentialVault, outbound: OutboundHttp) {
    this.db = db;
    this.vault = vault;
    this.outbound = outbound;
  }

  get(id: string, force = false, proxyUrl?: string | null) {
    const pending = this.pending.get(id);
    if (pending) return pending;
    const task = this.refresh(id, force, proxyUrl).finally(() => this.pending.delete(id));
    this.pending.set(id, task);
    return task;
  }

  private async proxy(id: string, db: Pick<Database, 'select'> = this.db) {
    const [channel] = await db
      .select({ encrypted: channels.proxyUrlEncrypted })
      .from(channels)
      .where(and(eq(channels.subscriptionAccountId, id), isNull(channels.deletedAt)));
    if (!channel) throw new GatewayError(503, 'subscription_unavailable', 'The subscription channel is unavailable');
    return channel.encrypted ? this.vault.decrypt(channel.encrypted) : null;
  }

  async authorize(id: string) {
    const proxyUrl = await this.proxy(id);
    return { credentials: await this.get(id, false, proxyUrl), request: this.outbound.forProxy(proxyUrl) };
  }

  private async refresh(id: string, force: boolean, proxyUrl?: string | null) {
    const result = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(subscriptionAccounts)
        .where(and(eq(subscriptionAccounts.id, id), isNull(subscriptionAccounts.deletedAt)))
        .for('update');
      if (!row?.enabled || row.provider !== 'antigravity')
        throw new GatewayError(503, 'subscription_unavailable', 'The Antigravity account is unavailable');
      if (row.errorCode) throw new GatewayError(401, row.errorCode, 'Authorize the Antigravity account again');
      const current = antigravityCredentialsSchema.parse(JSON.parse(this.vault.decrypt(row.credentialEncrypted)));
      const fresh = !force && row.expiresAt.getTime() > Date.now() + refreshMarginMs;
      if (fresh && current.projectId) return { credentials: current };
      if (row.cooldownUntil && row.cooldownUntil.getTime() > Date.now())
        throw new GatewayError(429, 'subscription_rate_limited', 'The Antigravity account is cooling down');
      if (proxyUrl === undefined) proxyUrl = await this.proxy(id, tx);
      const request = this.outbound.forProxy(proxyUrl);
      let next = current;
      try {
        if (!fresh) {
          const tokens = await refreshAntigravityToken(current.refreshToken, request, this.abort.signal);
          next = {
            ...next,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? next.refreshToken,
            expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
          };
        }
        if (!next.projectId) {
          const account = await loadAntigravityAccount(next.accessToken, request, this.abort.signal).catch(
            () => undefined,
          );
          if (account?.projectId) next = { ...next, projectId: account.projectId };
        }
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        await tx
          .update(subscriptionAccounts)
          .set(
            error.code === 'subscription_reauthorization_required'
              ? { errorCode: error.code }
              : { cooldownUntil: new Date(Date.now() + 60_000) },
          )
          .where(eq(subscriptionAccounts.id, id));
        return { error };
      }
      // 尚未完成 onboarding 的账号没有项目；保存已刷新的令牌，稍后再查询项目。
      await tx
        .update(subscriptionAccounts)
        .set({
          credentialEncrypted: this.vault.encrypt(JSON.stringify(next)),
          expiresAt: new Date(next.expiresAt),
          ...(next.projectId ? {} : { cooldownUntil: new Date(Date.now() + 5 * 60_000) }),
        })
        .where(eq(subscriptionAccounts.id, id));
      if (!next.projectId)
        return {
          error: new GatewayError(
            503,
            'subscription_project_missing',
            'The Antigravity account has no project; complete onboarding in the official client first',
          ),
        };
      return { credentials: next };
    });
    if (result.error) throw result.error;
    return result.credentials;
  }

  async dispose() {
    this.abort.abort();
    await Promise.allSettled(this.pending.values());
  }
}
