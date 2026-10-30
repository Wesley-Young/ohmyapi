import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
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

import { channels } from './catalog.ts';
import { createdAt, endpoint, id } from './common.ts';
import { apiKeys, users } from './identity.ts';
import { requests } from './requests.ts';

/** 审核模型的分类选项；none 表示没有发现问题。 */
export const moderationCategories = [
  'cyber_attack',
  'violence',
  'fraud',
  'harassment_hate',
  'jailbreak',
  'none',
] as const;
export type ModerationCategory = (typeof moderationCategories)[number];

export const moderationVerdicts = ['pass', 'suspect', 'violation'] as const;
export type ModerationVerdict = (typeof moderationVerdicts)[number];

/**
 * - rate：按渠道比例抽中。
 * - floor：用户当天的保底抽样。
 */
export const moderationSampleReason = pgEnum('moderation_sample_reason', ['rate', 'floor']);
export const moderationStatus = pgEnum('moderation_status', ['pending', 'running', 'done', 'failed']);
export const moderationVerdict = pgEnum('moderation_verdict', moderationVerdicts);

/**
 * 抽中送审的 session。同一用户的同一 session 每天一条，送审前多个请求的内容合并为一份快照。
 * 内容加密保存，超过保留期后清除，判定结果保留。
 */
export const moderationSessions = pgTable(
  'moderation_sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id),
    /** 协议会话标识或会话开头内容的哈希，不保存原值。 */
    sessionHash: text('session_hash').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    entryChannelId: uuid('entry_channel_id')
      .notNull()
      .references(() => channels.id),
    executionChannelId: uuid('execution_channel_id')
      .notNull()
      .references(() => channels.id),
    endpoint: endpoint('endpoint').notNull(),
    requestedModel: text('requested_model').notNull(),
    reason: moderationSampleReason('reason').notNull(),
    requestCount: integer('request_count').notNull(),
    lastRequestId: uuid('last_request_id')
      .notNull()
      .references(() => requests.id),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    contentEncrypted: text('content_encrypted'),
    contentChars: integer('content_chars').notNull(),
    truncated: boolean('truncated').notNull(),
    imageCount: integer('image_count').notNull(),
    status: moderationStatus('status').default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastError: text('last_error'),
    verdict: moderationVerdict('verdict'),
    category: text('category').$type<ModerationCategory>(),
    severity: integer('severity'),
    violationScore: real('violation_score'),
    /** 审核接口返回的完整答案。 */
    answers: jsonb('answers').$type<Record<string, unknown>>(),
    auditModel: text('audit_model'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgedBy: uuid('acknowledged_by').references(() => users.id),
    contentPurgedAt: timestamp('content_purged_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    unique('moderation_sessions_session_unique').on(table.userId, table.sessionHash, table.day),
    index('moderation_sessions_queue_idx').on(table.status, table.lockedUntil),
    index('moderation_sessions_alert_idx').on(table.verdict, table.acknowledgedAt, table.createdAt),
    index('moderation_sessions_user_idx').on(table.userId, table.createdAt),
    check(
      'moderation_sessions_counts',
      sql`${table.requestCount} >= 1 and ${table.contentChars} >= 0 and ${table.imageCount} >= 0 and ${table.attempts} >= 0`,
    ),
    check('moderation_sessions_severity', sql`${table.severity} is null or ${table.severity} between 0 and 3`),
    check(
      'moderation_sessions_decided',
      sql`(${table.status} = 'done') = (${table.verdict} is not null and ${table.decidedAt} is not null)`,
    ),
  ],
);

/** 审核使用的渠道、模型和规则；单行。 */
export const moderationSettings = pgTable(
  'moderation_settings',
  {
    id: integer('id').primaryKey().default(1),
    channelId: uuid('channel_id').references(() => channels.id),
    model: text('model'),
    rules: text('rules').default('').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    updatedBy: uuid('updated_by').references(() => users.id),
  },
  (table) => [
    check('moderation_settings_singleton', sql`${table.id} = 1`),
    check('moderation_settings_rules', sql`char_length(${table.rules}) <= 8000`),
    check('moderation_settings_model', sql`${table.model} is null or char_length(${table.model}) between 1 and 128`),
  ],
);
