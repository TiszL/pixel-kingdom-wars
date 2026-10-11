-- D-153.134 private actual advanced departures/returns. Application validates model,
-- current authority and stock projection; SQL enforces source/receipt consistency.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS advanced_expeditions (
  id uuid PRIMARY KEY,
  actor_wallet text NOT NULL REFERENCES players(wallet),
  base_id uuid NOT NULL REFERENCES bases(id) ON DELETE RESTRICT,
  installation_id uuid NOT NULL REFERENCES advanced_vehicle_installations(reservation_id) ON DELETE RESTRICT,
  route_id text NOT NULL,
  policy_version integer NOT NULL,
  completed_before bigint NOT NULL,
  home_evidence jsonb NOT NULL,
  route_snapshot jsonb NOT NULL CHECK(jsonb_typeof(route_snapshot)='object' AND octet_length(route_snapshot::text)<=1048576),
  term_id uuid NOT NULL,
  term_hash text NOT NULL,
  finality jsonb NOT NULL,
  access_evidence jsonb,
  resource_id text NOT NULL,
  gross bigint NOT NULL,
  net bigint NOT NULL,
  tax bigint NOT NULL,
  departed_at timestamptz NOT NULL,
  returns_at timestamptz NOT NULL,
  CONSTRAINT advanced_expedition_term_fk FOREIGN KEY (term_id, term_hash) REFERENCES expedition_term_snapshots(term_id, snapshot_hash),
  CONSTRAINT advanced_expeditions_amount_ck CHECK (gross > 0 AND net >= 0 AND tax >= 0 AND net::numeric + tax::numeric = gross::numeric),
  CONSTRAINT advanced_expeditions_time_ck CHECK (isfinite(returns_at) AND isfinite(departed_at) AND returns_at > departed_at),
  CONSTRAINT advanced_expeditions_version_ck CHECK (policy_version > 0)
);
CREATE INDEX IF NOT EXISTS advanced_expeditions_due_idx ON advanced_expeditions(base_id, returns_at, id);
CREATE TABLE IF NOT EXISTS advanced_expedition_inflight (
  installation_id uuid PRIMARY KEY REFERENCES advanced_vehicle_installations(reservation_id),
  expedition_id uuid NOT NULL UNIQUE REFERENCES advanced_expeditions(id),
  base_id uuid NOT NULL UNIQUE REFERENCES bases(id)
);
CREATE TABLE IF NOT EXISTS advanced_expedition_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expedition_id uuid NOT NULL UNIQUE REFERENCES advanced_expeditions(id),
  -- No player FK: return must never take a player lock after its base.
  custody_wallet text NOT NULL,
  returned_at timestamptz NOT NULL,
  completed_total bigint NOT NULL CHECK(completed_total>0)
);
CREATE TABLE IF NOT EXISTS advanced_expedition_entries (
  return_id uuid NOT NULL REFERENCES advanced_expedition_returns(id),
  bucket text NOT NULL,
  delta bigint NOT NULL,
  PRIMARY KEY (return_id, bucket),
  CONSTRAINT advanced_expedition_entries_bucket_ck CHECK (bucket IN ('issued','base_stock','island_pool')),
  CONSTRAINT advanced_expedition_entries_domain_ck CHECK (delta >= -9223372036854775807)
);
CREATE INDEX IF NOT EXISTS advanced_expeditions_installation_idx ON advanced_expeditions(installation_id,id);
CREATE TABLE IF NOT EXISTS advanced_expedition_supplies (
 expedition_id uuid NOT NULL REFERENCES advanced_expeditions(id),resource_id text NOT NULL,
 reserve_id uuid NOT NULL UNIQUE REFERENCES resource_stock_operations(id),consume_id uuid NOT NULL UNIQUE REFERENCES resource_stock_operations(id),
 PRIMARY KEY(expedition_id,resource_id)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_advanced_expedition_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE trip public.advanced_expeditions%ROWTYPE;inst public.advanced_vehicle_installations%ROWTYPE;eid uuid;n bigint;custody text;
BEGIN
 IF TG_RELID NOT IN ('public.advanced_expeditions'::regclass,'public.advanced_expedition_inflight'::regclass,'public.advanced_expedition_returns'::regclass,'public.advanced_expedition_entries'::regclass,'public.advanced_expedition_supplies'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END) OR TG_WHEN<>'BEFORE'
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'ADVANCED_TRIGGER_IDENTITY';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'ADVANCED_OWNER' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'ADVANCED_READ_COMMITTED';END IF;
 IF TG_OP<>'INSERT' AND NOT(TG_OP='DELETE' AND TG_TABLE_NAME='advanced_expedition_inflight') THEN RAISE EXCEPTION 'ADVANCED_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='advanced_expeditions' THEN
  SELECT * INTO STRICT inst FROM public.advanced_vehicle_installations WHERE reservation_id=NEW.installation_id FOR UPDATE NOWAIT;
  SELECT count(*) INTO n FROM public.advanced_expedition_returns r JOIN public.advanced_expeditions e ON e.id=r.expedition_id WHERE e.installation_id=inst.reservation_id;
  IF NEW.completed_before IS NOT NULL AND NEW.completed_before<>n THEN RAISE EXCEPTION 'ADVANCED_COUNTER';END IF;NEW.completed_before:=n;
  IF jsonb_typeof(NEW.route_snapshot->'supplies') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'ADVANCED_SUPPLY';END IF;
  IF jsonb_array_length(NEW.route_snapshot->'supplies')<>(SELECT count(DISTINCT s->>'resourceId') FROM jsonb_array_elements(NEW.route_snapshot->'supplies') s) THEN RAISE EXCEPTION 'ADVANCED_SUPPLY';END IF;
  IF inst.base_id<>NEW.base_id OR EXISTS(SELECT 1 FROM public.advanced_expedition_inflight WHERE base_id=NEW.base_id)
  OR NOT EXISTS(SELECT 1 FROM public.bases b JOIN public.base_slots s ON s.base_id=b.id WHERE b.id=NEW.base_id AND b.owner_wallet=NEW.actor_wallet AND b.status='active' AND s.wallet=NEW.actor_wallet AND s.active)
  OR NOT EXISTS(SELECT 1 FROM public.expedition_term_snapshots WHERE term_id=NEW.term_id AND snapshot_hash=NEW.term_hash AND starts_at<=NEW.departed_at AND NEW.departed_at<ends_at)
  OR (NEW.route_snapshot->>'family'=inst.family AND (NEW.route_snapshot->>'tier')::integer=inst.tier
   AND NEW.home_evidence->>'baseId'=NEW.base_id::text AND NEW.home_evidence->>'custodyWallet'=NEW.actor_wallet
   AND NEW.route_snapshot->>'routeId'=NEW.route_id AND (NEW.route_snapshot->>'policyVersion')::integer=NEW.policy_version
   AND NEW.route_snapshot->>'resourceId'=NEW.resource_id AND (NEW.route_snapshot->>'grossQuantity')::bigint=NEW.gross
   AND (NEW.route_snapshot->>'netQuantity')::bigint=NEW.net AND (NEW.route_snapshot->>'islandPoolQuantity')::bigint=NEW.tax
   AND NEW.returns_at-NEW.departed_at=(NEW.route_snapshot->>'durationSec')::bigint*interval '1 second'
   AND NEW.finality->>'commitment'='finalized' AND (NEW.finality->>'observedAt')::timestamptz<=NEW.departed_at) IS NOT TRUE
  THEN RAISE EXCEPTION 'ADVANCED_SOURCE';END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='advanced_expedition_entries' THEN SELECT expedition_id INTO STRICT eid FROM public.advanced_expedition_returns WHERE id=NEW.return_id;
 ELSIF TG_OP='DELETE' THEN eid:=OLD.expedition_id;ELSE eid:=NEW.expedition_id;END IF;
 SELECT * INTO STRICT trip FROM public.advanced_expeditions WHERE id=eid;
 SELECT * INTO STRICT inst FROM public.advanced_vehicle_installations WHERE reservation_id=trip.installation_id FOR UPDATE NOWAIT;
 IF TG_TABLE_NAME='advanced_expedition_returns' THEN
  SELECT owner_wallet INTO STRICT custody FROM public.bases WHERE id=trip.base_id FOR UPDATE NOWAIT;
  SELECT count(*)+1 INTO n FROM public.advanced_expedition_returns r JOIN public.advanced_expeditions e ON e.id=r.expedition_id WHERE e.installation_id=trip.installation_id;
  IF (NEW.completed_total IS NOT NULL AND NEW.completed_total<>n) OR n<>trip.completed_before+1 OR NEW.custody_wallet<>custody OR NEW.returned_at<trip.returns_at
  OR NOT EXISTS(SELECT 1 FROM public.advanced_expedition_inflight WHERE expedition_id=trip.id AND installation_id=trip.installation_id) THEN RAISE EXCEPTION 'ADVANCED_RETURN';END IF;
  NEW.completed_total:=n;
 ELSIF TG_TABLE_NAME='advanced_expedition_inflight' THEN
  IF TG_OP='DELETE' THEN IF NOT EXISTS(SELECT 1 FROM public.advanced_expedition_returns WHERE expedition_id=trip.id) THEN RAISE EXCEPTION 'ADVANCED_RETURN_REQUIRED';END IF;RETURN OLD;END IF;
  IF NEW.installation_id<>trip.installation_id OR NEW.base_id<>trip.base_id THEN RAISE EXCEPTION 'ADVANCED_FLIGHT';END IF;
 ELSIF TG_TABLE_NAME='advanced_expedition_supplies' THEN
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(trip.route_snapshot->'supplies') s JOIN public.resource_stock_operations r ON r.id=NEW.reserve_id
   JOIN public.resource_stock_operations c ON c.id=NEW.consume_id WHERE s->>'resourceId'=NEW.resource_id AND r.kind='reserve' AND r.reservation_id IS NULL
   AND c.kind='consume' AND c.reservation_id=r.id AND r.base_id=trip.base_id AND c.base_id=trip.base_id AND r.custody_wallet=trip.actor_wallet AND c.custody_wallet=trip.actor_wallet
   AND r.resource_id=NEW.resource_id AND c.resource_id=NEW.resource_id AND r.quantity=(s->>'quantity')::bigint AND c.quantity=r.quantity)
  THEN RAISE EXCEPTION 'ADVANCED_SUPPLY';END IF;
 END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_advanced_expedition_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE eid uuid;trip public.advanced_expeditions%ROWTYPE;rid uuid;
BEGIN
 IF TG_RELID NOT IN ('public.advanced_expeditions'::regclass,'public.advanced_expedition_inflight'::regclass,'public.advanced_expedition_returns'::regclass,'public.advanced_expedition_entries'::regclass,'public.advanced_expedition_supplies'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||'_complete') OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP NOT IN('INSERT','DELETE') THEN RAISE EXCEPTION 'ADVANCED_TRIGGER_IDENTITY';END IF;
 IF TG_TABLE_NAME='advanced_expeditions' THEN eid:=NEW.id;
 ELSIF TG_TABLE_NAME='advanced_expedition_entries' THEN SELECT expedition_id INTO STRICT eid FROM public.advanced_expedition_returns WHERE id=NEW.return_id;
 ELSIF TG_OP='DELETE' THEN eid:=OLD.expedition_id;ELSE eid:=NEW.expedition_id;END IF;
 SELECT * INTO STRICT trip FROM public.advanced_expeditions WHERE id=eid;
 IF (SELECT count(*) FROM public.advanced_expedition_inflight WHERE expedition_id=eid)+(SELECT count(*) FROM public.advanced_expedition_returns WHERE expedition_id=eid)<>1 THEN RAISE EXCEPTION 'ADVANCED_STATE';END IF;
 IF (SELECT count(*) FROM public.advanced_expedition_supplies WHERE expedition_id=eid)<>jsonb_array_length(trip.route_snapshot->'supplies') THEN RAISE EXCEPTION 'ADVANCED_SUPPLIES_INCOMPLETE';END IF;
 SELECT id INTO rid FROM public.advanced_expedition_returns WHERE expedition_id=eid;
 IF rid IS NOT NULL AND ((SELECT count(*) FROM public.advanced_expedition_entries WHERE return_id=rid)<>3
 OR NOT EXISTS(SELECT 1 FROM public.advanced_expedition_entries WHERE return_id=rid AND bucket='issued' AND delta=-trip.gross)
 OR NOT EXISTS(SELECT 1 FROM public.advanced_expedition_entries WHERE return_id=rid AND bucket='base_stock' AND delta=trip.net)
 OR NOT EXISTS(SELECT 1 FROM public.advanced_expedition_entries WHERE return_id=rid AND bucket='island_pool' AND delta=trip.tax)) THEN RAISE EXCEPTION 'ADVANCED_ENTRIES_INCOMPLETE';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_advanced_expedition_guard(),public.shardkeep_advanced_expedition_complete() FROM PUBLIC;
DO $migration$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['advanced_expeditions','advanced_expedition_inflight','advanced_expedition_returns','advanced_expedition_entries','advanced_expedition_supplies'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_guard') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_advanced_expedition_guard()',t||'_guard',t);
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_advanced_expedition_guard()',t||'_no_truncate',t);
   EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR DELETE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_advanced_expedition_complete()',t||'_complete',t);
  END IF;EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
 END LOOP;
END $migration$;
