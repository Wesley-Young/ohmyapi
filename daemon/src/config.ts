import { z } from 'zod';

import { parseMoney } from './core/money.ts';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

/** 新用户的默认初始余额，单位为百万分之一货币单位。 */
function readUserInitialBalance(env: Environment) {
  const raw = env.USER_INITIAL_BALANCE || '0';
  let micros: bigint;
  try {
    micros = parseMoney(raw);
  } catch {
    throw new Error('USER_INITIAL_BALANCE must be a decimal amount with at most six decimal places');
  }
  if (micros < 0n) throw new Error('USER_INITIAL_BALANCE must not be negative');
  return micros;
}

function readServerConfig(env: Environment) {
  return { host: env.HOST ?? '127.0.0.1', port: integerSetting(env, 'PORT', 8000, 65535) };
}

function readSessionConfig(env: Environment) {
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

function readEncryptionKey(env: Environment) {
  const key = env.CHANNEL_ENCRYPTION_KEY;
  if (!key) throw new Error('CHANNEL_ENCRYPTION_KEY is required');
  if (!/^[a-fA-F0-9]{64}$/.test(key)) throw new Error('CHANNEL_ENCRYPTION_KEY must contain 64 hexadecimal characters');
  return key;
}

function readGatewayConfig(env: Environment) {
  return {
    maxBodyBytes: integerSetting(env, 'GATEWAY_MAX_BODY_BYTES', 32 * 1024 * 1024, 32 * 1024 * 1024),
    bodyTimeoutMs: integerSetting(env, 'GATEWAY_BODY_TIMEOUT_MS', 120_000, 600_000),
    bodyIdleTimeoutMs: integerSetting(env, 'GATEWAY_BODY_IDLE_TIMEOUT_MS', 20_000, 600_000),
    streamIdleTimeoutMs: integerSetting(env, 'GATEWAY_STREAM_IDLE_TIMEOUT_MS', 300_000, 3_600_000),
    disconnectDrainTimeoutMs: integerSetting(env, 'GATEWAY_DISCONNECT_DRAIN_TIMEOUT_MS', 600_000, 3_600_000),
    // 用量解析在事件循环中同步执行 JSON.parse，上限同时约束单次阻塞时长和每个请求额外占用的内存。
    maxUsageEventBytes: integerSetting(env, 'GATEWAY_MAX_USAGE_EVENT_BYTES', 16 * 1024 * 1024, 64 * 1024 * 1024),
    maxUsageBodyBytes: integerSetting(env, 'GATEWAY_MAX_USAGE_BODY_BYTES', 16 * 1024 * 1024, 64 * 1024 * 1024),
    maxConcurrent: integerSetting(env, 'GATEWAY_USER_CONCURRENCY', 4, 100),
    requestsPerMinute: integerSetting(env, 'GATEWAY_USER_RPM', 60, 10_000),
  };
}

export type GatewayConfig = ReturnType<typeof readGatewayConfig>;

/** 仓库根目录下的接入点配置。 */
const accessEndpointsFile = new URL('../../endpoints.json', import.meta.url);

function isBaseUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    ['http:', 'https:'].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !raw.endsWith('/') &&
    (url.href === raw || url.href === `${raw}/`)
  );
}

const accessEndpointsSchema = z
  .array(
    z.strictObject({
      id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'id must be 1-32 lowercase letters, digits or hyphens'),
      label: z.string().trim().min(1).max(32),
      baseUrl: z
        .string()
        .refine(isBaseUrl, 'baseUrl must be a normalized HTTP(S) URL without a trailing slash, query or hash'),
      description: z.string().trim().min(1).max(500).optional(),
    }),
  )
  .min(1)
  .max(20)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length, 'id must be unique');

export type AccessEndpoint = z.infer<typeof accessEndpointsSchema>[number];

/** 读取接入点配置；文件不存在时返回空列表，存在但无效时抛出错误。 */
export function readAccessEndpoints(file: URL = accessEndpointsFile): AccessEndpoint[] {
  const path = fileURLToPath(file);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`Failed to read ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${path} must contain valid JSON`);
  }
  const result = accessEndpointsSchema.safeParse(json);
  if (!result.success) throw new Error(`${path} is invalid:\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** 服务运行所需的全部配置，启动时一次性读取并校验。 */
export function loadConfig(env: Environment = process.env) {
  return {
    server: readServerConfig(env),
    database: readDatabaseConfig(env),
    currency: readBillingCurrency(env),
    userInitialBalanceMicros: readUserInitialBalance(env),
    session: readSessionConfig(env),
    encryptionKey: readEncryptionKey(env),
    gateway: readGatewayConfig(env),
    accessEndpoints: readAccessEndpoints(),
    serveWeb: env.NODE_ENV === 'production',
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;

export function validateProductionConfig(env: Environment = process.env) {
  const { session } = loadConfig(env);
  if (!session.origin) throw new Error('APP_ORIGIN is required for production deployment');
  if (session.origin.startsWith('http:') && session.secure) {
    throw new Error('HTTP deployments require SESSION_COOKIE_SECURE=false');
  }
}
