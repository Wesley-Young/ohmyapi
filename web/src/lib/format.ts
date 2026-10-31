import type { AppRouter } from '@ohmyapi/daemon/trpc';
import { TRPCClientError } from '@trpc/client';

export function formError(error: unknown) {
  if (!error) return undefined;
  if (error instanceof TRPCClientError) {
    const rpc = error as TRPCClientError<AppRouter>;
    return { message: rpc.message, fields: rpc.data?.fieldErrors ?? {} };
  }
  return {
    message: error instanceof Error ? error.message : '操作失败，请稍后重试',
    fields: {} as Record<string, string[]>,
  };
}

export const localDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
/** 转为 datetime-local 输入框使用的本地时间字符串。 */
export function dateTimeInput(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, -1);
}
/** 整数计数（含 Token 数），按浏览器区域的数字格式显示。 */
export const formatCount = (value: string | number | bigint) => BigInt(value).toLocaleString();
/** 按浏览器默认区域显示的日期时间。 */
export const localDateTime = (value: string | number | Date) => new Date(value).toLocaleString();
/** 等效 API 费用固定以美元展示。 */
export function formatUsd(amount: string) {
  const value = Number(amount);
  if (value > 0 && value < 0.005) return '<$0.01';
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const displayMoney = (value: string) => value.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');

/** 货币的简短符号，如 USD → $、CNY → ¥；无法识别时返回货币代码。 */
export function currencySymbol(currency: string) {
  try {
    return (
      new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
        .formatToParts(0)
        .find((part) => part.type === 'currency')?.value ?? currency
    );
  } catch {
    return currency;
  }
}

/** 带货币符号的金额，如 $1.5；货币未知时只显示数值。 */
export const displayAmount = (value: string, currency: string | undefined) =>
  `${currency ? currencySymbol(currency) : ''}${displayMoney(value)}`;

/** 金额字符串是否为零，如 "0.000000"。 */
export const isZeroMoney = (value: string) => /^-?0(\.0*)?$/.test(value);

/** 倍率或倍率区间，如 1×、1× ~ 10×。 */
export function displayMultiplier(minimum: string, maximum = minimum) {
  const low = displayMoney(minimum);
  const high = displayMoney(maximum);
  return low === high ? `${low}×` : `${low}× ~ ${high}×`;
}

export function displayRange(minimum: string, maximum: string) {
  const low = displayMoney(minimum);
  const high = displayMoney(maximum);
  return low === high ? low : `${low}–${high}`;
}
