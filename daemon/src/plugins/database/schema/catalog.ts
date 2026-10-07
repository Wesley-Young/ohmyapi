import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, endpoint, id } from './common.js';
import { apiKeys, users } from './identity.js';

export const models = pgTable(
  'models',
  {
    id: id(),
    name: text('name').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    inputTokenLimit: bigint('input_token_limit', { mode: 'number' }).default(1_000_000).notNull(),
    outputTokenLimit: bigint('output_token_limit', { mode: 'number' }).default(128_000).notNull(),
    createdAt: createdAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('models_name_unique').on(table.name).where(sql`${table.deletedAt} is null`),
    check('models_token_limits', sql`${table.inputTokenLimit} >= 1 and ${table.outputTokenLimit} >= 1`),
  ],
);

export const channels = pgTable(
  'channels',
  {
    id: id(),
    name: text('name').notNull(),
    baseUrl: text('base_url').notNull(),
    // An authenticated encrypted envelope, never the upstream key in plaintext.
    credentialEncrypted: text('credential_encrypted').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    isPublic: boolean('is_public').default(true).notNull(),
    timeoutMs: integer('timeout_ms').default(120_000).notNull(),
    multiplierMicros: bigint('multiplier_micros', { mode: 'bigint' }).default(sql`1000000`).notNull(),
    createdAt: createdAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('channels_name_unique').on(table.name).where(sql`${table.deletedAt} is null`),
    check('channels_timeout_positive', sql`${table.timeoutMs} > 0`),
    check('channels_multiplier_range', sql`${table.multiplierMicros} between 0 and 1000000000`),
  ],
);

export const channelEndpoints = pgTable(
  'channel_endpoints',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
    endpoint: endpoint('endpoint').notNull(),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.endpoint] })],
);

export const channelAvailableModels = pgTable(
  'channel_available_models',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
    modelId: uuid('model_id')
      .notNull()
      .references(() => models.id),
    multiplierMicros: bigint('multiplier_micros', { mode: 'bigint' }),
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.modelId] }),
    check(
      'channel_models_multiplier_range',
      sql`${table.multiplierMicros} is null or ${table.multiplierMicros} between 0 and 1000000000`,
    ),
  ],
);

export const userModelGrants = pgTable(
  'user_model_grants',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    modelId: uuid('model_id')
      .notNull()
      .references(() => models.id),
  },
  (table) => [primaryKey({ columns: [table.userId, table.modelId] })],
);

export const apiKeyModelGrants = pgTable(
  'api_key_model_grants',
  {
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => apiKeys.id),
    modelId: uuid('model_id')
      .notNull()
      .references(() => models.id),
  },
  (table) => [primaryKey({ columns: [table.apiKeyId, table.modelId] })],
);

// Nullable only for pre-channel Keys; new Keys always receive a binding.
export const apiKeyChannels = pgTable('api_key_channels', {
  apiKeyId: uuid('api_key_id')
    .primaryKey()
    .references(() => apiKeys.id),
  channelId: uuid('channel_id')
    .notNull()
    .references(() => channels.id),
});
