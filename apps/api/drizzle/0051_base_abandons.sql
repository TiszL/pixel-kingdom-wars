CREATE TABLE "base_abandons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_wallet" text NOT NULL,
	"prior_keep_level" integer NOT NULL,
	"prior_expansions" integer NOT NULL,
	"buildings_deleted" integer NOT NULL,
	"obstacles_tombstoned" integer NOT NULL,
	"jobs_deleted" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "base_abandons" ADD CONSTRAINT "base_abandons_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "base_abandons_player_idx" ON "base_abandons" USING btree ("player_wallet");