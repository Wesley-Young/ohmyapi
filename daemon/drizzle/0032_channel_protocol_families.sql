INSERT INTO "channel_endpoints" ("channel_id", "endpoint")
SELECT "channel_id", '/v1/responses' FROM "channel_endpoints" WHERE "endpoint" = '/v1/responses/compact'
ON CONFLICT ("channel_id", "endpoint") DO NOTHING;--> statement-breakpoint
DELETE FROM "channel_endpoints" WHERE "endpoint" = '/v1/responses/compact';--> statement-breakpoint
ALTER TABLE "channel_endpoints" ADD CONSTRAINT "channel_endpoints_family" CHECK ("channel_endpoints"."endpoint" <> '/v1/responses/compact');
