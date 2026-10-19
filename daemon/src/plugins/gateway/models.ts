import type { ModelInfo } from '@ohmyapi/protocols';
import { and, eq } from 'drizzle-orm';

import type { Database } from '../database/client.ts';
import { activeModel } from '../database/query.ts';
import {
  apiKeyModelGrants,
  type channels,
  type Endpoint,
  effectiveChannelEndpoints,
  effectiveChannelModels,
  models,
  priceRules,
} from '../database/schema/index.ts';
import { canUseChannel, type KeyIdentity } from '../keys/access.ts';

/** Key 在绑定渠道上可调用且已定价的模型；指定端点时只返回该端点可用的模型。 */
export async function availableModels(
  db: Database,
  identity: KeyIdentity & { channelId: string },
  channel: typeof channels.$inferSelect,
  endpoint?: Endpoint,
): Promise<ModelInfo[]> {
  if (!(await canUseChannel(db, identity.user, channel))) return [];
  return db
    .selectDistinct({
      name: models.name,
      createdAt: models.createdAt,
      inputTokenLimit: models.inputTokenLimit,
      outputTokenLimit: models.outputTokenLimit,
    })
    .from(models)
    .innerJoin(effectiveChannelModels, eq(effectiveChannelModels.modelId, models.id))
    .innerJoin(effectiveChannelEndpoints, eq(effectiveChannelEndpoints.channelId, effectiveChannelModels.channelId))
    .innerJoin(priceRules, and(eq(priceRules.modelId, models.id), eq(priceRules.kind, 'default')))
    .leftJoin(
      apiKeyModelGrants,
      and(eq(apiKeyModelGrants.modelId, models.id), eq(apiKeyModelGrants.apiKeyId, identity.key.id)),
    )
    .where(
      and(
        eq(effectiveChannelModels.channelId, identity.channelId),
        endpoint ? eq(effectiveChannelEndpoints.endpoint, endpoint) : undefined,
        activeModel(),
        identity.key.restrictModels ? eq(apiKeyModelGrants.apiKeyId, identity.key.id) : undefined,
      ),
    )
    .orderBy(models.name);
}
