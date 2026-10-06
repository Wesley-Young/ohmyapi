CREATE TABLE "api_key_channels" (
	"api_key_id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_available_models" (
	"channel_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"multiplier_micros" bigint,
	CONSTRAINT "channel_available_models_channel_id_model_id_pk" PRIMARY KEY("channel_id","model_id"),
	CONSTRAINT "channel_models_multiplier_range" CHECK ("channel_available_models"."multiplier_micros" is null or "channel_available_models"."multiplier_micros" between 0 and 1000000000)
);
--> statement-breakpoint
INSERT INTO "channel_available_models" ("channel_id", "model_id") SELECT DISTINCT "channel_id", "model_id" FROM "channel_models" WHERE "enabled" = true;--> statement-breakpoint
DROP TABLE "channel_models";--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "multiplier_micros" bigint DEFAULT 1000000 NOT NULL;--> statement-breakpoint
ALTER TABLE "price_rules" ADD COLUMN "label" text DEFAULT '价格规则' NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "quoted_micros" bigint;--> statement-breakpoint
ALTER TABLE "api_key_channels" ADD CONSTRAINT "api_key_channels_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_channels" ADD CONSTRAINT "api_key_channels_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_available_models" ADD CONSTRAINT "channel_available_models_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_available_models" ADD CONSTRAINT "channel_available_models_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_multiplier_range" CHECK ("channels"."multiplier_micros" between 0 and 1000000000);