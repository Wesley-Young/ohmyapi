import { eq } from 'drizzle-orm';

import type { Transaction } from '../database/client.js';
import { type Endpoint, requests, requestUsage, type Usage, type UsageEstimate } from '../database/schema/index.js';
import { cacheReadForDisplay } from './cache-usage.js';

export type RequestRow = typeof requests.$inferSelect;
type RequestStatus = RequestRow['status'];

/**
 * 计费请求的状态流转：
 * received → reserved → forwarding → settling → settled
 *                     ↘ released（未执行或人工释放）
 * 任何未能确认费用的请求进入 needs_review，由管理员核对后结算或释放；
 * 未启用计费的请求（准入前被拒绝）直接进入 rejected。
 */
export const inflightStatuses = ['reserved', 'forwarding', 'settling'] as const satisfies RequestStatus[];
const terminalStatuses = new Set<RequestStatus>(['settled', 'released', 'rejected', 'completed']);

/** 已进入终态或等待人工核对，不再自动处理。 */
export const isClosed = (status: RequestStatus) => terminalStatuses.has(status) || status === 'needs_review';

/** 一次计费处理的结果，用于记录状态变更日志。 */
export type BillingOutcome = {
  request: RequestRow;
  status: 'rejected' | 'released' | 'settling' | 'settled' | 'needs_review';
  errorCode?: string;
  chargedMicros?: bigint;
  usageFinal?: boolean;
  blockSettlement?: boolean;
};

/** 网关在请求结束或检查点汇总的用量与上游结果。 */
export type BillingSummary = {
  usage?: Usage;
  usageFinal: boolean;
  usageEstimate?: UsageEstimate;
  blockSettlement?: boolean;
  httpStatus?: number;
  upstreamRequestId?: string;
  errorCode?: string;
  errorMessage?: string;
  noExecution: boolean;
  ttftMs?: number;
  outputTps?: number;
};

export async function lockRequest(tx: Transaction, id: string): Promise<RequestRow | undefined> {
  const [r] = await tx.select().from(requests).where(eq(requests.id, id)).for('update');
  return r;
}

export async function writeUsage(tx: Transaction, id: string, usage: Usage) {
  await tx
    .insert(requestUsage)
    .values({ requestId: id, ...usage })
    .onConflictDoUpdate({ target: requestUsage.requestId, set: usage });
}

/** 切换到不涉及钱款变动的状态；释放和结算见 settlement.ts。 */
export async function transition(
  tx: Transaction,
  r: RequestRow,
  status: 'rejected' | 'settling' | 'needs_review',
  fields: Partial<typeof requests.$inferInsert> = {},
): Promise<BillingOutcome> {
  await tx
    .update(requests)
    .set({ ...fields, status })
    .where(eq(requests.id, r.id));
  return { request: r, status };
}

/** 无法自动确认费用，转入人工核对并保留预占。 */
export async function markNeedsReview(
  tx: Transaction,
  r: RequestRow,
  errorCode: string,
  fields: Partial<typeof requests.$inferInsert> = {},
): Promise<BillingOutcome> {
  return { ...(await transition(tx, r, 'needs_review', { ...fields, errorCode })), errorCode };
}

export const usageDto = (u: typeof requestUsage.$inferSelect) => ({
  inputTokens: u.inputTokens.toString(),
  outputTokens: u.outputTokens.toString(),
  cacheReadTokens: u.cacheReadTokens.toString(),
  cacheWriteTokens: u.cacheWriteTokens.toString(),
  contextTokens: u.contextTokens.toString(),
  webSearchCalls: u.webSearchCalls.toString(),
  webSearchPreviewCalls: u.webSearchPreviewCalls.toString(),
});

/** 展示给用户的用量。缓存读取以上游报告为准，无法确认时为 null。 */
export const displayUsage = (r: { endpoint: Endpoint; usageFinal: boolean }, u: typeof requestUsage.$inferSelect) => ({
  ...usageDto(u),
  cacheReadTokens: cacheReadForDisplay(r.endpoint, r.usageFinal, u.rawUsage, u.cacheReadTokens),
});
