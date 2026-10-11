-- D-153.124 private DARK foundation. Owner attestation is not independently
-- verified mint evidence. No burn, message, installation, release or HTTP authority.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS vehicle_mint_registry (
 asset_id text PRIMARY KEY CHECK(asset_id~'^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
 collection text NOT NULL CHECK(collection~'^[1-9A-HJ-NP-Za-km-z]{32,44}$' AND collection<>asset_id),
 family text NOT NULL CHECK(family IN ('survey_balloon','cargo_cutter','courier_airship','expedition_barge')),
 tier integer NOT NULL CHECK(tier BETWEEN 1 AND 4), -- D-153.123; PHASE_E_VEHICLES.tiers
 owner_attestation jsonb NOT NULL CHECK(jsonb_typeof(owner_attestation)='object' AND octet_length(owner_attestation::text)<=65536),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at))
);
CREATE TABLE IF NOT EXISTS vehicle_activation_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),wallet text NOT NULL REFERENCES players(wallet),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 asset_id text NOT NULL UNIQUE REFERENCES vehicle_mint_registry(asset_id),
 base_id uuid NOT NULL REFERENCES bases(id) ON DELETE RESTRICT,
 berth_id uuid NOT NULL UNIQUE REFERENCES buildings(id) ON DELETE RESTRICT,
 family text NOT NULL,tier integer NOT NULL,
 completed_build_job_id uuid NOT NULL REFERENCES builder_jobs(id) ON DELETE RESTRICT,
 berth_completed_at timestamptz NOT NULL CHECK(isfinite(berth_completed_at)),
 reserved_at timestamptz NOT NULL CHECK(isfinite(reserved_at)),
 UNIQUE(wallet,idempotency_key),UNIQUE(base_id,family)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_vehicle_private_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE m public.vehicle_mint_registry%ROWTYPE;b public.bases%ROWTYPE;berth public.buildings%ROWTYPE;j public.builder_jobs%ROWTYPE;
BEGIN
 IF TG_RELID NOT IN ('public.vehicle_mint_registry'::regclass,'public.vehicle_activation_reservations'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END)
 OR TG_WHEN<>'BEFORE' OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'VEHICLE_TRIGGER_IDENTITY';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'VEHICLE_IMMUTABLE';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'VEHICLE_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'VEHICLE_READ_COMMITTED_REQUIRED';END IF;
 IF TG_TABLE_NAME='vehicle_mint_registry' THEN
  IF NEW.recorded_at IS NOT NULL THEN RAISE EXCEPTION 'VEHICLE_DERIVED_FIELDS';END IF;
  NEW.recorded_at:=clock_timestamp();RETURN NEW;
 END IF;
 IF NEW.family IS NOT NULL OR NEW.tier IS NOT NULL OR NEW.completed_build_job_id IS NOT NULL OR NEW.berth_completed_at IS NOT NULL OR NEW.reserved_at IS NOT NULL THEN RAISE EXCEPTION 'VEHICLE_DERIVED_FIELDS';END IF;
 SELECT * INTO m FROM public.vehicle_mint_registry WHERE asset_id=NEW.asset_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'VEHICLE_UNREGISTERED';END IF;
 PERFORM 1 FROM public.players WHERE wallet=NEW.wallet FOR UPDATE NOWAIT;
 SELECT * INTO b FROM public.bases WHERE id=NEW.base_id FOR UPDATE NOWAIT;
 IF NOT FOUND OR b.owner_wallet<>NEW.wallet OR b.status<>'active' OR NOT EXISTS(SELECT 1 FROM public.base_slots WHERE base_id=b.id AND wallet=NEW.wallet AND active) THEN RAISE EXCEPTION 'VEHICLE_BASE_UNAVAILABLE';END IF;
 PERFORM 1 FROM public.base_slots WHERE base_id=b.id AND wallet=NEW.wallet AND active FOR UPDATE NOWAIT;
 IF EXISTS(SELECT 1 FROM public.base_raid_locks WHERE base_id=b.id) THEN RAISE EXCEPTION 'VEHICLE_BASE_RAIDED';END IF;
 SELECT * INTO berth FROM public.buildings WHERE id=NEW.berth_id FOR UPDATE NOWAIT;
 IF NOT FOUND OR berth.base_id IS DISTINCT FROM b.id OR berth.type<>'berth' OR berth.level<1 THEN RAISE EXCEPTION 'VEHICLE_BERTH_UNAVAILABLE';END IF;
 SELECT * INTO j FROM public.builder_jobs WHERE building_id=berth.id AND base_id=b.id AND kind='build' AND completed_at IS NOT NULL AND cancelled_at IS NULL ORDER BY completed_at,id LIMIT 1 FOR UPDATE NOWAIT;
 IF NOT FOUND OR NOT isfinite(j.completed_at) OR EXISTS(SELECT 1 FROM public.builder_jobs WHERE building_id=berth.id AND kind='build' AND completed_at IS NULL) THEN RAISE EXCEPTION 'VEHICLE_BERTH_UNAVAILABLE';END IF;
 IF EXISTS(SELECT 1 FROM public.fleet_installations WHERE berth_id=berth.id) THEN RAISE EXCEPTION 'VEHICLE_BERTH_OCCUPIED';END IF;
 NEW.family:=m.family;NEW.tier:=m.tier;NEW.completed_build_job_id:=j.id;NEW.berth_completed_at:=j.completed_at;NEW.reserved_at:=clock_timestamp();RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_vehicle_private_guard() FROM PUBLIC;
DO $migration$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['vehicle_mint_registry','vehicle_activation_reservations'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_guard') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_private_guard()',t||'_guard',t);
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_vehicle_private_guard()',t||'_no_truncate',t);
  END IF;
 END LOOP;
END $migration$;
REVOKE ALL ON vehicle_mint_registry,vehicle_activation_reservations FROM PUBLIC;
