import { sql } from 'drizzle-orm';
import { check, foreignKey, index, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, id, micros } from './common.js';
import { users } from './identity.js';
import { requests } from './requests.js';

export const ledgerKind = pgEnum('ledger_kind', ['adjustment', 'reserve', 'settlement', 'release', 'correction']);

export const wallets = pgTable(
  'wallets',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id),
    balanceMicros: micros('balance_micros').default(sql`0`).notNull(),
    reservedMicros: micros('reserved_micros').default(sql`0`).notNull(),
    createdAt: createdAt(),
  },
  (table) => [check('wallets_reserved_nonnegative', sql`${table.reservedMicros} >= 0`)],
);

export const walletLedger = pgTable(
  'wallet_ledger',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => wallets.userId),
    requestId: uuid('request_id').references(() => requests.id),
    kind: ledgerKind('kind').notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    balanceDeltaMicros: micros('balance_delta_micros').notNull(),
    reservedDeltaMicros: micros('reserved_delta_micros').notNull(),
    balanceAfterMicros: micros('balance_after_micros').notNull(),
    reservedAfterMicros: micros('reserved_after_micros').notNull(),
    actorId: uuid('actor_id').references(() => users.id),
    reason: text('reason').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({ columns: [table.requestId, table.userId], foreignColumns: [requests.id, requests.userId] }),
    index('wallet_ledger_user_time_idx').on(table.userId, table.createdAt),
    uniqueIndex('wallet_ledger_request_event_unique')
      .on(table.requestId, table.kind)
      .where(sql`${table.kind} in ('reserve', 'settlement', 'release')`),
    uniqueIndex('wallet_ledger_request_final_unique')
      .on(table.requestId)
      .where(sql`${table.kind} in ('settlement', 'release')`),
    check('wallet_ledger_reserved_nonnegative', sql`${table.reservedAfterMicros} >= 0`),
    check('wallet_ledger_reason_present', sql`${table.kind} = 'adjustment' or length(trim(${table.reason})) > 0`),
    check(
      'wallet_ledger_event_shape',
      sql`
    (${table.kind} in ('adjustment', 'correction') and ${table.actorId} is not null and ${table.balanceDeltaMicros} <> 0 and ${table.reservedDeltaMicros} = 0)
    or (${table.kind} = 'reserve' and ${table.requestId} is not null and ${table.balanceDeltaMicros} = 0 and ${table.reservedDeltaMicros} > 0)
    or (${table.kind} = 'release' and ${table.requestId} is not null and ${table.balanceDeltaMicros} = 0 and ${table.reservedDeltaMicros} < 0)
    or (${table.kind} = 'settlement' and ${table.requestId} is not null and ${table.balanceDeltaMicros} <= 0 and ${table.reservedDeltaMicros} <= 0)
  `,
    ),
  ],
);
