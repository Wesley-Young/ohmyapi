ALTER TABLE "subscription_accounts" DROP CONSTRAINT "subscription_accounts_provider";--> statement-breakpoint
ALTER TABLE "subscription_accounts" ADD COLUMN "model_cooldowns" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_accounts" ADD CONSTRAINT "subscription_accounts_provider" CHECK ("subscription_accounts"."provider" in ('openai', 'claude'));