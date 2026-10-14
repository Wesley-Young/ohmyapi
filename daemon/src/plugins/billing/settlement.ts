import { eq } from 'drizzle-orm';

import { formatMoney } from '../../core/money.js';
import type { Transaction } from '../database/client.js';
import { requests } from '../database/schema/index.js';
import type { Usage } from '../gateway/usage.js';
import type { PricingService } from '../pricing/service.js';
import { lockWallet, postLedgerEntry } from '../wallet/ledger.js';
import type { RequestRow } from './requests.js';

/** 按请求受理时锁定的价格快照计算费用。 */
export function priceRequestUsage(pricing: PricingService, r: RequestRow, usage: Usage) {
  const locked = pricing.restore(r.reservationSnapshot?.pricing, r.receivedAt);
  if (locked.modelId !== r.modelId) throw new Error('Price snapshot scope mismatch');
  return pricing.calculate(locked, usage);
}

export type PricedUsage = ReturnType<typeof priceRequestUsage>;

/** 释放请求的全部预占，不扣费。 */
export async function releaseRequest(tx: Transaction, r: RequestRow, actorId: string | undefined, reason: string) {
  const wallet = await lockWallet(tx, r.userId);
  if (!wallet || wallet.reservedMicros < r.heldMicros) throw new Error('Wallet reservation mismatch');
  if (r.heldMicros > 0n)
    await postLedgerEntry(tx, wallet, {
      requestId: r.id,
      kind: 'release',
      idempotencyKey: `release:${r.id}`,
      balanceDeltaMicros: 0n,
      reservedDeltaMicros: -r.heldMicros,
      actorId,
      reason,
      metadata: { released: formatMoney(r.heldMicros), upstreamRequestId: r.upstreamRequestId },
    });
  await tx
    .update(requests)
    .set({ status: 'released', heldMicros: 0n, chargedMicros: 0n, finishedAt: new Date() })
    .where(eq(requests.id, r.id));
}

/** 按确定的金额结算：扣除费用并释放预占，金额可以超过预占。 */
export async function settleRequest(
  tx: Transaction,
  r: RequestRow,
  amount: bigint,
  snapshot: Record<string, unknown>,
  actorId?: string,
  reason = '结算',
) {
  const wallet = await lockWallet(tx, r.userId);
  if (!wallet || wallet.reservedMicros < r.heldMicros) throw new Error('Wallet reservation mismatch');
  await postLedgerEntry(tx, wallet, {
    requestId: r.id,
    kind: 'settlement',
    idempotencyKey: `settle:${r.id}`,
    balanceDeltaMicros: -amount,
    reservedDeltaMicros: -r.heldMicros,
    actorId,
    reason,
    metadata: { pricing: snapshot, exceededReservation: amount > r.reservedMicros },
  });
  await tx
    .update(requests)
    .set({
      status: 'settled',
      heldMicros: 0n,
      chargedMicros: amount,
      quotedMicros: typeof snapshot.totalMicros === 'string' ? BigInt(snapshot.totalMicros) : r.quotedMicros,
      pricingSnapshot: { ...snapshot, billed: true },
      finishedAt: r.finishedAt ?? new Date(),
    })
    .where(eq(requests.id, r.id));
}
