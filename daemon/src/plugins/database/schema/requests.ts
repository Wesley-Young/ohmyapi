import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import type { UsageEstimate } from '../../billing/estimation.js';
import { channels, models } from './catalog.js';
import { createdAt, endpoint, id, micros, tokenCount } from './common.js';
import { apiKeys, users } from './identity.js';

export const requestStatus = pgEnum('request_status', [
  'completed',
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
    reservedMicros: micros('reserved_micros').default(sql`0`).notNull(),
    chargedMicros: micros('charged_micros'),
    quotedMicros: micros('quoted_micros'),
    billingEnabled: boolean('billing_enabled').default(false).notNull(),
    heldMicros: micros('held_micros').default(sql`0`).notNull(),
    ownerId: uuid('owner_id'),
    usageFinal: boolean('usage_final').default(false).notNull(),
    usageEstimate: jsonb('usage_estimate').$type<UsageEstimate>(),
    reservationSnapshot: jsonb('reservation_snapshot').$type<Record<string, unknown>>(),
    resolutionKey: text('resolution_key').unique(),
    resolutionPayload: jsonb('resolution_payload').$type<Record<string, unknown>>(),
    // Filled during settlement; no prompts, completions, or credentials.
    pricingSnapshot: jsonb('pricing_snapshot').$type<Record<string, unknown>>(),
    upstreamRequestId: text('upstream_request_id'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    httpStatus: integer('http_status'),
    streaming: boolean('streaming').default(false).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('requests_owner_unique').on(table.id, table.userId),
    foreignKey({ columns: [table.apiKeyId, table.userId], foreignColumns: [apiKeys.id, apiKeys.userId] }),
    check(
      'requests_billing_terminal_shape',
      sql`not ${table.billingEnabled} or (${table.status} = 'settled' and ${table.chargedMicros} is not null and ${table.heldMicros} = 0) or (${table.status} = 'released' and ${table.chargedMicros} = 0 and ${table.heldMicros} = 0) or (${table.status} in ('reserved', 'forwarding', 'settling', 'needs_review') and ${table.chargedMicros} is null)`,
    ),
    check('requests_hold_range', sql`${table.heldMicros} >= 0 and ${table.heldMicros} <= ${table.reservedMicros}`),
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
    webSearchCalls: tokenCount('web_search_calls').default(sql`0`).notNull(),
    webSearchPreviewCalls: tokenCount('web_search_preview_calls').default(sql`0`).notNull(),
    rawUsage: jsonb('raw_usage').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'request_usage_nonnegative',
      sql`${table.inputTokens} >= 0 and ${table.outputTokens} >= 0 and ${table.cacheReadTokens} >= 0 and ${table.cacheWriteTokens} >= 0`,
    ),
    check(
      'request_usage_search_bounds',
      sql`${table.webSearchCalls} between 0 and 10000 and ${table.webSearchPreviewCalls} between 0 and 10000`,
    ),
    check(
      'request_usage_context_total',
      sql`${table.contextTokens} = ${table.inputTokens} + ${table.cacheReadTokens} + ${table.cacheWriteTokens}`,
    ),
  ],
);
