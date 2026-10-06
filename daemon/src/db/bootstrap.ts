import { eq, sql } from 'drizzle-orm';

import { hashPassword, validatePassword } from '../auth/password.js';
import { billingConventions } from '../billing/conventions.js';
import type { Database } from './client.js';
import { assertMigrationsCurrent } from './migrate.js';
import { adminAuditLogs, systemSettings, users, wallets } from './schema/index.js';

export interface BootstrapOptions {
  currency: string;
  username?: string;
  password?: string;
}

/** A single transaction, serialized across simultaneous init processes. */
export async function initializeDatabase(db: Database, options: BootstrapOptions) {
  if (!['USD', 'CNY'].includes(options.currency)) throw new Error('Billing currency must be USD or CNY');
  await assertMigrationsCurrent(db);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(1330138457)`);
    const [existing] = await tx.select().from(systemSettings).where(eq(systemSettings.id, 1));
    if (existing) {
      if (existing.currency !== options.currency)
        throw new Error('Billing currency differs from the initialized database');
      return { created: false, adminId: existing.bootstrapAdminId };
    }

    if (!options.username || !/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(options.username)) {
      throw new Error(
        'BOOTSTRAP_ADMIN_USERNAME must be 3–64 lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit',
      );
    }
    if (!options.password) throw new Error('BOOTSTRAP_ADMIN_PASSWORD is required for the first initialization');
    validatePassword(options.password);
    const [existingAdmin] = await tx.select({ id: users.id }).from(users).where(eq(users.role, 'admin')).limit(1);
    if (existingAdmin)
      throw new Error('An administrator already exists without system settings; recover the database explicitly');

    const [admin] = await tx
      .insert(users)
      .values({
        username: options.username,
        passwordHash: await hashPassword(options.password),
        role: 'admin',
      })
      .returning({ id: users.id });
    await tx.insert(wallets).values({ userId: admin.id });
    await tx.insert(systemSettings).values({
      currency: options.currency,
      moneyScale: Number(billingConventions.moneyScale),
      priceTokenUnit: Number(billingConventions.priceTokenUnit),
      timezone: billingConventions.timezone,
      contextPricing: billingConventions.contextPricing,
      rounding: billingConventions.rounding,
      missingUsage: billingConventions.missingUsage,
      bootstrapAdminId: admin.id,
    });
    await tx.insert(adminAuditLogs).values({
      actorId: admin.id,
      action: 'system.bootstrap',
      targetType: 'user',
      targetId: admin.id,
      metadata: { currency: options.currency },
    });
    return { created: true, adminId: admin.id };
  });
}
