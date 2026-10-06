export const billingConventions = {
  moneyScale: 1_000_000n,
  priceTokenUnit: 1_000_000n,
  timezone: 'Asia/Shanghai',
  contextPricing: 'whole_request',
  rounding: 'ceil_total',
  rulePrecedence: ['combined', 'context', 'time', 'default'],
  missingUsage: 'needs_review',
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

/** All usage categories are summed before the request total is rounded up. */
export function calculateTokenCharge(items: readonly { tokens: bigint; priceMicrosPerMillion: bigint }[]): bigint {
  let numerator = 0n;
  for (const item of items) {
    if (item.tokens < 0n || item.priceMicrosPerMillion < 0n) {
      throw new Error('Token counts and prices must be nonnegative');
    }
    numerator += item.tokens * item.priceMicrosPerMillion;
  }
  const result = (numerator + billingConventions.priceTokenUnit - 1n) / billingConventions.priceTokenUnit;
  if (result > maxDatabaseInteger) throw new Error('Charge is outside the PostgreSQL bigint range');
  return result;
}
