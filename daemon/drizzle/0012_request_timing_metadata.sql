ALTER TABLE "requests" ADD COLUMN "ttft_ms" integer;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "output_tps" real;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_timing_metadata" CHECK (("requests"."ttft_ms" is null or "requests"."ttft_ms" >= 0) and ("requests"."output_tps" is null or "requests"."output_tps" >= 0) and ("requests"."reasoning_effort" is null or length("requests"."reasoning_effort") <= 16));