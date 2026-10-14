import { serviceToken } from '@fraqjs/kernel';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import { formatMoney } from '../../core/money.js';
import { toPage } from '../../core/pagination.js';
import { displayUsage } from '../billing/requests.js';
import type { Database } from '../database/client.js';
import { paginate } from '../database/query.js';
import { apiKeys, channels, requestAttempts, requests, requestUsage, users } from '../database/schema/index.js';
import { type PricingService, publicPricingSnapshot } from '../pricing/service.js';

/** 请求记录列表：用户查看自己的请求，管理员查看全部或待核对的请求。 */
export class RequestHistory {
  static readonly token = serviceToken<RequestHistory>('ohmyapi/request-history');
  private readonly db: Database;
  private readonly pricing: PricingService;
  constructor(deps: { db: Database; pricing: PricingService }) {
    this.db = deps.db;
    this.pricing = deps.pricing;
  }

  async list(userId: string | undefined, page: number, reviewOnly = false) {
    const rows = await paginate(
      this.db
        .select({
          request: requests,
          username: users.username,
          usage: requestUsage,
          channelName: channels.name,
          channelType: channels.type,
          apiKeyName: apiKeys.name,
        })
        .from(requests)
        .innerJoin(users, eq(requests.userId, users.id))
        .leftJoin(channels, eq(requests.channelId, channels.id))
        .leftJoin(apiKeys, eq(requests.apiKeyId, apiKeys.id))
        .leftJoin(requestUsage, eq(requests.id, requestUsage.requestId))
        .where(
          and(
            userId ? eq(requests.userId, userId) : undefined,
            reviewOnly ? and(eq(requests.status, 'needs_review'), eq(requests.billingEnabled, true)) : undefined,
          ),
        )
        .orderBy(desc(requests.receivedAt), desc(requests.id))
        .$dynamic(),
      page,
    );
    const { items: pageRows, hasMore } = toPage(rows);
    const attempts =
      userId === undefined && pageRows.length > 0
        ? await this.db
            .select({
              id: requestAttempts.id,
              requestId: requestAttempts.requestId,
              channelId: requestAttempts.channelId,
              channelName: requestAttempts.channelName,
            })
            .from(requestAttempts)
            .where(
              inArray(
                requestAttempts.requestId,
                pageRows.map(({ request }) => request.id),
              ),
            )
            .orderBy(asc(requestAttempts.sequence))
        : [];
    return {
      currency: this.pricing.currency,
      hasMore,
      items: pageRows.map(({ request: r, username, usage: u, channelName, channelType, apiKeyName }) => ({
        id: r.id,
        username,
        apiKeyId: r.apiKeyId,
        apiKeyName,
        reasoningEffort: r.reasoningEffort,
        ttftMs: r.ttftMs,
        outputTps: r.outputTps,
        model: r.requestedModel,
        endpoint: r.endpoint,
        channelId: r.channelId,
        channelName,
        channelType,
        executionChannels: attempts
          .filter((attempt) => attempt.requestId === r.id)
          .map(({ id, channelId, channelName }) => ({ id, channelId, channelName })),
        status: r.status,
        billingEnabled: r.billingEnabled,
        usageFinal: r.usageFinal,
        usageEstimate: r.usageEstimate,
        reservedAmount: formatMoney(r.reservedMicros),
        heldAmount: formatMoney(r.heldMicros),
        chargedAmount: r.chargedMicros === null ? null : formatMoney(r.chargedMicros),
        quotedAmount: r.quotedMicros === null ? null : formatMoney(r.quotedMicros),
        pricing: userId ? publicPricingSnapshot(r.pricingSnapshot) : r.pricingSnapshot,
        streaming: r.streaming,
        httpStatus: r.httpStatus,
        receivedAt: r.receivedAt.toISOString(),
        durationMs: r.finishedAt ? r.finishedAt.getTime() - r.receivedAt.getTime() : null,
        errorCode: r.errorCode,
        upstreamRequestId: r.upstreamRequestId,
        usage: u ? displayUsage(r, u) : null,
      })),
    };
  }
}
