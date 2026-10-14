CREATE TYPE "public"."admin_scope" AS ENUM('users:read', 'users:write', 'wallet:read', 'wallet:write');--> statement-breakpoint
CREATE TABLE "admin_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"hint" text NOT NULL,
	"scopes" "admin_scope"[] NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "admin_tokens_name_length" CHECK (char_length("admin_tokens"."name") between 1 and 64),
	CONSTRAINT "admin_tokens_scopes_not_empty" CHECK (cardinality("admin_tokens"."scopes") > 0)
);
--> statement-breakpoint
ALTER TABLE "admin_tokens" ADD CONSTRAINT "admin_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_tokens_user_idx" ON "admin_tokens" USING btree ("user_id");