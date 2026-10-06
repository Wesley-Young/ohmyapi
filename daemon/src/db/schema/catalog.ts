import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, endpoint, id } from './common.js';
import { apiKeys, users } from './identity.js';

export const models = pgTable('models', {
  id: id(),
  name: text('name').notNull().unique(),
  enabled: boolean('enabled').default(true).notNull(),
  createdAt: createdAt(),
});

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
    createdAt: createdAt(),
  },
  (table) => [check('channels_timeout_positive', sql`${table.timeoutMs} > 0`)],
);

export const channelModels = pgTable(
  'channel_models',
  {
    id: id(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
    modelId: uuid('model_id')
      .notNull()
      .references(() => models.id),
    endpoint: endpoint('endpoint').notNull(),
    upstreamModel: text('upstream_model').notNull(),
    priority: integer('priority').default(0).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.modelId, table.endpoint],
      foreignColumns: [modelEndpoints.modelId, modelEndpoints.endpoint],
    }),
    unique('channel_models_binding_unique').on(table.channelId, table.modelId, table.endpoint),
    index('channel_models_route_idx').on(table.modelId, table.endpoint, table.priority),
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
