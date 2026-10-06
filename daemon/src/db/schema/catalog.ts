import { sql } from 'drizzle-orm';
import { bigint, boolean, check, integer, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';

import { createdAt, endpoint, id } from './common.js';
import { apiKeys, users } from './identity.js';

export const models = pgTable(
  'models',
  {
    id: id(),
    name: text('name').notNull().unique(),
    enabled: boolean('enabled').default(true).notNull(),
    inputTokenLimit: integer('input_token_limit').default(32768).notNull(),
    outputTokenLimit: integer('output_token_limit').default(4096).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'models_token_limits',
      sql`${table.inputTokenLimit} between 1 and 2000000 and ${table.outputTokenLimit} between 1 and 100000`,
    ),
  ],
);

export const modelEndpoints = pgTable(
  'model_endpoints',
  {
    modelId: uuid('model_id')
      .notNull()
      .references(() => models.id),
    endpoint: endpoint('endpoint').notNull(),
  },
  (table) => [primaryKey({ columns: [table.modelId, table.endpoint] })],
);

export const channels = pgTable(
  'channels',
  {
    id: id(),
    name: text('name').notNull().unique(),
    baseUrl: text('base_url').notNull(),
    // An authenticated encrypted envelope, never the upstream key in plaintext.
    credentialEncrypted: text('credential_encrypted').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    timeoutMs: integer('timeout_ms').default(120_000).notNull(),
    multiplierMicros: bigint('multiplier_micros', { mode: 'bigint' }).default(sql`1000000`).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
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
