CREATE OR REPLACE VIEW "public"."effective_channel_endpoints" AS (
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
);--> statement-breakpoint
CREATE OR REPLACE VIEW "public"."effective_channel_models" AS (
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
);