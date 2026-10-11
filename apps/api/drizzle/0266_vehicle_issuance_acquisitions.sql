-- D153.207: private local original issuance observations, never public admission.
-- Existing owner assertions remain explicit owner assertions, not mint evidence.
SET LOCAL lock_timeout='10s';
CREATE TABLE public.vehicle_issuance_originals (
 root_id text PRIMARY KEY CHECK(root_id~'^[0-9a-f]{32}$'),
 attempt_id text NOT NULL UNIQUE CHECK(attempt_id~'^[0-9a-f]{32}$'),
 permit_id text NOT NULL UNIQUE CHECK(permit_id~'^[0-9a-f]{32}$'),
 asset_id text NOT NULL UNIQUE, buyer text NOT NULL,
 original jsonb NOT NULL CHECK(jsonb_typeof(original)='object' AND octet_length(original::text)<=65536),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at))
);
CREATE TABLE public.vehicle_issuance_acquisitions (
 root_id text PRIMARY KEY REFERENCES public.vehicle_issuance_originals(root_id),
 asset_id text NOT NULL UNIQUE, collection text NOT NULL, buyer text NOT NULL,
 family text NOT NULL CHECK(family IN('survey_balloon','cargo_cutter','courier_airship','expedition_barge')),
 tier integer NOT NULL CHECK(tier BETWEEN 1 AND 4),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=65536),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at))
);
ALTER TABLE public.vehicle_mint_registry ALTER COLUMN owner_attestation DROP NOT NULL;
ALTER TABLE public.vehicle_mint_registry ADD COLUMN provenance text NOT NULL DEFAULT 'owner_attestation';
ALTER TABLE public.vehicle_mint_registry ADD COLUMN issuance_root text REFERENCES public.vehicle_issuance_acquisitions(root_id);
ALTER TABLE public.vehicle_mint_registry ADD CONSTRAINT vehicle_registry_provenance CHECK(
 (provenance='owner_attestation' AND owner_attestation IS NOT NULL AND issuance_root IS NULL)
 OR(provenance='finalized_issuance' AND owner_attestation IS NULL AND issuance_root IS NOT NULL));
REVOKE ALL ON public.vehicle_issuance_originals,public.vehicle_issuance_acquisitions FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_vehicle_issuance_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o public.vehicle_issuance_originals%ROWTYPE;a public.vehicle_issuance_acquisitions%ROWTYPE;
BEGIN
 IF TG_RELID NOT IN('public.vehicle_issuance_originals'::regclass,'public.vehicle_issuance_acquisitions'::regclass,'public.vehicle_mint_registry'::regclass)
 OR TG_NAME<>TG_TABLE_NAME||'_issuance_guard' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'VEHICLE_ISSUANCE_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'VEHICLE_ISSUANCE_IMMUTABLE';END IF;
 IF current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 THEN RAISE EXCEPTION 'VEHICLE_ISSUANCE_OWNER' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'VEHICLE_ISSUANCE_READ_COMMITTED';END IF;
 IF TG_TABLE_NAME='vehicle_mint_registry' THEN
  IF NEW.provenance='finalized_issuance' THEN
   SELECT * INTO a FROM public.vehicle_issuance_acquisitions WHERE root_id=NEW.issuance_root;
   IF a.root_id IS NULL OR (NEW.asset_id,NEW.collection,NEW.family,NEW.tier) IS DISTINCT FROM(a.asset_id,a.collection,a.family,a.tier)
    OR NEW.owner_attestation IS NOT NULL THEN RAISE EXCEPTION 'VEHICLE_ISSUANCE_REGISTRY';END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.recorded_at IS NOT NULL THEN RAISE EXCEPTION 'VEHICLE_ISSUANCE_DERIVED';END IF;
 IF TG_TABLE_NAME='vehicle_issuance_originals' THEN
  IF NEW.original->>'attemptId' IS DISTINCT FROM NEW.attempt_id OR NEW.original->>'permitId' IS DISTINCT FROM NEW.permit_id
   OR NEW.original->>'rootId' IS DISTINCT FROM NEW.root_id OR NEW.original->>'buyer' IS DISTINCT FROM NEW.buyer
   OR NEW.original->'identity'->>'assetId' IS DISTINCT FROM NEW.asset_id
   OR NEW.original->>'version' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'VEHICLE_ISSUANCE_ORIGINAL';END IF;
 ELSE
  SELECT * INTO o FROM public.vehicle_issuance_originals WHERE root_id=NEW.root_id FOR UPDATE;
  IF o.root_id IS NULL OR NEW.asset_id IS DISTINCT FROM o.asset_id OR NEW.buyer IS DISTINCT FROM o.buyer
   OR (NEW.collection,NEW.family,NEW.tier::text) IS DISTINCT FROM(o.original->'identity'->>'collection',o.original->'identity'->>'family',o.original->'identity'->>'tier')
   OR NEW.evidence->>'rootId' IS DISTINCT FROM NEW.root_id OR NEW.evidence->>'buyer' IS DISTINCT FROM NEW.buyer
   OR NEW.evidence->'identity' IS DISTINCT FROM o.original->'identity'
   OR NEW.evidence->>'originalHash' IS DISTINCT FROM o.original->>'originalHash'
   OR NEW.evidence->>'version' IS DISTINCT FROM '1' OR NEW.evidence->>'finalizedMintObserved' IS DISTINCT FROM 'true'
   OR NEW.evidence->>'activationAuthorized' IS DISTINCT FROM 'false' OR NEW.evidence->>'reservationReleaseAuthorized' IS DISTINCT FROM 'false'
   OR NEW.evidence->>'paymentAuthorized' IS DISTINCT FROM 'false' OR NEW.evidence->>'transactionProofVerified' IS DISTINCT FROM 'false'
  THEN RAISE EXCEPTION 'VEHICLE_ISSUANCE_EVIDENCE';END IF;
 END IF;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE FUNCTION public.shardkeep_vehicle_issuance_no_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 RAISE EXCEPTION 'VEHICLE_ISSUANCE_IMMUTABLE';END $$;
REVOKE ALL ON FUNCTION public.shardkeep_vehicle_issuance_guard(),public.shardkeep_vehicle_issuance_no_truncate() FROM PUBLIC;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['vehicle_issuance_originals','vehicle_issuance_acquisitions','vehicle_mint_registry'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_issuance_guard()',t||'_issuance_guard',t);
  IF t<>'vehicle_mint_registry' THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_vehicle_issuance_no_truncate()',t||'_no_truncate',t);
  END IF;
 END LOOP;
END $$;
