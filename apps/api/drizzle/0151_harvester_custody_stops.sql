-- Preserve the first positive finalized custody boundary independently of
-- delivery capacity. This is neither completed accounting nor a new lease.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS harvester_custody_stops (
 source_id uuid PRIMARY KEY REFERENCES harvester_sources(id), cutoff_at timestamptz NOT NULL,
 custody_wallet text NOT NULL, observation_id bigint NOT NULL, asset_id text NOT NULL,
 observed_owner text NOT NULL, observed_slot bigint NOT NULL, checked_at timestamptz NOT NULL,
 observation_status text NOT NULL, observation_source text NOT NULL, audit_hash text NOT NULL
);
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_custody_stops'::regclass AND tgname = 'harvester_custody_stop_immutable') THEN
    CREATE TRIGGER harvester_custody_stop_immutable BEFORE UPDATE OR DELETE ON harvester_custody_stops FOR EACH ROW EXECUTE FUNCTION public.shardkeep_harvester_accounting_immutable();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_custody_stops'::regclass AND tgname = 'harvester_custody_stop_no_truncate') THEN
    CREATE TRIGGER harvester_custody_stop_no_truncate BEFORE TRUNCATE ON harvester_custody_stops FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_harvester_accounting_immutable();
  END IF;
END;
$migration$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_harvester_custody_stop_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE src public.harvester_sources%ROWTYPE; home public.bases%ROWTYPE; observed public.deed_ownership_observations%ROWTYPE;
BEGIN
 SELECT * INTO STRICT src FROM public.harvester_sources WHERE id=NEW.source_id;
 SELECT * INTO STRICT home FROM public.bases WHERE id=src.base_id FOR UPDATE;
 SELECT * INTO observed FROM public.deed_ownership_observations WHERE base_id=src.base_id ORDER BY checked_at DESC,id DESC LIMIT 1;
 -- The accepted observation must already exist under this custody lock. A
 -- caller-supplied owner, RPC failure or older observation is not a stop proof.
 IF NOT FOUND OR (NEW.observation_id=observed.id AND NEW.asset_id=observed.asset_id
  AND NEW.observed_owner=observed.owner AND NEW.observed_slot=observed.slot
  AND NEW.checked_at=observed.checked_at AND NEW.observation_status=observed.status::text
  AND NEW.observation_source=observed.source AND NEW.audit_hash=observed.audit_hash
  AND NEW.asset_id IN (home.deed_asset_id,home.deed_mint_asset_id)
  AND NEW.custody_wallet=home.owner_wallet AND NEW.observed_owner<>home.owner_wallet
  AND NEW.observed_owner<>'' AND NEW.observation_source<>'' AND NEW.audit_hash ~ '^[0-9a-f]{64}$'
  AND NEW.observation_status IN ('mismatch','owned') AND NEW.observed_slot BETWEEN 0 AND 9007199254740991
  AND isfinite(NEW.checked_at) AND NEW.checked_at=date_trunc('milliseconds',NEW.checked_at)
  AND isfinite(NEW.cutoff_at) AND NEW.cutoff_at=date_trunc('milliseconds',NEW.cutoff_at)
  AND NEW.cutoff_at>=src.admitted_at AND NEW.cutoff_at>=NEW.checked_at) IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM public.harvester_source_heads WHERE source_id=src.id AND wallet=src.actor_wallet AND base_id=src.base_id)
  OR EXISTS(SELECT 1 FROM public.harvester_source_closures WHERE source_id=src.id)
  OR EXISTS(SELECT 1 FROM public.harvester_events WHERE source_id=src.id AND earned_at>NEW.cutoff_at)
 THEN RAISE EXCEPTION 'Harvester custody stop requires original accepted finalized ownership evidence' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_harvester_custody_stop_guard() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_custody_stops'::regclass AND tgname = 'harvester_custody_stop_guard') THEN
    CREATE TRIGGER harvester_custody_stop_guard BEFORE INSERT ON harvester_custody_stops FOR EACH ROW EXECUTE FUNCTION public.shardkeep_harvester_custody_stop_guard();
  END IF;
END;
$migration$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_harvester_stopped_event_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 -- Serialize with insertion of the stop before reading its immutable cutoff.
 PERFORM id FROM public.bases WHERE id=(SELECT base_id FROM public.harvester_sources WHERE id=NEW.source_id) FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.harvester_custody_stops WHERE source_id=NEW.source_id AND NEW.earned_at>cutoff_at) THEN
  RAISE EXCEPTION 'Harvester event exceeds original custody stop' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_harvester_stopped_event_guard() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_events'::regclass AND tgname = 'harvester_stopped_event_guard') THEN
    CREATE TRIGGER harvester_stopped_event_guard BEFORE INSERT ON harvester_events FOR EACH ROW EXECUTE FUNCTION public.shardkeep_harvester_stopped_event_guard();
  END IF;
END;
$migration$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_harvester_stopped_closure_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM id FROM public.bases WHERE id=(SELECT base_id FROM public.harvester_sources WHERE id=NEW.source_id) FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.harvester_custody_stops WHERE source_id=NEW.source_id
  AND (NEW.cutoff_at<>cutoff_at OR NEW.reason<>'custody_change')) THEN
  RAISE EXCEPTION 'Harvester closure must retain original custody stop' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_harvester_stopped_closure_guard() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_source_closures'::regclass AND tgname = 'harvester_stopped_closure_guard') THEN
    CREATE TRIGGER harvester_stopped_closure_guard BEFORE INSERT ON harvester_source_closures FOR EACH ROW EXECUTE FUNCTION public.shardkeep_harvester_stopped_closure_guard();
  END IF;
END;
$migration$;
