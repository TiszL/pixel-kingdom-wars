-- Prospective development only. Source triggers remain dormant until explicit
-- owner initialization; no lazy completion, backfill, score or cohort mutation.
CREATE OR REPLACE FUNCTION public.shardkeep_mining_development_clock() RETURNS timestamptz
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$ SELECT clock_timestamp() $$;
CREATE TABLE IF NOT EXISTS mining_development_transactions (
 tx_key text PRIMARY KEY, observed_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS mining_development_baselines (
 base_id uuid PRIMARY KEY, observed_at timestamptz NOT NULL, effective_from timestamptz NOT NULL,
 base_state jsonb NOT NULL, buildings jsonb NOT NULL, jobs jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS mining_development_events (
 id bigserial PRIMARY KEY, base_id uuid NOT NULL, tx_key text NOT NULL, observed_at timestamptz NOT NULL,
 source_table text NOT NULL, source_id text NOT NULL, before_state jsonb, after_state jsonb
);
CREATE INDEX IF NOT EXISTS mining_development_events_base_id ON mining_development_events(base_id,id);
CREATE INDEX IF NOT EXISTS mining_development_events_tx_key ON mining_development_events(tx_key,id);
CREATE INDEX IF NOT EXISTS mining_development_events_base_clock ON mining_development_events(base_id,observed_at,id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_development_history_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP<>'INSERT' OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'MINING_DEVELOPMENT_HISTORY_IMMUTABLE'; END IF;
 IF TG_RELID='public.mining_development_transactions'::regclass THEN
  NEW.tx_key:=pg_current_xact_id()::text;
  NEW.observed_at:=public.shardkeep_mining_development_clock();
 ELSIF TG_RELID='public.mining_development_events'::regclass THEN
  IF NEW.tx_key<>pg_current_xact_id()::text OR NOT EXISTS(SELECT 1 FROM public.mining_development_transactions
   WHERE tx_key=NEW.tx_key AND observed_at=NEW.observed_at)
   OR NEW.source_table NOT IN ('bases','buildings','builder_jobs')
   OR NOT EXISTS(SELECT 1 FROM public.mining_development_baselines WHERE base_id=NEW.base_id AND observed_at<=NEW.observed_at)
   THEN RAISE EXCEPTION 'MINING_DEVELOPMENT_SOURCE_INVALID'; END IF;
 ELSE RAISE EXCEPTION 'MINING_DEVELOPMENT_HISTORY_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_mining_development_baseline_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t text; b public.bases%ROWTYPE; observed timestamptz; n bigint;
BEGIN
 IF TG_OP<>'INSERT' OR TG_RELID<>'public.mining_development_baselines'::regclass
  OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  THEN RAISE EXCEPTION 'MINING_DEVELOPMENT_HISTORY_IMMUTABLE'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_DEVELOPMENT_READ_COMMITTED_REQUIRED'; END IF;
 -- Required for atomic first activation and a complete source snapshot. Busy
 -- source writers/readers refuse promptly instead of extending a gameplay lock.
 LOCK TABLE public.bases,public.buildings,public.builder_jobs IN ACCESS EXCLUSIVE MODE NOWAIT;
 LOCK TABLE public.mining_development_baselines IN SHARE ROW EXCLUSIVE MODE NOWAIT;
 LOCK TABLE public.mining_development_events,public.mining_development_transactions IN SHARE MODE NOWAIT;
 SELECT * INTO b FROM public.bases WHERE id=NEW.base_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'MINING_DEVELOPMENT_BASE_UNAVAILABLE'; END IF;
 SELECT count(*) INTO n FROM (SELECT id FROM public.buildings WHERE base_id=b.id LIMIT 10001) bounded;
 IF n>10000 THEN RAISE EXCEPTION 'MINING_DEVELOPMENT_TOO_LARGE'; END IF;
 SELECT count(*) INTO n FROM (SELECT id FROM public.builder_jobs WHERE base_id=b.id LIMIT 10001) bounded;
 IF n>10000 THEN RAISE EXCEPTION 'MINING_DEVELOPMENT_TOO_LARGE'; END IF;
 IF EXISTS(SELECT 1 FROM public.mining_development_transactions WHERE tx_key=pg_current_xact_id()::text) THEN
  RAISE EXCEPTION 'MINING_DEVELOPMENT_BASELINE_REQUIRES_FRESH_TRANSACTION'; END IF;
 IF EXISTS(SELECT 1 FROM public.builder_jobs j JOIN public.buildings target ON target.id=j.building_id
  WHERE (j.base_id=b.id OR target.base_id=b.id) AND j.base_id IS DISTINCT FROM target.base_id) THEN
  RAISE EXCEPTION 'MINING_DEVELOPMENT_SOURCE_CONFLICT'; END IF;
 INSERT INTO public.mining_development_transactions(tx_key) VALUES(pg_current_xact_id()::text) ON CONFLICT DO NOTHING;
 SELECT observed_at INTO STRICT observed FROM public.mining_development_transactions WHERE tx_key=pg_current_xact_id()::text;
 NEW.observed_at:=observed;
 NEW.effective_from:=((observed AT TIME ZONE 'UTC')::date+1)::timestamp AT TIME ZONE 'UTC';
 NEW.base_state:=jsonb_build_object('id',b.id,'owner_wallet',b.owner_wallet,'status',b.status,'keep_level',b.keep_level,
  'land_paid_at',b.land_paid_at,'deed_asset_id',b.deed_asset_id,'deed_mint_asset_id',b.deed_mint_asset_id,'deed_minting_at',b.deed_minting_at);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'base_id',base_id,'type',type,'level',level) ORDER BY id),'[]')
  INTO NEW.buildings FROM public.buildings WHERE base_id=b.id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'base_id',base_id,'building_id',building_id,'kind',kind,
  'started_at',started_at,'finishes_at',finishes_at,'completed_at',completed_at,'cancelled_at',cancelled_at) ORDER BY id),'[]')
  INTO NEW.jobs FROM public.builder_jobs WHERE base_id=b.id;
 FOREACH t IN ARRAY ARRAY['bases','buildings','builder_jobs'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER %I',t,t||'_mining_development_capture');
  EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER %I',t,t||'_mining_development_truncate');
 END LOOP;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_capture_mining_development() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n jsonb; o jsonb; fields text[]; affected uuid[]; target uuid; boundary timestamptz; observed timestamptz; ref text; key text; linked_count bigint;
BEGIN
 -- Runtime EXECUTE/TRIGGER grants cannot attach this definer to a fake table.
 IF TG_RELID NOT IN ('public.bases'::regclass,'public.buildings'::regclass,'public.builder_jobs'::regclass)
  OR (TG_OP='TRUNCATE' AND (TG_NAME<>TG_TABLE_NAME||'_mining_development_truncate' OR TG_LEVEL<>'STATEMENT' OR TG_WHEN<>'BEFORE'))
  OR (TG_OP<>'TRUNCATE' AND (TG_OP NOT IN ('INSERT','UPDATE','DELETE') OR TG_NAME<>TG_TABLE_NAME||'_mining_development_capture' OR TG_LEVEL<>'ROW' OR TG_WHEN<>'AFTER'))
  THEN RAISE EXCEPTION 'MINING_DEVELOPMENT_SOURCE_INVALID'; END IF;
 -- Check before ANY baseline lookup: a stale RR snapshot must not hide a
 -- baseline committed after that reader began. Dormant triggers skip this.
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_DEVELOPMENT_READ_COMMITTED_REQUIRED'; END IF;
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'MINING_DEVELOPMENT_SOURCE_TRUNCATE_FORBIDDEN'; END IF;
 IF TG_OP<>'DELETE' THEN n:=to_jsonb(NEW); END IF;
 IF TG_OP<>'INSERT' THEN o:=to_jsonb(OLD); END IF;
 IF TG_TABLE_NAME='bases' THEN
  fields:=ARRAY['id','owner_wallet','status','keep_level','land_paid_at','deed_asset_id','deed_mint_asset_id','deed_minting_at'];
  affected:=ARRAY[(n->>'id')::uuid,(o->>'id')::uuid];
 ELSIF TG_TABLE_NAME='buildings' THEN
  fields:=ARRAY['id','base_id','type','level']; affected:=ARRAY[(n->>'base_id')::uuid,(o->>'base_id')::uuid];
 ELSE
  fields:=ARRAY['id','base_id','building_id','kind','started_at','finishes_at','completed_at','cancelled_at'];
  affected:=ARRAY[(n->>'base_id')::uuid,(o->>'base_id')::uuid];
 END IF;
 SELECT jsonb_object_agg(k,v) INTO n FROM jsonb_each(n) e(k,v) WHERE k=ANY(fields);
 SELECT jsonb_object_agg(k,v) INTO o FROM jsonb_each(o) e(k,v) WHERE k=ANY(fields);
 IF n IS NOT DISTINCT FROM o THEN RETURN coalesce(NEW,OLD); END IF;
 -- Preserve attribution even for an inconsistent cross-base link. Readers
 -- receive the fact on every affected base and must refuse ambiguous history.
 IF TG_TABLE_NAME='builder_jobs' THEN
  PERFORM id FROM public.buildings WHERE id IN ((n->>'building_id')::uuid,(o->>'building_id')::uuid) ORDER BY id FOR SHARE NOWAIT;
  SELECT affected||coalesce(array_agg(DISTINCT base_id),ARRAY[]::uuid[]) INTO affected FROM public.buildings
   WHERE id IN ((n->>'building_id')::uuid,(o->>'building_id')::uuid);
 ELSIF TG_TABLE_NAME='buildings' THEN
  SELECT count(*) INTO linked_count FROM (SELECT id FROM public.builder_jobs
   WHERE building_id IN ((n->>'id')::uuid,(o->>'id')::uuid) LIMIT 10001) bounded;
  IF linked_count>10000 THEN RAISE EXCEPTION 'MINING_DEVELOPMENT_TOO_LARGE'; END IF;
  PERFORM id FROM public.builder_jobs WHERE building_id IN ((n->>'id')::uuid,(o->>'id')::uuid) ORDER BY id FOR SHARE NOWAIT;
  SELECT affected||coalesce(array_agg(DISTINCT base_id),ARRAY[]::uuid[]) INTO affected FROM public.builder_jobs
   WHERE building_id IN ((n->>'id')::uuid,(o->>'id')::uuid);
 END IF;
 ref:=coalesce(n->>'id',o->>'id');
 -- Hold the capture barrier until the source transaction commits; closed-day
 -- readers take SHARE NOWAIT across sources, baselines, markers and events.
 LOCK TABLE public.mining_development_events IN ROW EXCLUSIVE MODE;
 FOR target,boundary IN SELECT base_id,observed_at FROM public.mining_development_baselines
   WHERE base_id=ANY(affected) ORDER BY base_id LOOP
  IF observed IS NULL THEN
   key:=pg_current_xact_id()::text;
   INSERT INTO public.mining_development_transactions(tx_key) VALUES(key) ON CONFLICT DO NOTHING;
   SELECT observed_at INTO STRICT observed FROM public.mining_development_transactions WHERE tx_key=key;
  END IF;
  IF observed<boundary THEN RAISE EXCEPTION 'MINING_DEVELOPMENT_CLOCK_BEFORE_BASELINE'; END IF;
  INSERT INTO public.mining_development_events(base_id,tx_key,observed_at,source_table,source_id,before_state,after_state)
   VALUES(target,key,observed,TG_TABLE_NAME,ref,o,n);
 END LOOP;
 RETURN coalesce(NEW,OLD);
END $$;
--> statement-breakpoint
DO $migration$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['mining_development_transactions','mining_development_events'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_immutable') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_development_history_guard()',t||'_immutable',t);
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_development_history_guard()',t||'_no_truncate',t);
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_development_baselines'::regclass AND tgname='mining_development_baselines_immutable') THEN
  CREATE TRIGGER mining_development_baselines_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.mining_development_baselines FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_development_baseline_guard();
  CREATE TRIGGER mining_development_baselines_no_truncate BEFORE TRUNCATE ON public.mining_development_baselines FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_development_baseline_guard();
 END IF;
 FOREACH t IN ARRAY ARRAY['bases','buildings','builder_jobs'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_mining_development_capture') THEN
   EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_capture_mining_development()',t||'_mining_development_capture',t);
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_capture_mining_development()',t||'_mining_development_truncate',t);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.mining_development_baselines) THEN
   EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I',t,t||'_mining_development_capture');
   EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I',t,t||'_mining_development_truncate');
  END IF;
 END LOOP;
END $migration$;
REVOKE ALL ON mining_development_baselines,mining_development_transactions,mining_development_events FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_mining_development_clock(),public.shardkeep_mining_development_history_guard(),public.shardkeep_mining_development_baseline_guard(),public.shardkeep_capture_mining_development() FROM PUBLIC;
