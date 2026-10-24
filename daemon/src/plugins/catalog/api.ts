import { createRoute, z } from '@hono/zod-openapi';

import { cursorLimitInput } from '../../core/pagination.ts';
import {
  type ApiAuth,
  adminErrors,
  channelIdParams,
  createApi,
  errorResponse,
  jsonResponse,
  moneySchema,
} from '../../openapi/common.ts';
import { channelTypes, endpoints, pricingModes, subscriptionProviders } from '../database/schema/index.ts';
import type { ChannelDirectory } from './directory.ts';

const identityFields = { id: z.uuid(), name: z.string() };
const commonFields = {
  enabled: z.boolean(),
  isPublic: z.boolean().meta({ description: '为 true 时对未被屏蔽的用户可用；为 false 时仅对授权的用户可用' }),
  multiplier: moneySchema.meta({ description: '渠道倍率', example: '1.000000' }),
  timeoutMs: z.number().int().meta({ description: '上游请求超时，毫秒' }),
  endpoints: z.array(z.enum(endpoints)).meta({ description: '渠道支持的端点；聚合渠道为子渠道端点的并集' }),
  createdAt: z.iso.datetime(),
};

const apiChannel = z
  .object({
    ...identityFields,
    type: z.literal('api'),
    ...commonFields,
    baseUrl: z.string().meta({ description: '上游地址' }),
    maxConcurrent: z.number().int().nullable().meta({
      description: '渠道同时执行的请求数上限，null 表示不限；达到上限时聚合渠道跳过该渠道，直接使用时返回 429',
    }),
    activeRequests: z.number().int().meta({ description: '进行中的请求数' }),
  })
  .meta({ id: 'ApiChannel', description: '通过 API Key 连接上游的渠道' });

const subscriptionChannel = z
  .object({
    ...identityFields,
    type: z.literal('subscription'),
    ...commonFields,
    subscription: z.object({
      provider: z.enum(subscriptionProviders),
      email: z.string().nullable().meta({ description: '订阅账号的邮箱' }),
      status: z.enum(['active', 'cooling_down', 'reauthorization_required']).meta({
        description:
          '`active`：可用；`cooling_down`：账号触发上游限流，冷却到 `cooldownUntil`；`reauthorization_required`：凭据失效，需要在控制台重新授权或导入凭据',
      }),
      errorCode: z.string().nullable().meta({ description: '凭据失效的原因代码', example: null }),
      cooldownUntil: z.iso.datetime().nullable().meta({ description: '账号级冷却的结束时间' }),
      modelCooldowns: z.array(z.object({ model: z.string(), until: z.iso.datetime() })).meta({
        description: '正在冷却的模型及冷却结束时间；model 是发往上游的模型名，渠道配置了上游模型名时与模型名称不同',
      }),
      maxConcurrent: z.number().int().meta({ description: '并发上限' }),
      activeRequests: z.number().int().meta({ description: '进行中的请求数' }),
    }),
  })
  .meta({ id: 'SubscriptionChannel', description: '使用 ChatGPT 或 Claude 订阅账号的渠道' });

const aggregateChannel = z
  .object({
    ...identityFields,
    type: z.literal('aggregate'),
    ...commonFields,
    pricingMode: z.enum(pricingModes).meta({
      description: '`unified`：按聚合渠道的倍率计费；`passthrough`：按实际执行的子渠道倍率计费',
    }),
    members: z
      .array(
        z.object({
          channelId: z.uuid(),
          priority: z.number().int().meta({ description: '优先级，数值大的优先' }),
          weight: z.number().int().meta({ description: '同一优先级内的分配权重' }),
        }),
      )
      .meta({ description: '子渠道，按优先级从高到低排列' }),
  })
  .meta({ id: 'AggregateChannel', description: '把请求分配给多个子渠道的渠道' });

const channelSchema = z.discriminatedUnion('type', [apiChannel, subscriptionChannel, aggregateChannel]).meta({
  id: 'Channel',
});

const listQuery = z.object({
  type: z.enum(channelTypes, { error: '类型需为 api、subscription 或 aggregate' }).optional().meta({
    description: '只返回该类型的渠道',
  }),
  cursor: z.string().max(512).optional().meta({ description: '上一页响应中的 `nextCursor`' }),
  limit: cursorLimitInput.meta({ description: '每页条数，1–100', example: 20 }),
});

export function channelApi(directory: ChannelDirectory, auth: ApiAuth) {
  const read = auth.admin('channels:read');
  return createApi()
    .openapi(
      createRoute({
        method: 'get',
        path: '/admin/channels',
        tags: ['Channels'],
        summary: '渠道列表',
        description: '未删除的渠道，按创建时间倒序。需要权限 `channels:read`。',
        security: read.security,
        middleware: [read.middleware] as const,
        request: { query: listQuery },
        responses: {
          200: jsonResponse(
            z
              .object({
                items: z.array(channelSchema),
                nextCursor: z.string().nullable().meta({ description: '下一页的游标；没有更多时为 null' }),
              })
              .meta({ id: 'ChannelPage' }),
            '渠道列表',
          ),
          400: errorResponse('参数或游标无效'),
          ...adminErrors,
        },
      }),
      async (c) => c.json(await directory.page(c.req.valid('query')), 200),
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/admin/channels/{channelId}',
        tags: ['Channels'],
        summary: '渠道详情',
        description: '需要权限 `channels:read`。',
        security: read.security,
        middleware: [read.middleware] as const,
        request: { params: channelIdParams },
        responses: {
          200: jsonResponse(channelSchema, '渠道'),
          400: errorResponse('渠道标识无效'),
          ...adminErrors,
          404: errorResponse('渠道不存在或已删除'),
        },
      }),
      async (c) => c.json(await directory.get(c.req.valid('param').channelId), 200),
    );
}
