import { readBillingCurrency, readDatabaseConfig } from '../config.ts';
import { errorDetails, formatEvent, globalLogger } from '../core/logging.ts';
import { createDatabase } from '../plugins/database/client.ts';
import { initializeDatabase } from './bootstrap.ts';

async function main() {
  const options = {
    currency: readBillingCurrency(),
    username: process.env.BOOTSTRAP_ADMIN_USERNAME,
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  };
  // Credentials are consumed only by this command, never by the running server.
  delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const { db, pool } = createDatabase(readDatabaseConfig());
  try {
    const result = await initializeDatabase(db, options);
    globalLogger.info(
      result.created
        ? 'Administrator, wallet, and billing settings initialized'
        : 'Database already initialized; existing credentials preserved',
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  globalLogger.error(formatEvent('数据库初始化失败', errorDetails(error)));
  process.exitCode = 1;
});
