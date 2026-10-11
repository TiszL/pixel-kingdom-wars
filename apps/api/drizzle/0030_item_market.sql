CREATE TABLE "item_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_wallet" text NOT NULL,
	"item_id" text NOT NULL,
	"price_shards" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"buyer_wallet" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "item_listings" ADD CONSTRAINT "item_listings_seller_wallet_players_wallet_fk" FOREIGN KEY ("seller_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_listings" ADD CONSTRAINT "item_listings_buyer_wallet_players_wallet_fk" FOREIGN KEY ("buyer_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "item_listings_status_idx" ON "item_listings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "item_listings_seller_idx" ON "item_listings" USING btree ("seller_wallet");