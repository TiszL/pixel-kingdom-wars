CREATE TYPE "public"."hero_key" AS ENUM('vex', 'theodor');--> statement-breakpoint
CREATE TABLE "hero_levels" (
	"player_wallet" text NOT NULL,
	"hero" "hero_key" NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hero_levels_player_wallet_hero_pk" PRIMARY KEY("player_wallet","hero")
);
--> statement-breakpoint
ALTER TABLE "hero_levels" ADD CONSTRAINT "hero_levels_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;