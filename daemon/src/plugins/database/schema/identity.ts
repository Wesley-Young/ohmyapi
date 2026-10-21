import { sql } from 'drizzle-orm';
import {
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
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, id } from './common.ts';

export const userRole = pgEnum('user_role', ['admin', 'user']);
export const userStatus = pgEnum('user_status', ['active', 'disabled']);

export const users = pgTable(
  'users',
  {
    id: id(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRole('role').default('user').notNull(),
    status: userStatus('status').default('active').notNull(),
    /** 网关并发请求数上限，覆盖 GATEWAY_USER_CONCURRENCY；null 时使用全局配置。 */
    maxConcurrent: integer('max_concurrent'),
    createdAt: createdAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('users_username_unique').on(table.username).where(sql`${table.deletedAt} is null`),
    check('users_username_format', sql`${table.username} ~ '^[a-z0-9][a-z0-9_.-]{2,63}$'`),
    check('users_concurrency', sql`${table.maxConcurrent} is null or ${table.maxConcurrent} between 1 and 1000`),
  ],
);

/** 用户组只是普通用户的标签；组级授权在操作时展开写入每个成员的渠道授权。 */
export const userGroups = pgTable(
  'user_groups',
  {
    id: id(),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('user_groups_name_unique').on(table.name),
    check('user_groups_name_length', sql`char_length(${table.name}) between 1 and 64`),
  ],
);

export const userGroupMembers = pgTable(
  'user_group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => userGroups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.userId] }),
    index('user_group_members_user_idx').on(table.userId),
  ],
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
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [index('api_keys_user_idx').on(table.userId), unique('api_keys_owner_unique').on(table.id, table.userId)],
);

/** 管理令牌的权限范围，顺序即界面展示顺序。 */
export const adminScopes = ['users:read', 'users:write', 'wallet:read', 'wallet:write', 'channels:read'] as const;
export type AdminScope = (typeof adminScopes)[number];
export const adminScope = pgEnum('admin_scope', adminScopes);

/** 公开 API 的管理令牌，以所属管理员的身份调用；只保存哈希。 */
export const adminTokens = pgTable(
  'admin_tokens',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    /** 令牌末尾几位，用于在界面上辨认。 */
    hint: text('hint').notNull(),
    scopes: adminScope('scopes').array().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index('admin_tokens_user_idx').on(table.userId),
    check('admin_tokens_name_length', sql`char_length(${table.name}) between 1 and 64`),
    check('admin_tokens_scopes_not_empty', sql`cardinality(${table.scopes}) > 0`),
  ],
);

/** 初始化标记：存在即表示已创建首个管理员。货币和计费约定由配置与代码决定，见 config.ts 和 core/money.ts。 */
export const systemSettings = pgTable(
  'system_settings',
  {
    id: integer('id').primaryKey().default(1),
    bootstrapAdminId: uuid('bootstrap_admin_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [check('system_settings_singleton', sql`${table.id} = 1`)],
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
