import { type Disposable, serviceToken } from '@fraqjs/kernel';
import { eq, sql } from 'drizzle-orm';

import type { DatabaseConfig } from '../../config.ts';
import { definePlugin } from '../../kernel.ts';
import { createDatabase } from './client.ts';
import { assertMigrationsCurrent } from './migrate.ts';
import { systemSettings } from './schema/index.ts';

export class DatabaseService implements Disposable {
  static readonly token = serviceToken<DatabaseService>('ohmyapi/database');
  private readonly connection;
  readonly db;

  constructor(config: DatabaseConfig) {
    this.connection = createDatabase(config);
    this.db = this.connection.db;
  }

  async assertInitialized() {
    await assertMigrationsCurrent(this.db);
    const [settings] = await this.db.select().from(systemSettings).where(eq(systemSettings.id, 1));
    if (!settings) throw new Error('Database is not initialized; run pnpm db:migrate and pnpm db:init');
  }

  async checkConnection() {
    await this.db.execute(sql`select 1`);
  }

  async dispose() {
    await this.connection.pool.end();
  }
}

export const DatabasePlugin = definePlugin({
  name: 'ohmyapi-database',
  provides: [DatabaseService],
  async apply(ctx) {
    const service = new DatabaseService(ctx.config.database);
    ctx.provide(DatabaseService, service);
    await service.assertInitialized();
  },
});
