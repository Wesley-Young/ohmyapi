import { and, eq, isNull } from 'drizzle-orm';

import { GatewayError } from '../../../core/errors.ts';
import type { CredentialVault } from '../../../core/vault.ts';
import type { Database } from '../../database/client.ts';
import { channels } from '../../database/schema/catalog.ts';
import { subscriptionAccounts } from '../../database/schema/subscription.ts';
import type { OutboundHttp } from '../../outbound/index.ts';
import { exchangeToken } from './client.ts';
import { credentialsSchema, type OpenAICredentials, parseCredentials } from './credentials.ts';

export class OpenAITokens {
  private readonly refreshing = new Map<string, Promise<OpenAICredentials>>();
  private readonly abort = new AbortController();
  private readonly db: Database;
  private readonly vault: CredentialVault;
  private readonly outbound: OutboundHttp;
  constructor(db: Database, vault: CredentialVault, outbound: OutboundHttp) {
    this.db = db;
    this.vault = vault;
    this.outbound = outbound;
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

  get(id: string, force = false, proxyUrl?: string | null) {
    const key = JSON.stringify({ id, proxyUrl });
    const pending = this.refreshing.get(key);
    if (pending) return pending;
    const task = this.refresh(id, force, proxyUrl).finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, task);
    return task;
  }

  private async refresh(id: string, force: boolean, proxyUrl?: string | null) {
    let encrypted: string | undefined;
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(subscriptionAccounts)
          .where(and(eq(subscriptionAccounts.id, id), isNull(subscriptionAccounts.deletedAt)))
          .for('update');
        if (!row?.enabled)
          throw new GatewayError(503, 'subscription_unavailable', 'The subscription account is unavailable');
        encrypted = row.credentialEncrypted;
        const credentials = credentialsSchema.parse(JSON.parse(this.vault.decrypt(encrypted)));
        if (!force && row.expiresAt.getTime() > Date.now() + 60_000) return credentials;
        if (!credentials.refreshToken) {
          if (!force && row.expiresAt.getTime() > Date.now()) return credentials;
          throw new GatewayError(
            401,
            'subscription_reauthorization_required',
            'Import new credentials or authorize this account again',
          );
        }
        const next = parseCredentials(
          await exchangeToken(
            { grant_type: 'refresh_token', refresh_token: credentials.refreshToken },
            this.abort.signal,
            this.outbound.forProxy(proxyUrl === undefined ? await this.proxy(id, tx) : proxyUrl),
          ),
          credentials,
        );
        if (next.accountId !== credentials.accountId || (credentials.userId && next.userId !== credentials.userId))
          throw new GatewayError(
            401,
            'subscription_reauthorization_required',
            'Refreshed credentials belong to a different account',
          );
        await tx
          .update(subscriptionAccounts)
          .set({
            credentialEncrypted: this.vault.encrypt(JSON.stringify(next)),
            expiresAt: new Date(next.expiresAt),
            errorCode: null,
          })
          .where(eq(subscriptionAccounts.id, id));
        return next;
      });
    } catch (error) {
      if (encrypted && error instanceof GatewayError && error.code === 'subscription_reauthorization_required')
        await this.db
          .update(subscriptionAccounts)
          .set({ errorCode: error.code })
          .where(and(eq(subscriptionAccounts.id, id), eq(subscriptionAccounts.credentialEncrypted, encrypted)));
      throw error;
    }
  }

  async dispose() {
    this.abort.abort();
    await Promise.allSettled(this.refreshing.values());
  }
}
