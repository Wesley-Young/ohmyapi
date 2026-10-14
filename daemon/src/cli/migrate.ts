import { readDatabaseConfig } from '../config.js';
import { errorDetails, formatEvent, globalLogger } from '../core/logging.js';
import { createDatabase } from '../plugins/database/client.js';
import { migrateDatabase } from '../plugins/database/migrate.js';

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
