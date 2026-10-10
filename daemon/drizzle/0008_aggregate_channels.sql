CREATE TYPE "public"."request_attempt_status" AS ENUM('prepared', 'forwarding', 'completed', 'failed', 'unknown');--> statement-breakpoint
CREATE TABLE "aggregate_channel_members" (
	"aggregate_channel_id" uuid NOT NULL,
	"member_channel_id" uuid NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "aggregate_channel_members_aggregate_channel_id_member_channel_id_pk" PRIMARY KEY("aggregate_channel_id","member_channel_id"),
	CONSTRAINT "aggregate_members_no_self" CHECK ("aggregate_channel_members"."aggregate_channel_id" <> "aggregate_channel_members"."member_channel_id"),
	CONSTRAINT "aggregate_members_priority_range" CHECK ("aggregate_channel_members"."priority" between 0 and 1000),
	CONSTRAINT "aggregate_members_weight_range" CHECK ("aggregate_channel_members"."weight" between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "request_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"channel_id" uuid NOT NULL,
	"channel_name" text NOT NULL,
	"channel_type" "channel_type" NOT NULL,
	"subscription_account_id" uuid,
	"status" "request_attempt_status" DEFAULT 'prepared' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"no_execution" boolean,
	"http_status" integer,
	"upstream_request_id" text,
	"error_code" text,
	"error_message" text,
	CONSTRAINT "request_attempt_sequence_unique" UNIQUE("request_id","sequence"),
	CONSTRAINT "request_attempt_sequence_positive" CHECK ("request_attempts"."sequence" > 0),
	CONSTRAINT "request_attempt_leaf_channel" CHECK ("request_attempts"."channel_type" <> 'aggregate')
);
--> statement-breakpoint
ALTER TABLE "aggregate_channel_members" ADD CONSTRAINT "aggregate_channel_members_aggregate_channel_id_channels_id_fk" FOREIGN KEY ("aggregate_channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aggregate_channel_members" ADD CONSTRAINT "aggregate_channel_members_member_channel_id_channels_id_fk" FOREIGN KEY ("member_channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_attempts" ADD CONSTRAINT "request_attempts_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_attempts" ADD CONSTRAINT "request_attempts_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_attempts" ADD CONSTRAINT "request_attempts_subscription_account_id_subscription_accounts_id_fk" FOREIGN KEY ("subscription_account_id") REFERENCES "public"."subscription_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aggregate_members_member_idx" ON "aggregate_channel_members" USING btree ("member_channel_id");--> statement-breakpoint
CREATE VIEW "public"."effective_channel_endpoints" AS (
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
  having count(*) = (select count(*) from aggregate_channel_members all_members where all_members.aggregate_channel_id = membership.aggregate_channel_id)
);--> statement-breakpoint
CREATE VIEW "public"."effective_channel_models" AS (
  select cm.channel_id, cm.model_id, cm.multiplier_micros
  from channel_available_models cm join channels c on c.id = cm.channel_id
  where c.type <> 'aggregate'
  union all
  select common.channel_id, common.model_id, overrides.multiplier_micros
  from (
    select membership.aggregate_channel_id as channel_id, cm.model_id
    from aggregate_channel_members membership
    join channels parent on parent.id = membership.aggregate_channel_id and parent.type = 'aggregate' and parent.deleted_at is null
    join channels child on child.id = membership.member_channel_id and child.type in ('api', 'subscription') and child.deleted_at is null
    join channel_available_models cm on cm.channel_id = child.id
    group by membership.aggregate_channel_id, cm.model_id
    having count(*) = (select count(*) from aggregate_channel_members all_members where all_members.aggregate_channel_id = membership.aggregate_channel_id)
  ) common
  left join channel_available_models overrides on overrides.channel_id = common.channel_id and overrides.model_id = common.model_id
);