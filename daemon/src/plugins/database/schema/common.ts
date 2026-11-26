import { type Endpoint, endpoints, type FamilyEndpoint, familyEndpoints, protocolFor } from '@ohmyapi/protocols';
import { bigint, pgEnum, timestamp, uuid } from 'drizzle-orm/pg-core';

export { type Endpoint, endpoints } from '@ohmyapi/protocols';

/** 渠道按协议族配置，使用主端点匹配该族的所有请求。 */
export const channelEndpointFor = (path: Endpoint) => familyEndpoints[protocolFor(path).family];

export const endpoint = pgEnum('endpoint', endpoints);
export const channelEndpointColumn = () => endpoint('endpoint').$type<FamilyEndpoint>().notNull();
export const id = () => uuid('id').defaultRandom().primaryKey();
export const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
export const micros = (name: string) => bigint(name, { mode: 'bigint' });
export const tokenCount = (name: string) => bigint(name, { mode: 'bigint' });
