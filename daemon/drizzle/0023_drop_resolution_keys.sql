ALTER TABLE "requests" DROP CONSTRAINT "requests_resolution_key_unique";--> statement-breakpoint
ALTER TABLE "requests" DROP COLUMN "resolution_key";--> statement-breakpoint
ALTER TABLE "requests" DROP COLUMN "resolution_payload";