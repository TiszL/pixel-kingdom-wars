-- D-152 / E2-GEMS-CONTRACT §1.1: Gems are the fourth ledger currency
-- (non-withdrawable in-game KEEP). Same recreate pattern as 0073: PostgreSQL
-- forbids USING an ALTER TYPE ... ADD VALUE label until commit, while Drizzle
-- applies every pending migration in ONE transaction (a fresh database runs
-- 0026 + 0073 + 0134 together), so each enum is replaced rather than extended.
-- Existing label order is preserved; the new labels are appended. No data
-- movement and no INSERT: bootstrapSystemAccounts creates the system rows
-- lazily. The ALTER COLUMN ... TYPE statements rewrite accounts, withdrawals and
-- deposits under ACCESS EXCLUSIVE (release runbook item).
--
-- Unlike 0073, two kinds of dependents now carry enum LITERALS: the 0074 scope
-- CHECK ('player_keep'::account_kind ...) and the four 0070 partial deposit
-- indexes (kind = 'builder'::deposit_kind ...). When a column is retyped,
-- PostgreSQL re-parses those definitions against the RENAMED legacy type and
-- fails ("operator does not exist: account_kind = account_kind_legacy_0134"),
-- so each is dropped before its retype and recreated — the indexes verbatim,
-- the CHECK extended — afterwards. Nothing else depends on the three types
-- (verified with pg_depend / pg_indexes / pg_constraint on a 0133 database).
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_owner_scope_ck";--> statement-breakpoint
ALTER TYPE "public"."account_kind" RENAME TO "account_kind_legacy_0134";--> statement-breakpoint
CREATE TYPE "public"."account_kind" AS ENUM(
  'player_keep', 'player_sol_credit', 'emission_pool', 'burn', 'league_pool',
  'league_entitlement_escrow', 'treasury', 'quest_bucket', 'sol_treasury',
  'withdrawal_escrow', 'onchain_outflow', 'onchain_inflow', 'keep_genesis',
  'league_sol_pool', 'player_shards', 'forge_escrow', 'forge_payout_escrow',
  'clan_chest', 'shard_genesis', 'shard_burn', 'base_shards', 'base_forge_escrow',
  'raid_loot_escrow', 'mail_keep_escrow', 'mail_shards_escrow',
  'player_gems', 'player_gems_store', 'gems_mint', 'gems_sink', 'gems_reward_budget'
);--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "kind" TYPE "public"."account_kind"
  USING "kind"::text::"public"."account_kind";--> statement-breakpoint
DROP TYPE "public"."account_kind_legacy_0134";--> statement-breakpoint
ALTER TYPE "public"."currency" RENAME TO "currency_legacy_0134";--> statement-breakpoint
CREATE TYPE "public"."currency" AS ENUM('KEEP', 'SOL', 'SHARDS', 'GEMS');--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "currency" TYPE "public"."currency"
  USING "currency"::text::"public"."currency";--> statement-breakpoint
ALTER TABLE "withdrawals" ALTER COLUMN "currency" TYPE "public"."currency"
  USING "currency"::text::"public"."currency";--> statement-breakpoint
DROP TYPE "public"."currency_legacy_0134";--> statement-breakpoint
DROP INDEX "deposits_builder_legacy_slot_pending_uq";--> statement-breakpoint
DROP INDEX "deposits_expansion_legacy_slot_pending_uq";--> statement-breakpoint
DROP INDEX "deposits_builder_slot_pending_uq";--> statement-breakpoint
DROP INDEX "deposits_expansion_slot_pending_uq";--> statement-breakpoint
ALTER TYPE "public"."deposit_kind" RENAME TO "deposit_kind_legacy_0134";--> statement-breakpoint
CREATE TYPE "public"."deposit_kind" AS ENUM(
  'entry', 'deed', 'builder', 'expansion', 'sol_topup', 'keep_deposit', 'energy',
  'energy_pack', 'shield', 'mine', 'mine_build', 'warzone_shield', 'keep_vend',
  'gems_buy'
);--> statement-breakpoint
ALTER TABLE "deposits" ALTER COLUMN "kind" TYPE "public"."deposit_kind"
  USING "kind"::text::"public"."deposit_kind";--> statement-breakpoint
DROP TYPE "public"."deposit_kind_legacy_0134";--> statement-breakpoint
-- The four 0070 indexes, byte-for-byte (their labels come from the CREATE TYPE
-- above, so comparing the enum inside this transaction is safe).
CREATE UNIQUE INDEX "deposits_builder_legacy_slot_pending_uq" ON "deposits" USING btree ("player_wallet",(("payload"->>'expectedBuilders')::integer)) WHERE "deposits"."kind" = 'builder' AND "deposits"."status" = 'pending' AND NOT ("deposits"."payload" ? 'baseId') AND "deposits"."payload" ? 'expectedBuilders';--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_expansion_legacy_slot_pending_uq" ON "deposits" USING btree ("player_wallet",(("payload"->>'expectedExpansions')::integer)) WHERE "deposits"."kind" = 'expansion' AND "deposits"."status" = 'pending' AND NOT ("deposits"."payload" ? 'baseId') AND "deposits"."payload" ? 'expectedExpansions';--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_builder_slot_pending_uq" ON "deposits" USING btree (("payload"->>'baseId'),(("payload"->>'expectedBuilders')::integer)) WHERE "deposits"."kind" = 'builder' AND "deposits"."status" = 'pending' AND "deposits"."payload" ? 'baseId' AND "deposits"."payload" ? 'expectedBuilders';--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_expansion_slot_pending_uq" ON "deposits" USING btree (("payload"->>'baseId'),(("payload"->>'expectedExpansions')::integer)) WHERE "deposits"."kind" = 'expansion' AND "deposits"."status" = 'pending' AND "deposits"."payload" ? 'baseId' AND "deposits"."payload" ? 'expectedExpansions';--> statement-breakpoint
-- The 0074 scope rule, extended: the two Gems player kinds are wallet-scoped;
-- gems_mint / gems_sink / gems_reward_budget fall into the system branch by
-- exclusion, exactly like every other system kind.
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_scope_ck" CHECK (
    ("accounts"."base_id" IS NOT NULL AND "accounts"."owner_wallet" IS NULL AND "accounts"."kind" IN ('base_shards', 'base_forge_escrow'))
    OR
    ("accounts"."base_id" IS NULL AND "accounts"."owner_wallet" IS NOT NULL AND "accounts"."kind" IN ('player_keep', 'player_sol_credit', 'player_shards', 'player_gems', 'player_gems_store'))
    OR
    ("accounts"."base_id" IS NULL AND "accounts"."owner_wallet" IS NULL AND "accounts"."kind" NOT IN ('player_keep', 'player_sol_credit', 'player_shards', 'player_gems', 'player_gems_store', 'base_shards', 'base_forge_escrow'))
  );--> statement-breakpoint
-- E2-GEMS-CONTRACT §1.1 / §2 `POST /deposits { kind: 'gems_buy', keepIn,
-- idempotencyKey }`: one intent per (wallet, key). Comparing the enum here is
-- safe ONLY because 'gems_buy' is a label of the type CREATEd above in this
-- same transaction, not an ADD VALUE label (see deposits_mine_target_pending_uq).
CREATE UNIQUE INDEX deposits_gems_buy_key_uq ON deposits
(player_wallet, (payload->>'idempotencyKey'))
WHERE kind = 'gems_buy';--> statement-breakpoint
-- E2-GEMS-CONTRACT §3 item provenance: shop_gems items are account-bound
-- (listItem refuses them); every pre-existing row is 'legacy'.
ALTER TABLE "player_items" ADD COLUMN "acquired_via" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "player_items" ADD CONSTRAINT "player_items_acquired_via_ck" CHECK ("player_items"."acquired_via" IN ('legacy', 'shop_keep', 'shop_gems', 'drop', 'craft', 'market', 'grant'));--> statement-breakpoint
ALTER TABLE "base_items" ADD COLUMN "acquired_via" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "base_items" ADD CONSTRAINT "base_items_acquired_via_ck" CHECK ("base_items"."acquired_via" IN ('legacy', 'shop_keep', 'shop_gems', 'drop', 'craft', 'market', 'grant'));--> statement-breakpoint
-- E2-WORKSHOP-CONTRACT §3: SHARDS are spent at start (the debit id is stored on
-- the row); collect is the only completion path (lazy, no worker). The 10000
-- literal is PHASE_E_POLICY.forge.shardsPerIngot (D-149 lock: one ingot =
-- 10,000 SHARDS); migrations-fresh-db.test.ts pins the literal to the constant.
CREATE TABLE "workshop_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_id" uuid NOT NULL,
	"started_by_wallet" text NOT NULL,
	"workshop_level_at_start" integer NOT NULL,
	"recipe_version" integer NOT NULL,
	"ingots" integer NOT NULL,
	"shards_charged" bigint NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone NOT NULL,
	"collected_at" timestamp with time zone,
	"collected_by_wallet" text,
	"debit_ledger_txn_id" uuid NOT NULL,
	"start_idempotency_key" text NOT NULL,
	"collect_idempotency_key" text,
	CONSTRAINT "workshop_jobs_debit_ledger_txn_id_unique" UNIQUE("debit_ledger_txn_id"),
	CONSTRAINT "workshop_jobs_start_key_uq" UNIQUE("started_by_wallet","start_idempotency_key"),
	CONSTRAINT "workshop_jobs_collect_key_uq" UNIQUE("collected_by_wallet","collect_idempotency_key"),
	CONSTRAINT "workshop_jobs_ingots_ck" CHECK ("workshop_jobs"."ingots" > 0),
	CONSTRAINT "workshop_jobs_shards_charged_ck" CHECK ("workshop_jobs"."shards_charged" = "workshop_jobs"."ingots" * 10000)
);
--> statement-breakpoint
ALTER TABLE "workshop_jobs" ADD CONSTRAINT "workshop_jobs_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_jobs" ADD CONSTRAINT "workshop_jobs_started_by_wallet_players_wallet_fk" FOREIGN KEY ("started_by_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_jobs" ADD CONSTRAINT "workshop_jobs_debit_ledger_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("debit_ledger_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workshop_jobs_base_collected_idx" ON "workshop_jobs" USING btree ("base_id","collected_at");--> statement-breakpoint
CREATE INDEX "workshop_jobs_base_started_idx" ON "workshop_jobs" USING btree ("base_id","started_at");
