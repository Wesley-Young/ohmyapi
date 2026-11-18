import { sql } from 'drizzle-orm';
import { bigint, pgView, text, uuid } from 'drizzle-orm/pg-core';

import { endpoint } from './common.ts';

// 聚合渠道的模型和端点分别取全部成员配置的并集，成员暂时停用或冷却不改变聚合渠道的能力；
// 某个模型和端点的组合由哪些成员执行，在路由时按成员各自的配置筛选。
export const effectiveChannelModels = pgView('effective_channel_models', {
  channelId: uuid('channel_id').notNull(),
  modelId: uuid('model_id').notNull(),
  multiplierMicros: bigint('multiplier_micros', { mode: 'bigint' }),
}).as(sql`
  select cm.channel_id, cm.model_id, cm.multiplier_micros
  from channel_available_models cm join channels c on c.id = cm.channel_id
  where c.type <> 'aggregate'
  union all
  select member_models.channel_id, member_models.model_id, overrides.multiplier_micros
  from (
    select membership.aggregate_channel_id as channel_id, cm.model_id
    from aggregate_channel_members membership
    join channels parent on parent.id = membership.aggregate_channel_id and parent.type = 'aggregate' and parent.deleted_at is null
    join channels child on child.id = membership.member_channel_id and child.type in ('api', 'subscription') and child.deleted_at is null
    join channel_available_models cm on cm.channel_id = child.id
    group by membership.aggregate_channel_id, cm.model_id
  ) member_models
  left join channel_available_models overrides on overrides.channel_id = member_models.channel_id and overrides.model_id = member_models.model_id
`);

export const effectiveChannelEndpoints = pgView('effective_channel_endpoints', {
  channelId: uuid('channel_id').notNull(),
  endpoint: endpoint('endpoint').notNull(),
}).as(sql`
  select ce.channel_id, ce.endpoint
  from channel_endpoints ce join channels c on c.id = ce.channel_id
  where c.type <> 'aggregate'
  union all
  select membership.aggregate_channel_id as channel_id, ce.endpoint
  from aggregate_channel_members membership
  join channels parent on parent.id = membership.aggregate_channel_id and parent.type = 'aggregate' and parent.deleted_at is null
  join channels child on child.id = membership.member_channel_id and child.type in ('api', 'subscription') and child.deleted_at is null
  join channel_endpoints ce on ce.channel_id = child.id
  group by membership.aggregate_channel_id, ce.endpoint
`);

// 价格区间包含全部成员配置；实时可用性、优先级和请求兼容性由路由决定。
export const channelModelPrices = pgView('channel_model_prices', {
  channelId: uuid('channel_id').notNull(),
  modelId: uuid('model_id').notNull(),
  pricingChannelId: uuid('pricing_channel_id').notNull(),
  multiplierMicros: bigint('multiplier_micros', { mode: 'bigint' }).notNull(),
  multiplierSource: text('multiplier_source').$type<'channel' | 'model'>().notNull(),
}).as(sql`
  select cm.channel_id, cm.model_id, c.id as pricing_channel_id,
    coalesce(cm.multiplier_micros, c.multiplier_micros) as multiplier_micros,
    case when cm.multiplier_micros is null then 'channel' else 'model' end as multiplier_source
  from effective_channel_models cm join channels c on c.id = cm.channel_id
  where c.pricing_mode = 'unified' and c.deleted_at is null
  union all
  select cm.channel_id, cm.model_id, child.id as pricing_channel_id,
    coalesce(child_model.multiplier_micros, child.multiplier_micros) as multiplier_micros,
    case when child_model.multiplier_micros is null then 'channel' else 'model' end as multiplier_source
  from effective_channel_models cm join channels parent on parent.id = cm.channel_id
  join aggregate_channel_members membership on membership.aggregate_channel_id = parent.id
  join channels child on child.id = membership.member_channel_id and child.deleted_at is null and child.type in ('api', 'subscription')
  join channel_available_models child_model on child_model.channel_id = child.id and child_model.model_id = cm.model_id
  where parent.type = 'aggregate' and parent.pricing_mode = 'passthrough' and parent.deleted_at is null
`);
