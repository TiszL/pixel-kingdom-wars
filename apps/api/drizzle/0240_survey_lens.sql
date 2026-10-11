-- D153.189 frozen Survey Lens policy copied from PHASE_E_SURVEY_LENS.
-- HELD S5: forward trigger extensions; no applied migration is edited.
SET LOCAL lock_timeout='10s';
ALTER TABLE public.ordinary_equipment_stocks DROP CONSTRAINT IF EXISTS ordinary_equipment_stocks_item_id_check;
ALTER TABLE public.ordinary_equipment_stocks ADD CONSTRAINT ordinary_equipment_stocks_item_id_check CHECK(item_id IN('route_compass','survey_lens'));
CREATE TABLE IF NOT EXISTS public.ordinary_equipment_secondary_outputs(
 trip_kind text NOT NULL,expedition_id uuid NOT NULL,base_id uuid NOT NULL REFERENCES bases(id),
 term_id uuid NOT NULL REFERENCES expedition_term_snapshots(term_id),term_hash text NOT NULL,
 resource_id text NOT NULL CHECK(resource_id IN('frost_quartz','heartwood_logs','sunstone_rubble','crown_iron_ore','rough_prism','storm_ore','thorn_fibre','ember_nodules')),gross bigint NOT NULL,net bigint NOT NULL,tax bigint NOT NULL,
 PRIMARY KEY(trip_kind,expedition_id),FOREIGN KEY(trip_kind,expedition_id) REFERENCES ordinary_equipment_reservations(trip_kind,expedition_id),
 CHECK(gross>0 AND net>0 AND tax>0 AND net::numeric+tax::numeric=gross::numeric));
CREATE INDEX IF NOT EXISTS equipment_secondary_pool ON public.ordinary_equipment_secondary_outputs(term_id,resource_id,trip_kind,expedition_id);
CREATE TABLE IF NOT EXISTS public.ordinary_equipment_secondary_returns(
 trip_kind text NOT NULL,expedition_id uuid NOT NULL,return_id uuid NOT NULL,
 stock_before bigint NOT NULL,stock_after bigint NOT NULL,
 PRIMARY KEY(trip_kind,expedition_id),FOREIGN KEY(trip_kind,expedition_id) REFERENCES ordinary_equipment_secondary_outputs(trip_kind,expedition_id),
 CHECK(stock_before>=0 AND stock_after>stock_before));
CREATE TABLE IF NOT EXISTS public.ordinary_equipment_secondary_entries(
 trip_kind text NOT NULL,expedition_id uuid NOT NULL,bucket text NOT NULL CHECK(bucket IN('issued','base_stock','island_pool')),delta bigint NOT NULL,
 PRIMARY KEY(trip_kind,expedition_id,bucket),FOREIGN KEY(trip_kind,expedition_id) REFERENCES ordinary_equipment_secondary_returns(trip_kind,expedition_id));
REVOKE ALL ON ordinary_equipment_secondary_outputs,ordinary_equipment_secondary_returns,ordinary_equipment_secondary_entries FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_equipment_guard_v2() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job public.ordinary_equipment_jobs%ROWTYPE;bid uuid;custody text;trip jsonb;terminal jsonb;r public.ordinary_equipment_reservations%ROWTYPE;
 compass constant jsonb:='{"recipeVersion":1,"recipeId":"craft_route_compass","quantity":1,"durationSec":300,"inputs":[{"kind":"crafting","itemId":"prismstone_lens","quantity":"2"},{"kind":"crafting","itemId":"crownsteel","quantity":"2"}],"output":{"itemId":"route_compass","quantity":"1"}}';
 lens constant jsonb:='{"recipeVersion":1,"recipeId":"craft_survey_lens","quantity":1,"durationSec":300,"inputs":[{"kind":"crafting","itemId":"prismstone_lens","quantity":"2"},{"kind":"crafting","itemId":"frostglass","quantity":"2"}],"output":{"itemId":"survey_lens","quantity":"1"}}';
 recipe jsonb;ingredient jsonb;n bigint;f jsonb;item text;
BEGIN
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.ordinary_equipment_jobs'::regclass) THEN RAISE EXCEPTION 'EQUIPMENT_OWNER';END IF;
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'EQUIPMENT_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='ordinary_equipment_stocks' THEN IF TG_OP='DELETE' THEN RAISE EXCEPTION 'EQUIPMENT_IMMUTABLE';END IF;RETURN NEW;END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'EQUIPMENT_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='ordinary_equipment_jobs' THEN
  recipe:=CASE NEW.recipe_snapshot->>'recipeId' WHEN 'craft_route_compass' THEN compass WHEN 'craft_survey_lens' THEN lens ELSE NULL END;
  IF recipe IS NULL THEN RAISE EXCEPTION 'EQUIPMENT_CRAFT_ADMISSION';END IF;
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
  FOR ingredient IN SELECT value FROM jsonb_array_elements(recipe->'inputs') ORDER BY value->>'itemId' LOOP
   n:=(ingredient->>'quantity')::bigint;
   UPDATE public.crafting_stocks SET available=available-n WHERE base_id=NEW.base_id AND item_id=ingredient->>'itemId' AND available>=n;
   IF NOT FOUND THEN RAISE EXCEPTION 'EQUIPMENT_MATERIALS';END IF;
  END LOOP;
  INSERT INTO public.ordinary_equipment_stocks(base_id,item_id,pending_output) VALUES(NEW.base_id,recipe->'output'->>'itemId',1)
   ON CONFLICT(base_id,item_id) DO UPDATE SET pending_output=ordinary_equipment_stocks.pending_output+1;
 ELSIF TG_TABLE_NAME='ordinary_equipment_completions' THEN
  SELECT * INTO STRICT job FROM public.ordinary_equipment_jobs WHERE id=NEW.job_id;
  SELECT owner_wallet INTO STRICT custody FROM public.bases WHERE id=job.base_id FOR UPDATE;
  IF NEW.custody_wallet<>custody OR NOT isfinite(NEW.completed_at) OR NEW.completed_at<job.ready_at THEN RAISE EXCEPTION 'EQUIPMENT_COMPLETION';END IF;
  UPDATE public.ordinary_equipment_stocks SET available=available+1,pending_output=pending_output-1 WHERE base_id=job.base_id AND item_id=job.recipe_snapshot->'output'->>'itemId' AND pending_output>=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'EQUIPMENT_PENDING_MISSING';END IF;
 ELSIF TG_TABLE_NAME='ordinary_equipment_reservations' THEN
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1',NEW.trip_kind||'_expeditions') INTO STRICT trip USING NEW.expedition_id;
  f:=trip->'route_snapshot'->'fitting';
  IF (trip->>'base_id'=NEW.base_id::text AND f=NEW.fitting_snapshot AND f->>'itemId' IN('route_compass','survey_lens') AND f->>'policyVersion'='1') IS NOT TRUE THEN RAISE EXCEPTION 'EQUIPMENT_RESERVATION';END IF;
  PERFORM id FROM public.bases WHERE id=NEW.base_id FOR UPDATE;
  UPDATE public.ordinary_equipment_stocks SET available=available-1,reserved=reserved+1 WHERE base_id=NEW.base_id AND item_id=f->>'itemId' AND available>=1;
  IF NOT FOUND THEN IF f->>'itemId'='survey_lens' THEN RAISE EXCEPTION 'LENS_UNAVAILABLE';ELSE RAISE EXCEPTION 'EQUIPMENT_UNAVAILABLE';END IF;END IF;
 ELSIF TG_TABLE_NAME='ordinary_equipment_releases' THEN
  SELECT * INTO STRICT r FROM public.ordinary_equipment_reservations WHERE trip_kind=NEW.trip_kind AND expedition_id=NEW.expedition_id;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1 AND expedition_id=$2',NEW.trip_kind||'_expedition_returns') INTO terminal USING NEW.return_id,NEW.expedition_id;
  IF terminal IS NULL OR NEW.base_id<>r.base_id THEN RAISE EXCEPTION 'EQUIPMENT_RETURN_REQUIRED';END IF;
  PERFORM id FROM public.bases WHERE id=NEW.base_id FOR UPDATE;
  UPDATE public.ordinary_equipment_stocks SET available=available+1,reserved=reserved-1 WHERE base_id=NEW.base_id AND item_id=r.fitting_snapshot->>'itemId' AND reserved>=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'EQUIPMENT_RESERVED_MISSING';END IF;
 END IF;
 RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.shardkeep_equipment_guard_v2() FROM PUBLIC;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['ordinary_equipment_stocks','ordinary_equipment_jobs','ordinary_equipment_completions','ordinary_equipment_reservations','ordinary_equipment_releases'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS equipment_guard ON public.%I',t);
  EXECUTE format('CREATE TRIGGER equipment_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_equipment_guard_v2()',t);
  EXECUTE format('DROP TRIGGER IF EXISTS equipment_truncate ON public.%I',t);
  EXECUTE format('CREATE TRIGGER equipment_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_equipment_guard_v2()',t);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_equipment_secondary_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE trip jsonb;terminal jsonb;part jsonb;s public.ordinary_equipment_secondary_outputs%ROWTYPE;inventory public.resource_stocks%ROWTYPE;expected bigint;
BEGIN
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.ordinary_equipment_jobs'::regclass) THEN RAISE EXCEPTION 'EQUIPMENT_OWNER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'EQUIPMENT_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='ordinary_equipment_secondary_outputs' THEN
  IF NEW.trip_kind NOT IN('starter','advanced') THEN RAISE EXCEPTION 'LENS_SOURCE_KIND';END IF;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1',NEW.trip_kind||'_expeditions') INTO STRICT trip USING NEW.expedition_id;
  part:=trip->'route_snapshot'->'secondaryOutput';
  IF (trip->'route_snapshot'->'fitting'->>'itemId'='survey_lens' AND NEW.base_id::text=trip->>'base_id'
   AND NEW.term_id::text=trip->>'term_id' AND NEW.term_hash=trip->>'term_hash'
   AND part=jsonb_build_object('resourceId',NEW.resource_id,'grossQuantity',NEW.gross::text,'netQuantity',NEW.net::text,'islandPoolQuantity',NEW.tax::text)) IS NOT TRUE
  THEN RAISE EXCEPTION 'LENS_SOURCE_TERMS';END IF;
 ELSIF TG_TABLE_NAME='ordinary_equipment_secondary_returns' THEN
  SELECT * INTO STRICT s FROM public.ordinary_equipment_secondary_outputs WHERE trip_kind=NEW.trip_kind AND expedition_id=NEW.expedition_id;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1 AND expedition_id=$2',NEW.trip_kind||'_expedition_returns') INTO terminal USING NEW.return_id,NEW.expedition_id;
  IF terminal IS NULL OR NEW.stock_before IS NOT NULL OR NEW.stock_after IS NOT NULL THEN RAISE EXCEPTION 'LENS_RETURN_TERMS';END IF;
  PERFORM id FROM public.bases WHERE id=s.base_id FOR UPDATE;
  INSERT INTO public.resource_stocks(base_id,resource_id) VALUES(s.base_id,s.resource_id) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT inventory FROM public.resource_stocks WHERE base_id=s.base_id AND resource_id=s.resource_id FOR UPDATE;
  IF inventory.available::numeric+inventory.reserved::numeric+s.net::numeric>9223372036854775807 THEN RAISE EXCEPTION 'LENS_STOCK_OVERFLOW';END IF;
  NEW.stock_before:=inventory.available;NEW.stock_after:=inventory.available+s.net;
  UPDATE public.resource_stocks SET available=NEW.stock_after WHERE base_id=s.base_id AND resource_id=s.resource_id;
 ELSE
  SELECT * INTO STRICT s FROM public.ordinary_equipment_secondary_outputs WHERE trip_kind=NEW.trip_kind AND expedition_id=NEW.expedition_id;
  expected:=CASE NEW.bucket WHEN 'issued' THEN -s.gross WHEN 'base_stock' THEN s.net WHEN 'island_pool' THEN s.tax ELSE NULL END;
  IF expected IS NULL OR NEW.delta<>expected THEN RAISE EXCEPTION 'LENS_ENTRY_TERMS';END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_equipment_secondary_guard() FROM PUBLIC;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['ordinary_equipment_secondary_outputs','ordinary_equipment_secondary_returns','ordinary_equipment_secondary_entries'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS equipment_secondary_guard ON public.%I',t);
  EXECUTE format('CREATE TRIGGER equipment_secondary_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_equipment_secondary_guard()',t);
  EXECUTE format('DROP TRIGGER IF EXISTS equipment_secondary_truncate ON public.%I',t);
  EXECUTE format('CREATE TRIGGER equipment_secondary_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_equipment_secondary_guard()',t);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_equipment_trip_proof_v2() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE kind text;eid uuid;trip jsonb;terminal jsonb;f jsonb;held public.ordinary_equipment_reservations%ROWTYPE;released public.ordinary_equipment_releases%ROWTYPE;g numeric;d numeric;secondary numeric;part jsonb;s public.ordinary_equipment_secondary_outputs%ROWTYPE;sr public.ordinary_equipment_secondary_returns%ROWTYPE;entry_count integer;entry_sum numeric;
BEGIN
 IF TG_TABLE_NAME LIKE 'starter_%' THEN kind:='starter';ELSIF TG_TABLE_NAME LIKE 'advanced_%' THEN kind:='advanced';ELSE kind:=NEW.trip_kind;END IF;
 IF TG_TABLE_NAME IN('starter_expeditions','advanced_expeditions') THEN eid:=NEW.id;ELSE eid:=NEW.expedition_id;END IF;
 EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1',kind||'_expeditions') INTO trip USING eid;
 SELECT * INTO held FROM public.ordinary_equipment_reservations WHERE trip_kind=kind AND expedition_id=eid;
 f:=trip->'route_snapshot'->'fitting';
 SELECT * INTO s FROM public.ordinary_equipment_secondary_outputs WHERE trip_kind=kind AND expedition_id=eid;
 IF f IS NULL THEN IF held.expedition_id IS NOT NULL OR s.expedition_id IS NOT NULL OR trip->'route_snapshot' ? 'secondaryOutput' THEN RAISE EXCEPTION 'EQUIPMENT_UNEXPECTED';END IF;RETURN NULL;END IF;
 IF held.expedition_id IS NULL OR held.base_id::text<>trip->>'base_id' OR held.fitting_snapshot<>f THEN RAISE EXCEPTION 'EQUIPMENT_RESERVATION_REQUIRED';END IF;
 IF f->>'itemId'='route_compass' THEN
 IF s.expedition_id IS NOT NULL OR trip->'route_snapshot' ? 'secondaryOutput' THEN RAISE EXCEPTION 'LENS_UNEXPECTED';END IF;
 -- Frozen generated v1 ratios: floor to whole-tax quantum, never drop carry.
 g:=floor(floor((f->>'originalGrossQuantity')::numeric*3/4)/5)*5;d:=ceil((f->>'originalDurationSec')::numeric*4/5);
 IF f<>jsonb_build_object('itemId','route_compass','policyVersion',1,'originalDurationSec',(f->>'originalDurationSec')::bigint,
   'originalGrossQuantity',f->>'originalGrossQuantity','originalNetQuantity',f->>'originalNetQuantity','originalIslandPoolQuantity',f->>'originalIslandPoolQuantity')
  OR g<=0 OR d<=0 OR (f->>'originalNetQuantity')::numeric+(f->>'originalIslandPoolQuantity')::numeric<>(f->>'originalGrossQuantity')::numeric
  OR (trip->'route_snapshot'->>'durationSec')::numeric<>d OR (trip->>'gross')::numeric<>g OR (trip->>'tax')::numeric<>g/5 OR (trip->>'net')::numeric<>g-g/5 THEN RAISE EXCEPTION 'EQUIPMENT_FROZEN_TERMS';END IF;
 ELSE
  part:=trip->'route_snapshot'->'secondaryOutput';secondary:=floor(floor((f->>'originalGrossQuantity')::numeric/5)/5)*5;
  g:=(f->>'originalGrossQuantity')::numeric-secondary;d:=(f->>'originalDurationSec')::numeric;
  IF (f=jsonb_build_object('itemId','survey_lens','policyVersion',1,'resourceId',f->>'resourceId','originalDurationSec',d::bigint,
    'originalGrossQuantity',f->>'originalGrossQuantity','originalNetQuantity',f->>'originalNetQuantity','originalIslandPoolQuantity',f->>'originalIslandPoolQuantity')
    AND f->>'resourceId' IN('frost_quartz','heartwood_logs','sunstone_rubble','crown_iron_ore','rough_prism','storm_ore','thorn_fibre','ember_nodules')
    AND f->>'resourceId'<>trip->>'resource_id' AND secondary>0 AND g>0 AND d>0
    AND (f->>'originalNetQuantity')::numeric+(f->>'originalIslandPoolQuantity')::numeric=(f->>'originalGrossQuantity')::numeric
    AND (trip->'route_snapshot'->>'durationSec')::numeric=d AND (trip->>'gross')::numeric=g
    AND (trip->>'net')::numeric=g-g/5 AND (trip->>'tax')::numeric=g/5
    AND (trip->>'net')::numeric+secondary-secondary/5=(f->>'originalNetQuantity')::numeric
    AND (trip->>'tax')::numeric+secondary/5=(f->>'originalIslandPoolQuantity')::numeric
    AND s.expedition_id IS NOT NULL AND s.base_id::text=trip->>'base_id' AND s.term_id::text=trip->>'term_id' AND s.term_hash=trip->>'term_hash'
    AND s.resource_id=f->>'resourceId' AND s.gross::numeric=secondary AND s.net::numeric=secondary-secondary/5 AND s.tax::numeric=secondary/5
    AND part=jsonb_build_object('resourceId',s.resource_id,'grossQuantity',s.gross::text,'netQuantity',s.net::text,'islandPoolQuantity',s.tax::text)) IS NOT TRUE
   THEN RAISE EXCEPTION 'LENS_FROZEN_TERMS';END IF;
 END IF;
 EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE expedition_id=$1',kind||'_expedition_returns') INTO terminal USING eid;
 SELECT * INTO released FROM public.ordinary_equipment_releases WHERE trip_kind=kind AND expedition_id=eid;
 IF (terminal IS NULL)<>(released.expedition_id IS NULL) OR (terminal IS NOT NULL AND released.return_id::text<>terminal->>'id') THEN RAISE EXCEPTION 'EQUIPMENT_RELEASE_REQUIRED';END IF;
 IF f->>'itemId'='survey_lens' THEN
  SELECT * INTO sr FROM public.ordinary_equipment_secondary_returns WHERE trip_kind=kind AND expedition_id=eid;
  IF (terminal IS NULL)<>(sr.expedition_id IS NULL) OR (terminal IS NOT NULL AND sr.return_id::text<>terminal->>'id') THEN RAISE EXCEPTION 'LENS_RETURN_REQUIRED';END IF;
  SELECT count(*),coalesce(sum(delta::numeric),0) INTO entry_count,entry_sum FROM public.ordinary_equipment_secondary_entries WHERE trip_kind=kind AND expedition_id=eid;
  IF (terminal IS NULL AND entry_count<>0) OR (terminal IS NOT NULL AND (entry_count<>3 OR entry_sum<>0 OR sr.stock_after::numeric-sr.stock_before::numeric<>s.net::numeric)) THEN RAISE EXCEPTION 'LENS_ENTRIES_REQUIRED';END IF;
 END IF;
 RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.shardkeep_equipment_trip_proof_v2() FROM PUBLIC;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['starter_expeditions','advanced_expeditions','starter_expedition_returns','advanced_expedition_returns','ordinary_equipment_reservations','ordinary_equipment_releases','ordinary_equipment_secondary_outputs','ordinary_equipment_secondary_returns','ordinary_equipment_secondary_entries'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS equipment_trip_proof ON public.%I',t);
  EXECUTE format('CREATE CONSTRAINT TRIGGER equipment_trip_proof AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_equipment_trip_proof_v2()',t);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_equipment_starter_insert_guard_v2()
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
      NEW.route_snapshot:=(NEW.route_snapshot-'fitting'-'secondaryOutput')||jsonb_build_object('durationSec',(original_fitting->>'originalDurationSec')::bigint,
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
REVOKE ALL ON FUNCTION public.shardkeep_equipment_starter_insert_guard_v2() FROM PUBLIC;

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.starter_expeditions'::regclass AND tgname='starter_expedition_insert_guard'
   AND tgfoid<>'public.shardkeep_equipment_starter_insert_guard_v2()'::regprocedure) THEN
  DROP TRIGGER starter_expedition_insert_guard ON public.starter_expeditions;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.starter_expeditions'::regclass AND tgname='starter_expedition_insert_guard') THEN
  CREATE TRIGGER starter_expedition_insert_guard BEFORE INSERT ON public.starter_expeditions FOR EACH ROW EXECUTE FUNCTION public.shardkeep_equipment_starter_insert_guard_v2();
 END IF;
END $$;

--> statement-breakpoint
-- D-153.136: original resource rights include advanced returns. No new economics.
-- Private source tables remain owner-only. Runtime gets a boolean presence probe,
-- never source JSON; any header (including partial/corrupt history) holds fallback.
CREATE INDEX IF NOT EXISTS advanced_expeditions_pool_idx ON public.advanced_expeditions(term_id,resource_id,id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_has_equipment_resource_sources_v2(term_id uuid,resource_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.advanced_expeditions s WHERE s.term_id=$1 AND (s.resource_id=$2 OR s.route_snapshot->'fitting'->>'resourceId'=$2))
 OR EXISTS(SELECT 1 FROM public.starter_expeditions s WHERE s.term_id=$1 AND s.route_snapshot->'fitting'->>'resourceId'=$2)
$$;
REVOKE ALL ON FUNCTION public.shardkeep_has_equipment_resource_sources_v2(uuid,text) FROM PUBLIC;
-- This scalar compatibility probe is safe for existing/custom/future roles.
-- No private table privileges or raw financial evidence are exposed.
GRANT EXECUTE ON FUNCTION public.shardkeep_has_equipment_resource_sources_v2(uuid,text) TO PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_seeker_resource_claim_guard_v2() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE term public.expedition_term_snapshots%ROWTYPE; dest public.bases%ROWTYPE; inventory public.resource_stocks%ROWTYPE;
 prior public.seeker_resource_claims%ROWTYPE; total numeric; paid numeric; winners integer; recipient text; source_count bigint;
BEGIN
 IF TG_RELID<>'public.seeker_resource_claims'::regclass OR TG_WHEN<>'BEFORE'
 OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'seeker_resource_claim_no_truncate' ELSE 'seeker_resource_claim_guard' END)
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'SEEKER_RESOURCE_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SEEKER_RESOURCE_IMMUTABLE';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'SEEKER_RESOURCE_ISOLATION';END IF;
 IF NEW.term_hash IS NOT NULL OR NEW.winner_count IS NOT NULL OR NEW.pool_total IS NOT NULL OR NEW.previous_id IS NOT NULL
 OR NEW.previous_total IS NOT NULL OR NEW.cumulative_total IS NOT NULL OR NEW.quantity IS NOT NULL
 OR NEW.stock_before IS NOT NULL OR NEW.stock_after IS NOT NULL OR NEW.claimed_at IS NOT NULL THEN RAISE EXCEPTION 'SEEKER_RESOURCE_DERIVED';END IF;
 -- Match the service/player/base/slot order; no pool lock precedes custody.
 PERFORM 1 FROM public.players WHERE wallet=NEW.wallet FOR UPDATE;
 SELECT * INTO STRICT dest FROM public.bases WHERE id=NEW.base_id AND owner_wallet=NEW.wallet AND status='active' FOR UPDATE;
 PERFORM 1 FROM public.base_slots WHERE base_id=dest.id AND wallet=NEW.wallet AND active FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.base_raid_locks WHERE base_id=dest.id) THEN RAISE EXCEPTION 'SEEKER_RESOURCE_DESTINATION';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('seeker-resource:'||NEW.term_id::text||':'||NEW.resource_id,0));
 SELECT * INTO STRICT term FROM public.expedition_term_snapshots WHERE term_id=NEW.term_id;
 SELECT count(*),max(CASE WHEN (s->>'spotId')::integer=NEW.spot_id THEN s->>'ownerWallet' END)
 INTO winners,recipient FROM jsonb_array_elements(term.snapshot->'spots') s WHERE s->>'ownerWallet' IS NOT NULL;
 IF winners<1 OR recipient IS DISTINCT FROM NEW.wallet THEN RAISE EXCEPTION 'SEEKER_RESOURCE_NOT_OWNER';END IF;
 -- Every committed source contributes exactly its original tax once. Original
 -- producer triggers enforce the three legs, and admission retains term proof.
 SELECT COALESCE(sum(tax),0),count(*) INTO total,source_count FROM (
  SELECT e.delta::numeric AS tax FROM public.starter_expedition_entries e
   JOIN public.starter_expedition_returns r ON r.id=e.return_id
   JOIN public.starter_expeditions s ON s.id=r.expedition_id
   WHERE e.bucket='island_pool' AND s.term_id=NEW.term_id AND s.term_hash=term.snapshot_hash AND s.resource_id=NEW.resource_id
  UNION ALL
  SELECT e.delta::numeric FROM public.harvester_entries e JOIN public.harvester_sources s ON s.id=e.source_id
   WHERE e.bucket='island_pool' AND s.term_id=NEW.term_id AND s.term_hash=term.snapshot_hash AND s.resource_id=NEW.resource_id
   UNION ALL
   SELECT e.delta::numeric FROM public.advanced_expedition_entries e
    JOIN public.advanced_expedition_returns r ON r.id=e.return_id
    JOIN public.advanced_expeditions s ON s.id=r.expedition_id
    WHERE e.bucket='island_pool' AND s.term_id=NEW.term_id AND s.term_hash=term.snapshot_hash AND s.resource_id=NEW.resource_id
  UNION ALL
  SELECT e.delta::numeric FROM public.ordinary_equipment_secondary_entries e
   JOIN public.ordinary_equipment_secondary_outputs s USING(trip_kind,expedition_id)
   JOIN public.ordinary_equipment_secondary_returns r USING(trip_kind,expedition_id)
   WHERE e.bucket='island_pool' AND s.term_id=NEW.term_id AND s.term_hash=term.snapshot_hash AND s.resource_id=NEW.resource_id
 ) sources;
 IF source_count<1 OR total<0 OR total>9223372036854775807 OR total IS DISTINCT FROM NEW.expected_pool::numeric THEN RAISE EXCEPTION 'SEEKER_RESOURCE_SOURCE_CHANGED';END IF;
 SELECT * INTO prior FROM public.seeker_resource_claims WHERE term_id=NEW.term_id AND resource_id=NEW.resource_id AND spot_id=NEW.spot_id ORDER BY cumulative_total DESC LIMIT 1;
 NEW.previous_id:=prior.id;NEW.previous_total:=COALESCE(prior.cumulative_total,0);
 IF NEW.previous_total<>NEW.expected_previous THEN RAISE EXCEPTION 'SEEKER_RESOURCE_CURSOR_CHANGED';END IF;
 NEW.term_hash:=term.snapshot_hash;NEW.winner_count:=winners;NEW.pool_total:=total;
 NEW.cumulative_total:=div(total,winners);NEW.quantity:=NEW.cumulative_total-NEW.previous_total;
 IF NEW.quantity<=0 THEN RAISE EXCEPTION 'SEEKER_RESOURCE_NOTHING_DUE';END IF;
 SELECT COALESCE(sum(quantity::numeric),0) INTO paid FROM public.seeker_resource_claims WHERE term_id=NEW.term_id AND resource_id=NEW.resource_id;
 IF paid+NEW.quantity>total THEN RAISE EXCEPTION 'SEEKER_RESOURCE_POOL_UNDERFLOW';END IF;
 INSERT INTO public.resource_stocks(base_id,resource_id) VALUES(NEW.base_id,NEW.resource_id) ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT inventory FROM public.resource_stocks WHERE base_id=NEW.base_id AND resource_id=NEW.resource_id FOR UPDATE;
 IF inventory.available::numeric+inventory.reserved::numeric+NEW.quantity::numeric>9223372036854775807 THEN RAISE EXCEPTION 'SEEKER_RESOURCE_STOCK_OVERFLOW';END IF;
 NEW.stock_before:=inventory.available;NEW.stock_after:=inventory.available+NEW.quantity;NEW.claimed_at:=clock_timestamp();
 UPDATE public.resource_stocks SET available=NEW.stock_after WHERE base_id=NEW.base_id AND resource_id=NEW.resource_id;
 RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.shardkeep_seeker_resource_claim_guard_v2() FROM PUBLIC;

DROP TRIGGER IF EXISTS seeker_resource_claim_guard ON public.seeker_resource_claims;
CREATE TRIGGER seeker_resource_claim_guard BEFORE INSERT OR UPDATE OR DELETE ON public.seeker_resource_claims FOR EACH ROW EXECUTE FUNCTION public.shardkeep_seeker_resource_claim_guard_v2();
DROP TRIGGER IF EXISTS seeker_resource_claim_no_truncate ON public.seeker_resource_claims;
CREATE TRIGGER seeker_resource_claim_no_truncate BEFORE TRUNCATE ON public.seeker_resource_claims FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_seeker_resource_claim_guard_v2();
