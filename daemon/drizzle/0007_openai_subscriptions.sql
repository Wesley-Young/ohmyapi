ALTER TYPE "public"."endpoint" ADD VALUE '/v1/responses/compact';--> statement-breakpoint
CREATE TABLE "subscription_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider" text DEFAULT 'openai' NOT NULL,
	"account_id" text NOT NULL,
	"user_id" text DEFAULT '' NOT NULL,
	"credential_encrypted" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"max_concurrent" integer DEFAULT 5 NOT NULL,
	"error_code" text,
	"cooldown_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "subscription_accounts_provider" CHECK ("subscription_accounts"."provider" = 'openai'),
	CONSTRAINT "subscription_accounts_concurrency" CHECK ("subscription_accounts"."max_concurrent" between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "subscription_account_id" uuid;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "subscription_account_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_accounts_identity_unique" ON "subscription_accounts" USING btree ("provider","account_id","user_id") WHERE "subscription_accounts"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_subscription_account_id_subscription_accounts_id_fk" FOREIGN KEY ("subscription_account_id") REFERENCES "public"."subscription_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_subscription_account_id_subscription_accounts_id_fk" FOREIGN KEY ("subscription_account_id") REFERENCES "public"."subscription_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_subscription_config" CHECK (("channels"."type" = 'subscription' and "channels"."subscription_account_id" is not null) or ("channels"."type" <> 'subscription' and "channels"."subscription_account_id" is null));
--> statement-breakpoint
CREATE UNIQUE INDEX "channels_subscription_account_unique" ON "channels" USING btree ("subscription_account_id") WHERE "channels"."deleted_at" is null;
