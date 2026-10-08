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

export function readSessionConfig(env: Environment = process.env) {
  const raw = env.SESSION_COOKIE_SECURE;
  if (raw !== undefined && raw !== 'true' && raw !== 'false')
    throw new Error('SESSION_COOKIE_SECURE must be true or false');
  let origin: string | undefined;
  if (env.APP_ORIGIN) {
    const url = new URL(env.APP_ORIGIN);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== env.APP_ORIGIN)
      throw new Error('APP_ORIGIN must be an HTTP(S) origin without a trailing slash');
    origin = url.origin;
  }
  return { secure: raw === undefined ? env.NODE_ENV === 'production' : raw === 'true', origin };
}

export function readGatewayConfig(env: Environment = process.env) {
  if (!env.CHANNEL_ENCRYPTION_KEY) throw new Error('CHANNEL_ENCRYPTION_KEY is required');
  if (!/^[a-fA-F0-9]{64}$/.test(env.CHANNEL_ENCRYPTION_KEY)) {
    throw new Error('CHANNEL_ENCRYPTION_KEY must contain 64 hexadecimal characters');
  }
  return {
    maxBodyBytes: integerSetting(env, 'GATEWAY_MAX_BODY_BYTES', 32 * 1024 * 1024, 32 * 1024 * 1024),
    bodyTimeoutMs: integerSetting(env, 'GATEWAY_BODY_TIMEOUT_MS', 120_000, 600_000),
    streamIdleTimeoutMs: integerSetting(env, 'GATEWAY_STREAM_IDLE_TIMEOUT_MS', 300_000, 3_600_000),
    maxUsageEventBytes: integerSetting(env, 'GATEWAY_MAX_USAGE_EVENT_BYTES', 128 * 1024 * 1024, 256 * 1024 * 1024),
    maxUsageBodyBytes: integerSetting(env, 'GATEWAY_MAX_USAGE_BODY_BYTES', 128 * 1024 * 1024, 256 * 1024 * 1024),
    maxConcurrent: integerSetting(env, 'GATEWAY_USER_CONCURRENCY', 4, 100),
    requestsPerMinute: integerSetting(env, 'GATEWAY_USER_RPM', 60, 10_000),
  };
}

export function validateProductionConfig(env: Environment = process.env) {
  readServerConfig(env);
  readDatabaseConfig(env);
  readBillingCurrency(env);
  readGatewayConfig(env);
  const session = readSessionConfig(env);
  if (!session.origin) throw new Error('APP_ORIGIN is required for production deployment');
  if (session.origin.startsWith('http:') && session.secure) {
    throw new Error('HTTP deployments require SESSION_COOKIE_SECURE=false');
  }
}
