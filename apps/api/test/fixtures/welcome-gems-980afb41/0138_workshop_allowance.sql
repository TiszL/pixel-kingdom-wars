-- D-153.13: freeze Workshop-only allowance classification. Historical rows
-- deliberately stay NULL: reconstructing their original ownership is unsafe.
SET lock_timeout = '10s';
--> statement-breakpoint
ALTER TABLE workshop_jobs ADD COLUMN capacity_scope_at_start text;
ALTER TABLE workshop_jobs ADD CONSTRAINT workshop_jobs_capacity_scope_ck
  CHECK (capacity_scope_at_start IN ('free_wallet', 'deed_base'));
CREATE INDEX workshop_jobs_wallet_started_idx ON workshop_jobs (started_by_wallet, started_at);
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_guard_workshop_start_facts()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Workshop start facts are immutable'; END IF;
  IF ROW(NEW.id, NEW.base_id, NEW.started_by_wallet, NEW.workshop_level_at_start,
      NEW.capacity_scope_at_start, NEW.recipe_version, NEW.ingots, NEW.shards_charged,
      NEW.started_at, NEW.ready_at, NEW.debit_ledger_txn_id, NEW.start_idempotency_key)
    IS DISTINCT FROM ROW(OLD.id, OLD.base_id, OLD.started_by_wallet, OLD.workshop_level_at_start,
      OLD.capacity_scope_at_start, OLD.recipe_version, OLD.ingots, OLD.shards_charged,
      OLD.started_at, OLD.ready_at, OLD.debit_ledger_txn_id, OLD.start_idempotency_key) THEN
    RAISE EXCEPTION 'Workshop start facts are immutable';
  END IF;
  IF OLD.collected_at IS NOT NULL AND ROW(NEW.collected_at, NEW.collected_by_wallet, NEW.collect_idempotency_key)
    IS DISTINCT FROM ROW(OLD.collected_at, OLD.collected_by_wallet, OLD.collect_idempotency_key) THEN
    RAISE EXCEPTION 'Workshop collection facts are immutable';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.shardkeep_guard_workshop_start_facts() FROM PUBLIC;
CREATE TRIGGER workshop_start_facts_guard BEFORE UPDATE OR DELETE ON workshop_jobs
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_guard_workshop_start_facts();
--> statement-breakpoint
SET lock_timeout = '0';
