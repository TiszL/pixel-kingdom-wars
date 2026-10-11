ALTER TABLE "item_listings" DROP COLUMN "price_shards";--> statement-breakpoint
ALTER TABLE "item_listings" ADD COLUMN "price_lamports" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "item_listings" ADD COLUMN "reserved_by" text;--> statement-breakpoint
ALTER TABLE "item_listings" ADD COLUMN "reserved_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "item_listings" ADD COLUMN "reference" text;--> statement-breakpoint
ALTER TABLE "item_listings" ADD COLUMN "tx_signature" text;--> statement-breakpoint
ALTER TABLE "item_listings" ADD CONSTRAINT "item_listings_reserved_by_players_wallet_fk" FOREIGN KEY ("reserved_by") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;