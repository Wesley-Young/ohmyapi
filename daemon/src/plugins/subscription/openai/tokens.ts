import { and, eq, isNull } from 'drizzle-orm';

import type { CredentialVault } from '../../catalog/vault.js';
import type { Database } from '../../database/client.js';
import { subscriptionAccounts } from '../../database/schema/subscription.js';
import { GatewayError } from '../../gateway/errors.js';
import { exchangeToken } from './client.js';
import { credentialsSchema, type OpenAICredentials, parseCredentials } from './credentials.js';

export class OpenAITokens {
  private readonly refreshing = new Map<string, Promise<OpenAICredentials>>();
  private readonly abort = new AbortController();
  private readonly db: Database;
  private readonly vault: CredentialVault;
  constructor(db: Database, vault: CredentialVault) {
    this.db = db;
    this.vault = vault;
  }

  get(id: string, force = false) {
    const pending = this.refreshing.get(id);
    if (pending) return pending;
    const task = this.refresh(id, force).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, task);
    return task;
  }

  private async refresh(id: string, force: boolean) {
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
