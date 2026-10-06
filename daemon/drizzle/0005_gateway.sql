ALTER TYPE "public"."request_status" ADD VALUE 'completed' BEFORE 'received';--> statement-breakpoint
CREATE TABLE "channel_endpoints" (
	"channel_id" uuid NOT NULL,
	"endpoint" "endpoint" NOT NULL,
	CONSTRAINT "channel_endpoints_channel_id_endpoint_pk" PRIMARY KEY("channel_id","endpoint")
);
--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "http_status" integer;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "streaming" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_endpoints" ADD CONSTRAINT "channel_endpoints_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "channel_endpoints" ("channel_id", "endpoint") SELECT DISTINCT "channel_id", "endpoint" FROM "channel_models" ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "channel_models" ADD CONSTRAINT "channel_models_channel_id_endpoint_channel_endpoints_channel_id_endpoint_fk" FOREIGN KEY ("channel_id","endpoint") REFERENCES "public"."channel_endpoints"("channel_id","endpoint") ON DELETE no action ON UPDATE no action;