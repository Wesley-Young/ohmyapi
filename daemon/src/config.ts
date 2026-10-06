type Environment = Record<string, string | undefined>;

function integerSetting(env: Environment, name: string, fallback: number, max: number) {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be between 1 and ${max}`);
  }
  return value;
}

export function readDatabaseConfig(env: Environment = process.env) {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL must be a PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) {
    throw new Error('DATABASE_URL must identify a PostgreSQL host and database');
  }
  return {
    connectionString,
    max: integerSetting(env, 'DATABASE_POOL_MAX', 10, 100),
    connectionTimeoutMillis: integerSetting(env, 'DATABASE_CONNECT_TIMEOUT_MS', 5_000, 60_000),
    idleTimeoutMillis: 30_000,
  };
}

export type DatabaseConfig = ReturnType<typeof readDatabaseConfig>;

export function readBillingCurrency(env: Environment = process.env) {
  const currency = env.BILLING_CURRENCY ?? 'USD';
  if (!['USD', 'CNY'].includes(currency)) throw new Error('BILLING_CURRENCY must be USD or CNY');
  return currency;
}

export function readServerConfig(env: Environment = process.env) {
  return { host: env.HOST ?? '127.0.0.1', port: integerSetting(env, 'PORT', 8000, 65535) };
}
