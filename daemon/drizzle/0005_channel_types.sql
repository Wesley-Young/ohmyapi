CREATE TYPE "public"."channel_type" AS ENUM('api', 'subscription', 'aggregate');--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "base_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "credential_encrypted" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "type" "channel_type" DEFAULT 'api' NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_connection_config" CHECK (("channels"."type" = 'api' and "channels"."base_url" is not null and "channels"."credential_encrypted" is not null) or ("channels"."type" <> 'api' and "channels"."base_url" is null and "channels"."credential_encrypted" is null));
