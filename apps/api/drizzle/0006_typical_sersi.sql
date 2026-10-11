ALTER TYPE "public"."account_kind" ADD VALUE 'keep_genesis';--> statement-breakpoint
CREATE TABLE "mine_state" (
	"player_wallet" text PRIMARY KEY NOT NULL,
	"accrued_shards" bigint DEFAULT 0 NOT NULL,
	"last_accrual_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "purchased_energy" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "raids" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "streaks" ADD COLUMN "ever_completed_week1" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "streaks" ADD COLUMN "cache_claimed_day" date;--> statement-breakpoint
ALTER TABLE "mine_state" ADD CONSTRAINT "mine_state_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raids" ADD CONSTRAINT "raids_idempotency_key_unique" UNIQUE("idempotency_key");