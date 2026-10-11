-- D-153.137 S5 HELD: private permanent service intent, never a burn or applied
-- service. The owner application verifies Core/base authority and locked shared
-- transition rules. SQL binds original state; registry mint identity is attested.
-- Initial receipts remain authoritative without backfill. Global signature/hash
-- exclusion must join BOTH consumption writers before service consumption exists.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS vehicle_service_intents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),wallet text NOT NULL REFERENCES players(wallet),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 installation_id uuid NOT NULL REFERENCES advanced_vehicle_installations(reservation_id),
 asset_id text NOT NULL UNIQUE REFERENCES vehicle_mint_registry(asset_id),
 operation text NOT NULL CHECK(operation IN ('upgrade','restore_uses')),
 base_id uuid NOT NULL REFERENCES bases(id),berth_id uuid NOT NULL REFERENCES buildings(id),
 family text NOT NULL,tier integer NOT NULL,revision integer NOT NULL CHECK(revision=0),
 completed_total bigint NOT NULL CHECK(completed_total>=0),allowance_start bigint NOT NULL CHECK(allowance_start=0),
 reserved_at timestamptz NOT NULL CHECK(isfinite(reserved_at)),
 UNIQUE(wallet,idempotency_key),UNIQUE(installation_id,revision)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_vehicle_service_intent_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i public.advanced_vehicle_installations%ROWTYPE;m public.vehicle_mint_registry%ROWTYPE;b public.bases%ROWTYPE;n bigint;
BEGIN
 IF TG_RELID<>'public.vehicle_service_intents'::regclass OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END)
 OR TG_WHEN<>'BEFORE' OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'VEHICLE_SERVICE_TRIGGER';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'VEHICLE_SERVICE_OWNER' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'VEHICLE_SERVICE_READ_COMMITTED';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'VEHICLE_SERVICE_IMMUTABLE';END IF;
 IF NEW.base_id IS NOT NULL OR NEW.berth_id IS NOT NULL OR NEW.family IS NOT NULL OR NEW.tier IS NOT NULL OR NEW.revision IS NOT NULL OR NEW.completed_total IS NOT NULL OR NEW.allowance_start IS NOT NULL OR NEW.reserved_at IS NOT NULL THEN RAISE EXCEPTION 'VEHICLE_SERVICE_DERIVED';END IF;
 PERFORM 1 FROM public.players WHERE wallet=NEW.wallet FOR UPDATE NOWAIT;
 SELECT * INTO STRICT i FROM public.advanced_vehicle_installations WHERE reservation_id=NEW.installation_id;
 SELECT * INTO STRICT b FROM public.bases WHERE id=i.base_id FOR UPDATE NOWAIT;
 IF b.owner_wallet<>NEW.wallet OR b.status<>'active' OR NOT EXISTS(SELECT 1 FROM public.base_slots WHERE base_id=b.id AND wallet=NEW.wallet AND active) THEN RAISE EXCEPTION 'VEHICLE_SERVICE_BASE';END IF;
 PERFORM 1 FROM public.base_slots WHERE base_id=b.id AND wallet=NEW.wallet AND active FOR UPDATE NOWAIT;
 IF EXISTS(SELECT 1 FROM public.base_raid_locks WHERE base_id=b.id) THEN RAISE EXCEPTION 'VEHICLE_SERVICE_BASE';END IF;
 SELECT * INTO STRICT i FROM public.advanced_vehicle_installations WHERE reservation_id=NEW.installation_id FOR UPDATE NOWAIT;
 SELECT * INTO STRICT m FROM public.vehicle_mint_registry WHERE asset_id=NEW.asset_id FOR UPDATE NOWAIT;
 IF m.family<>i.family OR m.tier<>i.tier THEN RAISE EXCEPTION 'VEHICLE_SERVICE_IDENTITY';END IF;
 IF EXISTS(SELECT 1 FROM public.vehicle_activation_reservations WHERE asset_id=m.asset_id)
 OR EXISTS(SELECT 1 FROM public.vehicle_service_intents WHERE asset_id=m.asset_id OR installation_id=i.reservation_id) THEN RAISE EXCEPTION 'VEHICLE_SERVICE_RESERVED';END IF;
 -- Header-first raw SQL must not hide an obligation by delaying its flight row.
 IF EXISTS(SELECT 1 FROM public.advanced_expedition_inflight WHERE installation_id=i.reservation_id)
 OR EXISTS(SELECT 1 FROM public.advanced_expeditions e WHERE e.installation_id=i.reservation_id AND NOT EXISTS(SELECT 1 FROM public.advanced_expedition_returns r WHERE r.expedition_id=e.id)) THEN RAISE EXCEPTION 'VEHICLE_SERVICE_AWAY';END IF;
 SELECT count(*) INTO n FROM public.advanced_expedition_returns r JOIN public.advanced_expeditions e ON e.id=r.expedition_id WHERE e.installation_id=i.reservation_id;
 NEW.base_id:=i.base_id;NEW.berth_id:=i.berth_id;NEW.family:=i.family;NEW.tier:=i.tier;NEW.revision:=0;NEW.completed_total:=n;NEW.allowance_start:=0;NEW.reserved_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_vehicle_initial_service_exclusion() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID<>'public.vehicle_activation_reservations'::regclass OR TG_NAME<>'vehicle_activation_asset_service_exclusion' OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'VEHICLE_SERVICE_TRIGGER';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'VEHICLE_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'VEHICLE_READ_COMMITTED_REQUIRED';END IF;
 -- This runs before0204's guard; its remaining reverse provenance waits are NOWAIT.
 PERFORM 1 FROM public.vehicle_mint_registry WHERE asset_id=NEW.asset_id FOR UPDATE NOWAIT;
 IF EXISTS(SELECT 1 FROM public.vehicle_service_intents WHERE asset_id=NEW.asset_id) THEN RAISE EXCEPTION 'VEHICLE_SERVICE_RESERVED';END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_vehicle_service_departure_exclusion() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID<>'public.advanced_expeditions'::regclass OR TG_NAME<>'advanced_vehicle_service_exclusion' OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'VEHICLE_SERVICE_TRIGGER';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'VEHICLE_SERVICE_OWNER' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'VEHICLE_SERVICE_READ_COMMITTED';END IF;
 PERFORM 1 FROM public.advanced_vehicle_installations WHERE reservation_id=NEW.installation_id FOR UPDATE NOWAIT;
 -- No service completion writer exists yet. Every captured intent remains held.
 IF EXISTS(SELECT 1 FROM public.vehicle_service_intents WHERE installation_id=NEW.installation_id) THEN RAISE EXCEPTION 'VEHICLE_SERVICE_RESERVED';END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_vehicle_service_intent_guard(),public.shardkeep_vehicle_initial_service_exclusion(),public.shardkeep_vehicle_service_departure_exclusion() FROM PUBLIC;
DO $migration$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.vehicle_service_intents'::regclass AND tgname='vehicle_service_intents_guard') THEN
 CREATE TRIGGER vehicle_service_intents_guard BEFORE INSERT OR UPDATE OR DELETE ON public.vehicle_service_intents FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_service_intent_guard();
 CREATE TRIGGER vehicle_service_intents_no_truncate BEFORE TRUNCATE ON public.vehicle_service_intents FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_vehicle_service_intent_guard();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.vehicle_activation_reservations'::regclass AND tgname='vehicle_activation_asset_service_exclusion') THEN
 CREATE TRIGGER vehicle_activation_asset_service_exclusion BEFORE INSERT ON public.vehicle_activation_reservations FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_initial_service_exclusion();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.advanced_expeditions'::regclass AND tgname='advanced_vehicle_service_exclusion') THEN
 CREATE TRIGGER advanced_vehicle_service_exclusion BEFORE INSERT ON public.advanced_expeditions FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_service_departure_exclusion();END IF;
END $migration$;
REVOKE ALL ON vehicle_service_intents FROM PUBLIC;
