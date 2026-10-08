import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { DatabaseConfig } from '../../config.js';
import { errorDetails, globalLogger } from '../../logging.js';
import * as schema from './schema/index.js';

export function createDatabase(config: DatabaseConfig) {
  const pool = new Pool(config);
  const db = drizzle({ client: pool, schema });
  // pg requires a listener for errors from idle connections. Never log the URL.
  pool.on('error', (error) => globalLogger.error(`空闲 PostgreSQL 连接失败 ${JSON.stringify(errorDetails(error))}`));
  return { db, pool };
}

export type Database = ReturnType<typeof createDatabase>['db'];
