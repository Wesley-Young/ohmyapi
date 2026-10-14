import { defineConfig } from 'drizzle-kit';

import { readDatabaseConfig } from './src/config.ts';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/plugins/database/schema/index.ts',
  out: './drizzle',
  ...(process.env.DATABASE_URL ? { dbCredentials: { url: readDatabaseConfig().connectionString } } : {}),
  strict: true,
});
