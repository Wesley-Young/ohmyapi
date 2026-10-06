import { sql } from 'drizzle-orm';
import { check, integer, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { models } from './catalog.js';
import { createdAt, id, micros, tokenCount } from './common.js';

export const priceRuleKind = pgEnum('price_rule_kind', ['default', 'context', 'time', 'combined']);

export const priceRules = pgTable(
  'price_rules',
  {
    id: id(),
    modelId: uuid('model_id')
      .notNull()
      .references(() => models.id),
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
    uniqueIndex('price_rules_default_unique').on(table.modelId).where(sql`${table.kind} = 'default'`),
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
