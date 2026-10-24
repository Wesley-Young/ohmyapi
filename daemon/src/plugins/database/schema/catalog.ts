import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, endpoint, id } from './common.ts';
import { apiKeys, users } from './identity.ts';
import { subscriptionAccounts } from './subscription.ts';

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

export const channelTypes = ['api', 'subscription', 'aggregate'] as const;
export type ChannelType = (typeof channelTypes)[number];
export const pricingModes = ['unified', 'passthrough'] as const;
export type PricingMode = (typeof pricingModes)[number];

export const channelType = pgEnum('channel_type', channelTypes);
export const channelPricingMode = pgEnum('channel_pricing_mode', pricingModes);

export const channels = pgTable(
  'channels',
  {
    id: id(),
    name: text('name').notNull(),
    type: channelType('type').default('api').notNull(),
    pricingMode: channelPricingMode('pricing_mode').default('unified').notNull(),
    baseUrl: text('base_url'),
    proxyUrlEncrypted: text('proxy_url_encrypted'),
    // API 渠道的凭据使用认证加密保存；其他类型由各自的账号或成员配置提供连接信息。
    credentialEncrypted: text('credential_encrypted'),
    subscriptionAccountId: uuid('subscription_account_id').references(() => subscriptionAccounts.id),
    enabled: boolean('enabled').default(true).notNull(),
    isPublic: boolean('is_public').default(true).notNull(),
    timeoutMs: integer('timeout_ms').default(120_000).notNull(),
    /** API 渠道同时执行的请求数上限，null 表示不限；订阅渠道使用账号的上限。 */
    maxConcurrent: integer('max_concurrent'),
    multiplierMicros: bigint('multiplier_micros', { mode: 'bigint' }).default(sql`1000000`).notNull(),
    createdAt: createdAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('channels_name_unique').on(table.name).where(sql`${table.deletedAt} is null`),
    uniqueIndex('channels_subscription_account_unique')
      .on(table.subscriptionAccountId)
      .where(sql`${table.deletedAt} is null`),
    check('channels_proxy_type', sql`${table.type} <> 'aggregate' or ${table.proxyUrlEncrypted} is null`),
    check('channels_timeout_positive', sql`${table.timeoutMs} > 0`),
    check(
      'channels_concurrency',
      sql`${table.maxConcurrent} is null or (${table.type} = 'api' and ${table.maxConcurrent} between 1 and 1000)`,
    ),
    check(
      'channels_subscription_config',
      sql`(${table.type} = 'subscription' and ${table.subscriptionAccountId} is not null) or (${table.type} <> 'subscription' and ${table.subscriptionAccountId} is null)`,
    ),
    check(
      'channels_connection_config',
      sql`(${table.type} = 'api' and ${table.baseUrl} is not null and ${table.credentialEncrypted} is not null) or (${table.type} <> 'api' and ${table.baseUrl} is null and ${table.credentialEncrypted} is null)`,
    ),
    check('channels_multiplier_range', sql`${table.multiplierMicros} between 0 and 1000000000`),
    check('channels_pricing_mode_type', sql`${table.type} = 'aggregate' or ${table.pricingMode} = 'unified'`),
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

export const aggregateChannelMembers = pgTable(
  'aggregate_channel_members',
  {
    aggregateChannelId: uuid('aggregate_channel_id')
      .notNull()
      .references(() => channels.id),
    memberChannelId: uuid('member_channel_id')
      .notNull()
      .references(() => channels.id),
    priority: integer('priority').default(0).notNull(),
    weight: integer('weight').default(1).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.aggregateChannelId, table.memberChannelId] }),
    index('aggregate_members_member_idx').on(table.memberChannelId),
    check('aggregate_members_no_self', sql`${table.aggregateChannelId} <> ${table.memberChannelId}`),
    check('aggregate_members_priority_range', sql`${table.priority} between 0 and 1000`),
    check('aggregate_members_weight_range', sql`${table.weight} between 1 and 1000`),
  ],
);

/** 请求的推理强度等于 from 时改为 to；按 from 精确匹配，不链式应用。 */
export type ReasoningEffortRule = { from: string; to: string };

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
    /**
     * 发往上游的模型名，null 表示与模型名称相同。只改写转发的请求，价格、倍率和权限仍按 modelId。
     * 聚合渠道由子渠道各自配置，不使用此列。
     */
    upstreamModel: text('upstream_model'),
    /**
     * 发往上游前对推理强度的改写规则，空数组表示不改写。只改写转发的请求，价格、倍率和权限仍按 modelId。
     * 聚合渠道由子渠道各自配置，不使用此列。
     */
    reasoningEffortRules: jsonb('reasoning_effort_rules').$type<ReasoningEffortRule[]>().default([]).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.modelId] }),
    check(
      'channel_models_multiplier_range',
      sql`${table.multiplierMicros} is null or ${table.multiplierMicros} between 0 and 1000000000`,
    ),
    check(
      'channel_models_upstream_model',
      sql`${table.upstreamModel} is null or length(${table.upstreamModel}) between 1 and 128`,
    ),
    check(
      'channel_models_reasoning_effort_rules',
      sql`jsonb_typeof(${table.reasoningEffortRules}) = 'array' and jsonb_array_length(${table.reasoningEffortRules}) <= 16`,
    ),
  ],
);

export const userChannelGrants = pgTable(
  'user_channel_grants',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
  },
  (table) => [primaryKey({ columns: [table.userId, table.channelId] })],
);

/** 公开渠道对个别用户的屏蔽；渠道改为非公开时不生效。 */
export const userChannelBlocks = pgTable(
  'user_channel_blocks',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
  },
  (table) => [primaryKey({ columns: [table.userId, table.channelId] })],
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
