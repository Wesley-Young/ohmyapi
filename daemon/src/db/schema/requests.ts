import { sql } from 'drizzle-orm';
import { check, foreignKey, index, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { channels, models } from './catalog.js';
import { createdAt, endpoint, id, micros, tokenCount } from './common.js';
import { apiKeys, users } from './identity.js';
import { priceRules, priceVersions } from './pricing.js';

export const requestStatus = pgEnum('request_status', [
  'received',
  'reserved',
  'forwarding',
  'settling',
  'settled',
  'rejected',
  'released',
  'needs_review',
]);

export const requests = pgTable(
  'requests',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id),
    modelId: uuid('model_id').references(() => models.id),
    requestedModel: text('requested_model').notNull(),
    endpoint: endpoint('endpoint').notNull(),
    channelId: uuid('channel_id').references(() => channels.id),
    status: requestStatus('status').default('received').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    priceVersionId: uuid('price_version_id').references(() => priceVersions.id),
    priceRuleId: uuid('price_rule_id').references(() => priceRules.id),
    reservedMicros: micros('reserved_micros').default(sql`0`).notNull(),
    chargedMicros: micros('charged_micros'),
    // Filled during settlement; no prompts, completions, or credentials.
    pricingSnapshot: jsonb('pricing_snapshot').$type<Record<string, unknown>>(),
    upstreamRequestId: text('upstream_request_id'),
    errorCode: text('error_code'),
    createdAt: createdAt(),
  },
  (table) => [
    unique('requests_owner_unique').on(table.id, table.userId),
    foreignKey({ columns: [table.apiKeyId, table.userId], foreignColumns: [apiKeys.id, apiKeys.userId] }),
    foreignKey({
      columns: [table.priceVersionId, table.modelId, table.endpoint],
      foreignColumns: [priceVersions.id, priceVersions.modelId, priceVersions.endpoint],
    }),
    foreignKey({
      columns: [table.priceRuleId, table.priceVersionId],
      foreignColumns: [priceRules.id, priceRules.priceVersionId],
    }),
    check(
      'requests_price_scope',
      sql`(${table.priceVersionId} is null or ${table.modelId} is not null) and (${table.priceRuleId} is null or ${table.priceVersionId} is not null)`,
    ),
    index('requests_user_time_idx').on(table.userId, table.receivedAt),
    index('requests_recovery_idx').on(table.status, table.heartbeatAt),
    check(
      'requests_amounts_nonnegative',
      sql`${table.reservedMicros} >= 0 and (${table.chargedMicros} is null or ${table.chargedMicros} >= 0)`,
    ),
  ],
);

export const requestUsage = pgTable(
  'request_usage',
  {
    requestId: uuid('request_id')
      .primaryKey()
      .references(() => requests.id),
    // The categories below are disjoint, unlike some providers' raw usage.
    inputTokens: tokenCount('input_tokens').notNull(),
    outputTokens: tokenCount('output_tokens').notNull(),
    cacheReadTokens: tokenCount('cache_read_tokens').default(sql`0`).notNull(),
    cacheWriteTokens: tokenCount('cache_write_tokens').default(sql`0`).notNull(),
    contextTokens: tokenCount('context_tokens').notNull(),
    rawUsage: jsonb('raw_usage').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'request_usage_nonnegative',
      sql`${table.inputTokens} >= 0 and ${table.outputTokens} >= 0 and ${table.cacheReadTokens} >= 0 and ${table.cacheWriteTokens} >= 0`,
    ),
    check(
      'request_usage_context_total',
      sql`${table.contextTokens} = ${table.inputTokens} + ${table.cacheReadTokens} + ${table.cacheWriteTokens}`,
    ),
  ],
);
