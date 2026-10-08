import { readBillingCurrency, readDatabaseConfig } from '../config.js';
import { errorDetails, globalLogger } from '../logging.js';
import { initializeDatabase } from '../plugins/database/bootstrap.js';
import { createDatabase } from '../plugins/database/client.js';

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
  globalLogger.error(`数据库初始化失败 ${JSON.stringify(errorDetails(error))}`);
  process.exitCode = 1;
});
