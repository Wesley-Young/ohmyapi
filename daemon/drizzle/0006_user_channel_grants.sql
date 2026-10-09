CREATE TABLE "user_channel_grants" (
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	CONSTRAINT "user_channel_grants_user_id_channel_id_pk" PRIMARY KEY("user_id","channel_id")
);
--> statement-breakpoint
ALTER TABLE "user_channel_grants" ADD CONSTRAINT "user_channel_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_channel_grants" ADD CONSTRAINT "user_channel_grants_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- 将旧模型授权迁移到包含这些模型的非公开渠道，之后按整个渠道授权。
INSERT INTO "user_channel_grants" ("user_id", "channel_id")
SELECT DISTINCT grants."user_id", channels."id"
FROM "user_model_grants" AS grants
INNER JOIN "users" ON "users"."id" = grants."user_id"
INNER JOIN "models" ON "models"."id" = grants."model_id"
INNER JOIN "channel_available_models" AS available ON available."model_id" = grants."model_id"
INNER JOIN "channels" ON channels."id" = available."channel_id"
WHERE "users"."role" = 'user'
  AND "users"."deleted_at" IS NULL
  AND "models"."deleted_at" IS NULL
  AND channels."deleted_at" IS NULL
  AND channels."is_public" = false;
--> statement-breakpoint
DROP TABLE "user_model_grants";
