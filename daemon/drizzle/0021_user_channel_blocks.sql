CREATE TABLE "user_channel_blocks" (
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	CONSTRAINT "user_channel_blocks_user_id_channel_id_pk" PRIMARY KEY("user_id","channel_id")
);
--> statement-breakpoint
ALTER TABLE "user_channel_blocks" ADD CONSTRAINT "user_channel_blocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_channel_blocks" ADD CONSTRAINT "user_channel_blocks_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;