import { type Disposable, serviceToken } from '@fraqjs/kernel';
import { eq, sql } from 'drizzle-orm';

import type { DatabaseConfig } from '../../config.js';
import { readBillingCurrency } from '../../config.js';
import { definePlugin } from '../../kernel.js';
import { createDatabase } from './client.js';
import { assertMigrationsCurrent } from './migrate.js';
import { systemSettings } from './schema/index.js';

export class DatabaseService implements Disposable {
  static readonly token = serviceToken<DatabaseService>('ohmyapi/database');
  private readonly connection;
  readonly db;

  constructor(config: DatabaseConfig) {
    this.connection = createDatabase(config);
    this.db = this.connection.db;
  }

  async assertInitialized(currency: string) {
    await assertMigrationsCurrent(this.db);
    const [settings] = await this.db.select().from(systemSettings).where(eq(systemSettings.id, 1));
    if (!settings) throw new Error('Database is not initialized; run pnpm db:migrate and pnpm db:init');
    if (settings.currency !== currency) {
      await this.db.update(systemSettings).set({ currency }).where(eq(systemSettings.id, 1));
    }
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
  async apply(ctx, config: DatabaseConfig, currency: string = readBillingCurrency()) {
    const service = new DatabaseService(config);
    ctx.provide(DatabaseService, service);
    await service.assertInitialized(currency);
  },
});
