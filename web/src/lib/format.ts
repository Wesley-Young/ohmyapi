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
  new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
export const displayMoney = (value: string) => value.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');

export function displayRange(minimum: string, maximum: string) {
  const low = displayMoney(minimum);
  const high = displayMoney(maximum);
  return low === high ? low : `${low}–${high}`;
}
