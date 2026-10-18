ALTER TABLE "system_settings" DROP CONSTRAINT "system_settings_currency";--> statement-breakpoint
ALTER TABLE "system_settings" DROP CONSTRAINT "system_settings_conventions";--> statement-breakpoint
ALTER TABLE "price_rules" DROP CONSTRAINT "price_rules_timezone";--> statement-breakpoint
ALTER TABLE "system_settings" DROP COLUMN "currency";--> statement-breakpoint
ALTER TABLE "system_settings" DROP COLUMN "money_scale";--> statement-breakpoint
ALTER TABLE "system_settings" DROP COLUMN "price_token_unit";--> statement-breakpoint
ALTER TABLE "system_settings" DROP COLUMN "timezone";--> statement-breakpoint
ALTER TABLE "system_settings" DROP COLUMN "context_pricing";--> statement-breakpoint
ALTER TABLE "system_settings" DROP COLUMN "rounding";--> statement-breakpoint
ALTER TABLE "system_settings" DROP COLUMN "missing_usage";--> statement-breakpoint
ALTER TABLE "price_rules" DROP COLUMN "timezone";