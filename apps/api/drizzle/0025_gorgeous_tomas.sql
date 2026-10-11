CREATE TABLE "player_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_wallet" text NOT NULL,
	"item_id" text NOT NULL,
	"qty" integer DEFAULT 1 NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "keep_skin" text;--> statement-breakpoint
ALTER TABLE "player_items" ADD CONSTRAINT "player_items_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "player_items_owner_item_uq" ON "player_items" USING btree ("player_wallet","item_id");--> statement-breakpoint
CREATE INDEX "player_items_owner_idx" ON "player_items" USING btree ("player_wallet");