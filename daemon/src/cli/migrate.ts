import { readDatabaseConfig } from '../config.ts';
import { errorDetails, formatEvent, globalLogger } from '../core/logging.ts';
import { createDatabase } from '../plugins/database/client.ts';
import { migrateDatabase } from '../plugins/database/migrate.ts';

async function main() {
  const { pool } = createDatabase(readDatabaseConfig());
  try {
    await migrateDatabase(pool);
    globalLogger.info('Database migrations completed');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  globalLogger.error(formatEvent('数据库迁移失败', errorDetails(error)));
  process.exitCode = 1;
});
