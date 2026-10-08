import { createColoredLogHandler } from '@fraqjs/color-log';
import { Logger, type LogLevel } from '@fraqjs/kernel';
import { DrizzleQueryError } from 'drizzle-orm';

export const logHandler = createColoredLogHandler({ minLevel: 'debug' });
export const globalLogger = new Logger(logHandler, 'ohmyapi');

export type EventLogger = Pick<Logger, LogLevel>;
export type LogFields = Record<string, string | number | boolean | null | undefined>;

const errorTypes = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'AbortError',
  'TimeoutError',
  'TRPCError',
  'DrizzleQueryError',
  'DatabaseError',
  'AggregateError',
]);
const errorCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EADDRINUSE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const errorReasons = new Map([
  ['Database is not initialized; run pnpm db:migrate and pnpm db:init', 'database_not_initialized'],
  ['Another ohmyapi instance owns billing for this database', 'billing_ownership_conflict'],
  ['Unable to initialize billing ownership and recovery', 'billing_initialization_failed'],
  ['Billing is unavailable', 'billing_unavailable'],
  ['Wallet reservation mismatch', 'wallet_reservation_mismatch'],
  ['Wallet missing', 'wallet_missing'],
  ['Wallet amount out of range', 'wallet_amount_out_of_range'],
  ['Request reservation lost', 'request_reservation_lost'],
  ['Request admission state changed', 'request_admission_state_changed'],
  ['Price snapshot scope mismatch', 'price_snapshot_scope_mismatch'],
  ['Price snapshot time mismatch', 'price_snapshot_time_mismatch'],
]);

function redactErrorMessage(message: string) {
  return message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\b(cookie|set-cookie)\s*:\s*[^\r\n]+/gi, '$1: [REDACTED]')
    .replace(
      /(["']?(?:password|passwd|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      '$1[REDACTED]',
    );
}

export function errorDetails(error: unknown): LogFields {
  const fields: LogFields = { errorType: 'UnknownError' };
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  const causes: string[] = [];
  // 保留具体消息和底层原因；Drizzle 包装消息包含 SQL 与参数，改用底层异常消息。
  while (pending.length && seen.size < 4) {
    const current = pending.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    if (!(current instanceof Error)) {
      if (typeof current === 'string') {
        const message = redactErrorMessage(current);
        if (seen.size === 1) fields.errorMessage = message;
        else causes.push(message);
      }
      continue;
    }
    const queryError = current instanceof DrizzleQueryError;
    if (seen.size === 1)
      fields.errorType = queryError ? 'DrizzleQueryError' : errorTypes.has(current.name) ? current.name : 'Error';
    const code = 'code' in current ? current.code : undefined;
    let message = queryError ? '数据库查询失败' : redactErrorMessage(current.message);
    // PostgreSQL 的数据转换错误可能把实际参数值嵌入消息。
    if (typeof code === 'string' && /^22[0-9A-Z]{3}$/.test(code))
      message = message.replace(/"[^"]*"|'[^']*'/g, '[REDACTED]');
    if (seen.size === 1) fields.errorMessage = message;
    else causes.push(message);
    const reason = errorReasons.get(current.message);
    if (reason && fields.reason === undefined) fields.reason = reason;
    if (
      fields.causeCode === undefined &&
      typeof code === 'string' &&
      (errorCodes.has(code) || /^[0-9A-Z]{5}$/.test(code))
    ) {
      fields.causeCode = code;
    }
    if (current.cause !== undefined) pending.push(current.cause);
    if (current instanceof AggregateError) pending.push(...current.errors.slice(0, 4));
  }
  if (causes.length) fields.causeMessage = causes.join('; ');
  return fields;
}

export function safeErrorMessage(error: unknown): string | undefined {
  const fields = errorDetails(error);
  const messages = [fields.errorMessage, fields.causeMessage].filter((value) => typeof value === 'string' && value);
  return messages.length ? messages.join('\n').slice(0, 4096) : undefined;
}

export function createLogSampler() {
  const nextLogs = new Map<string, number>();
  return (category: string) => {
    const now = Date.now();
    if ((nextLogs.get(category) ?? 0) > now) return false;
    for (const [key, until] of nextLogs) if (until <= now) nextLogs.delete(key);
    nextLogs.set(category, now + 60_000);
    return true;
  };
}
