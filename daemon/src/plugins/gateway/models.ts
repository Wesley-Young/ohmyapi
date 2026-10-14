import { and, eq } from 'drizzle-orm';

import type { Database } from '../database/client.js';
import { activeModel } from '../database/query.js';
import {
  apiKeyModelGrants,
  effectiveChannelModels as channelAvailableModels,
  effectiveChannelEndpoints as channelEndpoints,
  type channels,
  models,
  priceRules,
  userChannelGrants,
} from '../database/schema/index.js';
import type { KeyIdentity } from './identity.js';

type ModelEntry = { name: string; createdAt: Date };

/** Key 在绑定渠道上可调用且已定价的模型。 */
export function availableModels(
  db: Database,
  identity: KeyIdentity & { channelId: string },
  channel: typeof channels.$inferSelect,
): Promise<ModelEntry[]> {
  return db
    .selectDistinct({ name: models.name, createdAt: models.createdAt })
    .from(models)
    .innerJoin(channelAvailableModels, eq(channelAvailableModels.modelId, models.id))
    .innerJoin(channelEndpoints, eq(channelEndpoints.channelId, channelAvailableModels.channelId))
    .innerJoin(priceRules, and(eq(priceRules.modelId, models.id), eq(priceRules.kind, 'default')))
    .leftJoin(
      apiKeyModelGrants,
      and(eq(apiKeyModelGrants.modelId, models.id), eq(apiKeyModelGrants.apiKeyId, identity.key.id)),
    )
    .leftJoin(
      userChannelGrants,
      and(
        eq(userChannelGrants.channelId, channelAvailableModels.channelId),
        eq(userChannelGrants.userId, identity.user.id),
      ),
    )
    .where(
      and(
        eq(channelAvailableModels.channelId, identity.channelId),
        activeModel(),
        identity.key.restrictModels ? eq(apiKeyModelGrants.apiKeyId, identity.key.id) : undefined,
        identity.user.role !== 'admin' && !channel.isPublic
          ? eq(userChannelGrants.userId, identity.user.id)
          : undefined,
      ),
    )
    .orderBy(models.name);
}

/** 按客户端协议输出模型列表。 */
export function modelListResponse(req: Request, available: ModelEntry[], id: string): Response {
  const headers = { 'x-request-id': id, 'cache-control': 'no-store' };
  // 与 New API 一致：同时带 x-api-key 和 anthropic-version 时返回 Anthropic 格式，其余返回 OpenAI 格式。
  if (req.headers.get('x-api-key') && req.headers.get('anthropic-version'))
    return Response.json(
      {
        data: available.map((model) => ({
          type: 'model',
          id: model.name,
          display_name: model.name,
          created_at: model.createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        })),
        has_more: false,
        first_id: available[0]?.name ?? null,
        last_id: available.at(-1)?.name ?? null,
      },
      { headers },
    );
  return Response.json(
    {
      object: 'list',
      data: available.map((model) => ({
        id: model.name,
        object: 'model',
        created: Math.floor(model.createdAt.getTime() / 1000),
        owned_by: 'ohmyapi',
      })),
    },
    { headers },
  );
}
