import { and, eq, isNull } from 'drizzle-orm';

import { GatewayError } from '../../../core/errors.js';
import type { CredentialVault } from '../../../core/vault.js';
import type { Database } from '../../database/client.js';
import { channels, subscriptionAccounts } from '../../database/schema/index.js';
import type { OutboundHttp } from '../../outbound/index.js';
import { ClaudeRefreshError, refreshClaudeToken } from './client.js';
import { type ClaudeCredentials, claudeCredentialsSchema } from './credentials.js';

export class ClaudeTokens {
  private readonly pending = new Map<string, Promise<ClaudeCredentials>>();
  private readonly abort = new AbortController();
  // 数据库提交失败也不能立即重用旧令牌；保留轮换结果，后续只重试持久化。
  private readonly rotated = new Map<string, { encrypted: string; credentials: ClaudeCredentials }>();
  private readonly db: Database;
  private readonly vault: CredentialVault;
  private readonly outbound: OutboundHttp;
  private readonly blocked = new Map<string, { encrypted: string; error: GatewayError }>();
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
    return {
      credentials: await this.get(id, false, proxyUrl),
      request: this.outbound.forProxy(proxyUrl),
    };
  }

  private async refresh(id: string, force: boolean, proxyUrl?: string | null) {
    const result = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(subscriptionAccounts)
        .where(and(eq(subscriptionAccounts.id, id), isNull(subscriptionAccounts.deletedAt)))
        .for('update');
      if (!row?.enabled || row.provider !== 'claude')
        throw new GatewayError(503, 'subscription_unavailable', 'The Claude account is unavailable');
      if (row.errorCode) throw new GatewayError(401, row.errorCode, 'Import current Claude credentials');
      const blocked = this.blocked.get(id);
      if (blocked?.encrypted === row.credentialEncrypted) throw blocked.error;
      this.blocked.delete(id);
      const credentials = claudeCredentialsSchema.parse(JSON.parse(this.vault.decrypt(row.credentialEncrypted)));
      const recovered = this.rotated.get(id);
      if (recovered && recovered.encrypted !== row.credentialEncrypted) this.rotated.delete(id);
      if (!this.rotated.has(id) && !force && row.expiresAt.getTime() > Date.now() + 60_000) return { credentials };
      if (!credentials.refreshToken) {
        if (!force && row.expiresAt.getTime() > Date.now()) return { credentials };
        await tx
          .update(subscriptionAccounts)
          .set({ errorCode: 'subscription_reauthorization_required' })
          .where(eq(subscriptionAccounts.id, id));
        return {
          error: new GatewayError(401, 'subscription_reauthorization_required', 'Import new Claude credentials'),
        };
      }
      if (row.cooldownUntil && row.cooldownUntil.getTime() > Date.now())
        throw new GatewayError(429, 'subscription_rate_limited', 'The Claude account is cooling down');
      if (proxyUrl === undefined) proxyUrl = await this.proxy(id, tx);
      let next = this.rotated.get(id)?.credentials;
      if (!next) {
        try {
          next = await refreshClaudeToken(credentials, this.outbound.forProxy(proxyUrl), this.abort.signal);
          if (next.accountId !== credentials.accountId || next.userId !== credentials.userId)
            throw new GatewayError(
              401,
              'subscription_reauthorization_required',
              'Refreshed credentials belong to a different Claude account',
            );
          this.rotated.set(id, { encrypted: row.credentialEncrypted, credentials: next });
        } catch (error) {
          if (!(error instanceof GatewayError)) throw error;
          if (error.code !== 'subscription_refresh_failed')
            this.blocked.set(id, { encrypted: row.credentialEncrypted, error });
          await tx
            .update(subscriptionAccounts)
            .set(
              error.code === 'subscription_refresh_failed'
                ? {
                    cooldownUntil: error instanceof ClaudeRefreshError ? error.retryAt : new Date(Date.now() + 300_000),
                  }
                : { errorCode: error.code },
            )
            .where(eq(subscriptionAccounts.id, id));
          return { error };
        }
      }
      await tx
        .update(subscriptionAccounts)
        .set({
          credentialEncrypted: this.vault.encrypt(JSON.stringify(next)),
          expiresAt: new Date(next.expiresAt),
          errorCode: null,
        })
        .where(eq(subscriptionAccounts.id, id));
      return { credentials: next };
    });
    if (result.error) throw result.error;
    this.rotated.delete(id);
    return result.credentials;
  }
  async dispose() {
    this.abort.abort();
    await Promise.allSettled(this.pending.values());
    this.rotated.clear();
    this.blocked.clear();
  }
}
