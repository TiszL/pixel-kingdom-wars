-- D-153.127 initial installation only. Private owner writer supplies independently
-- checked finalized burn evidence; SQL enforces consistency, not RPC authenticity.
-- Registry mint admission remains owner-attested. No release, upgrades or use events.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS vehicle_burn_consumptions (
 asset_id text PRIMARY KEY REFERENCES vehicle_mint_registry(asset_id),
 reservation_id uuid NOT NULL UNIQUE REFERENCES vehicle_burn_preparations(reservation_id),
 wallet text NOT NULL,signature text NOT NULL UNIQUE CHECK(signature~'^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
 signed_transaction_sha256 text NOT NULL UNIQUE CHECK(signed_transaction_sha256~'^[0-9a-f]{64}$'),
 original_message_sha256 text NOT NULL CHECK(original_message_sha256~'^[0-9a-f]{64}$'),
 slot bigint NOT NULL CHECK(slot BETWEEN 0 AND 9007199254740991),
 proof jsonb NOT NULL CHECK(jsonb_typeof(proof)='object' AND octet_length(proof::text)<=1048576),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at))
);
CREATE TABLE IF NOT EXISTS advanced_vehicle_installations (
 reservation_id uuid PRIMARY KEY REFERENCES vehicle_burn_consumptions(reservation_id),
 asset_id text NOT NULL UNIQUE REFERENCES vehicle_burn_consumptions(asset_id),
 base_id uuid NOT NULL REFERENCES bases(id),berth_id uuid NOT NULL UNIQUE REFERENCES buildings(id),
 family text NOT NULL,tier integer NOT NULL,installed_wallet text NOT NULL,
 completed_build_job_id uuid NOT NULL REFERENCES builder_jobs(id),berth_completed_at timestamptz NOT NULL,
 installed_at timestamptz NOT NULL CHECK(isfinite(installed_at)),UNIQUE(base_id,family)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_vehicle_installation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r public.vehicle_activation_reservations%ROWTYPE;p public.vehicle_burn_preparations%ROWTYPE;c public.vehicle_burn_consumptions%ROWTYPE;
 berth public.buildings%ROWTYPE;j public.builder_jobs%ROWTYPE;proof jsonb;
BEGIN
 IF TG_RELID NOT IN ('public.vehicle_burn_consumptions'::regclass,'public.advanced_vehicle_installations'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END)
 OR TG_WHEN<>'BEFORE' OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'VEHICLE_INSTALLATION_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'VEHICLE_INSTALLATION_IMMUTABLE';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'VEHICLE_INSTALLATION_OWNER' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'VEHICLE_INSTALLATION_READ_COMMITTED';END IF;
 SELECT * INTO STRICT r FROM public.vehicle_activation_reservations WHERE id=NEW.reservation_id FOR UPDATE;
 SELECT * INTO STRICT p FROM public.vehicle_burn_preparations WHERE reservation_id=r.id FOR UPDATE;
 -- Current custody may differ: the committed original destination is permanent.
 -- NOWAIT avoids introducing a reverse wait against gameplay holding these rows.
 PERFORM 1 FROM public.bases WHERE id=r.base_id FOR KEY SHARE NOWAIT;
 SELECT * INTO STRICT berth FROM public.buildings WHERE id=r.berth_id FOR UPDATE NOWAIT;
 SELECT * INTO STRICT j FROM public.builder_jobs WHERE id=r.completed_build_job_id FOR UPDATE NOWAIT;
 IF berth.base_id IS DISTINCT FROM r.base_id OR berth.type<>'berth' OR berth.level<1 OR j.base_id IS DISTINCT FROM r.base_id OR j.building_id IS DISTINCT FROM r.berth_id
 OR j.kind<>'build' OR j.completed_at IS DISTINCT FROM r.berth_completed_at OR j.cancelled_at IS NOT NULL
 OR EXISTS(SELECT 1 FROM public.fleet_installations WHERE berth_id=r.berth_id) THEN RAISE EXCEPTION 'VEHICLE_INSTALLATION_DESTINATION';END IF;
 IF TG_TABLE_NAME='vehicle_burn_consumptions' THEN
  IF NEW.asset_id IS NOT NULL OR NEW.wallet IS NOT NULL OR NEW.signature IS NOT NULL OR NEW.signed_transaction_sha256 IS NOT NULL OR NEW.original_message_sha256 IS NOT NULL OR NEW.slot IS NOT NULL OR NEW.recorded_at IS NOT NULL THEN RAISE EXCEPTION 'VEHICLE_INSTALLATION_DERIVED';END IF;
  proof:=NEW.proof;
  IF jsonb_typeof(proof) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(proof))<>21
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(proof) k WHERE k<>ALL(ARRAY['version','reservationId','wallet','identity','signature','slot','blockTime','originalMessageSha256','signedTransactionSha256','feeLamports','assetRefundLamports','transactionEvidenceVerified','finalityVerified','preBurnOwnershipVerified','registryMembershipVerified','installationAuthorized','preBurnOwner','finalizedThroughSlot','anchorSlot','history','source']))
  OR proof->'version' IS DISTINCT FROM '1'::jsonb OR proof->'reservationId' IS DISTINCT FROM to_jsonb(r.id::text) OR proof->'wallet' IS DISTINCT FROM to_jsonb(r.wallet)
  OR proof->'identity' IS DISTINCT FROM p.plan->'identity' OR proof->'preBurnOwner' IS DISTINCT FROM to_jsonb(r.wallet)
  OR proof->'originalMessageSha256' IS DISTINCT FROM to_jsonb(p.message_sha256)
  OR (proof->>'signedTransactionSha256'~'^[0-9a-f]{64}$') IS DISTINCT FROM true OR (proof->>'signature'~'^[1-9A-HJ-NP-Za-km-z]{64,88}$') IS DISTINCT FROM true
  OR proof->'transactionEvidenceVerified' IS DISTINCT FROM 'true'::jsonb OR proof->'finalityVerified' IS DISTINCT FROM 'true'::jsonb OR proof->'preBurnOwnershipVerified' IS DISTINCT FROM 'true'::jsonb
  OR proof->'registryMembershipVerified' IS DISTINCT FROM 'false'::jsonb OR proof->'installationAuthorized' IS DISTINCT FROM 'false'::jsonb
  OR proof->'anchorSlot' IS DISTINCT FROM p.owner_anchor->'slot'
  OR proof#>'{source,genesisHash}' IS DISTINCT FROM p.owner_anchor->'genesisHash'
  OR proof#>'{source,reviewedDeploymentSlot}' IS DISTINCT FROM p.owner_anchor->'reviewedDeploymentSlot'
  OR proof#>'{source,reviewedProgramDataSha256}' IS DISTINCT FROM p.owner_anchor->'reviewedProgramDataSha256'
  OR proof#>>'{source,addressIndexCompleteness}' IS DISTINCT FROM 'configured-provider-trust' OR proof#>>'{source,savedAnchorAuthority}' IS DISTINCT FROM 'private-application-reservation'
  OR jsonb_typeof(proof->'history') IS DISTINCT FROM 'array' OR jsonb_array_length(proof->'history')>2000
  OR jsonb_typeof(proof->'slot') IS DISTINCT FROM 'number' OR (proof->>'slot'~'^(0|[1-9][0-9]*)$') IS DISTINCT FROM true
  OR jsonb_typeof(proof->'finalizedThroughSlot') IS DISTINCT FROM 'number' OR (proof->>'finalizedThroughSlot'~'^(0|[1-9][0-9]*)$') IS DISTINCT FROM true
  THEN RAISE EXCEPTION 'VEHICLE_INSTALLATION_SOURCE';END IF;
  IF (proof->>'slot')::numeric<=(proof->>'anchorSlot')::numeric OR (proof->>'finalizedThroughSlot')::numeric<(proof->>'slot')::numeric OR (proof->>'finalizedThroughSlot')::numeric>9007199254740991 THEN RAISE EXCEPTION 'VEHICLE_INSTALLATION_SOURCE';END IF;
  NEW.asset_id:=r.asset_id;NEW.wallet:=r.wallet;NEW.signature:=proof->>'signature';NEW.signed_transaction_sha256:=proof->>'signedTransactionSha256';NEW.original_message_sha256:=p.message_sha256;NEW.slot:=(proof->>'slot')::bigint;NEW.recorded_at:=clock_timestamp();
 ELSE
  IF NEW.asset_id IS NOT NULL OR NEW.base_id IS NOT NULL OR NEW.berth_id IS NOT NULL OR NEW.family IS NOT NULL OR NEW.tier IS NOT NULL OR NEW.installed_wallet IS NOT NULL OR NEW.completed_build_job_id IS NOT NULL OR NEW.berth_completed_at IS NOT NULL OR NEW.installed_at IS NOT NULL THEN RAISE EXCEPTION 'VEHICLE_INSTALLATION_DERIVED';END IF;
  SELECT * INTO STRICT c FROM public.vehicle_burn_consumptions WHERE reservation_id=r.id;
  IF c.asset_id<>r.asset_id OR c.wallet<>r.wallet THEN RAISE EXCEPTION 'VEHICLE_INSTALLATION_SOURCE';END IF;
  NEW.asset_id:=r.asset_id;NEW.base_id:=r.base_id;NEW.berth_id:=r.berth_id;NEW.family:=r.family;NEW.tier:=r.tier;NEW.installed_wallet:=r.wallet;NEW.completed_build_job_id:=r.completed_build_job_id;NEW.berth_completed_at:=r.berth_completed_at;NEW.installed_at:=clock_timestamp();
 END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_vehicle_installation_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID NOT IN ('public.vehicle_burn_consumptions'::regclass,'public.advanced_vehicle_installations'::regclass) OR TG_NAME<>TG_TABLE_NAME||'_complete' OR TG_OP<>'INSERT' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'VEHICLE_INSTALLATION_TRIGGER';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.vehicle_burn_consumptions c JOIN public.advanced_vehicle_installations i USING(reservation_id) WHERE c.reservation_id=NEW.reservation_id AND c.asset_id=i.asset_id AND c.wallet=i.installed_wallet) THEN RAISE EXCEPTION 'VEHICLE_INSTALLATION_INCOMPLETE';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_vehicle_installation_guard(),public.shardkeep_vehicle_installation_complete() FROM PUBLIC;
DO $migration$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['vehicle_burn_consumptions','advanced_vehicle_installations'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_guard') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_installation_guard()',t||'_guard',t);
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_vehicle_installation_guard()',t||'_no_truncate',t);
   EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_installation_complete()',t||'_complete',t);
  END IF;
 END LOOP;
END $migration$;
REVOKE ALL ON vehicle_burn_consumptions,advanced_vehicle_installations FROM PUBLIC;
