import { createRoute, z } from '@hono/zod-openapi';

import {
  type ApiAuth,
  adminErrors,
  channelIdParams,
  createApi,
  errorResponse,
  jsonResponse,
  moneySchema,
} from '../../openapi/common.ts';
import { subscriptionProviders } from '../database/schema/index.ts';
import type { SubscriptionService } from './service.ts';

const quotaWindow = z
  .object({
    usedPercent: z.number().meta({ description: '已用比例，0–100' }),
    resetsAt: z.iso.datetime().nullable().meta({ description: '窗口重置时间' }),
  })
  .nullable()
  .meta({ id: 'QuotaWindow', description: '额度窗口；套餐没有该窗口时为 null' });

const quotaSchema = z
  .object({
    provider: z.enum(subscriptionProviders),
    plan: z.string().nullable().meta({ description: '上游的套餐标识', example: 'pro' }),
    fiveHour: quotaWindow.meta({ description: '5 小时窗口' }),
    sevenDay: quotaWindow.meta({ description: '7 天窗口' }),
    fetchedAt: z.iso.datetime().meta({ description: '从上游获取的时间' }),
  })
  .meta({ id: 'SubscriptionQuota' });

const usageAmount = z.object({ amount: moneySchema, requests: z.number().int() });
const tokenCount = z.string().meta({ description: 'token 数，十进制字符串', example: '1024' });

const cycleUsageSchema = z
  .object({
    provider: z.enum(subscriptionProviders),
    startsAt: z.iso.datetime().meta({ description: '周期开始时间' }),
    resetsAt: z.iso.datetime().nullable().meta({ description: '上游报告的周期重置时间' }),
    source: z.enum(['upstream', 'manual', 'rolling']).meta({
      description:
        '周期起点的来源。`upstream`：上游 7 天窗口；`manual`：管理员填写的提前重置时刻；`rolling`：上游没有周期信息，取最近 7 天',
    }),
    manualResetAt: z.iso.datetime().nullable().meta({ description: '管理员填写的重置时刻（Claude）' }),
    manualResetActive: z.boolean().meta({ description: '手动重置时刻是否落在当前周期内并作为起点' }),
    usedPercent: z.number().nullable().meta({ description: '上游报告的 7 天窗口已用比例，0–100' }),
    projectedAmount: moneySchema.nullable().meta({
      description: '按已用比例推算的整个周期的等效费用；已用比例达到 5% 时提供',
    }),
    amount: moneySchema.meta({ description: '周期内请求按当前价格计算的等效 API 费用' }),
    requests: z.number().int().meta({ description: '周期内的请求数' }),
    fallback: usageAmount.meta({ description: '价格规则已变更、按默认规则估算的部分' }),
    unconfirmed: usageAmount.meta({ description: '用量尚未最终确认的部分' }),
    unpricedRequests: z.number().int().meta({ description: '部分用量缺少单价、未计入费用的请求数' }),
    models: z
      .array(
        z.object({
          modelId: z.uuid().nullable(),
          name: z.string().nullable(),
          requests: z.number().int(),
          inputTokens: tokenCount,
          outputTokens: tokenCount,
          cacheReadTokens: tokenCount,
          cacheWriteTokens: tokenCount,
          amount: moneySchema,
        }),
      )
      .meta({ description: '按模型汇总，按费用从高到低排列' }),
  })
  .meta({ id: 'SubscriptionCycleUsage' });

const resetCreditsSchema = z
  .object({
    credits: z.array(
      z.object({
        id: z.string(),
        expiresAt: z.iso.datetime().nullable(),
        supported: z.boolean().meta({ description: '当前套餐是否支持使用' }),
        usable: z.boolean().meta({ description: '套餐支持且未过期' }),
      }),
    ),
    availableCount: z.number().int().meta({ description: '可用的重置次数' }),
  })
  .meta({ id: 'OpenAIResetCredits' });

const channelErrors = {
  400: errorResponse('渠道标识无效，或订阅渠道未启用'),
  ...adminErrors,
  404: errorResponse('订阅渠道不存在或已删除'),
};
const upstreamErrors = { ...channelErrors, 502: errorResponse('上游查询失败') };

export function subscriptionApi(subscription: SubscriptionService, auth: ApiAuth) {
  const read = auth.admin('channels:read');
  return createApi()
    .openapi(
      createRoute({
        tags: ['Channels'],
        security: read.security,
        middleware: [read.middleware] as const,
        method: 'get',
        path: '/admin/channels/{channelId}/quota',
        summary: '订阅额度',
        description: '订阅账号的 5 小时和 7 天额度窗口，结果缓存 60 秒。需要权限 `channels:read`。',
        request: { params: channelIdParams },
        responses: { 200: jsonResponse(quotaSchema, '额度'), ...upstreamErrors },
      }),
      async (c) => c.json(await subscription.quota(c.get('principal'), c.req.valid('param').channelId), 200),
    )
    .openapi(
      createRoute({
        tags: ['Channels'],
        security: read.security,
        middleware: [read.middleware] as const,
        method: 'get',
        path: '/admin/channels/{channelId}/cycle-usage',
        summary: '订阅周期用量',
        description: '当前 7 天周期内经该订阅账号的请求，按当前价格换算的等效 API 费用。需要权限 `channels:read`。',
        request: { params: channelIdParams },
        responses: { 200: jsonResponse(cycleUsageSchema, '周期用量'), ...channelErrors },
      }),
      async (c) => c.json(await subscription.cycleUsage(c.get('principal'), c.req.valid('param').channelId), 200),
    )
    .openapi(
      createRoute({
        tags: ['Channels'],
        security: read.security,
        middleware: [read.middleware] as const,
        method: 'get',
        path: '/admin/channels/{channelId}/reset-credits',
        summary: 'OpenAI 重置次数',
        description: 'OpenAI 订阅账号可用于重置额度窗口的次数。需要权限 `channels:read`。',
        request: { params: channelIdParams },
        responses: {
          200: jsonResponse(resetCreditsSchema, '重置次数'),
          400: errorResponse('渠道标识无效，订阅渠道未启用，或不是 OpenAI 订阅'),
          ...adminErrors,
          404: upstreamErrors[404],
          502: upstreamErrors[502],
        },
      }),
      async (c) =>
        c.json(await subscription.listOpenAIResetCredits(c.get('principal'), c.req.valid('param').channelId), 200),
    );
}
