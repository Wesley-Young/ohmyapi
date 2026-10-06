import { readDatabaseConfig } from '../config.js';
import { createDatabase } from '../db/client.js';
import { migrateDatabase } from '../db/migrate.js';

async function main() {
  const { pool } = createDatabase(readDatabaseConfig());
  try {
    await migrateDatabase(pool);
    console.info('Database migrations completed');
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  console.error('Database migration failed. Check DATABASE_URL, PostgreSQL connectivity, and migration SQL.');
  process.exitCode = 1;
});
