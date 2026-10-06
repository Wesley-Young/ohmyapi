import { defineConfig } from 'drizzle-kit';

import { readDatabaseConfig } from './src/config.js';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  ...(process.env.DATABASE_URL ? { dbCredentials: { url: readDatabaseConfig().connectionString } } : {}),
  strict: true,
});
