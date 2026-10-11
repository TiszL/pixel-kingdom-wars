CREATE TABLE "item_uses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_wallet" text NOT NULL,
	"item_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_uses_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "item_uses" ADD CONSTRAINT "item_uses_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "item_uses_owner_idx" ON "item_uses" USING btree ("player_wallet");