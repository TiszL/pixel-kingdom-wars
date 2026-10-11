-- D-153.124 S5 HELD: additive guards on existing starter/build provenance.
-- No old rows/functions rewritten, no backfill/grants or live activation.
SET LOCAL lock_timeout='10s';
CREATE OR REPLACE FUNCTION public.shardkeep_vehicle_starter_exclusion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID<>'public.fleet_installations'::regclass OR TG_NAME<>'vehicle_starter_exclusion' OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'VEHICLE_TRIGGER_IDENTITY';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'VEHICLE_READ_COMMITTED_REQUIRED';END IF;
 -- Same base/berth mutex as both registries; invoker need not read private rows.
 PERFORM 1 FROM public.bases WHERE id=NEW.base_id FOR UPDATE;
 PERFORM 1 FROM public.buildings WHERE id=NEW.berth_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.vehicle_activation_reservations WHERE berth_id=NEW.berth_id) THEN RAISE EXCEPTION 'VEHICLE_BERTH_OCCUPIED';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_vehicle_provenance_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID NOT IN ('public.buildings'::regclass,'public.builder_jobs'::regclass)
 OR TG_NAME<>('vehicle_provenance_'||TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_truncate' ELSE '' END)
 OR TG_WHEN<>'BEFORE' OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'VEHICLE_TRIGGER_IDENTITY';END IF;
 -- A stale snapshot can miss a reservation whose source rows were only locked.
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'VEHICLE_READ_COMMITTED_REQUIRED';END IF;
 IF TG_OP='TRUNCATE' THEN
  IF EXISTS(SELECT 1 FROM public.vehicle_activation_reservations) THEN RAISE EXCEPTION 'VEHICLE_PROVENANCE_RESERVED';END IF;RETURN NULL;
 END IF;
 IF TG_TABLE_NAME='buildings' THEN
  IF EXISTS(SELECT 1 FROM public.vehicle_activation_reservations WHERE berth_id=OLD.id) AND
   (TG_OP='DELETE' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.base_id IS DISTINCT FROM OLD.base_id OR NEW.type IS DISTINCT FROM OLD.type OR NEW.level<1 OR NEW.player_wallet IS DISTINCT FROM OLD.player_wallet)
  THEN RAISE EXCEPTION 'VEHICLE_PROVENANCE_RESERVED';END IF;
 ELSE
  IF TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM public.vehicle_activation_reservations WHERE completed_build_job_id=OLD.id) AND
   (TG_OP='DELETE' OR ROW(NEW.id,NEW.base_id,NEW.building_id,NEW.player_wallet,NEW.kind,NEW.started_at,NEW.finishes_at,NEW.completed_at,NEW.cancelled_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.base_id,OLD.building_id,OLD.player_wallet,OLD.kind,OLD.started_at,OLD.finishes_at,OLD.completed_at,OLD.cancelled_at))
  THEN RAISE EXCEPTION 'VEHICLE_PROVENANCE_RESERVED';END IF;
  IF TG_OP<>'DELETE' AND NEW.kind='build' AND (TG_OP='INSERT' OR NEW.building_id IS DISTINCT FROM OLD.building_id OR NEW.kind IS DISTINCT FROM OLD.kind) THEN
   -- Prevent a new unfinished build racing a reservation's positive proof.
   PERFORM 1 FROM public.buildings WHERE id=NEW.building_id FOR UPDATE NOWAIT;
   IF EXISTS(SELECT 1 FROM public.vehicle_activation_reservations WHERE berth_id=NEW.building_id) THEN RAISE EXCEPTION 'VEHICLE_PROVENANCE_RESERVED';END IF;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_vehicle_starter_exclusion(),public.shardkeep_vehicle_provenance_guard() FROM PUBLIC;
DO $migration$ DECLARE t text;BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.fleet_installations'::regclass AND tgname='vehicle_starter_exclusion') THEN
 CREATE TRIGGER vehicle_starter_exclusion BEFORE INSERT ON public.fleet_installations FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_starter_exclusion();END IF;
 FOREACH t IN ARRAY ARRAY['buildings','builder_jobs'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname='vehicle_provenance_'||t) THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE %s ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_provenance_guard()','vehicle_provenance_'||t,CASE WHEN t='buildings' THEN 'UPDATE OR DELETE' ELSE 'INSERT OR UPDATE OR DELETE' END,t);
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_vehicle_provenance_guard()','vehicle_provenance_'||t||'_truncate',t);
  END IF;
 END LOOP;
END $migration$;
