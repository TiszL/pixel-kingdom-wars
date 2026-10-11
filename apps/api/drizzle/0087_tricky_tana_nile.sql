SET lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE "quest_bucket_retirement_state" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"phase" text DEFAULT 'fenced' NOT NULL,
	"fenced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"reconciliation_txn_id" uuid,
	CONSTRAINT "quest_bucket_retirement_state_reconciliation_txn_id_unique" UNIQUE("reconciliation_txn_id"),
	CONSTRAINT "quest_bucket_retirement_state_singleton_ck" CHECK ("quest_bucket_retirement_state"."id" = true),
	CONSTRAINT "quest_bucket_retirement_state_phase_ck" CHECK ("quest_bucket_retirement_state"."phase" IN ('fenced', 'ready')),
	CONSTRAINT "quest_bucket_retirement_state_ready_ck" CHECK (
    ("quest_bucket_retirement_state"."phase" = 'fenced' AND "quest_bucket_retirement_state"."ready_at" IS NULL AND "quest_bucket_retirement_state"."reconciliation_txn_id" IS NULL)
    OR ("quest_bucket_retirement_state"."phase" = 'ready' AND "quest_bucket_retirement_state"."ready_at" IS NOT NULL)
  )
);
--> statement-breakpoint
ALTER TABLE "quest_bucket_retirement_state" ADD CONSTRAINT "quest_bucket_retirement_state_reconciliation_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("reconciliation_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- This migration installs a dormant one-way fence. The application performs
-- the value-neutral append-only reconciliation during drained startup, then
-- flips this singleton to ready in the same transaction.
INSERT INTO "quest_bucket_retirement_state" ("id", "phase") VALUES (true, 'fenced');
--> statement-breakpoint

CREATE FUNCTION public."shardkeep_quest_bucket_retired"()
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce((
    SELECT "phase" = 'ready'
    FROM public."quest_bucket_retirement_state"
    WHERE "id" = true
  ), false)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public."shardkeep_quest_bucket_retired"() FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public."shardkeep_activate_quest_bucket_retirement"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD."phase" = 'ready' THEN
    RAISE EXCEPTION 'QUEST_BUCKET_RETIREMENT_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."phase" <> 'ready'
    OR NEW."fenced_at" IS DISTINCT FROM OLD."fenced_at"
    OR NEW."ready_at" IS NULL
  THEN
    RAISE EXCEPTION 'QUEST_BUCKET_RETIREMENT_INVALID_TRANSITION' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public."accounts" WHERE "kind" = 'quest_bucket' AND "balance" <> 0
  ) THEN
    RAISE EXCEPTION 'QUEST_BUCKET_RETIREMENT_BALANCE_NONZERO' USING ERRCODE = 'P0001';
  END IF;
  IF (EXISTS (
    SELECT 1 FROM public."ledger_transactions" WHERE "idempotency_key" = 'genesis:quest_bucket'
  ) OR EXISTS (
    SELECT 1
    FROM public."ledger_entries" le
    JOIN public."ledger_transactions" lt ON lt."id" = le."txn_id"
    JOIN public."accounts" a ON a."id" = le."account_id"
    WHERE a."kind" = 'keep_genesis' AND lt."type" = 'dev.grant' AND le."delta" < 0
  )) AND NEW."reconciliation_txn_id" IS NULL THEN
    RAISE EXCEPTION 'QUEST_BUCKET_RETIREMENT_RECONCILIATION_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public."ledger_transactions" WHERE "idempotency_key" = 'genesis:quest_bucket'
  ) AND NOT EXISTS (
    SELECT 1
    FROM public."ledger_entries" le
    JOIN public."ledger_transactions" lt ON lt."id" = le."txn_id"
    JOIN public."accounts" a ON a."id" = le."account_id"
    WHERE a."kind" = 'keep_genesis' AND lt."type" = 'dev.grant' AND le."delta" < 0
  ) AND NEW."reconciliation_txn_id" IS NOT NULL THEN
    RAISE EXCEPTION 'QUEST_BUCKET_RETIREMENT_UNEXPECTED_RECONCILIATION' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."reconciliation_txn_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public."ledger_transactions"
    WHERE "id" = NEW."reconciliation_txn_id"
      AND "idempotency_key" = 'economy:quest_bucket_retirement:v1'
      AND "type" = 'economy.quest_bucket_retirement'
  ) THEN
    RAISE EXCEPTION 'QUEST_BUCKET_RETIREMENT_RECONCILIATION_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public."shardkeep_activate_quest_bucket_retirement"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "quest_bucket_retirement_state_transition_trg"
BEFORE UPDATE OR DELETE ON "quest_bucket_retirement_state"
FOR EACH ROW EXECUTE FUNCTION public."shardkeep_activate_quest_bucket_retirement"();
--> statement-breakpoint

CREATE FUNCTION public."shardkeep_reject_retired_quest_entry"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  target_account uuid;
BEGIN
  target_account := CASE WHEN TG_OP = 'DELETE' THEN OLD."account_id" ELSE NEW."account_id" END;
  IF public."shardkeep_quest_bucket_retired"() AND EXISTS (
    SELECT 1 FROM public."accounts" WHERE "id" = target_account AND "kind" = 'quest_bucket'
  ) THEN
    RAISE EXCEPTION 'QUEST_BUCKET_RETIRED' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public."shardkeep_reject_retired_quest_entry"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "ledger_entries_retired_quest_bucket_trg"
BEFORE INSERT OR UPDATE OR DELETE ON "ledger_entries"
FOR EACH ROW EXECUTE FUNCTION public."shardkeep_reject_retired_quest_entry"();
--> statement-breakpoint

CREATE FUNCTION public."shardkeep_reject_retired_quest_balance"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public."shardkeep_quest_bucket_retired"() AND OLD."kind" = 'quest_bucket' THEN
    RAISE EXCEPTION 'QUEST_BUCKET_RETIRED' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public."shardkeep_reject_retired_quest_balance"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "accounts_retired_quest_bucket_trg"
BEFORE UPDATE OR DELETE ON "accounts"
FOR EACH ROW EXECUTE FUNCTION public."shardkeep_reject_retired_quest_balance"();
--> statement-breakpoint
SET lock_timeout = '0';
