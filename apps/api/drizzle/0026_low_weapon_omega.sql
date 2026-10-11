ALTER TYPE "public"."account_kind" ADD VALUE 'player_shards';--> statement-breakpoint
ALTER TYPE "public"."account_kind" ADD VALUE 'forge_escrow';--> statement-breakpoint
ALTER TYPE "public"."currency" ADD VALUE 'SHARDS';--> statement-breakpoint
CREATE TABLE "forge_contributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" text NOT NULL,
	"player_wallet" text NOT NULL,
	"shards" bigint NOT NULL,
	"settled_at" timestamp with time zone,
	"keep_paid" bigint,
	"shards_refunded" bigint
);
--> statement-breakpoint
ALTER TABLE "forge_contributions" ADD CONSTRAINT "forge_contributions_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "forge_day_player_uq" ON "forge_contributions" USING btree ("day","player_wallet");--> statement-breakpoint
CREATE INDEX "forge_day_idx" ON "forge_contributions" USING btree ("day");