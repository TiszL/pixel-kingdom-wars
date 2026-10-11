ALTER TYPE "public"."account_kind" ADD VALUE 'forge_payout_escrow' BEFORE 'clan_chest';--> statement-breakpoint
ALTER TABLE "forge_contributions" ADD COLUMN "keep_escrow_txn_id" uuid;--> statement-breakpoint
ALTER TABLE "forge_contributions" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "forge_contributions" ADD COLUMN "claim_txn_id" uuid;--> statement-breakpoint
ALTER TABLE "forge_contributions" ADD COLUMN "expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "forge_contributions" ADD CONSTRAINT "forge_contributions_keep_escrow_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("keep_escrow_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_contributions" ADD CONSTRAINT "forge_contributions_claim_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("claim_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- ===================================================================
-- DOUBLE-PAY FIREBREAK. Every row that already carries settled_at was paid
-- DIRECTLY to player_keep by the OLD auto-credit settlement (game/forge.ts,
-- ledger key `forge:${day}:${wallet}:keep`, emission_pool → player_keep). That
-- KEEP sits in the player's spendable balance TODAY. If any of these rows
-- became claimable, claiming would credit the same payout a SECOND time
-- against real balances.
-- Stamp them claimed AT THEIR SETTLE TIME (not now()): it is the truth — the
-- money reached them then — and it makes the history screen render legacy days
-- on their real dates instead of a wall of migration-day timestamps.
-- The SECOND, independent gate is keep_escrow_txn_id IS NULL, which no legacy
-- row can ever acquire (acquiring one requires re-entering settleForgeDay,
-- which filters on settled_at IS NULL). That gate is what also catches any day
-- settled by the OLD code in the migrate→deploy window: it lands with BOTH
-- columns NULL and the API reports it as `paid_legacy`, never as claimable.
-- ===================================================================
UPDATE "forge_contributions"
   SET "claimed_at" = "settled_at"
 WHERE "settled_at" IS NOT NULL AND "claimed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "forge_player_day_idx" ON "forge_contributions" USING btree ("player_wallet","day" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "forge_day_keep_idx" ON "forge_contributions" USING btree ("day","keep_paid" DESC NULLS LAST,"player_wallet");--> statement-breakpoint
CREATE INDEX "forge_unclaimed_idx" ON "forge_contributions" USING btree ("settled_at") WHERE claimed_at is null and expired_at is null and keep_escrow_txn_id is not null;--> statement-breakpoint
ALTER TABLE "forge_contributions" ADD CONSTRAINT "forge_contributions_claim_txn_id_unique" UNIQUE("claim_txn_id");