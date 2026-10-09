import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { createdAt, id } from './common.js';

export const subscriptionAccounts = pgTable(
  'subscription_accounts',
  {
    id: id(),
    name: text('name').notNull(),
    provider: text('provider').default('openai').notNull(),
    accountId: text('account_id').notNull(),
    userId: text('user_id').default('').notNull(),
    credentialEncrypted: text('credential_encrypted').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    maxConcurrent: integer('max_concurrent').default(5).notNull(),
    errorCode: text('error_code'),
    cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
    createdAt: createdAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('subscription_accounts_identity_unique')
      .on(table.provider, table.accountId, table.userId)
      .where(sql`${table.deletedAt} is null`),
    check('subscription_accounts_provider', sql`${table.provider} = 'openai'`),
    check('subscription_accounts_concurrency', sql`${table.maxConcurrent} between 1 and 100`),
  ],
);
