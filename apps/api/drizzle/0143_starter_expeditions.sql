-- Internal automatic starter dispatch/return. No public admission or issuer.
-- Application writers enforce authority and stock projection correspondence;
-- these SQL constraints enforce original identity, terminal state and entries.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.expedition_term_snapshots'::regclass AND conname = 'expedition_term_id_hash_uq') THEN
    ALTER TABLE expedition_term_snapshots ADD CONSTRAINT expedition_term_id_hash_uq UNIQUE (term_id, snapshot_hash);
  END IF;
END;
$migration$;
CREATE TABLE IF NOT EXISTS starter_expeditions (
  id uuid PRIMARY KEY,
  actor_wallet text NOT NULL REFERENCES players(wallet),
  base_id uuid NOT NULL REFERENCES bases(id) ON DELETE RESTRICT,
  installation_id uuid NOT NULL REFERENCES fleet_installations(id) ON DELETE RESTRICT,
  route_id text NOT NULL,
  route_version integer NOT NULL,
  reward_version integer NOT NULL,
  home_evidence jsonb NOT NULL,
  route_snapshot jsonb NOT NULL,
  term_id uuid NOT NULL,
  term_hash text NOT NULL,
  finality jsonb NOT NULL,
  resource_id text NOT NULL,
  gross bigint NOT NULL,
  net bigint NOT NULL,
  tax bigint NOT NULL,
  departed_at timestamptz NOT NULL,
  returns_at timestamptz NOT NULL,
  CONSTRAINT starter_expedition_term_fk FOREIGN KEY (term_id, term_hash) REFERENCES expedition_term_snapshots(term_id, snapshot_hash),
  CONSTRAINT starter_expeditions_amount_ck CHECK (gross > 0 AND net >= 0 AND tax >= 0 AND net::numeric + tax::numeric = gross::numeric),
  CONSTRAINT starter_expeditions_time_ck CHECK (returns_at > departed_at),
  CONSTRAINT starter_expeditions_version_ck CHECK (route_version > 0 AND reward_version > 0)
);
CREATE INDEX IF NOT EXISTS starter_expeditions_due_idx ON starter_expeditions(base_id, returns_at, id);
CREATE TABLE IF NOT EXISTS starter_expedition_inflight (
  installation_id uuid PRIMARY KEY REFERENCES fleet_installations(id),
  expedition_id uuid NOT NULL UNIQUE REFERENCES starter_expeditions(id)
);
CREATE TABLE IF NOT EXISTS starter_expedition_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expedition_id uuid NOT NULL UNIQUE REFERENCES starter_expeditions(id),
  -- No player FK: return must never take a player lock after its base.
  custody_wallet text NOT NULL,
  returned_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS starter_expedition_entries (
  return_id uuid NOT NULL REFERENCES starter_expedition_returns(id),
  bucket text NOT NULL,
  delta bigint NOT NULL,
  PRIMARY KEY (return_id, bucket),
  CONSTRAINT starter_expedition_entries_bucket_ck CHECK (bucket IN ('issued','base_stock','island_pool')),
  CONSTRAINT starter_expedition_entries_domain_ck CHECK (delta >= -9223372036854775807)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_starter_expedition_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'starter expedition evidence is immutable' USING ERRCODE = '23514';
END;
$$;
REVOKE ALL ON FUNCTION public.shardkeep_starter_expedition_immutable() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.starter_expeditions'::regclass AND tgname = 'starter_expeditions_immutable') THEN
    CREATE TRIGGER starter_expeditions_immutable BEFORE UPDATE OR DELETE ON starter_expeditions FOR EACH ROW EXECUTE FUNCTION public.shardkeep_starter_expedition_immutable();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.starter_expeditions'::regclass AND tgname = 'starter_expeditions_no_truncate') THEN
    CREATE TRIGGER starter_expeditions_no_truncate BEFORE TRUNCATE ON starter_expeditions FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_starter_expedition_immutable();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.starter_expedition_returns'::regclass AND tgname = 'starter_returns_immutable') THEN
    CREATE TRIGGER starter_returns_immutable BEFORE UPDATE OR DELETE ON starter_expedition_returns FOR EACH ROW EXECUTE FUNCTION public.shardkeep_starter_expedition_immutable();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.starter_expedition_returns'::regclass AND tgname = 'starter_returns_no_truncate') THEN
    CREATE TRIGGER starter_returns_no_truncate BEFORE TRUNCATE ON starter_expedition_returns FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_starter_expedition_immutable();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.starter_expedition_entries'::regclass AND tgname = 'starter_entries_immutable') THEN
    CREATE TRIGGER starter_entries_immutable BEFORE UPDATE OR DELETE ON starter_expedition_entries FOR EACH ROW EXECUTE FUNCTION public.shardkeep_starter_expedition_immutable();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.starter_expedition_entries'::regclass AND tgname = 'starter_entries_no_truncate') THEN
    CREATE TRIGGER starter_entries_no_truncate BEFORE TRUNCATE ON starter_expedition_entries FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_starter_expedition_immutable();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.starter_expedition_inflight'::regclass AND tgname = 'starter_inflight_no_update') THEN
    CREATE TRIGGER starter_inflight_no_update BEFORE UPDATE ON starter_expedition_inflight FOR EACH ROW EXECUTE FUNCTION public.shardkeep_starter_expedition_immutable();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.starter_expedition_inflight'::regclass AND tgname = 'starter_inflight_no_truncate') THEN
    CREATE TRIGGER starter_inflight_no_truncate BEFORE TRUNCATE ON starter_expedition_inflight FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_starter_expedition_immutable();
  END IF;
END;
$migration$;
--> statement-breakpoint
-- Keep any later same-block refinement when this file is replayed.
DO $migration$
BEGIN
  IF pg_catalog.to_regprocedure('public.shardkeep_starter_expedition_insert_guard()') IS NULL THEN
    CREATE FUNCTION public.shardkeep_starter_expedition_insert_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE trip public.starter_expeditions%ROWTYPE; custody text;
BEGIN
  IF TG_TABLE_NAME = 'starter_expeditions' THEN
    IF NOT EXISTS (SELECT 1 FROM public.fleet_installations WHERE id = NEW.installation_id AND base_id = NEW.base_id AND family = 'starter')
      OR NOT EXISTS (SELECT 1 FROM public.expedition_term_snapshots WHERE term_id = NEW.term_id AND snapshot_hash = NEW.term_hash AND starts_at <= NEW.departed_at AND NEW.departed_at < ends_at)
      OR (NEW.home_evidence->>'baseId' = NEW.base_id::text
        AND NEW.home_evidence->>'custodyWallet' = NEW.actor_wallet
        AND NEW.route_snapshot->>'routeId' = NEW.route_id
        AND (NEW.route_snapshot->>'routeCatalogueVersion')::integer = NEW.route_version
        AND (NEW.route_snapshot->>'rewardTableVersion')::integer = NEW.reward_version
        AND NEW.route_snapshot->>'realmId' = NEW.home_evidence->>'realmId'
        AND NEW.route_snapshot->>'resourceId' = NEW.resource_id
        AND NEW.route_snapshot->>'vehicleFamily' = 'starter'
        AND (NEW.route_snapshot->>'grossQuantity')::bigint = NEW.gross
        AND (NEW.route_snapshot->>'netQuantity')::bigint = NEW.net
        AND (NEW.route_snapshot->>'islandPoolQuantity')::bigint = NEW.tax
        AND NEW.returns_at - NEW.departed_at = (NEW.route_snapshot->>'durationSec')::bigint * interval '1 second'
        AND NEW.finality->>'commitment' = 'finalized'
        AND (NEW.finality->>'observedAt')::timestamptz <= NEW.departed_at) IS NOT TRUE
    THEN RAISE EXCEPTION 'starter expedition original binding mismatch' USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME = 'starter_expedition_inflight' THEN
    IF NOT EXISTS (SELECT 1 FROM public.starter_expeditions WHERE id = NEW.expedition_id AND installation_id = NEW.installation_id)
    THEN RAISE EXCEPTION 'starter flight differs from original installation' USING ERRCODE = '23514'; END IF;
  ELSE
    SELECT * INTO STRICT trip FROM public.starter_expeditions WHERE id = NEW.expedition_id;
    SELECT owner_wallet INTO custody FROM public.bases WHERE id = trip.base_id FOR UPDATE;
    IF custody IS DISTINCT FROM NEW.custody_wallet OR NEW.returned_at < trip.returns_at
    THEN RAISE EXCEPTION 'starter return custody or deadline mismatch' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
  END IF;
END;
$migration$;
REVOKE ALL ON FUNCTION public.shardkeep_starter_expedition_insert_guard() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.starter_expeditions'::regclass AND tgname = 'starter_expedition_insert_guard') THEN
    CREATE TRIGGER starter_expedition_insert_guard BEFORE INSERT ON starter_expeditions FOR EACH ROW EXECUTE FUNCTION public.shardkeep_starter_expedition_insert_guard();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.starter_expedition_inflight'::regclass AND tgname = 'starter_inflight_insert_guard') THEN
    CREATE TRIGGER starter_inflight_insert_guard BEFORE INSERT ON starter_expedition_inflight FOR EACH ROW EXECUTE FUNCTION public.shardkeep_starter_expedition_insert_guard();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.starter_expedition_returns'::regclass AND tgname = 'starter_return_insert_guard') THEN
    CREATE TRIGGER starter_return_insert_guard BEFORE INSERT ON starter_expedition_returns FOR EACH ROW EXECUTE FUNCTION public.shardkeep_starter_expedition_insert_guard();
  END IF;
END;
$migration$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_starter_expedition_state_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE eid uuid; trip public.starter_expeditions%ROWTYPE; rid uuid; active_count integer; return_count integer;
BEGIN
  IF TG_TABLE_NAME = 'starter_expeditions' THEN eid := NEW.id;
  ELSIF TG_TABLE_NAME = 'starter_expedition_entries' THEN
    SELECT expedition_id INTO STRICT eid FROM public.starter_expedition_returns WHERE id = NEW.return_id;
  ELSIF TG_OP = 'DELETE' THEN eid := OLD.expedition_id;
  ELSE eid := NEW.expedition_id; END IF;
  SELECT * INTO STRICT trip FROM public.starter_expeditions WHERE id = eid;
  SELECT count(*) INTO active_count FROM public.starter_expedition_inflight WHERE expedition_id = eid;
  SELECT count(*) INTO return_count FROM public.starter_expedition_returns WHERE expedition_id = eid;
  IF active_count + return_count <> 1 THEN
    RAISE EXCEPTION 'starter expedition must be in flight XOR returned' USING ERRCODE = '23514'; END IF;
  IF return_count = 1 THEN
    SELECT id INTO STRICT rid FROM public.starter_expedition_returns WHERE expedition_id = eid;
    IF (SELECT count(*) FROM public.starter_expedition_entries WHERE return_id = rid) <> 3
      OR NOT EXISTS (SELECT 1 FROM public.starter_expedition_entries WHERE return_id = rid AND bucket = 'issued' AND delta = -trip.gross)
      OR NOT EXISTS (SELECT 1 FROM public.starter_expedition_entries WHERE return_id = rid AND bucket = 'base_stock' AND delta = trip.net)
      OR NOT EXISTS (SELECT 1 FROM public.starter_expedition_entries WHERE return_id = rid AND bucket = 'island_pool' AND delta = trip.tax)
      OR (SELECT sum(delta::numeric) FROM public.starter_expedition_entries WHERE return_id = rid) <> 0
    THEN RAISE EXCEPTION 'starter return requires original balanced three-entry proof' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.shardkeep_starter_expedition_state_guard() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.starter_expeditions'::regclass AND tgname = 'starter_trip_state') THEN
    CREATE CONSTRAINT TRIGGER starter_trip_state AFTER INSERT ON starter_expeditions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_starter_expedition_state_guard();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.starter_expedition_inflight'::regclass AND tgname = 'starter_flight_state') THEN
    CREATE CONSTRAINT TRIGGER starter_flight_state AFTER INSERT OR DELETE ON starter_expedition_inflight DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_starter_expedition_state_guard();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.starter_expedition_returns'::regclass AND tgname = 'starter_return_state') THEN
    CREATE CONSTRAINT TRIGGER starter_return_state AFTER INSERT ON starter_expedition_returns DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_starter_expedition_state_guard();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.starter_expedition_entries'::regclass AND tgname = 'starter_entries_state') THEN
    CREATE CONSTRAINT TRIGGER starter_entries_state AFTER INSERT ON starter_expedition_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_starter_expedition_state_guard();
  END IF;
END;
$migration$;
