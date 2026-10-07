import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';

import type { Database } from './client.js';

import { fileURLToPath } from 'node:url';

const migrationsFolder = fileURLToPath(new URL('../../../drizzle/', import.meta.url));

export async function assertMigrationsCurrent(db: Database) {
  const latest = readMigrationFiles({ migrationsFolder }).at(-1);
  const result = await db.execute<{ hash: string }>(
    sql`select hash from drizzle.__drizzle_migrations order by created_at desc limit 1`,
  );
  if (!latest || result.rows[0]?.hash !== latest.hash) {
    throw new Error('Database migrations are out of date; run pnpm db:migrate');
  }
}

export async function migrateDatabase(pool: Pool) {
  const client = await pool.connect();
  try {
    // Session lock serializes deployment jobs; migrate runs its own transaction.
    await client.query('select pg_advisory_lock(1330138458)');
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    // Destroy this dedicated connection to release the lock even after errors.
    client.release(true);
  }
}
