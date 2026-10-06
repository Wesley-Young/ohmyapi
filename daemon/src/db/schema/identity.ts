import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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

import { createdAt, id } from './common.js';

export const userRole = pgEnum('user_role', ['admin', 'user']);
export const userStatus = pgEnum('user_status', ['active', 'disabled']);

export const users = pgTable(
  'users',
  {
    id: id(),
    username: text('username').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    role: userRole('role').default('user').notNull(),
    status: userStatus('status').default('active').notNull(),
    createdAt: createdAt(),
  },
  (table) => [check('users_username_format', sql`${table.username} ~ '^[a-z0-9][a-z0-9_.-]{2,63}$'`)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index('sessions_user_idx').on(table.userId), index('sessions_expiry_idx').on(table.expiresAt)],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    key: text('key').notNull().unique(),
    restrictModels: boolean('restrict_models').default(false).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index('api_keys_user_idx').on(table.userId), unique('api_keys_owner_unique').on(table.id, table.userId)],
);

export const systemSettings = pgTable(
  'system_settings',
  {
    id: integer('id').primaryKey().default(1),
    currency: text('currency').notNull(),
    moneyScale: integer('money_scale').default(1_000_000).notNull(),
    priceTokenUnit: integer('price_token_unit').default(1_000_000).notNull(),
    timezone: text('timezone').default('Asia/Shanghai').notNull(),
    contextPricing: text('context_pricing').default('whole_request').notNull(),
    rounding: text('rounding').default('ceil_total').notNull(),
    missingUsage: text('missing_usage').default('needs_review').notNull(),
    bootstrapAdminId: uuid('bootstrap_admin_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [
    check('system_settings_singleton', sql`${table.id} = 1`),
    check('system_settings_currency', sql`${table.currency} in ('USD', 'CNY')`),
    check(
      'system_settings_conventions',
      sql`${table.moneyScale} = 1000000 and ${table.priceTokenUnit} = 1000000 and ${table.timezone} = 'Asia/Shanghai' and ${table.contextPricing} = 'whole_request' and ${table.rounding} = 'ceil_total' and ${table.missingUsage} = 'needs_review'`,
    ),
  ],
);

export const adminAuditLogs = pgTable(
  'admin_audit_logs',
  {
    id: id(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [index('audit_actor_time_idx').on(table.actorId, table.createdAt)],
);
