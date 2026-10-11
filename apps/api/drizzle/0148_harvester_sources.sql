-- GENERATED frozen D153.28 Harvester policy v1 and native-resource identity.
-- Source: shared constants PHASE_E_HARVESTER.v1 / PHASE_E_SEEKER_AUCTION,
-- phaseEResources. Future versions append; no issuance/cap/settlement is implied.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS harvester_sources (
 id uuid PRIMARY KEY, actor_wallet text NOT NULL REFERENCES players(wallet), base_id uuid NOT NULL REFERENCES bases(id) ON DELETE RESTRICT,
 harvester_id uuid NOT NULL, harvester_completed_job_id uuid NOT NULL, harvester_completed_at timestamptz NOT NULL,
 policy_version integer NOT NULL, realm_id text NOT NULL, resource_id text NOT NULL, home_evidence jsonb NOT NULL, interval_snapshot jsonb NOT NULL,
 term_id uuid NOT NULL, term_hash text NOT NULL, finality jsonb NOT NULL, admitted_at timestamptz NOT NULL, lease_expires_at timestamptz NOT NULL,
 CONSTRAINT harvester_source_term_fk FOREIGN KEY(term_id,term_hash) REFERENCES expedition_term_snapshots(term_id,snapshot_hash),
 CONSTRAINT harvester_source_scope_uq UNIQUE(id,actor_wallet,base_id),
 CONSTRAINT harvester_source_time_ck CHECK(lease_expires_at>admitted_at AND harvester_completed_at<=admitted_at)
);
CREATE INDEX IF NOT EXISTS harvester_source_base_idx ON harvester_sources(base_id,admitted_at);
-- Both wallet and base remain pending, even when expired/sold, until a reviewed
-- settlement migration can preserve all old obligations. Not a permanent cap.
CREATE TABLE IF NOT EXISTS harvester_source_heads (
 wallet text PRIMARY KEY, base_id uuid NOT NULL UNIQUE, source_id uuid NOT NULL UNIQUE,
 CONSTRAINT harvester_head_original_source_fk FOREIGN KEY(source_id,wallet,base_id) REFERENCES harvester_sources(id,actor_wallet,base_id)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_harvester_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE term public.expedition_term_snapshots%ROWTYPE; expected jsonb; native jsonb;
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Harvester source history and pending heads are immutable' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='harvester_source_heads' THEN RETURN NEW; END IF;
 SELECT * INTO STRICT term FROM public.expedition_term_snapshots WHERE term_id=NEW.term_id AND snapshot_hash=NEW.term_hash;
 native := '{"frostveil":"frost_quartz","elderwood":"heartwood_logs","sunscar":"sunstone_rubble","crownlands":"crown_iron_ore","seeker-reach":"rough_prism","stormcairn":"storm_ore","thornwake":"thorn_fibre","cinderfall":"ember_nodules"}'::jsonb;
 expected := jsonb_build_object('policyVersion',1,'sourceId',NEW.id::text,'originalWallet',NEW.actor_wallet,
  'baseId',NEW.base_id::text,'harvesterId',NEW.harvester_id::text,'realmId',NEW.realm_id,
  'admittedAtMs',extract(epoch from NEW.admitted_at)*1000,
  'term',jsonb_build_object('id',NEW.term_id::text,'hash',NEW.term_hash,'startsAtMs',extract(epoch from term.starts_at)*1000,'endsAtMs',extract(epoch from term.ends_at)*1000));
 IF (NEW.policy_version=1 AND NEW.resource_id=native->>NEW.realm_id AND NEW.interval_snapshot=expected
  AND isfinite(NEW.admitted_at) AND NEW.admitted_at=date_trunc('milliseconds',NEW.admitted_at) AND NEW.admitted_at>=term.starts_at AND NEW.admitted_at<term.ends_at
  AND isfinite(NEW.harvester_completed_at) AND NEW.harvester_completed_at<=NEW.admitted_at
  AND NEW.lease_expires_at=least(NEW.admitted_at+interval '86400 seconds',term.ends_at)
  AND NEW.home_evidence->>'baseId'=NEW.base_id::text AND NEW.home_evidence->>'custodyWallet'=NEW.actor_wallet
  AND NEW.home_evidence->>'realmId'=NEW.realm_id AND NEW.home_evidence->>'version'='1'
  AND NEW.home_evidence->>'source' IN ('free_assignment','deed_location')
  AND NEW.finality->>'commitment'='finalized') IS NOT TRUE THEN
  RAISE EXCEPTION 'Harvester original interval mismatch' USING ERRCODE='23514'; END IF;
 IF (jsonb_typeof(NEW.finality)='object' AND (SELECT count(*) FROM jsonb_object_keys(NEW.finality))=3
  AND NEW.finality->>'contextSlot' ~ '^(0|[1-9][0-9]{0,19})$' AND (NEW.finality->>'contextSlot')::numeric<=18446744073709551615
  AND isfinite((NEW.finality->>'observedAt')::timestamptz)
  AND (NEW.finality->>'observedAt')::timestamptz<=NEW.admitted_at
  AND NEW.admitted_at-(NEW.finality->>'observedAt')::timestamptz<=interval '10000 milliseconds'
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(term.snapshot->'spots') spot WHERE (spot->>'settlementSlot')::numeric>(NEW.finality->>'contextSlot')::numeric)) IS NOT TRUE THEN
  RAISE EXCEPTION 'Harvester finalized observation mismatch' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.buildings b JOIN public.builder_jobs j ON j.building_id=b.id
  WHERE b.id=NEW.harvester_id AND b.base_id=NEW.base_id AND b.type='harvester' AND b.level>=1
   AND j.id=NEW.harvester_completed_job_id AND j.base_id=NEW.base_id AND j.kind='build' AND j.cancelled_at IS NULL
   AND j.completed_at=NEW.harvester_completed_at)
  OR EXISTS(SELECT 1 FROM public.builder_jobs j WHERE j.building_id=NEW.harvester_id AND j.kind='build' AND j.completed_at IS NULL) THEN
  RAISE EXCEPTION 'Harvester completion proof missing' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_harvester_source_guard() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_sources'::regclass AND tgname = 'harvester_source_guard') THEN
    CREATE TRIGGER harvester_source_guard BEFORE INSERT OR UPDATE OR DELETE ON harvester_sources FOR EACH ROW EXECUTE FUNCTION public.shardkeep_harvester_source_guard();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_sources'::regclass AND tgname = 'harvester_source_no_truncate') THEN
    CREATE TRIGGER harvester_source_no_truncate BEFORE TRUNCATE ON harvester_sources FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_harvester_source_guard();
  END IF;
END;
$migration$;
-- Keep any later same-block refinement when this file is replayed.
DO $migration$
BEGIN
  IF pg_catalog.to_regprocedure('public.shardkeep_harvester_head_guard()') IS NULL THEN
    CREATE FUNCTION public.shardkeep_harvester_head_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Harvester source history and pending heads are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
  END IF;
END;
$migration$;
REVOKE ALL ON FUNCTION public.shardkeep_harvester_head_guard() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_source_heads'::regclass AND tgname = 'harvester_head_guard') THEN
    CREATE TRIGGER harvester_head_guard BEFORE INSERT OR UPDATE OR DELETE ON harvester_source_heads FOR EACH ROW EXECUTE FUNCTION public.shardkeep_harvester_head_guard();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_source_heads'::regclass AND tgname = 'harvester_head_no_truncate') THEN
    CREATE TRIGGER harvester_head_no_truncate BEFORE TRUNCATE ON harvester_source_heads FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_harvester_source_guard();
  END IF;
END;
$migration$;
--> statement-breakpoint
-- Keep any later same-block refinement when this file is replayed.
DO $migration$
BEGIN
  IF pg_catalog.to_regprocedure('public.shardkeep_harvester_source_head_proof()') IS NULL THEN
    CREATE FUNCTION public.shardkeep_harvester_source_head_proof() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.harvester_source_heads WHERE source_id=NEW.id AND wallet=NEW.actor_wallet AND base_id=NEW.base_id) THEN
  RAISE EXCEPTION 'Harvester original pending head missing' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
  END IF;
END;
$migration$;
REVOKE ALL ON FUNCTION public.shardkeep_harvester_source_head_proof() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_sources'::regclass AND tgname = 'harvester_source_head_proof') THEN
    CREATE CONSTRAINT TRIGGER harvester_source_head_proof AFTER INSERT ON harvester_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_harvester_source_head_proof();
  END IF;
END;
$migration$;
