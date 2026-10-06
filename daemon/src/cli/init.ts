import { readBillingCurrency, readDatabaseConfig } from '../config.js';
import { initializeDatabase } from '../db/bootstrap.js';
import { createDatabase } from '../db/client.js';

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
    console.info(
      result.created
        ? 'Administrator, wallet, and billing settings initialized'
        : 'Database already initialized; existing credentials preserved',
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // Drizzle query errors carry parameter values; do not log them or their causes.
  console.error(
    error instanceof Error && !('cause' in error)
      ? error.message
      : 'Database initialization failed. Check migrations and PostgreSQL connectivity.',
  );
  process.exitCode = 1;
});
