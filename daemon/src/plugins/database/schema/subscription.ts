import { sql } from 'drizzle-orm';
import { boolean, check, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { createdAt, id } from './common.js';

export const subscriptionProviders = ['openai', 'claude'] as const;
export type SubscriptionProvider = (typeof subscriptionProviders)[number];

export const subscriptionAccounts = pgTable(
  'subscription_accounts',
  {
    id: id(),
    name: text('name').notNull(),
    provider: text('provider', { enum: subscriptionProviders }).default('openai').notNull(),
    accountId: text('account_id').notNull(),
    userId: text('user_id').default('').notNull(),
    credentialEncrypted: text('credential_encrypted').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    maxConcurrent: integer('max_concurrent').default(5).notNull(),
    errorCode: text('error_code'),
    modelCooldowns: jsonb('model_cooldowns').$type<Record<string, string>>().default({}).notNull(),
    cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
    // 管理员填写的 7d 周期提前重置时刻（如 Claude 续费），仅在当前上游周期内生效。
    cycleResetAt: timestamp('cycle_reset_at', { withTimezone: true }),
    createdAt: createdAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('subscription_accounts_identity_unique')
      .on(table.provider, table.accountId, table.userId)
      .where(sql`${table.deletedAt} is null`),
    check('subscription_accounts_provider', sql`${table.provider} in ('openai', 'claude')`),
    check('subscription_accounts_concurrency', sql`${table.maxConcurrent} between 1 and 100`),
  ],
);
