CREATE TYPE "public"."endpoint" AS ENUM('/v1/chat/completions', '/v1/responses', '/v1/messages');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'user');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."price_rule_kind" AS ENUM('default', 'context', 'time', 'combined');--> statement-breakpoint
CREATE TYPE "public"."price_status" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('received', 'reserved', 'forwarding', 'settling', 'settled', 'rejected', 'released', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."ledger_kind" AS ENUM('adjustment', 'reserve', 'settlement', 'release', 'correction');--> statement-breakpoint
CREATE TABLE "api_key_model_grants" (
	"api_key_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	CONSTRAINT "api_key_model_grants_api_key_id_model_id_pk" PRIMARY KEY("api_key_id","model_id")
);
--> statement-breakpoint
CREATE TABLE "channel_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"endpoint" "endpoint" NOT NULL,
	"upstream_model" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "channel_models_binding_unique" UNIQUE("channel_id","model_id","endpoint")
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"credential_encrypted" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"timeout_ms" integer DEFAULT 120000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channels_name_unique" UNIQUE("name"),
	CONSTRAINT "channels_timeout_positive" CHECK ("channels"."timeout_ms" > 0)
);
--> statement-breakpoint
CREATE TABLE "model_endpoints" (
	"model_id" uuid NOT NULL,
	"endpoint" "endpoint" NOT NULL,
	CONSTRAINT "model_endpoints_model_id_endpoint_pk" PRIMARY KEY("model_id","endpoint")
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "models_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "user_model_grants" (
	"user_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	CONSTRAINT "user_model_grants_user_id_model_id_pk" PRIMARY KEY("user_id","model_id")
);
--> statement-breakpoint
CREATE TABLE "admin_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"currency" text NOT NULL,
	"money_scale" integer DEFAULT 1000000 NOT NULL,
	"price_token_unit" integer DEFAULT 1000000 NOT NULL,
	"timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"context_pricing" text DEFAULT 'whole_request' NOT NULL,
	"rounding" text DEFAULT 'ceil_total' NOT NULL,
	"missing_usage" text DEFAULT 'needs_review' NOT NULL,
	"bootstrap_admin_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_settings_singleton" CHECK ("system_settings"."id" = 1),
	CONSTRAINT "system_settings_currency" CHECK ("system_settings"."currency" in ('USD', 'CNY')),
	CONSTRAINT "system_settings_conventions" CHECK ("system_settings"."money_scale" = 1000000 and "system_settings"."price_token_unit" = 1000000 and "system_settings"."timezone" = 'Asia/Shanghai' and "system_settings"."context_pricing" = 'whole_request' and "system_settings"."rounding" = 'ceil_total' and "system_settings"."missing_usage" = 'needs_review')
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_username_format" CHECK ("users"."username" ~ '^[a-z0-9][a-z0-9_.-]{2,63}$')
);
--> statement-breakpoint
CREATE TABLE "price_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"price_version_id" uuid NOT NULL,
	"kind" "price_rule_kind" NOT NULL,
	"context_min" bigint,
	"context_max" bigint,
	"weekdays_mask" integer,
	"start_minute" integer,
	"end_minute" integer,
	"timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"input_price_micros" bigint NOT NULL,
	"output_price_micros" bigint NOT NULL,
	"cache_read_price_micros" bigint,
	"cache_write_price_micros" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_rules_context_shape" CHECK (("price_rules"."kind" in ('context', 'combined') and "price_rules"."context_min" is not null and "price_rules"."context_min" >= 0 and ("price_rules"."context_max" is null or "price_rules"."context_max" > "price_rules"."context_min")) or ("price_rules"."kind" in ('default', 'time') and "price_rules"."context_min" is null and "price_rules"."context_max" is null)),
	CONSTRAINT "price_rules_time_shape" CHECK (("price_rules"."kind" in ('time', 'combined') and "price_rules"."weekdays_mask" is not null and "price_rules"."weekdays_mask" between 1 and 127 and "price_rules"."start_minute" is not null and "price_rules"."start_minute" >= 0 and "price_rules"."end_minute" is not null and "price_rules"."end_minute" <= 1440 and "price_rules"."end_minute" > "price_rules"."start_minute") or ("price_rules"."kind" in ('default', 'context') and "price_rules"."weekdays_mask" is null and "price_rules"."start_minute" is null and "price_rules"."end_minute" is null)),
	CONSTRAINT "price_rules_timezone" CHECK ("price_rules"."timezone" = 'Asia/Shanghai'),
	CONSTRAINT "price_rules_prices_nonnegative" CHECK ("price_rules"."input_price_micros" >= 0 and "price_rules"."output_price_micros" >= 0 and ("price_rules"."cache_read_price_micros" is null or "price_rules"."cache_read_price_micros" >= 0) and ("price_rules"."cache_write_price_micros" is null or "price_rules"."cache_write_price_micros" >= 0))
);
--> statement-breakpoint
CREATE TABLE "price_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"endpoint" "endpoint" NOT NULL,
	"version" integer NOT NULL,
	"status" "price_status" DEFAULT 'draft' NOT NULL,
	"effective_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_versions_number_unique" UNIQUE("model_id","endpoint","version"),
	CONSTRAINT "price_versions_number_positive" CHECK ("price_versions"."version" > 0),
	CONSTRAINT "price_versions_publication" CHECK (("price_versions"."status" = 'draft' and "price_versions"."published_at" is null) or ("price_versions"."status" = 'published' and "price_versions"."published_at" is not null and "price_versions"."effective_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "request_usage" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"context_tokens" bigint NOT NULL,
	"raw_usage" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_usage_nonnegative" CHECK ("request_usage"."input_tokens" >= 0 and "request_usage"."output_tokens" >= 0 and "request_usage"."cache_read_tokens" >= 0 and "request_usage"."cache_write_tokens" >= 0),
	CONSTRAINT "request_usage_context_total" CHECK ("request_usage"."context_tokens" = "request_usage"."input_tokens" + "request_usage"."cache_read_tokens" + "request_usage"."cache_write_tokens")
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"api_key_id" uuid,
	"model_id" uuid,
	"requested_model" text NOT NULL,
	"endpoint" "endpoint" NOT NULL,
	"channel_id" uuid,
	"status" "request_status" DEFAULT 'received' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"price_version_id" uuid,
	"price_rule_id" uuid,
	"reserved_micros" bigint DEFAULT 0 NOT NULL,
	"charged_micros" bigint,
	"pricing_snapshot" jsonb,
	"upstream_request_id" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requests_amounts_nonnegative" CHECK ("requests"."reserved_micros" >= 0 and ("requests"."charged_micros" is null or "requests"."charged_micros" >= 0))
);
--> statement-breakpoint
CREATE TABLE "wallet_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"request_id" uuid,
	"kind" "ledger_kind" NOT NULL,
	"idempotency_key" text NOT NULL,
	"balance_delta_micros" bigint NOT NULL,
	"reserved_delta_micros" bigint NOT NULL,
	"balance_after_micros" bigint NOT NULL,
	"reserved_after_micros" bigint NOT NULL,
	"actor_id" uuid,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_ledger_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "wallet_ledger_reserved_nonnegative" CHECK ("wallet_ledger"."reserved_after_micros" >= 0),
	CONSTRAINT "wallet_ledger_reason_present" CHECK (length(trim("wallet_ledger"."reason")) > 0),
	CONSTRAINT "wallet_ledger_event_shape" CHECK (
    ("wallet_ledger"."kind" in ('adjustment', 'correction') and "wallet_ledger"."actor_id" is not null and "wallet_ledger"."balance_delta_micros" <> 0 and "wallet_ledger"."reserved_delta_micros" = 0)
    or ("wallet_ledger"."kind" = 'reserve' and "wallet_ledger"."request_id" is not null and "wallet_ledger"."balance_delta_micros" = 0 and "wallet_ledger"."reserved_delta_micros" > 0)
    or ("wallet_ledger"."kind" = 'release' and "wallet_ledger"."request_id" is not null and "wallet_ledger"."balance_delta_micros" = 0 and "wallet_ledger"."reserved_delta_micros" < 0)
    or ("wallet_ledger"."kind" = 'settlement' and "wallet_ledger"."request_id" is not null and "wallet_ledger"."balance_delta_micros" <= 0 and "wallet_ledger"."reserved_delta_micros" <= 0)
  )
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"balance_micros" bigint DEFAULT 0 NOT NULL,
	"reserved_micros" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_reserved_nonnegative" CHECK ("wallets"."reserved_micros" >= 0)
);
--> statement-breakpoint
ALTER TABLE "api_key_model_grants" ADD CONSTRAINT "api_key_model_grants_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_model_grants" ADD CONSTRAINT "api_key_model_grants_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_models" ADD CONSTRAINT "channel_models_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_models" ADD CONSTRAINT "channel_models_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_endpoints" ADD CONSTRAINT "model_endpoints_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_model_grants" ADD CONSTRAINT "user_model_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_model_grants" ADD CONSTRAINT "user_model_grants_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_bootstrap_admin_id_users_id_fk" FOREIGN KEY ("bootstrap_admin_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_price_version_id_price_versions_id_fk" FOREIGN KEY ("price_version_id") REFERENCES "public"."price_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_versions" ADD CONSTRAINT "price_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_versions" ADD CONSTRAINT "price_versions_model_id_endpoint_model_endpoints_model_id_endpoint_fk" FOREIGN KEY ("model_id","endpoint") REFERENCES "public"."model_endpoints"("model_id","endpoint") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_usage" ADD CONSTRAINT "request_usage_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_price_version_id_price_versions_id_fk" FOREIGN KEY ("price_version_id") REFERENCES "public"."price_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_price_rule_id_price_rules_id_fk" FOREIGN KEY ("price_rule_id") REFERENCES "public"."price_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_user_id_wallets_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."wallets"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_models_route_idx" ON "channel_models" USING btree ("model_id","endpoint","priority");--> statement-breakpoint
CREATE INDEX "audit_actor_time_idx" ON "admin_audit_logs" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "api_keys_user_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "price_rules_default_unique" ON "price_rules" USING btree ("price_version_id") WHERE "price_rules"."kind" = 'default';--> statement-breakpoint
CREATE UNIQUE INDEX "price_versions_effective_unique" ON "price_versions" USING btree ("model_id","endpoint","effective_at") WHERE "price_versions"."status" = 'published';--> statement-breakpoint
CREATE INDEX "requests_user_time_idx" ON "requests" USING btree ("user_id","received_at");--> statement-breakpoint
CREATE INDEX "requests_recovery_idx" ON "requests" USING btree ("status","heartbeat_at");--> statement-breakpoint
CREATE INDEX "wallet_ledger_user_time_idx" ON "wallet_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_ledger_request_event_unique" ON "wallet_ledger" USING btree ("request_id","kind") WHERE "wallet_ledger"."kind" in ('reserve', 'settlement', 'release');