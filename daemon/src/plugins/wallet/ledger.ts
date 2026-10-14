import { eq } from 'drizzle-orm';

import { formatMoney } from '../../core/money.ts';
import type { Transaction } from '../database/client.ts';
import { walletLedger, wallets } from '../database/schema/index.ts';

export type Wallet = typeof wallets.$inferSelect;
export type LedgerEntry = typeof walletLedger.$inferSelect;

const maxMicros = 9_223_372_036_854_775_807n;
function bounded(micros: bigint) {
  if (micros < -maxMicros - 1n || micros > maxMicros) throw new Error('Wallet amount out of range');
  return micros;
}

/** 锁定用户钱包；同一事务中的余额变动都需先持有该行锁。 */
export async function lockWallet(tx: Transaction, userId: string): Promise<Wallet | undefined> {
  const [wallet] = await tx.select().from(wallets).where(eq(wallets.userId, userId)).for('update');
  return wallet;
}

/**
 * 在已锁定的钱包上记一笔账：按增量更新余额和预占，并写入带变动后余额的流水。
 * 钱包余额只通过这里变更，保证钱包与流水汇总始终一致。
 */
export async function postLedgerEntry(
  tx: Transaction,
  wallet: Wallet,
  entry: {
    kind: LedgerEntry['kind'];
    idempotencyKey: string;
    balanceDeltaMicros: bigint;
    reservedDeltaMicros: bigint;
    reason: string;
    requestId?: string;
    actorId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<LedgerEntry> {
  const balanceMicros = bounded(wallet.balanceMicros + entry.balanceDeltaMicros);
  const reservedMicros = bounded(wallet.reservedMicros + entry.reservedDeltaMicros);
  await tx.update(wallets).set({ balanceMicros, reservedMicros }).where(eq(wallets.userId, wallet.userId));
  const [row] = await tx
    .insert(walletLedger)
    .values({ ...entry, userId: wallet.userId, balanceAfterMicros: balanceMicros, reservedAfterMicros: reservedMicros })
    .returning();
  return row;
}

/** 流水的金额字段，供各处展示统一格式。 */
export const ledgerAmounts = (entry: LedgerEntry) => ({
  amount: formatMoney(entry.balanceDeltaMicros),
  reservedAmount: formatMoney(entry.reservedDeltaMicros),
  balanceAfter: formatMoney(entry.balanceAfterMicros),
  reservedAfter: formatMoney(entry.reservedAfterMicros),
});
