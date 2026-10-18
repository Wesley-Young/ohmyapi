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
  real,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { channels, channelType, models } from './catalog.ts';
import { createdAt, endpoint, id, micros, tokenCount } from './common.ts';
import { apiKeys, users } from './identity.ts';
import { subscriptionAccounts } from './subscription.ts';

/** 客户端断连时按本地估算结算所保存的依据。 */
export type UsageEstimate = {
  /** 已有记录可能是此前的 o200k_base_v1。 */
  method: 'o200k_base_v1' | 'char_class_v1';
  reason: 'client_disconnected';
  /** 输入始终取上游报告；request_estimate 只见于已有记录。 */
  inputSource: 'upstream' | 'request_estimate';
  outputSource: 'upstream' | 'observed_estimate' | 'upstream_with_observed_tail';
  reportedOutputTokens: string | null;
  observedTailTokens: string;
  /** 以下三项只见于已有记录：当时按模型默认尺寸估算图像输入。 */
  inputImageCount?: number;
  inputImageTokens?: number;
  imageMethod?: 'model_default_1024_v1';
  searchSource: 'upstream' | 'observed' | 'request' | 'none';
};

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
    subscriptionAccountId: uuid('subscription_account_id').references(() => subscriptionAccounts.id),
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
    // Streaming only: from gateway receipt to the first non-empty generated content.
    ttftMs: integer('ttft_ms'),
    // Output tokens per second, measured by the gateway when the request finished.
    outputTps: real('output_tps'),
    // Normalized reasoning effort sent upstream after gateway rewrites.
    reasoningEffort: text('reasoning_effort'),
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
    index('requests_subscription_time_idx').on(table.subscriptionAccountId, table.receivedAt),
    // 全站统计按时间窗口扫描，不带用户或账号条件。
    index('requests_time_idx').on(table.receivedAt),
    index('requests_recovery_idx').on(table.status, table.heartbeatAt),
    // 预占在用户历史不足时读取同一模型和端点的近期用量。
    index('requests_model_history_idx').on(table.modelId, table.endpoint, table.receivedAt),
    check(
      'requests_amounts_nonnegative',
      sql`${table.reservedMicros} >= 0 and (${table.chargedMicros} is null or ${table.chargedMicros} >= 0)`,
    ),
    check(
      'requests_timing_metadata',
      sql`(${table.ttftMs} is null or ${table.ttftMs} >= 0) and (${table.outputTps} is null or ${table.outputTps} >= 0) and (${table.reasoningEffort} is null or length(${table.reasoningEffort}) <= 16)`,
    ),
  ],
);

export const requestAttemptStatus = pgEnum('request_attempt_status', [
  'prepared',
  'forwarding',
  'completed',
  'failed',
  'unknown',
]);

export const requestAttempts = pgTable(
  'request_attempts',
  {
    id: id(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id),
    sequence: integer('sequence').notNull(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
    channelName: text('channel_name').notNull(),
    channelType: channelType('channel_type').notNull(),
    subscriptionAccountId: uuid('subscription_account_id').references(() => subscriptionAccounts.id),
    status: requestAttemptStatus('status').default('prepared').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    noExecution: boolean('no_execution'),
    httpStatus: integer('http_status'),
    upstreamRequestId: text('upstream_request_id'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
  },
  (table) => [
    unique('request_attempt_sequence_unique').on(table.requestId, table.sequence),
    check('request_attempt_sequence_positive', sql`${table.sequence} > 0`),
    check('request_attempt_leaf_channel', sql`${table.channelType} <> 'aggregate'`),
  ],
);

/** 归一化后的请求用量，各类别互不重叠；与 request_usage 表一一对应。 */
export type Usage = {
  inputTokens: bigint;
  outputTokens: bigint;
  cacheReadTokens: bigint;
  cacheWriteTokens: bigint;
  contextTokens: bigint;
  webSearchCalls: bigint;
  webSearchPreviewCalls: bigint;
  rawUsage: Record<string, unknown>;
};

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
