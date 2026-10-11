-- D153.188 additive durable ordinary equipment. Frozen v1 recipe/effect below is
-- generated from PHASE_E_ORDINARY_EQUIPMENT and existing resource tax constants.
-- No currency/NFT/bound input, old nine-item ordinary inventory is unchanged.
SET LOCAL lock_timeout='10s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ordinary_equipment_stocks(
 base_id uuid NOT NULL REFERENCES bases(id),item_id text NOT NULL CHECK(item_id='route_compass'),
 available bigint NOT NULL DEFAULT 0,reserved bigint NOT NULL DEFAULT 0,pending_output bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(base_id,item_id),CHECK(available>=0 AND reserved>=0 AND pending_output>=0 AND available::numeric+reserved::numeric+pending_output::numeric<=9223372036854775807));
CREATE TABLE IF NOT EXISTS ordinary_equipment_jobs(
 id uuid PRIMARY KEY,actor_wallet text NOT NULL REFERENCES players(wallet),base_id uuid NOT NULL REFERENCES bases(id),recipe_snapshot jsonb NOT NULL,
 workshop_id uuid NOT NULL,workshop_completed_job_id uuid NOT NULL,started_at timestamptz NOT NULL,ready_at timestamptz NOT NULL,
 CHECK(isfinite(started_at) AND isfinite(ready_at) AND ready_at>started_at));
CREATE INDEX IF NOT EXISTS ordinary_equipment_jobs_due ON ordinary_equipment_jobs(base_id,ready_at,id);
CREATE TABLE IF NOT EXISTS ordinary_equipment_completions(job_id uuid PRIMARY KEY REFERENCES ordinary_equipment_jobs(id),custody_wallet text NOT NULL,completed_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS ordinary_equipment_reservations(trip_kind text NOT NULL CHECK(trip_kind IN('starter','advanced')),expedition_id uuid NOT NULL,
 base_id uuid NOT NULL REFERENCES bases(id),fitting_snapshot jsonb NOT NULL,PRIMARY KEY(trip_kind,expedition_id));
CREATE INDEX IF NOT EXISTS ordinary_equipment_reservations_base ON ordinary_equipment_reservations(base_id);
CREATE TABLE IF NOT EXISTS ordinary_equipment_releases(trip_kind text NOT NULL,expedition_id uuid NOT NULL,base_id uuid NOT NULL REFERENCES bases(id),return_id uuid NOT NULL,
 PRIMARY KEY(trip_kind,expedition_id),FOREIGN KEY(trip_kind,expedition_id) REFERENCES ordinary_equipment_reservations(trip_kind,expedition_id));
REVOKE ALL ON ordinary_equipment_stocks,ordinary_equipment_jobs,ordinary_equipment_completions,ordinary_equipment_reservations,ordinary_equipment_releases FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_equipment_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job public.ordinary_equipment_jobs%ROWTYPE;bid uuid;custody text;trip jsonb;terminal jsonb;r public.ordinary_equipment_reservations%ROWTYPE;
 recipe constant jsonb:='{"recipeVersion":1,"recipeId":"craft_route_compass","quantity":1,"durationSec":300,"inputs":[{"kind":"crafting","itemId":"prismstone_lens","quantity":"2"},{"kind":"crafting","itemId":"crownsteel","quantity":"2"}],"output":{"itemId":"route_compass","quantity":"1"}}';
 ingredient jsonb;n bigint;f jsonb;
BEGIN
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.ordinary_equipment_jobs'::regclass) THEN RAISE EXCEPTION 'EQUIPMENT_OWNER';END IF;
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'EQUIPMENT_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='ordinary_equipment_stocks' THEN IF TG_OP='DELETE' THEN RAISE EXCEPTION 'EQUIPMENT_IMMUTABLE';END IF;RETURN NEW;END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'EQUIPMENT_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='ordinary_equipment_jobs' THEN
  SELECT owner_wallet INTO STRICT custody FROM public.bases WHERE id=NEW.base_id AND status='active' FOR UPDATE;
  IF NEW.actor_wallet<>custody OR NEW.recipe_snapshot<>recipe OR NEW.ready_at-NEW.started_at<>(recipe->>'durationSec')::bigint*interval '1 second'
   OR NOT EXISTS(SELECT 1 FROM public.base_slots WHERE base_id=NEW.base_id AND wallet=NEW.actor_wallet AND active)
   OR NOT EXISTS(SELECT 1 FROM public.buildings b JOIN public.builder_jobs j ON j.id=NEW.workshop_completed_job_id
    WHERE b.id=NEW.workshop_id AND b.base_id=NEW.base_id AND b.type='workshop' AND b.level>=1 AND j.building_id=b.id AND j.base_id=b.base_id AND j.kind='build' AND j.cancelled_at IS NULL AND j.completed_at<=NEW.started_at)
   OR EXISTS(SELECT 1 FROM public.builder_jobs WHERE building_id=NEW.workshop_id AND kind='build' AND completed_at IS NULL)
   OR EXISTS(SELECT 1 FROM public.ordinary_crafting_jobs WHERE base_id=NEW.base_id AND completed_at IS NULL)
   OR EXISTS(SELECT 1 FROM public.ordinary_equipment_jobs j LEFT JOIN public.ordinary_equipment_completions c ON c.job_id=j.id WHERE j.base_id=NEW.base_id AND c.job_id IS NULL)
  THEN RAISE EXCEPTION 'EQUIPMENT_CRAFT_ADMISSION';END IF;
  -- Consume only existing ordinary refined stock. No client-supplied amounts.
  FOR ingredient IN SELECT value FROM jsonb_array_elements(recipe->'inputs') LOOP
   n:=(ingredient->>'quantity')::bigint;
   UPDATE public.crafting_stocks SET available=available-n WHERE base_id=NEW.base_id AND item_id=ingredient->>'itemId' AND available>=n;
   IF NOT FOUND THEN RAISE EXCEPTION 'EQUIPMENT_MATERIALS';END IF;
  END LOOP;
  INSERT INTO public.ordinary_equipment_stocks(base_id,item_id,pending_output) VALUES(NEW.base_id,'route_compass',1)
   ON CONFLICT(base_id,item_id) DO UPDATE SET pending_output=ordinary_equipment_stocks.pending_output+1;
 ELSIF TG_TABLE_NAME='ordinary_equipment_completions' THEN
  SELECT * INTO STRICT job FROM public.ordinary_equipment_jobs WHERE id=NEW.job_id;
  SELECT owner_wallet INTO STRICT custody FROM public.bases WHERE id=job.base_id FOR UPDATE;
  IF NEW.custody_wallet<>custody OR NOT isfinite(NEW.completed_at) OR NEW.completed_at<job.ready_at THEN RAISE EXCEPTION 'EQUIPMENT_COMPLETION';END IF;
  UPDATE public.ordinary_equipment_stocks SET available=available+1,pending_output=pending_output-1 WHERE base_id=job.base_id AND item_id='route_compass' AND pending_output>=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'EQUIPMENT_PENDING_MISSING';END IF;
 ELSIF TG_TABLE_NAME='ordinary_equipment_reservations' THEN
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1',NEW.trip_kind||'_expeditions') INTO STRICT trip USING NEW.expedition_id;
  f:=trip->'route_snapshot'->'fitting';
  IF (trip->>'base_id'=NEW.base_id::text AND f=NEW.fitting_snapshot AND f->>'itemId'='route_compass' AND f->>'policyVersion'='1') IS NOT TRUE THEN RAISE EXCEPTION 'EQUIPMENT_RESERVATION';END IF;
  PERFORM id FROM public.bases WHERE id=NEW.base_id FOR UPDATE;
  UPDATE public.ordinary_equipment_stocks SET available=available-1,reserved=reserved+1 WHERE base_id=NEW.base_id AND item_id='route_compass' AND available>=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'EQUIPMENT_UNAVAILABLE';END IF;
 ELSIF TG_TABLE_NAME='ordinary_equipment_releases' THEN
  SELECT * INTO STRICT r FROM public.ordinary_equipment_reservations WHERE trip_kind=NEW.trip_kind AND expedition_id=NEW.expedition_id;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1 AND expedition_id=$2',NEW.trip_kind||'_expedition_returns') INTO terminal USING NEW.return_id,NEW.expedition_id;
  IF terminal IS NULL OR NEW.base_id<>r.base_id THEN RAISE EXCEPTION 'EQUIPMENT_RETURN_REQUIRED';END IF;
  PERFORM id FROM public.bases WHERE id=NEW.base_id FOR UPDATE;
  UPDATE public.ordinary_equipment_stocks SET available=available+1,reserved=reserved-1 WHERE base_id=NEW.base_id AND item_id='route_compass' AND reserved>=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'EQUIPMENT_RESERVED_MISSING';END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_equipment_guard() FROM PUBLIC;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['ordinary_equipment_stocks','ordinary_equipment_jobs','ordinary_equipment_completions','ordinary_equipment_reservations','ordinary_equipment_releases'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname='equipment_guard') THEN
   EXECUTE format('CREATE TRIGGER equipment_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_equipment_guard()',t);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname='equipment_truncate') THEN
   EXECUTE format('CREATE TRIGGER equipment_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_equipment_guard()',t);
  END IF;
 END LOOP;
END $$;
--> statement-breakpoint
-- A fitted trip and its reservation, and an actual return and its release, are
-- inseparable even if a writer sets constraints immediate or later rolls back.
CREATE OR REPLACE FUNCTION public.shardkeep_equipment_trip_proof() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE kind text;eid uuid;trip jsonb;terminal jsonb;f jsonb;held public.ordinary_equipment_reservations%ROWTYPE;released public.ordinary_equipment_releases%ROWTYPE;g numeric;d numeric;
BEGIN
 IF TG_TABLE_NAME LIKE 'starter_%' THEN kind:='starter';ELSIF TG_TABLE_NAME LIKE 'advanced_%' THEN kind:='advanced';ELSE kind:=NEW.trip_kind;END IF;
 IF TG_TABLE_NAME IN('starter_expeditions','advanced_expeditions') THEN eid:=NEW.id;ELSE eid:=NEW.expedition_id;END IF;
 EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1',kind||'_expeditions') INTO trip USING eid;
 SELECT * INTO held FROM public.ordinary_equipment_reservations WHERE trip_kind=kind AND expedition_id=eid;
 f:=trip->'route_snapshot'->'fitting';
 IF f IS NULL THEN IF held.expedition_id IS NOT NULL THEN RAISE EXCEPTION 'EQUIPMENT_UNEXPECTED';END IF;RETURN NULL;END IF;
 IF held.expedition_id IS NULL OR held.base_id::text<>trip->>'base_id' OR held.fitting_snapshot<>f THEN RAISE EXCEPTION 'EQUIPMENT_RESERVATION_REQUIRED';END IF;
 -- Frozen generated v1 ratios: floor to whole-tax quantum, never drop carry.
 g:=floor(floor((f->>'originalGrossQuantity')::numeric*3/4)/5)*5;d:=ceil((f->>'originalDurationSec')::numeric*4/5);
 IF f<>jsonb_build_object('itemId','route_compass','policyVersion',1,'originalDurationSec',(f->>'originalDurationSec')::bigint,
   'originalGrossQuantity',f->>'originalGrossQuantity','originalNetQuantity',f->>'originalNetQuantity','originalIslandPoolQuantity',f->>'originalIslandPoolQuantity')
  OR g<=0 OR d<=0 OR (f->>'originalNetQuantity')::numeric+(f->>'originalIslandPoolQuantity')::numeric<>(f->>'originalGrossQuantity')::numeric
  OR (trip->'route_snapshot'->>'durationSec')::numeric<>d OR (trip->>'gross')::numeric<>g OR (trip->>'tax')::numeric<>g/5 OR (trip->>'net')::numeric<>g-g/5 THEN RAISE EXCEPTION 'EQUIPMENT_FROZEN_TERMS';END IF;
 EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE expedition_id=$1',kind||'_expedition_returns') INTO terminal USING eid;
 SELECT * INTO released FROM public.ordinary_equipment_releases WHERE trip_kind=kind AND expedition_id=eid;
 IF (terminal IS NULL)<>(released.expedition_id IS NULL) OR (terminal IS NOT NULL AND released.return_id::text<>terminal->>'id') THEN RAISE EXCEPTION 'EQUIPMENT_RELEASE_REQUIRED';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_equipment_trip_proof() FROM PUBLIC;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['starter_expeditions','advanced_expeditions','starter_expedition_returns','advanced_expedition_returns','ordinary_equipment_reservations','ordinary_equipment_releases'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname='equipment_trip_proof') THEN
   EXECUTE format('CREATE CONSTRAINT TRIGGER equipment_trip_proof AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_equipment_trip_proof()',t);
  END IF;
 END LOOP;
END $$;

--> statement-breakpoint
-- HELD S5: retarget the original starter INSERT guard to a frozen extension.
-- No old migration/function/history is rewritten; repeated0185 cannot replace
-- this new function. All no-fitting validation is copied byte-for-byte below.
CREATE OR REPLACE FUNCTION public.shardkeep_equipment_starter_insert_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE fitted public.starter_expeditions%ROWTYPE; original_fitting jsonb; trip public.starter_expeditions%ROWTYPE; custody text; expected_realm text; expected_resource text; access_ok boolean; coverage jsonb; coverage_source jsonb; coverage_finality jsonb; expected_index integer; account_row jsonb; account_index integer;
BEGIN
  IF TG_TABLE_NAME = 'starter_expeditions' THEN
    -- Validate the copied ordinary policy against the original unfitted route.
    -- The actual immutable row remains the fitted effective route; the separate
    -- deferred equipment proof binds its exact arithmetic and reserved copy.
    IF NEW.route_snapshot ? 'fitting' THEN
      fitted:=NEW;original_fitting:=NEW.route_snapshot->'fitting';
      NEW.gross:=(original_fitting->>'originalGrossQuantity')::bigint;
      NEW.net:=(original_fitting->>'originalNetQuantity')::bigint;
      NEW.tax:=(original_fitting->>'originalIslandPoolQuantity')::bigint;
      NEW.returns_at:=NEW.departed_at+(original_fitting->>'originalDurationSec')::bigint*interval '1 second';
      NEW.route_snapshot:=(NEW.route_snapshot-'fitting')||jsonb_build_object('durationSec',(original_fitting->>'originalDurationSec')::bigint,
        'grossQuantity',NEW.gross::text,'netQuantity',NEW.net::text,'islandPoolQuantity',NEW.tax::text);
    END IF;
    IF NEW.route_snapshot->'access'->>'kind' = 'paid_realm' THEN
      expected_realm := CASE NEW.route_id
        WHEN 'paid_frostveil' THEN 'frostveil' WHEN 'paid_elderwood' THEN 'elderwood'
        WHEN 'paid_sunscar' THEN 'sunscar' WHEN 'paid_crownlands' THEN 'crownlands'
        WHEN 'paid_seeker_reach' THEN 'seeker-reach' WHEN 'paid_stormcairn' THEN 'stormcairn'
        WHEN 'paid_thornwake' THEN 'thornwake' WHEN 'paid_cinderfall' THEN 'cinderfall' ELSE NULL END;
      expected_resource := CASE expected_realm
        WHEN 'frostveil' THEN 'frost_quartz' WHEN 'elderwood' THEN 'heartwood_logs'
        WHEN 'sunscar' THEN 'sunstone_rubble' WHEN 'crownlands' THEN 'crown_iron_ore'
        WHEN 'seeker-reach' THEN 'rough_prism' WHEN 'stormcairn' THEN 'storm_ore'
        WHEN 'thornwake' THEN 'thorn_fibre' WHEN 'cinderfall' THEN 'ember_nodules' ELSE NULL END;
      expected_index := array_position(ARRAY['frostveil','elderwood','sunscar','crownlands','seeker-reach','stormcairn','thornwake','cinderfall'],expected_realm)-1;
      coverage := NEW.route_snapshot->'access'->'observation'; coverage_source := coverage->'source'; coverage_finality := coverage->'finality';
      access_ok := expected_realm IS NOT NULL AND NEW.route_version = 3 AND NEW.reward_version = 2
        AND (NEW.route_snapshot->'access') - ARRAY['kind','policyVersion','observation'] = '{}'::jsonb
        AND NEW.route_snapshot->'access'->'policyVersion' = '1'::jsonb
        AND NEW.route_snapshot->>'realmId' = expected_realm AND NEW.resource_id = expected_resource
        AND NEW.gross = 25 AND NEW.net = 20 AND NEW.tax = 5
        AND NEW.returns_at - NEW.departed_at = interval '1800 seconds'
        AND jsonb_typeof(coverage) = 'object'
        AND coverage - ARRAY['version','wallet','realm','accessAddress','configAddress','expiresAt','finality','source'] = '{}'::jsonb
        AND coverage->'version' = '1'::jsonb AND jsonb_typeof(coverage->'wallet') = 'string' AND coverage->>'wallet' = NEW.actor_wallet
        AND coverage->'realm' = to_jsonb(expected_index)
        AND jsonb_typeof(coverage->'accessAddress') = 'string' AND coverage->>'accessAddress' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
        AND jsonb_typeof(coverage->'configAddress') = 'string' AND coverage->>'configAddress' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
        AND jsonb_typeof(coverage->'expiresAt') = 'string' AND coverage->>'expiresAt' ~ '^[1-9][0-9]{0,18}$'
        AND (coverage->>'expiresAt')::numeric <= 9223372036854775807
        AND (coverage->>'expiresAt')::numeric > extract(epoch FROM NEW.departed_at)
        AND jsonb_typeof(coverage_finality) = 'object'
        AND coverage_finality - ARRAY['commitment','contextSlot','observedAt','chainUnixTimestamp'] = '{}'::jsonb
        AND jsonb_typeof(coverage_finality->'commitment') = 'string' AND coverage_finality->>'commitment' = 'finalized'
        AND jsonb_typeof(coverage_finality->'contextSlot') = 'string' AND coverage_finality->>'contextSlot' ~ '^(0|[1-9][0-9]{0,19})$'
        AND (coverage_finality->>'contextSlot')::numeric <= 18446744073709551615
        AND jsonb_typeof(coverage_finality->'observedAt') = 'string' AND coverage_finality->>'observedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
        AND (coverage_finality->>'observedAt')::timestamptz <= NEW.departed_at
        AND NEW.departed_at - (coverage_finality->>'observedAt')::timestamptz <= interval '10 seconds'
        AND jsonb_typeof(coverage_finality->'chainUnixTimestamp') = 'string'
        AND coverage_finality->>'chainUnixTimestamp' ~ '^[1-9][0-9]{0,18}$'
        AND (coverage_finality->>'chainUnixTimestamp')::numeric <= extract(epoch FROM NEW.departed_at)
        AND jsonb_typeof(coverage_source) = 'object'
        AND coverage_source - ARRAY['trust','stateProvenance','genesisHash','programId','reviewedDeploymentSlot','reviewedProgramDataSha256','upgradeAuthority','accounts'] = '{}'::jsonb
        AND jsonb_typeof(coverage_source->'trust') = 'string' AND coverage_source->>'trust' = 'trusted-finalized-rpc-reviewed-program'
        AND jsonb_typeof(coverage_source->'stateProvenance') = 'string' AND coverage_source->>'stateProvenance' = 'fresh-reviewed-deployment'
        AND jsonb_typeof(coverage_source->'genesisHash') = 'string' AND coverage_source->>'genesisHash' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
        AND jsonb_typeof(coverage_source->'programId') = 'string' AND coverage_source->>'programId' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
        AND jsonb_typeof(coverage_source->'reviewedProgramDataSha256') = 'string' AND coverage_source->>'reviewedProgramDataSha256' ~ '^[a-f0-9]{64}$'
        AND jsonb_typeof(coverage_source->'reviewedDeploymentSlot') = 'number'
        AND coverage_source->>'reviewedDeploymentSlot' ~ '^(0|[1-9][0-9]{0,15})$'
        AND (coverage_source->>'reviewedDeploymentSlot')::numeric <= 9007199254740991
        AND (coverage_source->>'reviewedDeploymentSlot')::numeric <= (coverage_finality->>'contextSlot')::numeric
        AND (coverage_source->'upgradeAuthority' = 'null'::jsonb OR (jsonb_typeof(coverage_source->'upgradeAuthority') = 'string' AND coverage_source->>'upgradeAuthority' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'))
        AND jsonb_typeof(coverage_source->'accounts') = 'array' AND jsonb_array_length(coverage_source->'accounts') = 5
        AND EXISTS (SELECT 1 FROM public.expedition_term_snapshots t WHERE t.term_id = NEW.term_id AND t.snapshot_hash = NEW.term_hash
          AND t.genesis_hash = coverage_source->>'genesisHash' AND t.program_id = coverage_source->>'programId');
      IF access_ok IS TRUE THEN
        FOR account_row, account_index IN SELECT value, ordinality::integer-1 FROM jsonb_array_elements(coverage_source->'accounts') WITH ORDINALITY LOOP
          IF (jsonb_typeof(account_row) = 'object' AND account_row - ARRAY['address','exists','owner','executable','dataSha256'] = '{}'::jsonb
            AND jsonb_typeof(account_row->'address') = 'string' AND account_row->>'address' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' AND account_row->'exists' = 'true'::jsonb
            AND account_row->'executable' = to_jsonb(account_index = 0) AND jsonb_typeof(account_row->'dataSha256') = 'string' AND account_row->>'dataSha256' ~ '^[a-f0-9]{64}$'
            AND jsonb_typeof(account_row->'owner') = 'string' AND account_row->>'owner' = CASE WHEN account_index < 2 THEN 'BPFLoaderUpgradeab1e11111111111111111111111'
              WHEN account_index = 4 THEN 'Sysvar1111111111111111111111111111111111111' ELSE coverage_source->>'programId' END
            AND CASE account_index WHEN 0 THEN account_row->>'address' = coverage_source->>'programId'
              WHEN 1 THEN account_row->>'dataSha256' = coverage_source->>'reviewedProgramDataSha256'
              WHEN 2 THEN account_row->>'address' = coverage->>'configAddress'
              WHEN 3 THEN account_row->>'address' = coverage->>'accessAddress'
              WHEN 4 THEN account_row->>'address' = 'SysvarC1ock11111111111111111111111111111111' ELSE false END) IS NOT TRUE
          THEN access_ok := false; EXIT; END IF;
        END LOOP;
        IF (SELECT count(DISTINCT value->>'address') FROM jsonb_array_elements(coverage_source->'accounts')) <> 5 THEN access_ok := false; END IF;
      END IF;
    ELSIF NEW.route_snapshot ? 'access' THEN
      expected_realm := CASE NEW.route_id
        WHEN 'common_frostveil' THEN 'frostveil'
        WHEN 'common_elderwood' THEN 'elderwood'
        WHEN 'common_sunscar' THEN 'sunscar'
        WHEN 'common_crownlands' THEN 'crownlands'
        WHEN 'common_seeker_reach' THEN 'seeker-reach'
        WHEN 'common_stormcairn' THEN 'stormcairn'
        WHEN 'common_thornwake' THEN 'thornwake'
        WHEN 'common_cinderfall' THEN 'cinderfall'
        ELSE NULL END;
      expected_resource := CASE expected_realm
        WHEN 'frostveil' THEN 'frost_quartz'
        WHEN 'elderwood' THEN 'heartwood_logs'
        WHEN 'sunscar' THEN 'sunstone_rubble'
        WHEN 'crownlands' THEN 'crown_iron_ore'
        WHEN 'seeker-reach' THEN 'rough_prism'
        WHEN 'stormcairn' THEN 'storm_ore'
        WHEN 'thornwake' THEN 'thorn_fibre'
        WHEN 'cinderfall' THEN 'ember_nodules'
        ELSE NULL END;
      access_ok := expected_realm IS NOT NULL
        AND NEW.route_version = 2 AND NEW.reward_version = 2
        AND NEW.route_snapshot->'access' = '{"kind":"starter_common","policyVersion":1}'::jsonb
        AND NEW.route_snapshot->>'realmId' = expected_realm AND NEW.resource_id = expected_resource
        AND NEW.gross = 5 AND NEW.net = 4 AND NEW.tax = 1
        AND NEW.returns_at - NEW.departed_at = interval '1800 seconds';
    ELSE
      access_ok := NEW.route_id IN ('introduction','coastal_survey','long_survey')
        AND NEW.route_snapshot->>'realmId' = NEW.home_evidence->>'realmId';
    END IF;
    IF access_ok IS NOT TRUE OR NOT EXISTS (SELECT 1 FROM public.fleet_installations WHERE id = NEW.installation_id AND base_id = NEW.base_id AND family = 'starter')
      OR NOT EXISTS (SELECT 1 FROM public.expedition_term_snapshots WHERE term_id = NEW.term_id AND snapshot_hash = NEW.term_hash AND starts_at <= NEW.departed_at AND NEW.departed_at < ends_at)
      OR (jsonb_typeof(NEW.route_snapshot) = 'object'
        AND NEW.route_snapshot - ARRAY['routeCatalogueVersion','rewardTableVersion','routeId','realmId','resourceId',
          'vehicleFamily','durationSec','grossQuantity','netQuantity','islandPoolQuantity','access'] = '{}'::jsonb
        AND NEW.route_snapshot->'routeCatalogueVersion' = to_jsonb(NEW.route_version)
        AND NEW.route_snapshot->'rewardTableVersion' = to_jsonb(NEW.reward_version)
        AND NEW.route_snapshot->'grossQuantity' = to_jsonb(NEW.gross::text)
        AND NEW.route_snapshot->'netQuantity' = to_jsonb(NEW.net::text)
        AND NEW.route_snapshot->'islandPoolQuantity' = to_jsonb(NEW.tax::text)
        AND jsonb_typeof(NEW.route_snapshot->'durationSec') = 'number'
        AND NEW.home_evidence->>'baseId' = NEW.base_id::text
        AND NEW.home_evidence->>'custodyWallet' = NEW.actor_wallet
        AND NEW.route_snapshot->>'routeId' = NEW.route_id
        AND (NEW.route_snapshot->>'routeCatalogueVersion')::integer = NEW.route_version
        AND (NEW.route_snapshot->>'rewardTableVersion')::integer = NEW.reward_version
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
  IF original_fitting IS NOT NULL THEN NEW:=fitted;END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.shardkeep_equipment_starter_insert_guard() FROM PUBLIC;

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.starter_expeditions'::regclass AND tgname='starter_expedition_insert_guard'
   AND tgfoid<>'public.shardkeep_equipment_starter_insert_guard()'::regprocedure) THEN
  DROP TRIGGER starter_expedition_insert_guard ON public.starter_expeditions;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.starter_expeditions'::regclass AND tgname='starter_expedition_insert_guard') THEN
  CREATE TRIGGER starter_expedition_insert_guard BEFORE INSERT ON public.starter_expeditions FOR EACH ROW EXECUTE FUNCTION public.shardkeep_equipment_starter_insert_guard();
 END IF;
END $$;
