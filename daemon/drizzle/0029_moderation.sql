CREATE TYPE "public"."moderation_sample_reason" AS ENUM('rate', 'floor');--> statement-breakpoint
CREATE TYPE "public"."moderation_status" AS ENUM('pending', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."moderation_verdict" AS ENUM('pass', 'suspect', 'violation');--> statement-breakpoint
CREATE TABLE "moderation_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"api_key_id" uuid,
	"session_hash" text NOT NULL,
	"day" date NOT NULL,
	"entry_channel_id" uuid NOT NULL,
	"execution_channel_id" uuid NOT NULL,
	"endpoint" "endpoint" NOT NULL,
	"requested_model" text NOT NULL,
	"reason" "moderation_sample_reason" NOT NULL,
	"request_count" integer NOT NULL,
	"last_request_id" uuid NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"content_encrypted" text,
	"content_chars" integer NOT NULL,
	"truncated" boolean NOT NULL,
	"image_count" integer NOT NULL,
	"status" "moderation_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"verdict" "moderation_verdict",
	"category" text,
	"severity" integer,
	"violation_score" real,
	"answers" jsonb,
	"audit_model" text,
	"decided_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"content_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_sessions_session_unique" UNIQUE("user_id","session_hash","day"),
	CONSTRAINT "moderation_sessions_counts" CHECK ("moderation_sessions"."request_count" >= 1 and "moderation_sessions"."content_chars" >= 0 and "moderation_sessions"."image_count" >= 0 and "moderation_sessions"."attempts" >= 0),
	CONSTRAINT "moderation_sessions_severity" CHECK ("moderation_sessions"."severity" is null or "moderation_sessions"."severity" between 0 and 3),
	CONSTRAINT "moderation_sessions_decided" CHECK (("moderation_sessions"."status" = 'done') = ("moderation_sessions"."verdict" is not null and "moderation_sessions"."decided_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "moderation_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"channel_id" uuid,
	"model" text,
	"rules" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "moderation_settings_singleton" CHECK ("moderation_settings"."id" = 1),
	CONSTRAINT "moderation_settings_rules" CHECK (char_length("moderation_settings"."rules") <= 8000),
	CONSTRAINT "moderation_settings_model" CHECK ("moderation_settings"."model" is null or char_length("moderation_settings"."model") between 1 and 128)
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "moderation_sample_ppm" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "moderation_daily_floor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "moderation_include_output" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_sessions" ADD CONSTRAINT "moderation_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_sessions" ADD CONSTRAINT "moderation_sessions_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_sessions" ADD CONSTRAINT "moderation_sessions_entry_channel_id_channels_id_fk" FOREIGN KEY ("entry_channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_sessions" ADD CONSTRAINT "moderation_sessions_execution_channel_id_channels_id_fk" FOREIGN KEY ("execution_channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_sessions" ADD CONSTRAINT "moderation_sessions_last_request_id_requests_id_fk" FOREIGN KEY ("last_request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_sessions" ADD CONSTRAINT "moderation_sessions_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD CONSTRAINT "moderation_settings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD CONSTRAINT "moderation_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moderation_sessions_queue_idx" ON "moderation_sessions" USING btree ("status","locked_until");--> statement-breakpoint
CREATE INDEX "moderation_sessions_alert_idx" ON "moderation_sessions" USING btree ("verdict","acknowledged_at","created_at");--> statement-breakpoint
CREATE INDEX "moderation_sessions_user_idx" ON "moderation_sessions" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_moderation" CHECK ("channels"."moderation_sample_ppm" between 0 and 1000000 and "channels"."moderation_daily_floor" between 0 and 100);--> statement-breakpoint
UPDATE "channels" SET "moderation_daily_floor" = 1 WHERE "type" = 'subscription';