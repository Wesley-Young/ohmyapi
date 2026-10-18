/**
 * 计费约定：金额以百万分之一货币单位保存，单价按每百万 Token 计；时段规则按北京时间匹配；
 * 多条规则同时匹配时按 rulePrecedence 的顺序取第一条。
 */
export const billingConventions = {
  moneyScale: 1_000_000n,
  priceTokenUnit: 1_000_000n,
  timezone: 'Asia/Shanghai',
  rulePrecedence: ['combined', 'context', 'time', 'default'],
} as const;

const maxDatabaseInteger = 9_223_372_036_854_775_807n;

/** Parse currency units without passing through a floating point number. */
export function parseMoney(value: string): bigint {
  if (!/^-?(0|[1-9]\d*)(\.\d{1,6})?$/.test(value)) {
    throw new Error('Money must be a decimal string with at most six decimal places');
  }
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const units = BigInt(whole) * billingConventions.moneyScale + BigInt(fraction.padEnd(6, '0'));
  const result = negative ? -units : units;
  if (result < -maxDatabaseInteger - 1n || result > maxDatabaseInteger) {
    throw new Error('Money is outside the PostgreSQL bigint range');
  }
  return result;
}

export function formatMoney(units: bigint): string {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = absolute / billingConventions.moneyScale;
  const fraction = (absolute % billingConventions.moneyScale).toString().padStart(6, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}
