CREATE TYPE "public"."devnet_faucet_status" AS ENUM('requested', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "devnet_faucet_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet" text NOT NULL,
	"lamports" bigint NOT NULL,
	"status" "devnet_faucet_status" DEFAULT 'requested' NOT NULL,
	"tx_signature" text,
	"error" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "devnet_faucet_grants_lamports_ck" CHECK ("devnet_faucet_grants"."lamports" > 0)
);
--> statement-breakpoint
CREATE TABLE "tester_board_hidden" (
	"wallet" text PRIMARY KEY NOT NULL,
	"reason" text,
	"hidden_by" text NOT NULL,
	"hidden_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devnet_faucet_grants" ADD CONSTRAINT "devnet_faucet_grants_wallet_players_wallet_fk" FOREIGN KEY ("wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tester_board_hidden" ADD CONSTRAINT "tester_board_hidden_wallet_players_wallet_fk" FOREIGN KEY ("wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devnet_faucet_grants_wallet_idx" ON "devnet_faucet_grants" USING btree ("wallet","requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "devnet_faucet_grants_status_idx" ON "devnet_faucet_grants" USING btree ("status","requested_at");