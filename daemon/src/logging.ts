import { createColoredLogHandler } from '@fraqjs/color-log';
import { Logger, type LogLevel } from '@fraqjs/kernel';

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
  ['BILLING_CURRENCY differs from the initialized database', 'billing_currency_mismatch'],
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

export function errorDetails(error: unknown): LogFields {
  const fields: LogFields = { errorType: 'UnknownError' };
  // 只提取错误类型和错误码，避免错误消息、堆栈及 cause 中的 SQL 参数泄漏。
  for (let depth = 0; depth < 4 && error instanceof Error; depth++, error = error.cause) {
    if (depth === 0) fields.errorType = errorTypes.has(error.name) ? error.name : 'Error';
    const reason = errorReasons.get(error.message);
    if (reason && fields.reason === undefined) fields.reason = reason;
    const code = 'code' in error ? error.code : undefined;
    if (typeof code === 'string' && (errorCodes.has(code) || /^[0-9A-Z]{5}$/.test(code))) {
      fields.causeCode = code;
      break;
    }
  }
  return fields;
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
