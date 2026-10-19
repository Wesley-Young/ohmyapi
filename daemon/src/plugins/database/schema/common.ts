import { endpoints } from '@ohmyapi/protocols';
import { bigint, pgEnum, timestamp, uuid } from 'drizzle-orm/pg-core';

export { type Endpoint, endpoints } from '@ohmyapi/protocols';

export const endpoint = pgEnum('endpoint', endpoints);
export const id = () => uuid('id').defaultRandom().primaryKey();
export const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
export const micros = (name: string) => bigint(name, { mode: 'bigint' });
export const tokenCount = (name: string) => bigint(name, { mode: 'bigint' });
