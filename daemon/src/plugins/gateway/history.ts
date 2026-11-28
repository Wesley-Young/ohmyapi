import { serviceToken } from '@fraqjs/kernel';
import { familyEndpoints } from '@ohmyapi/protocols';
import { and, asc, desc, eq, gte, inArray, lt, notInArray } from 'drizzle-orm';

import { formatMoney } from '../../core/money.ts';
import { toPage } from '../../core/pagination.ts';
import { displayUsage } from '../billing/requests.ts';
import type { Database } from '../database/client.ts';
import {
  activeApiKey,
  activeChannel,
  activeUser,
  availableSubscription,
  containsText,
  paginate,
} from '../database/query.ts';
import { apiKeys, channels, requestAttempts, requests, requestUsage, users } from '../database/schema/index.ts';
import { type PricingService, publicPricingSnapshot } from '../pricing/service.ts';
import type { OwnRequestFilters, PlatformRequestFilters } from './schemas.ts';

const decisionEndpoints = [familyEndpoints.systemone, familyEndpoints.decisions];

/** 请求记录列表：用户查看自己的请求，管理员查看全部或待核对的请求。 */
export class RequestHistory {
  static readonly token = serviceToken<RequestHistory>('ohmyapi/request-history');
  private readonly db: Database;
  private readonly pricing: PricingService;
  constructor(deps: { db: Database; pricing: PricingService }) {
    this.db = deps.db;
    this.pricing = deps.pricing;
  }

  /** 用户自己的请求，包含所用 API Key 的名称。 */
  listOwn(userId: string, filters: OwnRequestFilters) {
    return this.list(userId, filters);
  }

  /** 平台的全部请求；Key 名称由各用户自行设置，平台视图只展示所属用户。 */
  async listAll(filters: PlatformRequestFilters) {
    const { items, ...result } = await this.list(undefined, filters);
    return { ...result, items: items.map(({ apiKeyName: _, ...item }) => item) };
  }

  ownFilterOptions(userId: string) {
    return this.db
      .select({ id: apiKeys.id, name: apiKeys.name })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), activeApiKey()))
      .orderBy(apiKeys.name, apiKeys.id);
  }

  async platformFilterOptions() {
    const [userOptions, channelOptions] = await Promise.all([
      this.db
        .select({ id: users.id, name: users.username })
        .from(users)
        .where(activeUser())
        .orderBy(users.username, users.id),
      this.db
        .select({ id: channels.id, name: channels.name })
        .from(channels)
        .where(and(activeChannel(), availableSubscription()))
        .orderBy(channels.name, channels.id),
    ]);
    return { users: userOptions, channels: channelOptions };
  }

  private async list(ownerId: string | undefined, filters: OwnRequestFilters & Partial<PlatformRequestFilters>) {
    const { page, group, model, from, until, apiKeyId, channelId, reviewOnly } = filters;
    const userId = ownerId ?? filters.userId;
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
            group === 'regular' ? notInArray(requests.endpoint, decisionEndpoints) : undefined,
            group === 'decisions' ? inArray(requests.endpoint, decisionEndpoints) : undefined,
            userId ? eq(requests.userId, userId) : undefined,
            apiKeyId ? eq(requests.apiKeyId, apiKeyId) : undefined,
            channelId ? eq(requests.channelId, channelId) : undefined,
            from ? gte(requests.receivedAt, new Date(from)) : undefined,
            until ? lt(requests.receivedAt, new Date(until)) : undefined,
            containsText(requests.requestedModel, model ?? ''),
            reviewOnly ? and(eq(requests.status, 'needs_review'), eq(requests.billingEnabled, true)) : undefined,
          ),
        )
        .orderBy(desc(requests.receivedAt), desc(requests.id))
        .$dynamic(),
      page,
    );
    const { items: pageRows, hasMore } = toPage(rows);
    const attempts =
      ownerId === undefined && pageRows.length > 0
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
        pricing: ownerId ? publicPricingSnapshot(r.pricingSnapshot) : r.pricingSnapshot,
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
