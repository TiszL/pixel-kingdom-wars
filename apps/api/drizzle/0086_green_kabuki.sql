CREATE TABLE "troop_unlocks" (
	"player_wallet" text NOT NULL,
	"troop" "troop_type" NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "troop_unlocks_player_wallet_troop_pk" PRIMARY KEY("player_wallet","troop")
);
--> statement-breakpoint
ALTER TABLE "troop_unlocks" ADD CONSTRAINT "troop_unlocks_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;