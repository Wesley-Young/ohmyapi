ALTER TYPE "public"."endpoint" ADD VALUE '/v1/decisions';--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "endpoint" "endpoint" DEFAULT '/v1/systemone' NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD CONSTRAINT "moderation_settings_endpoint" CHECK ("moderation_settings"."endpoint"::text in ('/v1/systemone', '/v1/decisions'));