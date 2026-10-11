-- D153.28: close original obligations before selecting a fresh lease.
-- Frozen cadence literals project PHASE_E_HARVESTER.v1; no history rewrite.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS harvester_source_actor_idx ON harvester_sources(actor_wallet,admitted_at);
CREATE TABLE IF NOT EXISTS harvester_source_closures (
 source_id uuid PRIMARY KEY REFERENCES harvester_sources(id), cutoff_at timestamptz NOT NULL,
 reason text NOT NULL CHECK(reason IN ('replacement','custody_change','deactivation','facility_removed','realm_change','lease_expired')),
 custody_wallet text NOT NULL, processed_ordinal integer NOT NULL
);
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_source_closures'::regclass AND tgname = 'harvester_closure_immutable') THEN
    CREATE TRIGGER harvester_closure_immutable BEFORE UPDATE OR DELETE ON harvester_source_closures FOR EACH ROW EXECUTE FUNCTION public.shardkeep_harvester_accounting_immutable();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_source_closures'::regclass AND tgname = 'harvester_closure_no_truncate') THEN
    CREATE TRIGGER harvester_closure_no_truncate BEFORE TRUNCATE ON harvester_source_closures FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_harvester_accounting_immutable();
  END IF;
END;
$migration$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_harvester_closure_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE src public.harvester_sources%ROWTYPE; custody text; expected integer; actual integer; last_ordinal integer;
BEGIN
 SELECT * INTO STRICT src FROM public.harvester_sources WHERE id=NEW.source_id;
 SELECT owner_wallet INTO STRICT custody FROM public.bases WHERE id=src.base_id FOR UPDATE;
 PERFORM wallet FROM public.harvester_wallet_locks WHERE wallet=src.actor_wallet FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Harvester closure lacks accounting lock' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO expected FROM generate_series(1,15) AS n
  WHERE src.admitted_at+n*interval '5760 seconds'<=least(NEW.cutoff_at,src.lease_expires_at)
   AND src.admitted_at+n*interval '5760 seconds'<(SELECT ends_at FROM public.expedition_term_snapshots WHERE term_id=src.term_id);
 SELECT count(*),coalesce(max(ordinal),0) INTO actual,last_ordinal FROM public.harvester_events WHERE source_id=src.id;
 IF NOT EXISTS(SELECT 1 FROM public.harvester_source_heads WHERE source_id=src.id AND wallet=src.actor_wallet AND base_id=src.base_id)
  OR (isfinite(NEW.cutoff_at) AND NEW.cutoff_at=date_trunc('milliseconds',NEW.cutoff_at) AND NEW.cutoff_at>=src.admitted_at
   AND NEW.custody_wallet=custody AND NEW.processed_ordinal=expected AND actual=expected AND last_ordinal=expected
   AND (NEW.reason<>'lease_expired' OR NEW.cutoff_at>=src.lease_expires_at)) IS NOT TRUE
  OR EXISTS(SELECT 1 FROM public.harvester_events WHERE source_id=src.id AND earned_at>NEW.cutoff_at)
 THEN RAISE EXCEPTION 'Harvester closure requires every original due candidate' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_harvester_closure_guard() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_source_closures'::regclass AND tgname = 'harvester_closure_guard') THEN
    CREATE TRIGGER harvester_closure_guard BEFORE INSERT ON harvester_source_closures FOR EACH ROW EXECUTE FUNCTION public.shardkeep_harvester_closure_guard();
  END IF;
END;
$migration$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_harvester_closed_event_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 -- A closure is already authoritative inside its transaction, before its head
 -- is deleted. The 0149 head check alone cannot fence this insertion window.
 IF EXISTS(SELECT 1 FROM public.harvester_source_closures WHERE source_id=NEW.source_id) THEN
  RAISE EXCEPTION 'Closed Harvester source cannot earn another event' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_harvester_closed_event_guard() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_events'::regclass AND tgname = 'harvester_closed_event_guard') THEN
    CREATE TRIGGER harvester_closed_event_guard BEFORE INSERT ON harvester_events FOR EACH ROW EXECUTE FUNCTION public.shardkeep_harvester_closed_event_guard();
  END IF;
END;
$migration$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_harvester_head_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Harvester head identity is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN
  IF NOT EXISTS(SELECT 1 FROM public.harvester_source_closures WHERE source_id=OLD.source_id) THEN
   RAISE EXCEPTION 'Harvester head requires original closure' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;
 IF EXISTS(SELECT 1 FROM public.harvester_source_closures WHERE source_id=NEW.source_id) THEN
  RAISE EXCEPTION 'Closed Harvester source cannot reopen' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_harvester_head_guard() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_source_heads'::regclass AND tgname = 'harvester_head_guard') THEN
    CREATE TRIGGER harvester_head_guard BEFORE INSERT OR UPDATE OR DELETE ON harvester_source_heads FOR EACH ROW EXECUTE FUNCTION public.shardkeep_harvester_head_guard();
  END IF;
END;
$migration$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_harvester_source_head_proof() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE sid uuid; pending_count integer; closed_count integer;
BEGIN
 IF TG_TABLE_NAME='harvester_sources' THEN sid:=NEW.id;
 ELSIF TG_OP='DELETE' THEN sid:=OLD.source_id;
 ELSE sid:=NEW.source_id; END IF;
 SELECT count(*) INTO pending_count FROM public.harvester_source_heads WHERE source_id=sid;
 SELECT count(*) INTO closed_count FROM public.harvester_source_closures WHERE source_id=sid;
 IF pending_count+closed_count<>1 THEN RAISE EXCEPTION 'Harvester source must be pending XOR closed' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_source_closures'::regclass AND tgname = 'harvester_closure_head_proof') THEN
    CREATE CONSTRAINT TRIGGER harvester_closure_head_proof AFTER INSERT ON harvester_source_closures DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_harvester_source_head_proof();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_source_heads'::regclass AND tgname = 'harvester_head_state_proof') THEN
    CREATE CONSTRAINT TRIGGER harvester_head_state_proof AFTER INSERT OR DELETE ON harvester_source_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_harvester_source_head_proof();
  END IF;
END;
$migration$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_harvester_source_continuity_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 -- A new lease cannot overlap a closed wallet/base interval or manufacture a
 -- second pending original obligation. Head uniqueness remains the race fence.
 IF EXISTS(SELECT 1 FROM public.harvester_sources s LEFT JOIN public.harvester_source_closures c ON c.source_id=s.id
  WHERE (s.actor_wallet=NEW.actor_wallet OR s.base_id=NEW.base_id) AND (c.source_id IS NULL OR c.cutoff_at>NEW.admitted_at)) THEN
  RAISE EXCEPTION 'Harvester renewal overlaps an original obligation' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_harvester_source_continuity_guard() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_sources'::regclass AND tgname = 'harvester_source_continuity_guard') THEN
    CREATE TRIGGER harvester_source_continuity_guard BEFORE INSERT ON harvester_sources FOR EACH ROW EXECUTE FUNCTION public.shardkeep_harvester_source_continuity_guard();
  END IF;
END;
$migration$;
