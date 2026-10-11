CREATE TABLE "deed_economy_cutover_state" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"phase" text DEFAULT 'fenced' NOT NULL,
	"fenced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	CONSTRAINT "deed_economy_cutover_state_singleton_ck" CHECK ("deed_economy_cutover_state"."id" = true),
	CONSTRAINT "deed_economy_cutover_state_phase_ck" CHECK ("deed_economy_cutover_state"."phase" IN ('fenced', 'ready')),
	CONSTRAINT "deed_economy_cutover_state_ready_ck" CHECK (
    ("deed_economy_cutover_state"."phase" = 'fenced' AND "deed_economy_cutover_state"."ready_at" IS NULL)
    OR ("deed_economy_cutover_state"."phase" = 'ready' AND "deed_economy_cutover_state"."ready_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX "base_battle_records_owner_history_idx" ON "base_battle_records" USING btree ("owner_wallet_at_battle","created_at" DESC NULLS LAST);
--> statement-breakpoint

-- This migration is intentionally a ONE-WAY compatibility fence. It never
-- repairs ambiguous live money/gameplay state: operators must drain it while
-- the existing deploy maintenance window has API + worker stopped.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "raids"
    WHERE "status"::text IN ('pending_orders', 'resolving')
      AND ("attacker_base_id" IS NULL
        OR ("defender_wallet" IS NOT NULL AND "defender_base_id" IS NULL))
  ) THEN
    RAISE EXCEPTION '0077 cannot fence unresolved legacy NULL-base raids';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "item_listings"
    WHERE "status" IN ('active', 'reserved')
      AND "item_id" NOT IN ('skin_keep_gilded', 'skin_keep_frost', 'skin_keep_voidstone')
      AND ("base_id" IS NULL OR ("status" = 'reserved' AND "buyer_base_id" IS NULL))
  ) THEN
    RAISE EXCEPTION '0077 cannot fence unmatched open noncosmetic listings';
  END IF;
  IF EXISTS (SELECT 1 FROM "hero_raid_reservations" WHERE "player_wallet" IS NOT NULL) THEN
    RAISE EXCEPTION '0077 cannot fence wallet-scoped hero raid reservations';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "deposits"
    WHERE "status" = 'pending'
      AND "kind"::text IN (
        'builder', 'expansion', 'energy', 'energy_pack', 'shield',
        'mine', 'mine_build', 'warzone_shield'
      )
      AND nullif("payload"->>'baseId', '') IS NULL
  ) THEN
    -- A reference may already have been paid even when the watcher has not seen
    -- finality yet. Guessing a deed here (or after activation) can grant that
    -- payment to a different base; expiring it can strand real SOL. Operators
    -- must let the old watcher terminalize it before installing this fence.
    RAISE EXCEPTION '0077 cannot fence pending base-owned deposit without frozen baseId';
  END IF;
  IF EXISTS (SELECT 1 FROM "buildings" WHERE "base_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "builder_jobs" WHERE "base_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "obstacles" WHERE "base_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "layouts" WHERE "base_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "shields" WHERE "base_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "plots" WHERE "base_id" IS NULL)
  THEN
    RAISE EXCEPTION '0077 cannot fence legacy NULL-base physical state';
  END IF;
END $$;
--> statement-breakpoint

-- Cosmetics are wallet identity. 0076 removed their duplicated base inventory;
-- remove the last copied display shadow as well.
UPDATE "base_profiles" SET "keep_skin" = NULL WHERE "keep_skin" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "deed_economy_cutover_state" ("id", "phase") VALUES (true, 'fenced');
--> statement-breakpoint

CREATE FUNCTION "shardkeep_deed_economy_ready"()
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT "phase" = 'ready' FROM "deed_economy_cutover_state" WHERE "id" = true), false)
$$;
--> statement-breakpoint
CREATE FUNCTION "shardkeep_deed_writer"()
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT current_setting('shardkeep.deed_economy_writer', true) = 'v1'
$$;
--> statement-breakpoint
CREATE FUNCTION "shardkeep_legacy_test_escape"()
RETURNS boolean LANGUAGE sql STABLE AS $$
  -- Tests must SET LOCAL this exact GUC inside their transaction. The exact DB
  -- name prevents the escape from working in dev, staging, or production.
  SELECT current_database() = 'shardkeep_test'
    AND current_setting('shardkeep.allow_legacy_test', true) = 'on'
$$;
--> statement-breakpoint

CREATE FUNCTION "shardkeep_activate_deed_economy"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'DEED_ECONOMY_CUTOVER_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF OLD."phase" = 'ready' THEN
    RAISE EXCEPTION 'DEED_ECONOMY_CUTOVER_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF NOT "shardkeep_deed_writer"() AND NOT "shardkeep_legacy_test_escape"() THEN
    RAISE EXCEPTION 'DEED_ECONOMY_WRITER_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."phase" <> 'ready'
    OR NEW."fenced_at" IS DISTINCT FROM OLD."fenced_at"
    OR NEW."ready_at" IS NULL
  THEN
    RAISE EXCEPTION 'DEED_ECONOMY_CUTOVER_INVALID_TRANSITION' USING ERRCODE = 'P0001';
  END IF;
  -- Wait out every pre-cutover RowExclusive writer before the final checks and
  -- phase flip. Once these locks are held, a legacy transaction can neither
  -- sneak a shadow write between validation and activation nor commit one
  -- afterward: it either committed before these checks or blocks and sees
  -- phase=ready when its trigger eventually executes. ACCESS EXCLUSIVE is
  -- deliberately stronger than strictly necessary: activation is one short,
  -- stop-the-world operation, and the explicit global list is easier to audit
  -- than relying on the changing lock modes of old SQL statements.
  LOCK TABLE "accounts", "players", "army", "training_queue", "troop_research",
    "hero_levels", "hero_loadouts", "hero_equipment", "hero_raid_reservations",
    "quest_progress", "streaks", "mine_state", "daily_activity", "campaign_progress",
    "player_items", "forge_contributions", "buildings", "builder_jobs", "obstacles",
    "layouts", "shields", "plots", "raids", "item_listings", "deposits"
    IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM "base_economy_backfills" WHERE "ledger_status" <> 'complete') THEN
    RAISE EXCEPTION 'DEED_ECONOMY_BACKFILL_INCOMPLETE' USING ERRCODE = 'P0001';
  END IF;
  -- Every wallet SHARDS account is retired, including an orphan created by a
  -- legacy binary after 0074 prepared its finite queue.
  IF EXISTS (SELECT 1 FROM "accounts" WHERE "kind" = 'player_shards' AND "balance" <> 0) THEN
    RAISE EXCEPTION 'DEED_ECONOMY_LEGACY_BALANCE_NONZERO' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "raids"
    WHERE "status"::text IN ('pending_orders', 'resolving')
      AND ("attacker_base_id" IS NULL
        OR ("defender_wallet" IS NOT NULL AND "defender_base_id" IS NULL))
  ) THEN
    RAISE EXCEPTION 'DEED_ECONOMY_LEGACY_RAID_OPEN' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "item_listings"
    WHERE "status" IN ('active', 'reserved')
      AND "item_id" NOT IN ('skin_keep_gilded', 'skin_keep_frost', 'skin_keep_voidstone')
      AND ("base_id" IS NULL OR ("status" = 'reserved' AND "buyer_base_id" IS NULL))
  ) THEN
    RAISE EXCEPTION 'DEED_ECONOMY_LISTING_UNMATCHED' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM "hero_raid_reservations" WHERE "player_wallet" IS NOT NULL) THEN
    RAISE EXCEPTION 'DEED_ECONOMY_LEGACY_HERO_RESERVED' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "deposits"
    WHERE "status" = 'pending'
      AND "kind"::text IN (
        'builder', 'expansion', 'energy', 'energy_pack', 'shield',
        'mine', 'mine_build', 'warzone_shield'
      )
      AND nullif("payload"->>'baseId', '') IS NULL
  ) THEN
    RAISE EXCEPTION 'DEED_ECONOMY_LEGACY_DEPOSIT_OPEN' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM "buildings" WHERE "base_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "builder_jobs" WHERE "base_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "obstacles" WHERE "base_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "layouts" WHERE "base_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "shields" WHERE "base_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "plots" WHERE "base_id" IS NULL)
  THEN
    RAISE EXCEPTION 'DEED_ECONOMY_LEGACY_PHYSICAL_STATE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "deed_economy_cutover_one_way"
BEFORE INSERT OR UPDATE OR DELETE ON "deed_economy_cutover_state"
FOR EACH ROW EXECUTE FUNCTION "shardkeep_activate_deed_economy"();
--> statement-breakpoint

-- A rolled-back binary must not publish a payable SOL reference whose target
-- deed was never frozen. Terminal transitions and an operator repair that adds
-- baseId remain possible; only creation/retention of the ambiguous pending
-- state is forbidden after the one-way activation.
CREATE FUNCTION "shardkeep_fence_base_deposit_scope"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT "shardkeep_deed_economy_ready"() OR "shardkeep_legacy_test_escape"() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP <> 'DELETE'
    AND NEW."status" = 'pending'
    AND NEW."kind"::text IN (
      'builder', 'expansion', 'energy', 'energy_pack', 'shield',
      'mine', 'mine_build', 'warzone_shield'
    )
    AND nullif(NEW."payload"->>'baseId', '') IS NULL
  THEN
    RAISE EXCEPTION 'LEGACY_BASE_DEPOSIT_SCOPE_FENCED' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
--> statement-breakpoint
CREATE TRIGGER "deposits_deed_cutover_fence"
BEFORE INSERT OR UPDATE OR DELETE ON "deposits"
FOR EACH ROW EXECUTE FUNCTION "shardkeep_fence_base_deposit_scope"();
--> statement-breakpoint

-- Fully retired wallet gameplay tables: even deed-aware code may not recreate
-- an economic shadow after activation. Only the exact test escape is accepted.
CREATE FUNCTION "shardkeep_fence_legacy_gameplay"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT "shardkeep_deed_economy_ready"() OR "shardkeep_legacy_test_escape"() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'LEGACY_GAMEPLAY_WRITER_FENCED:%', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
CREATE TRIGGER "army_deed_cutover_fence" BEFORE INSERT OR UPDATE OR DELETE ON "army" FOR EACH ROW EXECUTE FUNCTION "shardkeep_fence_legacy_gameplay"();
CREATE TRIGGER "training_queue_deed_cutover_fence" BEFORE INSERT OR UPDATE OR DELETE ON "training_queue" FOR EACH ROW EXECUTE FUNCTION "shardkeep_fence_legacy_gameplay"();
CREATE TRIGGER "troop_research_deed_cutover_fence" BEFORE INSERT OR UPDATE OR DELETE ON "troop_research" FOR EACH ROW EXECUTE FUNCTION "shardkeep_fence_legacy_gameplay"();
CREATE TRIGGER "hero_levels_deed_cutover_fence" BEFORE INSERT OR UPDATE OR DELETE ON "hero_levels" FOR EACH ROW EXECUTE FUNCTION "shardkeep_fence_legacy_gameplay"();
CREATE TRIGGER "hero_loadouts_deed_cutover_fence" BEFORE INSERT OR UPDATE OR DELETE ON "hero_loadouts" FOR EACH ROW EXECUTE FUNCTION "shardkeep_fence_legacy_gameplay"();
CREATE TRIGGER "hero_equipment_deed_cutover_fence" BEFORE INSERT OR UPDATE OR DELETE ON "hero_equipment" FOR EACH ROW EXECUTE FUNCTION "shardkeep_fence_legacy_gameplay"();
CREATE TRIGGER "quest_progress_deed_cutover_fence" BEFORE INSERT OR UPDATE OR DELETE ON "quest_progress" FOR EACH ROW EXECUTE FUNCTION "shardkeep_fence_legacy_gameplay"();
CREATE TRIGGER "streaks_deed_cutover_fence" BEFORE INSERT OR UPDATE OR DELETE ON "streaks" FOR EACH ROW EXECUTE FUNCTION "shardkeep_fence_legacy_gameplay"();
CREATE TRIGGER "mine_state_deed_cutover_fence" BEFORE INSERT OR UPDATE OR DELETE ON "mine_state" FOR EACH ROW EXECUTE FUNCTION "shardkeep_fence_legacy_gameplay"();
CREATE TRIGGER "daily_activity_deed_cutover_fence" BEFORE INSERT OR UPDATE OR DELETE ON "daily_activity" FOR EACH ROW EXECUTE FUNCTION "shardkeep_fence_legacy_gameplay"();
CREATE TRIGGER "campaign_progress_deed_cutover_fence" BEFORE INSERT OR UPDATE OR DELETE ON "campaign_progress" FOR EACH ROW EXECUTE FUNCTION "shardkeep_fence_legacy_gameplay"();
--> statement-breakpoint

-- The ledger is one atomic liability surface. Fencing only player_shards would
-- still let a rolled-back binary bootstrap or mutate every KEEP/SOL/system/base
-- account while calculating reserves with its obsolete liability set. After
-- activation, every account mutation therefore requires the exact new-writer
-- connection marker; the doubly gated test escape remains fixture-only.
CREATE FUNCTION "shardkeep_fence_accounts_writer"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT "shardkeep_deed_economy_ready"() OR "shardkeep_deed_writer"()
    OR "shardkeep_legacy_test_escape"()
  THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'DEED_ECONOMY_WRITER_REQUIRED:accounts' USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
CREATE TRIGGER "accounts_deed_writer_cutover_fence"
BEFORE INSERT OR UPDATE OR DELETE ON "accounts"
FOR EACH ROW EXECUTE FUNCTION "shardkeep_fence_accounts_writer"();
--> statement-breakpoint

CREATE FUNCTION "shardkeep_fence_player_shards"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  candidate record;
  touches_player_shards boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN candidate := OLD; ELSE candidate := NEW; END IF;
  touches_player_shards := (TG_OP <> 'INSERT' AND OLD."kind" = 'player_shards')
    OR (TG_OP <> 'DELETE' AND NEW."kind" = 'player_shards');
  IF NOT touches_player_shards OR NOT "shardkeep_deed_economy_ready"()
    OR "shardkeep_legacy_test_escape"()
  THEN
    RETURN candidate;
  END IF;
  -- The audited cutover is transaction-local, only before activation, and the
  -- ready check above deliberately makes this escape impossible afterward.
  IF current_setting('shardkeep.deed_economy_cutover', true) = 'ledger-backfill'
    AND EXISTS (
      SELECT 1 FROM "base_economy_backfills" b
      WHERE b."ledger_status" <> 'complete'
        AND b."source_shard_account_id" = candidate."id"
    )
  THEN
    RETURN candidate;
  END IF;
  RAISE EXCEPTION 'LEGACY_PLAYER_SHARDS_FENCED' USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
CREATE TRIGGER "accounts_player_shards_deed_cutover_fence"
BEFORE INSERT OR UPDATE OR DELETE ON "accounts"
FOR EACH ROW EXECUTE FUNCTION "shardkeep_fence_player_shards"();
--> statement-breakpoint

CREATE FUNCTION "shardkeep_fence_wallet_items"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  candidate record;
  touches_noncosmetic boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN candidate := OLD; ELSE candidate := NEW; END IF;
  touches_noncosmetic := (TG_OP <> 'INSERT'
      AND OLD."item_id" NOT IN ('skin_keep_gilded', 'skin_keep_frost', 'skin_keep_voidstone'))
    OR (TG_OP <> 'DELETE'
      AND NEW."item_id" NOT IN ('skin_keep_gilded', 'skin_keep_frost', 'skin_keep_voidstone'));
  IF NOT "shardkeep_deed_economy_ready"() OR "shardkeep_legacy_test_escape"()
    OR NOT touches_noncosmetic
  THEN
    RETURN candidate;
  END IF;
  RAISE EXCEPTION 'LEGACY_NONCOSMETIC_ITEM_FENCED' USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
CREATE TRIGGER "player_items_deed_cutover_fence"
BEFORE INSERT OR UPDATE OR DELETE ON "player_items"
FOR EACH ROW EXECUTE FUNCTION "shardkeep_fence_wallet_items"();
--> statement-breakpoint

CREATE FUNCTION "shardkeep_fence_hero_reservation_scope"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE candidate record;
BEGIN
  IF TG_OP = 'DELETE' THEN candidate := OLD; ELSE candidate := NEW; END IF;
  IF NOT "shardkeep_deed_economy_ready"() OR "shardkeep_legacy_test_escape"() THEN RETURN candidate; END IF;
  IF NOT "shardkeep_deed_writer"() OR candidate."player_wallet" IS NOT NULL OR candidate."base_id" IS NULL THEN
    RAISE EXCEPTION 'LEGACY_HERO_RESERVATION_FENCED' USING ERRCODE = 'P0001';
  END IF;
  RETURN candidate;
END $$;
--> statement-breakpoint
CREATE TRIGGER "hero_raid_reservations_deed_cutover_fence"
BEFORE INSERT OR UPDATE OR DELETE ON "hero_raid_reservations"
FOR EACH ROW EXECUTE FUNCTION "shardkeep_fence_hero_reservation_scope"();
--> statement-breakpoint

-- Player scalar mirrors are still maintained by deed-aware transfer/deposit
-- code. Old binaries may not turn those mirrors back into authority.
CREATE FUNCTION "shardkeep_require_deed_writer"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT "shardkeep_deed_economy_ready"() OR "shardkeep_deed_writer"()
    OR "shardkeep_legacy_test_escape"()
  THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'DEED_ECONOMY_WRITER_REQUIRED:%', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
CREATE TRIGGER "players_deed_scalar_cutover_fence"
BEFORE UPDATE OF "entry_paid_at", "deed_asset_id", "deed_mint_asset_id", "deed_minting_at",
  "keep_level", "builders", "expansions", "trophies", "league", "week_start_trophies", "purchased_energy"
ON "players" FOR EACH ROW EXECUTE FUNCTION "shardkeep_require_deed_writer"();
--> statement-breakpoint

-- Physical state was already base-keyed by 0064. Require the new writer marker
-- for every mutation, and structurally reject any attempt to recreate a NULL arm.
CREATE FUNCTION "shardkeep_fence_physical_state"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE candidate record;
BEGIN
  IF TG_OP = 'DELETE' THEN candidate := OLD; ELSE candidate := NEW; END IF;
  IF NOT "shardkeep_deed_economy_ready"() OR "shardkeep_legacy_test_escape"() THEN RETURN candidate; END IF;
  IF NOT "shardkeep_deed_writer"() OR candidate."base_id" IS NULL THEN
    RAISE EXCEPTION 'LEGACY_PHYSICAL_STATE_FENCED:%', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  RETURN candidate;
END $$;
--> statement-breakpoint
CREATE TRIGGER "buildings_deed_cutover_fence" BEFORE INSERT OR UPDATE OR DELETE ON "buildings" FOR EACH ROW EXECUTE FUNCTION "shardkeep_fence_physical_state"();
CREATE TRIGGER "builder_jobs_deed_cutover_fence" BEFORE INSERT OR UPDATE OR DELETE ON "builder_jobs" FOR EACH ROW EXECUTE FUNCTION "shardkeep_fence_physical_state"();
CREATE TRIGGER "obstacles_deed_cutover_fence" BEFORE INSERT OR UPDATE OR DELETE ON "obstacles" FOR EACH ROW EXECUTE FUNCTION "shardkeep_fence_physical_state"();
CREATE TRIGGER "layouts_deed_cutover_fence" BEFORE INSERT OR UPDATE OR DELETE ON "layouts" FOR EACH ROW EXECUTE FUNCTION "shardkeep_fence_physical_state"();
CREATE TRIGGER "shields_deed_cutover_fence" BEFORE INSERT OR UPDATE OR DELETE ON "shields" FOR EACH ROW EXECUTE FUNCTION "shardkeep_fence_physical_state"();
CREATE TRIGGER "plots_deed_cutover_fence" BEFORE INSERT OR UPDATE OR DELETE ON "plots" FOR EACH ROW EXECUTE FUNCTION "shardkeep_fence_physical_state"();
--> statement-breakpoint

CREATE FUNCTION "shardkeep_fence_raid_scope"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE candidate record;
BEGIN
  IF TG_OP = 'DELETE' THEN candidate := OLD; ELSE candidate := NEW; END IF;
  IF NOT "shardkeep_deed_economy_ready"() OR "shardkeep_legacy_test_escape"() THEN RETURN candidate; END IF;
  IF NOT "shardkeep_deed_writer"() OR candidate."attacker_base_id" IS NULL
    OR (candidate."defender_wallet" IS NOT NULL AND candidate."defender_base_id" IS NULL)
  THEN
    RAISE EXCEPTION 'LEGACY_RAID_SCOPE_FENCED' USING ERRCODE = 'P0001';
  END IF;
  RETURN candidate;
END $$;
--> statement-breakpoint
CREATE TRIGGER "raids_deed_cutover_fence"
BEFORE INSERT OR UPDATE OR DELETE ON "raids"
FOR EACH ROW EXECUTE FUNCTION "shardkeep_fence_raid_scope"();
--> statement-breakpoint

-- Retain settled historical KEEP claims/expiry, but no binary may mutate the
-- old wallet/day SHARDS economy after activation.
CREATE OR REPLACE FUNCTION "shardkeep_fence_legacy_forge_write"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT "shardkeep_deed_economy_ready"() OR "shardkeep_legacy_test_escape"() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'DELETE') THEN
    RAISE EXCEPTION 'LEGACY_FORGE_WRITER_FENCED' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."day" IS DISTINCT FROM OLD."day"
    OR NEW."player_wallet" IS DISTINCT FROM OLD."player_wallet"
    OR NEW."shards" IS DISTINCT FROM OLD."shards"
    OR NEW."settled_at" IS DISTINCT FROM OLD."settled_at"
    OR NEW."keep_paid" IS DISTINCT FROM OLD."keep_paid"
    OR NEW."shards_refunded" IS DISTINCT FROM OLD."shards_refunded"
    OR NEW."item_dropped" IS DISTINCT FROM OLD."item_dropped"
    OR NEW."keep_escrow_txn_id" IS DISTINCT FROM OLD."keep_escrow_txn_id"
  THEN
    RAISE EXCEPTION 'LEGACY_FORGE_WRITER_FENCED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
