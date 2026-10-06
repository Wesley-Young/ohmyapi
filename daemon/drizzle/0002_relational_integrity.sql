-- PostgreSQL requires referenced unique constraints before composite foreign keys.
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_owner_unique" UNIQUE("id","user_id");--> statement-breakpoint
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_version_unique" UNIQUE("id","price_version_id");--> statement-breakpoint
ALTER TABLE "price_versions" ADD CONSTRAINT "price_versions_scope_unique" UNIQUE("id","model_id","endpoint");--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_owner_unique" UNIQUE("id","user_id");--> statement-breakpoint
ALTER TABLE "channel_models" ADD CONSTRAINT "channel_models_model_id_endpoint_model_endpoints_model_id_endpoint_fk" FOREIGN KEY ("model_id","endpoint") REFERENCES "public"."model_endpoints"("model_id","endpoint") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_api_key_id_user_id_api_keys_id_user_id_fk" FOREIGN KEY ("api_key_id","user_id") REFERENCES "public"."api_keys"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_price_version_id_model_id_endpoint_price_versions_id_model_id_endpoint_fk" FOREIGN KEY ("price_version_id","model_id","endpoint") REFERENCES "public"."price_versions"("id","model_id","endpoint") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_price_rule_id_price_version_id_price_rules_id_price_version_id_fk" FOREIGN KEY ("price_rule_id","price_version_id") REFERENCES "public"."price_rules"("id","price_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_request_id_user_id_requests_id_user_id_fk" FOREIGN KEY ("request_id","user_id") REFERENCES "public"."requests"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_price_scope" CHECK (("requests"."price_version_id" is null or "requests"."model_id" is not null) and ("requests"."price_rule_id" is null or "requests"."price_version_id" is not null));
