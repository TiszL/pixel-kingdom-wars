-- D-153.140 private immutable service consent journal. Original intent rights
-- survive base transfer; this binds original state, never current base custody.
-- SQL does NOT authenticate RPC JSON, mint provenance, burns or signatures.
-- No service consumption, applied transition, release or public grants.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS vehicle_service_burn_preparations (
 intent_id uuid PRIMARY KEY REFERENCES vehicle_service_intents(id) ON DELETE RESTRICT,
 wallet text NOT NULL,plan jsonb NOT NULL,owner_anchor jsonb NOT NULL,
 message_bytes bytea NOT NULL CHECK(octet_length(message_bytes) BETWEEN 1 AND 1167), -- Solana packet less one signature envelope
 message_sha256 text NOT NULL CHECK(message_sha256~'^[0-9a-f]{64}$'),
 blockhash_context_slot bigint NOT NULL CHECK(blockhash_context_slot BETWEEN 0 AND 9007199254740991),
 last_valid_block_height bigint NOT NULL CHECK(last_valid_block_height BETWEEN 0 AND 9007199254740991),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at))
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_vehicle_service_preparation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r public.vehicle_service_intents%ROWTYPE;i public.advanced_vehicle_installations%ROWTYPE;
 m public.vehicle_mint_registry%ROWTYPE;identity jsonb;state jsonb;a jsonb;n bigint;
BEGIN
 IF TG_RELID<>'public.vehicle_service_burn_preparations'::regclass OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'vehicle_service_burn_preparations_no_truncate' ELSE 'vehicle_service_burn_preparations_guard' END)
 OR TG_WHEN<>'BEFORE' OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'VEHICLE_SERVICE_PREPARATION_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'VEHICLE_SERVICE_PREPARATION_IMMUTABLE';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'VEHICLE_SERVICE_PREPARATION_OWNER' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'VEHICLE_SERVICE_PREPARATION_READ_COMMITTED';END IF;
 IF NEW.wallet IS NOT NULL OR NEW.message_sha256 IS NOT NULL OR NEW.recorded_at IS NOT NULL THEN RAISE EXCEPTION 'VEHICLE_SERVICE_PREPARATION_DERIVED';END IF;
 -- Discover immutable parent, then serialize in installation -> intent order.
 SELECT * INTO STRICT r FROM public.vehicle_service_intents WHERE id=NEW.intent_id;
 SELECT * INTO STRICT i FROM public.advanced_vehicle_installations WHERE reservation_id=r.installation_id FOR UPDATE;
 SELECT * INTO STRICT r FROM public.vehicle_service_intents WHERE id=NEW.intent_id FOR UPDATE;
 SELECT count(*) INTO n FROM public.advanced_expedition_returns ret JOIN public.advanced_expeditions e ON e.id=ret.expedition_id WHERE e.installation_id=i.reservation_id;
 IF r.base_id IS DISTINCT FROM i.base_id OR r.berth_id IS DISTINCT FROM i.berth_id OR r.family IS DISTINCT FROM i.family OR r.tier IS DISTINCT FROM i.tier
 OR r.revision<>0 OR r.allowance_start<>0 OR r.completed_total<>n OR r.asset_id=i.asset_id
 OR EXISTS(SELECT 1 FROM public.vehicle_activation_reservations WHERE asset_id=r.asset_id)
 OR EXISTS(SELECT 1 FROM public.advanced_expedition_inflight WHERE installation_id=i.reservation_id)
 OR EXISTS(SELECT 1 FROM public.advanced_expeditions e WHERE e.installation_id=i.reservation_id AND NOT EXISTS(SELECT 1 FROM public.advanced_expedition_returns ret WHERE ret.expedition_id=e.id))
 THEN RAISE EXCEPTION 'VEHICLE_SERVICE_PREPARATION_STATE';END IF;
 SELECT * INTO STRICT m FROM public.vehicle_mint_registry WHERE asset_id=r.asset_id;
 IF m.family IS DISTINCT FROM r.family OR m.tier IS DISTINCT FROM r.tier THEN RAISE EXCEPTION 'VEHICLE_SERVICE_PREPARATION_SOURCE';END IF;
 state:=jsonb_build_object('operation',r.operation,'installationId',r.installation_id::text,'baseId',r.base_id::text,'berthId',r.berth_id::text,'revision',r.revision,'family',r.family,'tier',r.tier,'completedTotal',r.completed_total::text,'allowanceStart',r.allowance_start::text);
 identity:=jsonb_build_object('assetId',r.asset_id,'collection',m.collection,'family',r.family,'tier',r.tier);a:=NEW.owner_anchor;
 IF jsonb_typeof(NEW.plan) IS DISTINCT FROM 'object' OR octet_length(NEW.plan::text)>4096 OR jsonb_typeof(a) IS DISTINCT FROM 'object' OR octet_length(a::text)>266240 THEN RAISE EXCEPTION 'VEHICLE_SERVICE_PREPARATION_SOURCE';END IF;
 IF NEW.plan IS DISTINCT FROM jsonb_build_object('wallet',r.wallet,'reservationId',r.id::text,'identity',identity,'blockhash',NEW.plan->>'blockhash','service',state)
 OR (NEW.plan->>'blockhash'~'^[1-9A-HJ-NP-Za-km-z]{32,44}$') IS DISTINCT FROM true
 OR (SELECT count(*) FROM jsonb_object_keys(a))<>9
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(a) k WHERE k<>ALL(ARRAY['version','wallet','identity','slot','genesisHash','reviewedDeploymentSlot','reviewedProgramDataSha256','assetDataHex','collectionDataHex']))
 OR a->'version' IS DISTINCT FROM '1'::jsonb OR a->>'wallet' IS DISTINCT FROM r.wallet OR a->'identity' IS DISTINCT FROM identity
 OR jsonb_typeof(a->'slot') IS DISTINCT FROM 'number' OR (a->>'slot'~'^(0|[1-9][0-9]*)$') IS DISTINCT FROM true
 OR jsonb_typeof(a->'reviewedDeploymentSlot') IS DISTINCT FROM 'number' OR (a->>'reviewedDeploymentSlot'~'^(0|[1-9][0-9]*)$') IS DISTINCT FROM true
 OR (a->>'genesisHash'~'^[1-9A-HJ-NP-Za-km-z]{32,44}$') IS DISTINCT FROM true
 OR (a->>'reviewedProgramDataSha256'~'^[0-9a-f]{64}$') IS DISTINCT FROM true
 OR (a->>'assetDataHex'~'^([0-9a-f]{2})+$') IS DISTINCT FROM true OR length(a->>'assetDataHex')>131072
 OR (a->>'collectionDataHex'~'^([0-9a-f]{2})+$') IS DISTINCT FROM true OR length(a->>'collectionDataHex')>131072
 THEN RAISE EXCEPTION 'VEHICLE_SERVICE_PREPARATION_SOURCE';END IF;
 IF (a->>'slot')::numeric>NEW.blockhash_context_slot OR (a->>'reviewedDeploymentSlot')::numeric>(a->>'slot')::numeric OR (a->>'slot')::numeric>9007199254740991 THEN RAISE EXCEPTION 'VEHICLE_SERVICE_PREPARATION_SOURCE';END IF;
 NEW.wallet:=r.wallet;NEW.message_sha256:=encode(sha256(NEW.message_bytes),'hex');NEW.recorded_at:=clock_timestamp();RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_vehicle_service_preparation_guard() FROM PUBLIC;
DO $migration$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.vehicle_service_burn_preparations'::regclass AND tgname='vehicle_service_burn_preparations_guard') THEN
 CREATE TRIGGER vehicle_service_burn_preparations_guard BEFORE INSERT OR UPDATE OR DELETE ON public.vehicle_service_burn_preparations FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_service_preparation_guard();
 CREATE TRIGGER vehicle_service_burn_preparations_no_truncate BEFORE TRUNCATE ON public.vehicle_service_burn_preparations FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_vehicle_service_preparation_guard();END IF;
END $migration$;
REVOKE ALL ON vehicle_service_burn_preparations FROM PUBLIC;
