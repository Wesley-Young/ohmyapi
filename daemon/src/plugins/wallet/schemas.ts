import { z } from 'zod';

import { parseMoney } from '../../core/money.ts';
import { pageInput } from '../../core/pagination.ts';
import { userIdInput } from '../users/schemas.ts';

export const statsRangeInput = z.object({ range: z.enum(['24h', '30d']) });
export const userLedgerInput = userIdInput.extend({ page: pageInput });
export const adjustmentAmount = z.string().refine((value) => {
  try {
    return parseMoney(value) !== 0n;
  } catch {
    return false;
  }
}, '请输入非零金额，最多六位小数');
export const adjustmentReason = z.string().trim().max(300, '原因最多 300 个字符').default('');
export const adjustWalletInput = userIdInput.extend({
  amount: adjustmentAmount,
  reason: adjustmentReason,
  idempotencyKey: z.uuid(),
});

export type StatsRange = z.infer<typeof statsRangeInput>['range'];
export type AdjustWalletInput = z.infer<typeof adjustWalletInput>;
