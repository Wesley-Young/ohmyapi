ALTER TABLE "price_rules" ADD COLUMN "web_search_price_micros" bigint;--> statement-breakpoint
ALTER TABLE "price_rules" ADD COLUMN "web_search_preview_price_micros" bigint;--> statement-breakpoint
ALTER TABLE "request_usage" ADD COLUMN "web_search_calls" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "request_usage" ADD COLUMN "web_search_preview_calls" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_search_prices_nonnegative" CHECK (("price_rules"."web_search_price_micros" is null or "price_rules"."web_search_price_micros" >= 0) and ("price_rules"."web_search_preview_price_micros" is null or "price_rules"."web_search_preview_price_micros" >= 0));--> statement-breakpoint
ALTER TABLE "request_usage" ADD CONSTRAINT "request_usage_search_bounds" CHECK ("request_usage"."web_search_calls" between 0 and 10000 and "request_usage"."web_search_preview_calls" between 0 and 10000);