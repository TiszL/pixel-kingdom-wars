-- The old prototype could mint KEEP from a pool that production never funded.
-- Abort instead of silently reinterpreting any positive legacy entitlement.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "base_league_entitlements" WHERE "keep_amount" <> 0
  ) THEN
    RAISE EXCEPTION
      'legacy positive KEEP league entitlements require an explicit operator audit before the SHARDS/items-only migration';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE TABLE "league_item_grants" (
	"week" date NOT NULL,
	"base_id" uuid NOT NULL,
	"item_id" text NOT NULL,
	"qty" integer NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "league_item_grants_week_base_id_item_id_pk" PRIMARY KEY("week","base_id","item_id"),
	CONSTRAINT "league_item_grants_qty_ck" CHECK ("league_item_grants"."qty" > 0),
	CONSTRAINT "league_item_grants_item_ck" CHECK ("league_item_grants"."item_id" IN ('keg_of_haste', 'finishers_seal'))
);
--> statement-breakpoint
CREATE TABLE "league_reward_activations" (
	"singleton" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled_at" timestamp with time zone NOT NULL,
	"configured_start_week" date NOT NULL,
	"first_complete_week" date NOT NULL,
	CONSTRAINT "league_reward_activations_singleton_ck" CHECK ("league_reward_activations"."singleton" = 1),
	CONSTRAINT "league_reward_activations_complete_after_config_ck" CHECK ("league_reward_activations"."first_complete_week" >= "league_reward_activations"."configured_start_week")
);
--> statement-breakpoint
CREATE TABLE "league_week_base_exclusions" (
	"week" date NOT NULL,
	"base_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "league_week_base_exclusions_week_base_id_pk" PRIMARY KEY("week","base_id")
);
--> statement-breakpoint
CREATE TABLE "league_week_base_snapshots" (
	"week" date NOT NULL,
	"base_id" uuid NOT NULL,
	"owner_wallet_at_close" text NOT NULL,
	"deed_asset_id" text NOT NULL,
	"deed_observation_id" bigint,
	"deed_observation_slot" bigint NOT NULL,
	"deed_observation_hash" text NOT NULL,
	"deed_observed_at" timestamp with time zone NOT NULL,
	"trophies" integer NOT NULL,
	"keep_level" integer NOT NULL,
	"rated_attacks" integer NOT NULL,
	"tier" "league" NOT NULL,
	"reward_eligible" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "league_week_base_snapshots_week_base_id_pk" PRIMARY KEY("week","base_id"),
	CONSTRAINT "league_week_base_snapshots_trophies_ck" CHECK ("league_week_base_snapshots"."trophies" >= 0),
	CONSTRAINT "league_week_base_snapshots_keep_level_ck" CHECK ("league_week_base_snapshots"."keep_level" BETWEEN 1 AND 20),
	CONSTRAINT "league_week_base_snapshots_rated_attacks_ck" CHECK ("league_week_base_snapshots"."rated_attacks" >= 0),
	CONSTRAINT "league_week_base_snapshots_observation_slot_ck" CHECK ("league_week_base_snapshots"."deed_observation_slot" >= 0)
);
--> statement-breakpoint
CREATE TABLE "league_week_closures" (
	"week" date PRIMARY KEY NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"effective_start_week" date NOT NULL,
	"feature_enabled_at_close" boolean NOT NULL,
	"rewards_enabled" boolean NOT NULL,
	"failure_reason" text,
	"participant_count" integer NOT NULL,
	"excluded_count" integer DEFAULT 0 NOT NULL,
	"rewarded_count" integer NOT NULL,
	"frozen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "league_week_closures_closes_at_unique" UNIQUE("closes_at"),
	CONSTRAINT "league_week_closures_participant_count_ck" CHECK ("league_week_closures"."participant_count" >= 0),
	CONSTRAINT "league_week_closures_excluded_count_ck" CHECK ("league_week_closures"."excluded_count" >= 0),
	CONSTRAINT "league_week_closures_failure_reason_ck" CHECK (
    "league_week_closures"."failure_reason" IS NULL OR (
      "league_week_closures"."failure_reason" = 'authority_snapshot_unavailable' AND "league_week_closures"."rewards_enabled" = false
    )
  ),
	CONSTRAINT "league_week_closures_rewarded_count_ck" CHECK (
    "league_week_closures"."rewarded_count" >= 0 AND "league_week_closures"."rewarded_count" <= "league_week_closures"."participant_count"
  )
);
--> statement-breakpoint
ALTER TABLE "base_league_entitlements" ADD COLUMN "keep_level_granted" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "base_league_entitlements" ADD COLUMN "cache_shards_granted" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "base_league_entitlements" ADD COLUMN "items_granted" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "league_item_grants" ADD CONSTRAINT "league_item_grants_receipt_fk" FOREIGN KEY ("week","base_id") REFERENCES "public"."base_league_entitlements"("week","base_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_week_base_exclusions" ADD CONSTRAINT "league_week_base_exclusions_week_fk" FOREIGN KEY ("week") REFERENCES "public"."league_week_closures"("week") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_week_base_snapshots" ADD CONSTRAINT "league_week_base_snapshots_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_week_base_snapshots" ADD CONSTRAINT "league_week_base_snapshots_owner_wallet_at_close_players_wallet_fk" FOREIGN KEY ("owner_wallet_at_close") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_week_base_snapshots" ADD CONSTRAINT "league_week_base_snapshots_week_fk" FOREIGN KEY ("week") REFERENCES "public"."league_week_closures"("week") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "league_week_base_snapshots_owner_idx" ON "league_week_base_snapshots" USING btree ("week","owner_wallet_at_close");--> statement-breakpoint
ALTER TABLE "base_league_entitlements" ADD CONSTRAINT "base_league_entitlements_keep_zero_ck" CHECK ("base_league_entitlements"."keep_amount" = 0);--> statement-breakpoint
ALTER TABLE "base_league_entitlements" ADD CONSTRAINT "base_league_entitlements_keep_level_ck" CHECK ("base_league_entitlements"."keep_level_granted" BETWEEN 1 AND 20);--> statement-breakpoint
ALTER TABLE "base_league_entitlements" ADD CONSTRAINT "base_league_entitlements_cache_nonnegative_ck" CHECK ("base_league_entitlements"."cache_shards_granted" >= 0);--> statement-breakpoint
ALTER TABLE "base_league_entitlements" ADD CONSTRAINT "base_league_entitlements_items_array_ck" CHECK (jsonb_typeof("base_league_entitlements"."items_granted") = 'array');
--> statement-breakpoint
CREATE FUNCTION prevent_league_receipt_rewrite() RETURNS trigger AS $$
BEGIN
  IF NEW.keep_amount <> 0 THEN
    RAISE EXCEPTION 'league settlement receipts cannot grant KEEP'
      USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.week, NEW.base_id, NEW.tier, NEW.trophies, NEW.keep_amount,
         NEW.keep_level_granted, NEW.cache_shards_granted, NEW.items_granted)
     IS DISTINCT FROM
     ROW(OLD.week, OLD.base_id, OLD.tier, OLD.trophies, OLD.keep_amount,
         OLD.keep_level_granted, OLD.cache_shards_granted, OLD.items_granted) THEN
    RAISE EXCEPTION 'league settlement receipt reward fields are immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.paid_at IS NOT NULL AND NEW.paid_at IS DISTINCT FROM OLD.paid_at THEN
    RAISE EXCEPTION 'league settlement paid_at is monotonic and cannot be cleared or rewritten'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER base_league_entitlements_immutable_reward_trg
BEFORE UPDATE ON "base_league_entitlements"
FOR EACH ROW EXECUTE FUNCTION prevent_league_receipt_rewrite();
--> statement-breakpoint
CREATE FUNCTION prevent_league_receipt_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'league settlement receipts are immutable audit records'
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER base_league_entitlements_no_delete_trg
BEFORE DELETE ON "base_league_entitlements"
FOR EACH ROW EXECUTE FUNCTION prevent_league_receipt_delete();
--> statement-breakpoint
CREATE FUNCTION prevent_frozen_league_row_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'frozen league close, activation, evidence, and grant rows are immutable'
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER league_reward_activations_immutable_trg
BEFORE UPDATE OR DELETE ON "league_reward_activations"
FOR EACH ROW EXECUTE FUNCTION prevent_frozen_league_row_mutation();
--> statement-breakpoint
CREATE TRIGGER league_week_closures_immutable_trg
BEFORE UPDATE OR DELETE ON "league_week_closures"
FOR EACH ROW EXECUTE FUNCTION prevent_frozen_league_row_mutation();
--> statement-breakpoint
CREATE TRIGGER league_week_base_snapshots_immutable_trg
BEFORE UPDATE OR DELETE ON "league_week_base_snapshots"
FOR EACH ROW EXECUTE FUNCTION prevent_frozen_league_row_mutation();
--> statement-breakpoint
CREATE TRIGGER league_week_base_exclusions_immutable_trg
BEFORE UPDATE OR DELETE ON "league_week_base_exclusions"
FOR EACH ROW EXECUTE FUNCTION prevent_frozen_league_row_mutation();
--> statement-breakpoint
CREATE TRIGGER league_item_grants_immutable_trg
BEFORE UPDATE OR DELETE ON "league_item_grants"
FOR EACH ROW EXECUTE FUNCTION prevent_frozen_league_row_mutation();
--> statement-breakpoint
-- All ordinary mutations take a shared transaction lock. Monday close takes
-- the exclusive form before reading any row, so neither lock order can
-- deadlock and a prelocked mutation fails retryably instead of stranding close.
CREATE FUNCTION enforce_league_boundary_fence() RETURNS trigger AS $$
DECLARE
  boundary_date date;
  closed_week date;
  first_week date;
  opening_enabled boolean;
  boundary_protected boolean;
BEGIN
  SELECT first_complete_week INTO first_week
    FROM league_reward_activations WHERE singleton = 1;
  IF first_week IS NULL THEN RETURN NULL; END IF;

  boundary_date := date_trunc('week', clock_timestamp() AT TIME ZONE 'UTC')::date;
  closed_week := boundary_date - 7;
  SELECT (
    (boundary_date >= first_week AND EXISTS (
      SELECT 1 FROM league_week_closures
      WHERE week = closed_week AND feature_enabled_at_close IS TRUE
    )) OR
    (closed_week >= first_week AND NOT EXISTS (
      SELECT 1 FROM league_week_closures WHERE week = closed_week
    ) AND EXISTS (
      SELECT 1 FROM league_week_closures
      WHERE week = closed_week - 7 AND feature_enabled_at_close IS TRUE
    ))
  ) INTO boundary_protected;
  IF boundary_protected IS NOT TRUE THEN RETURN NULL; END IF;

  IF NOT pg_try_advisory_xact_lock_shared(7446001) THEN
    RAISE EXCEPTION 'league week boundary is closing; retry this mutation'
      USING ERRCODE = '40001', HINT = 'Retry after the competing league mutation or close commits.';
  END IF;

  SELECT feature_enabled_at_close INTO opening_enabled
    FROM league_week_closures WHERE week = closed_week - 7;
  IF opening_enabled IS TRUE
     AND NOT EXISTS (SELECT 1 FROM league_week_closures WHERE week = closed_week) THEN
    RAISE EXCEPTION 'league week boundary is closing; retry this mutation'
      USING ERRCODE = '40001', HINT = 'Retry after the Monday 00:00 UTC league close commits.';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER base_profiles_league_boundary_trg
BEFORE INSERT OR DELETE OR UPDATE OF trophies ON "base_profiles"
FOR EACH STATEMENT EXECUTE FUNCTION enforce_league_boundary_fence();
--> statement-breakpoint
CREATE TRIGGER bases_league_boundary_trg
BEFORE INSERT OR DELETE OR UPDATE OF keep_level, owner_wallet, deed_asset_id, status, land_paid_at ON "bases"
FOR EACH STATEMENT EXECUTE FUNCTION enforce_league_boundary_fence();
