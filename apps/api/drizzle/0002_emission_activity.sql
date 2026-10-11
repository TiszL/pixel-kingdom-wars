CREATE TABLE "daily_activity" (
	"player_wallet" text NOT NULL,
	"day" date NOT NULL,
	"claimed_at" timestamp with time zone,
	"raids" integer DEFAULT 0 NOT NULL,
	"builds" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "daily_activity_player_wallet_day_pk" PRIMARY KEY("player_wallet","day")
);
--> statement-breakpoint
ALTER TABLE "streaks" ADD COLUMN "streak_bps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_activity" ADD CONSTRAINT "daily_activity_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;