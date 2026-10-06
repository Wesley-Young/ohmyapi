ALTER TABLE "models" ADD COLUMN "input_token_limit" integer DEFAULT 32768 NOT NULL;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "output_token_limit" integer DEFAULT 4096 NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "billing_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "held_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "usage_final" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "reservation_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "resolution_key" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "resolution_payload" jsonb;--> statement-breakpoint
ALTER TABLE "wallet_ledger" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_resolution_key_unique" UNIQUE("resolution_key");--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_token_limits" CHECK ("models"."input_token_limit" between 1 and 2000000 and "models"."output_token_limit" between 1 and 100000);--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_hold_range" CHECK ("requests"."held_micros" >= 0 and "requests"."held_micros" <= "requests"."reserved_micros");