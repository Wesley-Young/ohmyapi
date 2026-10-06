import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { modelEndpoints } from './catalog.js';
import { createdAt, endpoint, id, micros, tokenCount } from './common.js';
import { users } from './identity.js';

export const priceStatus = pgEnum('price_status', ['draft', 'published']);
export const priceRuleKind = pgEnum('price_rule_kind', ['default', 'context', 'time', 'combined']);

export const priceVersions = pgTable(
  'price_versions',
  {
    id: id(),
    modelId: uuid('model_id').notNull(),
    endpoint: endpoint('endpoint').notNull(),
    version: integer('version').notNull(),
    status: priceStatus('status').default('draft').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      columns: [table.modelId, table.endpoint],
      foreignColumns: [modelEndpoints.modelId, modelEndpoints.endpoint],
    }),
    unique('price_versions_number_unique').on(table.modelId, table.endpoint, table.version),
    unique('price_versions_scope_unique').on(table.id, table.modelId, table.endpoint),
    uniqueIndex('price_versions_effective_unique')
      .on(table.modelId, table.endpoint, table.effectiveAt)
      .where(sql`${table.status} = 'published'`),
    check('price_versions_number_positive', sql`${table.version} > 0`),
    check(
      'price_versions_publication',
      sql`(${table.status} = 'draft' and ${table.publishedAt} is null) or (${table.status} = 'published' and ${table.publishedAt} is not null and ${table.effectiveAt} is not null)`,
    ),
  ],
);

export const priceRules = pgTable(
  'price_rules',
  {
    id: id(),
    priceVersionId: uuid('price_version_id')
      .notNull()
      .references(() => priceVersions.id),
    kind: priceRuleKind('kind').notNull(),
    label: text('label').default('价格规则').notNull(),
    // Context intervals use [min, max), with NULL max meaning no upper bound.
    contextMin: tokenCount('context_min'),
    contextMax: tokenCount('context_max'),
    // Bit 0 = Monday, bit 6 = Sunday. Time intervals use [start, end).
    weekdaysMask: integer('weekdays_mask'),
    startMinute: integer('start_minute'),
    endMinute: integer('end_minute'),
    timezone: text('timezone').default('Asia/Shanghai').notNull(),
    inputPriceMicros: micros('input_price_micros').notNull(),
    outputPriceMicros: micros('output_price_micros').notNull(),
    // NULL means unsupported/unconfigured, not free.
    cacheReadPriceMicros: micros('cache_read_price_micros'),
    cacheWritePriceMicros: micros('cache_write_price_micros'),
    createdAt: createdAt(),
  },
  (table) => [
    unique('price_rules_version_unique').on(table.id, table.priceVersionId),
    uniqueIndex('price_rules_default_unique').on(table.priceVersionId).where(sql`${table.kind} = 'default'`),
    check(
      'price_rules_context_shape',
      sql`(${table.kind} in ('context', 'combined') and ${table.contextMin} is not null and ${table.contextMin} >= 0 and (${table.contextMax} is null or ${table.contextMax} > ${table.contextMin})) or (${table.kind} in ('default', 'time') and ${table.contextMin} is null and ${table.contextMax} is null)`,
    ),
    check(
      'price_rules_time_shape',
      sql`(${table.kind} in ('time', 'combined') and ${table.weekdaysMask} is not null and ${table.weekdaysMask} between 1 and 127 and ${table.startMinute} is not null and ${table.startMinute} >= 0 and ${table.endMinute} is not null and ${table.endMinute} <= 1440 and ${table.endMinute} > ${table.startMinute}) or (${table.kind} in ('default', 'context') and ${table.weekdaysMask} is null and ${table.startMinute} is null and ${table.endMinute} is null)`,
    ),
    check('price_rules_timezone', sql`${table.timezone} = 'Asia/Shanghai'`),
    check(
      'price_rules_prices_nonnegative',
      sql`${table.inputPriceMicros} >= 0 and ${table.outputPriceMicros} >= 0 and (${table.cacheReadPriceMicros} is null or ${table.cacheReadPriceMicros} >= 0) and (${table.cacheWritePriceMicros} is null or ${table.cacheWritePriceMicros} >= 0)`,
    ),
  ],
);
