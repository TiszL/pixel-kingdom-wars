CREATE TABLE "campaign_progress" (
	"player_wallet" text NOT NULL,
	"stage" integer NOT NULL,
	"best_stars" integer DEFAULT 0 NOT NULL,
	"first_three_star_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_progress_player_wallet_stage_pk" PRIMARY KEY("player_wallet","stage")
);
--> statement-breakpoint
ALTER TABLE "raids" ADD COLUMN "campaign_stage" integer;--> statement-breakpoint
ALTER TABLE "campaign_progress" ADD CONSTRAINT "campaign_progress_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;