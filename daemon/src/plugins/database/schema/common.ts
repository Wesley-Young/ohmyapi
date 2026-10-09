import { bigint, pgEnum, timestamp, uuid } from 'drizzle-orm/pg-core';

export const endpoint = pgEnum('endpoint', [
  '/v1/chat/completions',
  '/v1/responses',
  '/v1/messages',
  '/v1/responses/compact',
]);
export const id = () => uuid('id').defaultRandom().primaryKey();
export const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
export const micros = (name: string) => bigint(name, { mode: 'bigint' });
export const tokenCount = (name: string) => bigint(name, { mode: 'bigint' });
