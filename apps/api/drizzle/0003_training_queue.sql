CREATE TABLE "training_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_wallet" text NOT NULL,
	"troop" "troop_type" NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finishes_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "training_queue" ADD CONSTRAINT "training_queue_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "training_queue_player_idx" ON "training_queue" USING btree ("player_wallet","finishes_at");