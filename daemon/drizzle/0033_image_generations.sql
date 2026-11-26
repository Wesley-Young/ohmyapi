CREATE TYPE "public"."model_output_kind" AS ENUM('text', 'image');--> statement-breakpoint
ALTER TYPE "public"."endpoint" ADD VALUE '/v1/images';--> statement-breakpoint
ALTER TABLE "models" DROP CONSTRAINT "models_token_limits";--> statement-breakpoint
ALTER TABLE "models" ALTER COLUMN "input_token_limit" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "models" ALTER COLUMN "output_token_limit" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "price_rules" ALTER COLUMN "input_price_micros" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "price_rules" ALTER COLUMN "output_price_micros" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "output_kind" "model_output_kind" DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "price_rules" ADD COLUMN "output_kind" "model_output_kind" DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "price_rules" ADD COLUMN "image_price_micros" bigint;--> statement-breakpoint
ALTER TABLE "request_usage" ADD COLUMN "generated_images" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_id_output_kind" UNIQUE("id","output_kind");--> statement-breakpoint
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_model_output_kind_fk" FOREIGN KEY ("model_id","output_kind") REFERENCES "public"."models"("id","output_kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_token_limits" CHECK (("models"."output_kind" = 'text' and "models"."input_token_limit" is not null and "models"."input_token_limit" >= 1 and "models"."output_token_limit" is not null and "models"."output_token_limit" >= 1) or ("models"."output_kind" = 'image' and "models"."input_token_limit" is null and "models"."output_token_limit" is null));--> statement-breakpoint
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_output_kind_shape" CHECK (("price_rules"."output_kind" = 'text' and "price_rules"."input_price_micros" is not null and "price_rules"."output_price_micros" is not null and "price_rules"."image_price_micros" is null) or
       ("price_rules"."output_kind" = 'image' and "price_rules"."kind" in ('default', 'time') and "price_rules"."image_price_micros" is not null and "price_rules"."input_price_micros" is null and "price_rules"."output_price_micros" is null and "price_rules"."cache_read_price_micros" is null and "price_rules"."cache_write_price_micros" is null and "price_rules"."web_search_price_micros" is null and "price_rules"."web_search_preview_price_micros" is null));--> statement-breakpoint
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_image_price_nonnegative" CHECK ("price_rules"."image_price_micros" >= 0);--> statement-breakpoint
ALTER TABLE "request_usage" ADD CONSTRAINT "request_usage_images_nonnegative" CHECK ("request_usage"."generated_images" >= 0);