CREATE TYPE "public"."channel_pricing_mode" AS ENUM('unified', 'passthrough');--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "pricing_mode" "channel_pricing_mode" DEFAULT 'unified' NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_pricing_mode_type" CHECK ("channels"."type" = 'aggregate' or "channels"."pricing_mode" = 'unified');--> statement-breakpoint
CREATE VIEW "public"."channel_model_prices" AS (
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
);