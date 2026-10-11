-- ===================================================================
-- PER-MINT LEDGER DIMENSION (security review 2026-07-28, KEEP mint rotation)
--
-- The KEEP mint rotated twice on devnet — legacy 8u6xKsWBvQzKyhGCfeoaQJxu9Wg9FgVpSfMBKzU8wbGn
-- → v2 2yukYk9zKGeHQg3JKJEdg5JV3jmZLv6gDsp66F6PahNb
-- → v3 5GQh8Dg2BFtH3Yso5drRA2K8omw46m3KAQrhH3TMpWJC (2026-07-28)
-- — while deposits/withdrawals recorded only an AMOUNT. 13,959 KEEP of on-chain
-- outflow was therefore paid across at least two different SPL tokens with
-- nothing in the books to attribute any of it, making per-mint reserve
-- reconstruction impossible. This column is that missing dimension.
--
-- BOOKKEEPING ONLY. No payout, pricing or gating path reads `mint`; it is
-- written alongside the amount and read by humans and reserve tooling.
--
-- NOTE (concurrent work, 2026-07-29): drizzle-kit emits ONE migration for the
-- whole schema file, so the `refunded` status and `refund_ledger_txn_id`
-- statements below belong to the withdrawals-refund track, not to this one.
-- They are the correct DDL for the schema as checked in.
-- ===================================================================
ALTER TYPE "public"."withdrawal_status" ADD VALUE 'refunded';--> statement-breakpoint
ALTER TABLE "deposits" ADD COLUMN "mint" text;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD COLUMN "mint" text;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD COLUMN "refund_ledger_txn_id" uuid;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_refund_ledger_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("refund_ledger_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deposits_mint_idx" ON "deposits" USING btree ("mint");--> statement-breakpoint
CREATE INDEX "withdrawals_mint_idx" ON "withdrawals" USING btree ("mint");--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_refund_ledger_txn_id_unique" UNIQUE("refund_ledger_txn_id");--> statement-breakpoint
-- ===================================================================
-- BACKFILL — only what is actually KNOWABLE, nothing inferred.
--
-- KNOWABLE: every deposit kind except `keep_deposit` is denominated in
-- LAMPORTS by construction (the program's SOL split, or a direct SOL transfer
-- to the liquidity wallet). No SPL token was ever involved, so the native-SOL
-- mint is a fact about those rows, not a guess. `keep_vend` is included here on
-- purpose: the player paid SOL — the KEEP they received is a ledger credit that
-- never touched a mint (AUDIT-FIX-PLAN B1).
-- ===================================================================
UPDATE "deposits"
   SET "mint" = 'So11111111111111111111111111111111111111112'
 WHERE "mint" IS NULL AND "kind" <> 'keep_deposit';--> statement-breakpoint
-- ===================================================================
-- DELIBERATELY LEFT NULL — do not "fix" this later by guessing:
--
--   * deposits.kind = 'keep_deposit'  (KEEP that entered custody)
--   * every historical row in withdrawals (KEEP that left custody)
--
-- WHY it is not knowable HERE: the mint in force is whatever
-- infra/devnet.addresses.json said when the API PROCESS that handled the row
-- booted. The cutover between mints is a file edit plus a server restart —
-- neither leaves a row, a timestamp or a signature in this database. Even a
-- mint's own creation time (v3: 2026-07-28) is only an upper bound on when the
-- server started using it, so any created_at rule mis-attributes rows near the
-- boundary. Attributing a reserve liability to the WRONG token is strictly
-- worse than admitting it is unknown, so these stay NULL.
--
-- The answer does exist on chain: each row's tx_signature can be fetched and
-- its mint decoded. That is a one-off forensic script against an RPC, not a
-- migration, and it is the only honest way to fill these in.
-- ===================================================================
