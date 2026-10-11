-- D-152 / E2 contracts: additive dependent schema, after the enum-label
-- transaction has committed. Existing money rows, enum types, owner-scope
-- constraint and four pending-slot indexes remain untouched here.
-- Owner-scope replacement is isolated in held 0134_gems_owner_scope.
CREATE UNIQUE INDEX IF NOT EXISTS deposits_gems_buy_key_uq ON deposits
(player_wallet, (payload->>'idempotencyKey'))
WHERE kind = 'gems_buy';--> statement-breakpoint
-- E2-GEMS-CONTRACT §3 item provenance: shop_gems items are account-bound
-- (listItem refuses them); every pre-existing row is 'legacy'.
ALTER TABLE "player_items" ADD COLUMN IF NOT EXISTS "acquired_via" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.player_items'::regclass AND conname = 'player_items_acquired_via_ck') THEN
    ALTER TABLE "player_items" ADD CONSTRAINT "player_items_acquired_via_ck" CHECK ("player_items"."acquired_via" IN ('legacy', 'shop_keep', 'shop_gems', 'drop', 'craft', 'market', 'grant'));
  END IF;
END;
$$;--> statement-breakpoint
ALTER TABLE "base_items" ADD COLUMN IF NOT EXISTS "acquired_via" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.base_items'::regclass AND conname = 'base_items_acquired_via_ck') THEN
    ALTER TABLE "base_items" ADD CONSTRAINT "base_items_acquired_via_ck" CHECK ("base_items"."acquired_via" IN ('legacy', 'shop_keep', 'shop_gems', 'drop', 'craft', 'market', 'grant'));
  END IF;
END;
$$;--> statement-breakpoint
-- E2-WORKSHOP-CONTRACT §3: SHARDS are spent at start (the debit id is stored on
-- the row); collect is the only completion path (lazy, no worker). The 10000
-- literal is PHASE_E_POLICY.forge.shardsPerIngot (D-149 lock: one ingot =
-- 10,000 SHARDS); migrations-fresh-db.test.ts pins the literal to the constant.
CREATE TABLE IF NOT EXISTS "workshop_jobs" (
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
	CONSTRAINT "workshop_jobs_shards_charged_ck" CHECK ("workshop_jobs"."shards_charged" = "workshop_jobs"."ingots" * 10000),
	CONSTRAINT "workshop_jobs_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "workshop_jobs_started_by_wallet_players_wallet_fk" FOREIGN KEY ("started_by_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "workshop_jobs_debit_ledger_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("debit_ledger_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workshop_jobs_base_collected_idx" ON "workshop_jobs" USING btree ("base_id","collected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workshop_jobs_base_started_idx" ON "workshop_jobs" USING btree ("base_id","started_at");
