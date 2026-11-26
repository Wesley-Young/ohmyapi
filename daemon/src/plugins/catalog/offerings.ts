import { and, eq, type SQL, sql } from 'drizzle-orm';

import type { Database, Transaction } from '../database/client.ts';
import { activeChannel, activeModel, availableSubscription, compatibleModelEndpoint } from '../database/query.ts';
import {
  channelModelPrices,
  channels,
  effectiveChannelEndpoints,
  effectiveChannelModels,
  models,
} from '../database/schema/index.ts';
import { channelAccessible } from './access.ts';

// 聚合渠道的模型和端点各自取并集，只有同一成员同时提供的组合可以转发。
export function memberSupportsOffering(filter?: SQL) {
  return sql`exists (
    select 1 from aggregate_channel_members membership
    join channels child on child.id = membership.member_channel_id and child.deleted_at is null
    join channel_available_models cm on cm.channel_id = child.id and cm.model_id = ${models.id}
    join channel_endpoints ce on ce.channel_id = child.id and ce.endpoint = ${effectiveChannelEndpoints.endpoint}
    where membership.aggregate_channel_id = ${effectiveChannelEndpoints.channelId}
      ${filter ? sql`and ${filter}` : sql.empty()}
  )`;
}

/** 按入口渠道、模型和端点汇总用户可用的配置及价格倍率。 */
export async function channelOfferings(db: Database | Transaction, user: { id: string; role: string }, filter?: SQL) {
  const pricingMember = sql`(${channels.pricingMode} = 'unified' or child.id = ${channelModelPrices.pricingChannelId})`;
  const compatible = sql`(${channels.type} <> 'aggregate' or ${memberSupportsOffering(pricingMember)})`;
  const base = db
    .selectDistinct({
      channelId: channels.id,
      channelName: channels.name,
      channelType: channels.type,
      channelIsPublic: channels.isPublic,
      channelMultiplierMicros: channels.multiplierMicros,
      multiplierMicros: channelModelPrices.multiplierMicros,
      pricingMode: channels.pricingMode,
      endpoint: effectiveChannelEndpoints.endpoint,
      outputKind: models.outputKind,
      inputTokenLimit: models.inputTokenLimit,
      outputTokenLimit: models.outputTokenLimit,
      modelId: models.id,
      modelName: models.name,
    })
    .from(channels)
    .innerJoin(effectiveChannelModels, eq(channels.id, effectiveChannelModels.channelId))
    .innerJoin(models, eq(models.id, effectiveChannelModels.modelId))
    .innerJoin(
      channelModelPrices,
      and(eq(channelModelPrices.channelId, channels.id), eq(channelModelPrices.modelId, models.id)),
    )
    .innerJoin(effectiveChannelEndpoints, eq(effectiveChannelEndpoints.channelId, channels.id))
    .where(
      and(
        activeChannel(),
        availableSubscription(),
        activeModel(),
        channelAccessible(user),
        compatible,
        compatibleModelEndpoint(),
        filter,
      ),
    )
    .orderBy(channels.name, models.name);
  const rows = await base;
  const ranges = new Map<string, (typeof rows)[number] & { maxMultiplierMicros: bigint }>();
  for (const row of rows) {
    const key = `${row.channelId}:${row.modelId}:${row.endpoint}`;
    const previous = ranges.get(key);
    if (!previous) ranges.set(key, { ...row, maxMultiplierMicros: row.multiplierMicros });
    else {
      if (row.multiplierMicros < previous.multiplierMicros) previous.multiplierMicros = row.multiplierMicros;
      if (row.multiplierMicros > previous.maxMultiplierMicros) previous.maxMultiplierMicros = row.multiplierMicros;
    }
  }
  return [...ranges.values()];
}
