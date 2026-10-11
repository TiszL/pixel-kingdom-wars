-- D153.179: actual Mine settlement retains an earned numerator. Existing Mine
-- source rows/hashes remain unchanged; no backfill, policy install or role grant.
ALTER TABLE public.mine_accrual_states ADD COLUMN IF NOT EXISTS production_remainder bigint;
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.mine_accrual_states'::regclass AND conname='mine_production_remainder_ck') THEN
  -- 86400000 is MINE_DAY_MS, a time conversion rather than an economy setting.
  ALTER TABLE public.mine_accrual_states ADD CONSTRAINT mine_production_remainder_ck CHECK(production_remainder IS NULL OR production_remainder BETWEEN 0 AND 86399999);
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.shards_mine_production_settlements (
 id uuid PRIMARY KEY,mine_id uuid NOT NULL REFERENCES public.shards_mine_eras(mine_id),
 base_id uuid NOT NULL REFERENCES public.bases(id),wallet text NOT NULL REFERENCES public.players(wallet),
 state_version integer NOT NULL CHECK(state_version>=0),anchor_at timestamptz NOT NULL,
 previous_gross bigint NOT NULL CHECK(previous_gross>=0),remainder_before bigint,
 observed_at timestamptz NOT NULL,quota bigint NOT NULL CHECK(quota>=0),capacity bigint NOT NULL CHECK(capacity>=0),
 gross bigint NOT NULL CHECK(gross>=0),remainder_after bigint NOT NULL CHECK(remainder_after BETWEEN 0 AND 86399999),
 target_buffer bigint NOT NULL CHECK(target_buffer>=0),target_at timestamptz NOT NULL,
 kind text NOT NULL CHECK(kind IN ('capture','reanchor','collect','capacity_discard')),
 execution_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),applied boolean NOT NULL DEFAULT false,
 UNIQUE(mine_id,state_version),CHECK(remainder_before IS NULL OR remainder_before BETWEEN 0 AND 86399999),
 CHECK(isfinite(anchor_at) AND isfinite(observed_at) AND isfinite(target_at))
);
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.shards_mine_production_settlements'::regclass AND conname='mine_production_source_state_fk') THEN
  ALTER TABLE public.shards_mine_production_settlements ADD CONSTRAINT mine_production_source_state_fk
   FOREIGN KEY(mine_id) REFERENCES public.mine_accrual_states(mine_building_id) ON DELETE RESTRICT;
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.shards_mine_segment_production (
 segment_id uuid PRIMARY KEY REFERENCES public.shards_mine_segments(id),
 settlement_id uuid NOT NULL REFERENCES public.shards_mine_production_settlements(id)
);
REVOKE ALL ON public.shards_mine_production_settlements,public.shards_mine_segment_production FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mine_production_settlement_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE s public.mine_accrual_states%ROWTYPE;n numeric;gain numeric;rest numeric;projected numeric;b uuid;w text;
BEGIN
 PERFORM public.shardkeep_mine_production_hooks();
 IF TG_OP='UPDATE' THEN
  IF OLD.applied OR NOT NEW.applied OR (to_jsonb(NEW)-'applied') IS DISTINCT FROM (to_jsonb(OLD)-'applied')
   OR OLD.execution_xid<>pg_current_xact_id() THEN RAISE EXCEPTION 'MINE_PRODUCTION_IMMUTABLE';END IF;
  SELECT * INTO STRICT s FROM public.mine_accrual_states WHERE mine_building_id=OLD.mine_id;
  IF ROW(s.version,s.last_accrual_at,s.accrued_shards,s.production_remainder)
   IS DISTINCT FROM ROW(OLD.state_version+1,OLD.target_at,OLD.target_buffer,OLD.remainder_after)
   THEN RAISE EXCEPTION 'MINE_PRODUCTION_UNPAIRED';END IF;RETURN NEW;
 END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINE_PRODUCTION_IMMUTABLE';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINE_PRODUCTION_ISOLATION';END IF;
 SELECT * INTO STRICT s FROM public.mine_accrual_states WHERE mine_building_id=NEW.mine_id FOR UPDATE NOWAIT;
 SELECT m.base_id,p.owner_wallet INTO b,w FROM public.buildings m JOIN public.bases p ON p.id=m.base_id WHERE m.id=NEW.mine_id AND m.type='mine';
 IF ROW(NEW.base_id,NEW.wallet,NEW.state_version,NEW.anchor_at,NEW.previous_gross,NEW.remainder_before)
  IS DISTINCT FROM ROW(b,w,s.version,s.last_accrual_at,s.accrued_shards,s.production_remainder)
  OR NEW.applied OR NEW.anchor_at<>date_trunc('milliseconds',NEW.anchor_at)
  OR NEW.observed_at<>date_trunc('milliseconds',NEW.observed_at) OR NEW.target_at<>date_trunc('milliseconds',NEW.target_at)
  OR NEW.observed_at<NEW.anchor_at THEN RAISE EXCEPTION 'MINE_PRODUCTION_SOURCE';END IF;
 IF s.production_remainder IS NULL AND (NEW.kind<>'capture' OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID))
 THEN RAISE EXCEPTION 'MINE_PRODUCTION_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 -- D035's physical buffer is one daily quota (MINING.MINE_STORAGE_DAYS=1).
 IF NEW.capacity<>NEW.quota THEN RAISE EXCEPTION 'MINE_PRODUCTION_CAPACITY';END IF;
 IF NEW.kind='capacity_discard' THEN
  IF NEW.quota<=0 OR NEW.previous_gross<NEW.capacity OR coalesce(NEW.remainder_before,0)<=0
   OR NEW.gross<>0 OR NEW.remainder_after<>0 OR NEW.target_at<>NEW.anchor_at OR NEW.target_buffer<>NEW.previous_gross
   THEN RAISE EXCEPTION 'MINE_PRODUCTION_CAPACITY_DISCARD';END IF;
 ELSE
  n:=coalesce(NEW.remainder_before,0)::numeric+NEW.quota::numeric*extract(epoch FROM (NEW.observed_at-NEW.anchor_at))*1000;
  IF NEW.quota=0 THEN gain:=0;rest:=coalesce(NEW.remainder_before,0);
  ELSE
   gain:=greatest(0,least(floor(n/86400000),NEW.capacity::numeric-NEW.previous_gross));
   rest:=CASE WHEN NEW.previous_gross+gain>=NEW.capacity THEN 0 ELSE mod(n,86400000) END;
  END IF;
  projected:=NEW.previous_gross::numeric+gain;
  IF NEW.gross::numeric IS DISTINCT FROM gain OR NEW.remainder_after::numeric IS DISTINCT FROM rest
   OR NEW.target_at<>NEW.observed_at OR NEW.target_buffer::numeric IS DISTINCT FROM (CASE WHEN NEW.kind='collect' THEN 0 ELSE projected END)
   OR (NEW.kind IN ('capture','collect') AND projected=0)
   OR (NEW.kind='capture' AND NEW.gross<=0)
   OR (NEW.remainder_before IS NULL AND projected>=NEW.capacity)
   THEN RAISE EXCEPTION 'MINE_PRODUCTION_ARITHMETIC';END IF;
 END IF;
 NEW.execution_xid:=pg_current_xact_id();RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_mine_production_state_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE p public.shards_mine_production_settlements%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.production_remainder IS NOT NULL THEN RAISE EXCEPTION 'MINE_PRODUCTION_RESET';END IF;RETURN OLD;
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.production_remainder IS NOT NULL THEN RAISE EXCEPTION 'MINE_PRODUCTION_OPENING';END IF;RETURN NEW;
 END IF;
 IF OLD.production_remainder IS NULL AND NEW.production_remainder IS NULL THEN RETURN NEW;END IF;
 PERFORM public.shardkeep_mine_production_hooks();
 IF NEW.production_remainder IS NULL OR NEW.mine_building_id IS DISTINCT FROM OLD.mine_building_id THEN RAISE EXCEPTION 'MINE_PRODUCTION_RESET';END IF;
 IF NEW.version<OLD.version OR NEW.version>OLD.version+1 OR (NEW.accrued_shards IS DISTINCT FROM OLD.accrued_shards AND NEW.version<>OLD.version+1)
 THEN RAISE EXCEPTION 'MINE_PRODUCTION_VERSION';END IF;
 SELECT * INTO p FROM public.shards_mine_production_settlements WHERE mine_id=OLD.mine_building_id AND state_version=OLD.version;
 IF NOT FOUND THEN
  IF ROW(NEW.last_accrual_at,NEW.production_remainder) IS DISTINCT FROM ROW(OLD.last_accrual_at,OLD.production_remainder)
   THEN RAISE EXCEPTION 'MINE_PRODUCTION_SETTLEMENT_REQUIRED';END IF;
  RETURN NEW;
 END IF;
 IF p.applied OR p.execution_xid<>pg_current_xact_id()
  OR ROW(OLD.last_accrual_at,OLD.accrued_shards,OLD.production_remainder) IS DISTINCT FROM ROW(p.anchor_at,p.previous_gross,p.remainder_before)
  OR ROW(NEW.version,NEW.last_accrual_at,NEW.accrued_shards,NEW.production_remainder)
   IS DISTINCT FROM ROW(p.state_version+1,p.target_at,p.target_buffer,p.remainder_after)
 THEN RAISE EXCEPTION 'MINE_PRODUCTION_STATE';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_mine_production_state_applied() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.production_remainder IS NULL AND NEW.production_remainder IS NULL THEN RETURN NULL;END IF;
 UPDATE public.shards_mine_production_settlements SET applied=true
 WHERE mine_id=OLD.mine_building_id AND state_version=OLD.version AND NOT applied AND execution_xid=pg_current_xact_id();
 RETURN NULL;
END $$;
-- Exact original partition, including pre-policy pieces. Mutable balances and
-- recovered children are deliberately excluded from this immutable clock proof.
CREATE OR REPLACE FUNCTION public.shardkeep_mine_production_assert_complete(settlement uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE p public.shards_mine_production_settlements%ROWTYPE;s record;next_unit numeric:=1;first_unit numeric;last_unit numeric;cutoff timestamptz;legacy boolean;
BEGIN
 SELECT * INTO STRICT p FROM public.shards_mine_production_settlements WHERE id=settlement;
 IF NOT p.applied THEN RAISE EXCEPTION 'MINE_PRODUCTION_INCOMPLETE';END IF;
 SELECT b.effective_at INTO cutoff FROM public.shards_mine_eras e JOIN public.shards_mine_policy_boundary b ON b.id=e.policy_boundary_id WHERE e.mine_id=p.mine_id;
 FOR s IN SELECT m.*,c.settlement_id clock_id FROM public.shards_mine_segments m
  LEFT JOIN public.shards_mine_segment_production c ON c.segment_id=m.id
  WHERE m.mine_id=p.mine_id AND m.recovery_parent_id IS NULL
   AND (m.source_key LIKE 'mine:'||p.mine_id::text||':v'||p.state_version::text||':u%'
    OR m.source_key LIKE 'policy-legacy:'||p.mine_id::text||':v'||p.state_version::text||':u%')
  ORDER BY substring(m.source_key FROM ':u([0-9]+)')::numeric,m.id LOOP
  first_unit:=substring(s.source_key FROM ':u([0-9]+)')::numeric;last_unit:=first_unit+s.gross-1;
  legacy:=s.wallet IS NULL;
  IF first_unit IS DISTINCT FROM next_unit OR last_unit>p.gross OR s.gross<=0 OR p.quota<=0
   OR s.base_id<>p.base_id
   OR s.source_key IS DISTINCT FROM (CASE WHEN legacy THEN 'policy-legacy:' ELSE 'mine:' END)||p.mine_id::text||':v'||p.state_version::text||':u'||first_unit::text||':p'||p.id::text
   OR s.starts_at IS DISTINCT FROM p.anchor_at+(ceil((first_unit*86400000-coalesce(p.remainder_before,0))/p.quota)::text||' milliseconds')::interval
   OR s.ends_at IS DISTINCT FROM p.anchor_at+(ceil((last_unit*86400000-coalesce(p.remainder_before,0))/p.quota)::text||' milliseconds')::interval
   OR (legacy AND (cutoff IS NULL OR s.ends_at>=cutoff OR s.quota<>0 OR s.admission_id IS NOT NULL OR s.clock_id IS NOT NULL))
   OR (NOT legacy AND (s.wallet<>p.wallet OR s.quota<>p.quota OR s.anchor_at<>p.anchor_at
    OR s.first_unit<>first_unit OR s.last_unit<>last_unit OR s.clock_id IS DISTINCT FROM p.id
    OR (cutoff IS NOT NULL AND s.starts_at<cutoff)))
   THEN RAISE EXCEPTION 'MINE_PRODUCTION_SEGMENTS';END IF;
  next_unit:=last_unit+1;
 END LOOP;
 IF next_unit IS DISTINCT FROM p.gross::numeric+1 THEN RAISE EXCEPTION 'MINE_PRODUCTION_SEGMENTS';END IF;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_mine_production_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM public.shardkeep_mine_production_hooks();
 PERFORM public.shardkeep_mine_production_assert_complete(NEW.id);RETURN NULL;
END $$;
-- This mutation-side fence also runs after SET CONSTRAINTS has already flushed
-- an earlier settlement. A completed source version cannot gain later rows.
CREATE OR REPLACE FUNCTION public.shardkeep_mine_production_original_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE s public.mine_accrual_states%ROWTYPE;p public.shards_mine_production_settlements%ROWTYPE;marker text;
BEGIN
 IF TG_RELID<>'public.shards_mine_segments'::regclass OR TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINE_PRODUCTION_TRIGGER';END IF;
 IF NEW.recovery_parent_id IS NOT NULL THEN RETURN NEW;END IF;
 marker:=substring(NEW.source_key FROM ':p([0-9a-f-]+)$');
 SELECT * INTO s FROM public.mine_accrual_states WHERE mine_building_id=NEW.mine_id FOR UPDATE NOWAIT;
 IF NEW.source_key LIKE 'legacy:%' OR NEW.source_key LIKE 'legacy-adoption:%' THEN
  -- Opening/adoption happens before this physical production epoch is tracked.
  -- A legacy prefix must never relabel later production as unclocked old stock.
  IF s.production_remainder IS NOT NULL OR NEW.wallet IS NOT NULL OR NEW.admission_id IS NOT NULL
   OR NEW.quota<>0 OR NEW.anchor_at IS NOT NULL OR NEW.first_unit IS NOT NULL OR NEW.last_unit IS NOT NULL
   OR NEW.starts_at<>NEW.ends_at OR NEW.buffer<>NEW.gross OR NEW.reserved<>0 OR NEW.issued<>0 OR NEW.discarded<>0 OR NEW.resolved<>0
   OR NOT (NEW.source_key='legacy:'||NEW.mine_id::text OR NEW.source_key~('^legacy-adoption:[^:]+:'||NEW.mine_id::text||'$'))
   THEN RAISE EXCEPTION 'MINE_PRODUCTION_LEGACY_SOURCE';END IF;
  RETURN NEW;
 END IF;
 IF marker IS NULL AND s.production_remainder IS NULL THEN RETURN NEW;END IF;
 PERFORM public.shardkeep_mine_production_hooks();
 IF marker IS NULL THEN RAISE EXCEPTION 'MINE_PRODUCTION_ORIGINAL_CLOCK';END IF;
 SELECT * INTO p FROM public.shards_mine_production_settlements WHERE id=marker::uuid;
 IF NOT FOUND OR s.mine_building_id IS NULL OR p.applied OR p.execution_xid<>pg_current_xact_id() OR p.state_version<>s.version
  OR p.mine_id<>NEW.mine_id OR p.base_id<>NEW.base_id
  OR NEW.source_key !~ ('^(mine:|policy-legacy:)'||p.mine_id::text||':v'||p.state_version::text||':u[1-9][0-9]*:p'||p.id::text||'$')
  THEN RAISE EXCEPTION 'MINE_PRODUCTION_ORIGINAL_CLOCK';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_mine_production_original_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE marker text;parent_clock uuid;child_clock uuid;
BEGIN
 IF NEW.recovery_parent_id IS NOT NULL THEN
  SELECT substring(source_key FROM ':p([0-9a-f-]+)$') INTO marker FROM public.shards_mine_segments WHERE id=NEW.recovery_parent_id;
  IF marker IS NOT NULL THEN
   PERFORM public.shardkeep_mine_production_hooks();
   SELECT settlement_id INTO parent_clock FROM public.shards_mine_segment_production WHERE segment_id=NEW.recovery_parent_id;
   SELECT settlement_id INTO child_clock FROM public.shards_mine_segment_production WHERE segment_id=NEW.id;
   IF parent_clock IS DISTINCT FROM marker::uuid OR child_clock IS DISTINCT FROM parent_clock
    THEN RAISE EXCEPTION 'MINE_PRODUCTION_CHILD_CLOCK';END IF;
  END IF;RETURN NULL;
 END IF;
 marker:=substring(NEW.source_key FROM ':p([0-9a-f-]+)$');
 IF marker IS NOT NULL THEN
  PERFORM public.shardkeep_mine_production_hooks();
  PERFORM public.shardkeep_mine_production_assert_complete(marker::uuid);
 END IF;RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_mine_production_state_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.mine_accrual_states WHERE production_remainder IS NOT NULL)
  THEN RAISE EXCEPTION 'MINE_PRODUCTION_RESET';END IF;RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_mine_production_completion(segment uuid,unit numeric) RETURNS timestamptz
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE s public.shards_mine_segments%ROWTYPE;r bigint;
BEGIN
 SELECT * INTO STRICT s FROM public.shards_mine_segments WHERE id=segment;
 IF s.source_key~':p[0-9a-f-]+$' THEN
  PERFORM public.shardkeep_mine_production_hooks();
  SELECT coalesce(p.remainder_before,0) INTO r FROM public.shards_mine_segment_production c
  JOIN public.shards_mine_production_settlements p ON p.id=c.settlement_id WHERE c.segment_id=segment;
  IF r IS NULL THEN RAISE EXCEPTION 'MINE_PRODUCTION_MISSING_CLOCK';END IF;
 ELSE r:=0;END IF;
 IF s.quota<=0 OR unit<=0 THEN RAISE EXCEPTION 'MINE_PRODUCTION_COMPLETION';END IF;
 RETURN s.anchor_at+(ceil((unit*86400000-coalesce(r,0))/s.quota)::text||' milliseconds')::interval;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_mine_production_segment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE s public.shards_mine_segments%ROWTYPE;p public.shards_mine_production_settlements%ROWTYPE;original uuid;r bigint;
BEGIN
 PERFORM public.shardkeep_mine_production_hooks();
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINE_PRODUCTION_IMMUTABLE';END IF;
 SELECT * INTO STRICT s FROM public.shards_mine_segments WHERE id=NEW.segment_id;
 SELECT * INTO STRICT p FROM public.shards_mine_production_settlements WHERE id=NEW.settlement_id;
 IF s.recovery_parent_id IS NOT NULL THEN
  SELECT settlement_id INTO original FROM public.shards_mine_segment_production WHERE segment_id=s.recovery_parent_id;
  IF original IS DISTINCT FROM p.id THEN RAISE EXCEPTION 'MINE_PRODUCTION_PARENT_CLOCK';END IF;
 ELSE
  IF p.applied OR p.execution_xid<>pg_current_xact_id()
   OR s.source_key IS DISTINCT FROM 'mine:'||p.mine_id::text||':v'||p.state_version::text||':u'||s.first_unit::text||':p'||p.id::text
   THEN RAISE EXCEPTION 'MINE_PRODUCTION_ORIGINAL_CLOCK';END IF;
 END IF;
 r:=coalesce(p.remainder_before,0);
 IF ROW(s.mine_id,s.base_id,s.wallet,s.anchor_at,s.quota) IS DISTINCT FROM ROW(p.mine_id,p.base_id,p.wallet,p.anchor_at,p.quota)
  OR s.first_unit<=0 OR s.last_unit>p.gross OR s.last_unit-s.first_unit+1<>s.gross OR s.quota<=0
  OR s.starts_at IS DISTINCT FROM s.anchor_at+(ceil((s.first_unit::numeric*86400000-r)/s.quota)::text||' milliseconds')::interval
  OR s.ends_at IS DISTINCT FROM s.anchor_at+(ceil((s.last_unit::numeric*86400000-r)/s.quota)::text||' milliseconds')::interval
 THEN RAISE EXCEPTION 'MINE_PRODUCTION_SEGMENT_CLOCK';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_mine_production_child_clock() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.recovery_parent_id IS NOT NULL AND NEW.source_key~':p[0-9a-f-]+$' THEN
  INSERT INTO public.shards_mine_segment_production(segment_id,settlement_id)
   SELECT NEW.id,settlement_id FROM public.shards_mine_segment_production WHERE segment_id=NEW.recovery_parent_id;
 END IF;RETURN NULL;
END $$;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['shards_mine_production_settlements','shards_mine_segment_production'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_no_truncate') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_shards_mine_immutable()',t||'_no_truncate',t);
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.shards_mine_production_settlements'::regclass AND tgname='mine_production_settlement_guard') THEN
  CREATE TRIGGER mine_production_settlement_guard BEFORE INSERT OR UPDATE OR DELETE ON public.shards_mine_production_settlements FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mine_production_settlement_guard();
  CREATE CONSTRAINT TRIGGER mine_production_complete AFTER INSERT ON public.shards_mine_production_settlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mine_production_complete();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mine_accrual_states'::regclass AND tgname='mine_production_state_guard') THEN
  CREATE TRIGGER mine_production_state_guard BEFORE INSERT OR UPDATE OR DELETE ON public.mine_accrual_states FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mine_production_state_guard();
  CREATE TRIGGER mine_production_state_applied AFTER UPDATE ON public.mine_accrual_states FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mine_production_state_applied();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.shards_mine_segment_production'::regclass AND tgname='mine_production_segment_guard') THEN
  CREATE TRIGGER mine_production_segment_guard BEFORE INSERT OR UPDATE OR DELETE ON public.shards_mine_segment_production FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mine_production_segment_guard();
  CREATE TRIGGER mine_production_child_clock AFTER INSERT ON public.shards_mine_segments FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mine_production_child_clock();
 END IF;
END $$;

--> statement-breakpoint
-- Existing contracts: only versioned clock completion/source-key binding changes.
CREATE OR REPLACE FUNCTION public.shardkeep_mine_resolution_header_guard_production_v2() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE p public.shards_mine_segments%ROWTYPE;c jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINE_RESOLUTION_IMMUTABLE';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 THEN RAISE EXCEPTION 'MINE_RESOLUTION_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINE_RESOLUTION_ISOLATION';END IF;
 IF NOT isfinite(NEW.verified_at) OR NEW.verified_at<>date_trunc('milliseconds',NEW.verified_at)
 THEN RAISE EXCEPTION 'MINE_RESOLUTION_VERIFIED_TIME';END IF;
 SELECT * INTO STRICT p FROM public.shards_mine_segments WHERE id=NEW.parent_id FOR UPDATE NOWAIT;
 IF p.recovery_parent_id IS NOT NULL OR p.resolved<>0 OR p.wallet IS NULL OR p.admission_id IS NOT NULL
 OR p.buffer<>p.gross OR p.reserved<>0 OR p.issued<>0 OR p.discarded<>0 OR p.quota<=0
 OR p.anchor_at IS NULL OR p.anchor_at<>date_trunc('milliseconds',p.anchor_at)
 OR EXISTS(SELECT 1 FROM public.shards_mine_reservations WHERE segment_id=p.id)
 OR EXISTS(SELECT 1 FROM public.shards_mine_deliveries WHERE segment_id=p.id)
 OR EXISTS(SELECT 1 FROM public.shards_mine_dispositions WHERE segment_id=p.id)
 OR EXISTS(SELECT 1 FROM public.shards_tax_assessments WHERE segment_id=p.id)
 THEN RAISE EXCEPTION 'MINE_RESOLUTION_PARENT';END IF;
 -- MINE_DAY_MS is a time conversion, matching baseMining.ts; quota remains the
 -- immutable original source number. Ordinals never restart at a term boundary.
 IF p.starts_at IS DISTINCT FROM public.shardkeep_mine_production_completion(p.id,p.first_unit)
 OR p.ends_at IS DISTINCT FROM public.shardkeep_mine_production_completion(p.id,p.last_unit)
 THEN RAISE EXCEPTION 'MINE_RESOLUTION_PARENT_COMPLETION';END IF;
 c:=NEW.custody;
 IF c->>'version' IS DISTINCT FROM '1' OR c->>'status' IS DISTINCT FROM 'confirmed'
 OR jsonb_typeof(c->'evidence') IS DISTINCT FROM 'object'
 OR c#>>'{evidence,purpose}' IS DISTINCT FROM 'historical_physical_mine_custody'
 OR c#>'{evidence,sourceVerified}' IS DISTINCT FROM 'true'::jsonb
 OR c#>'{evidence,postingAuthorized}' IS DISTINCT FROM 'false'::jsonb
 OR c#>'{evidence,payoutAuthorized}' IS DISTINCT FROM 'false'::jsonb
 OR c#>'{evidence,operatingAdmissionAuthorized}' IS DISTINCT FROM 'false'::jsonb
 OR c-ARRAY['version','evidence'] IS DISTINCT FROM c#>'{evidence,custody}'
 OR c#>>'{evidence,segment,id}' IS DISTINCT FROM p.id::text
 OR jsonb_typeof(c#>'{evidence,rosters}') IS DISTINCT FROM 'array'
 OR NOT (c->'evidence')?'deeds'
 OR c->>'baseId' IS DISTINCT FROM p.base_id::text OR c->>'wallet' IS DISTINCT FROM p.wallet
 OR NOT coalesce(c->>'evidenceSha256'~'^[0-9a-f]{64}$',false)
 OR NOT coalesce(isfinite((c->>'startsAt')::timestamptz) AND (c->>'startsAt')::timestamptz<=p.starts_at,false)
 OR NOT c?'endsAt' OR (c->'endsAt'<>'null'::jsonb AND NOT coalesce(isfinite((c->>'endsAt')::timestamptz) AND (c->>'endsAt')::timestamptz>p.ends_at,false))
 THEN RAISE EXCEPTION 'MINE_RESOLUTION_CUSTODY';END IF;
 IF jsonb_typeof(NEW.term_source) IS DISTINCT FROM 'object'
 OR NOT coalesce(length(NEW.term_source->>'genesisHash')>0 AND length(NEW.term_source->>'programId')>0 AND length(NEW.term_source->>'auctionConfig')>0,false)
 OR NEW.term_source-ARRAY['genesisHash','programId','auctionConfig']<>'{}'::jsonb
 THEN RAISE EXCEPTION 'MINE_RESOLUTION_DOMAIN';END IF;
 NEW.parent_original:=to_jsonb(p);NEW.recorded_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_mine_resolution_child_guard_production_v2() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE p public.shards_mine_segments%ROWTYPE;
BEGIN
 IF NEW.resolved<>0 THEN RAISE EXCEPTION 'MINE_RESOLUTION_INSERT_BALANCE';END IF;
 IF NEW.recovery_parent_id IS NULL THEN RETURN NEW;END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 THEN RAISE EXCEPTION 'MINE_RESOLUTION_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.shards_mine_resolutions WHERE parent_id=NEW.recovery_parent_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'MINE_RESOLUTION_HEADER_REQUIRED';END IF;
 SELECT * INTO STRICT p FROM public.shards_mine_segments WHERE id=NEW.recovery_parent_id FOR UPDATE NOWAIT;
 IF p.recovery_parent_id IS NOT NULL OR ROW(NEW.mine_id,NEW.base_id,NEW.wallet,NEW.anchor_at,NEW.quota)
 IS DISTINCT FROM ROW(p.mine_id,p.base_id,p.wallet,p.anchor_at,p.quota)
 OR NEW.admission_id IS NOT NULL OR NEW.ownership_status<>'confirmed' OR NEW.wallet IS NULL
 OR NEW.first_unit<p.first_unit OR NEW.last_unit>p.last_unit OR NEW.last_unit<NEW.first_unit
 OR NEW.gross<>NEW.last_unit-NEW.first_unit+1 OR NEW.buffer<>NEW.gross
 OR NEW.reserved<>0 OR NEW.issued<>0 OR NEW.discarded<>0
 OR NEW.source_key IS DISTINCT FROM 'mine-recovered:'||p.id::text||':u'||NEW.first_unit::text||coalesce(substring(p.source_key from ':p[0-9a-f-]+$'),'')
 OR NEW.starts_at IS DISTINCT FROM public.shardkeep_mine_production_completion(p.id,NEW.first_unit)
 OR NEW.ends_at IS DISTINCT FROM public.shardkeep_mine_production_completion(p.id,NEW.last_unit)
 THEN RAISE EXCEPTION 'MINE_RESOLUTION_CHILD';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_shards_assessment_insert_guard_production_v2() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source public.shards_cache_sources%ROWTYPE;mine record;entry_count bigint;good_count bigint;expected_count bigint;delta_total numeric;historical record;
BEGIN
 IF TG_RELID NOT IN ('public.shards_tax_assessments'::regclass,'public.shards_cache_assessments'::regclass)
 OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'SHARDS_TAX_TRIGGER';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'SHARDS_TAX_ISOLATION';END IF;
 -- Service writers already take this mutex before custody/ledger locks. Direct
 -- inserts must still serialize across both assessment relations.
 INSERT INTO public.shards_tax_wallet_locks(wallet) VALUES(NEW.wallet) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM public.shards_tax_wallet_locks WHERE wallet=NEW.wallet FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.shards_tax_all_assessments WHERE wallet=NEW.wallet AND lineage=NEW.lineage AND wallet_sequence=NEW.wallet_sequence)
 THEN RAISE EXCEPTION 'SHARDS_TAX_SEQUENCE_DUPLICATE';END IF;
 IF NEW.lineage<>'d150-resource-tax-v1' OR NEW.carry_before>=10000 OR NEW.carry_after>=10000
 OR NEW.tax::numeric<>div(NEW.gross::numeric*2000+NEW.carry_before,10000)
 OR NEW.carry_after::numeric<>mod(NEW.gross::numeric*2000+NEW.carry_before,10000)
 THEN RAISE EXCEPTION 'SHARDS_TAX_ARITHMETIC';END IF;
 IF TG_RELID='public.shards_cache_assessments'::regclass THEN
  SELECT * INTO STRICT source FROM public.shards_cache_sources WHERE operation_key=NEW.operation_key;
  IF ROW(NEW.wallet,NEW.gross,NEW.term_id,NEW.term_hash,NEW.ledger_id)
  IS DISTINCT FROM ROW(source.wallet,source.gross,source.term_id,source.term_hash,source.ledger_id)
  OR NEW.receipt#>>'{source,kind}' IS DISTINCT FROM 'daily_cache'
  OR NEW.receipt#>>'{source,key}' IS DISTINCT FROM NEW.operation_key
  OR NEW.receipt#>>'{source,baseId}' IS DISTINCT FROM source.base_id::text
  OR NEW.receipt#>'{source,earning}' IS DISTINCT FROM jsonb_build_object('kind','instant','at',to_char(source.earned_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  OR NEW.receipt->'term' IS DISTINCT FROM source.observation THEN RAISE EXCEPTION 'SHARDS_CACHE_ASSESSMENT_SOURCE';END IF;
  expected_count:=1+(CASE WHEN NEW.net>0 THEN 1 ELSE 0 END)+(CASE WHEN NEW.tax>0 THEN 1 ELSE 0 END);
  SELECT count(*),count(*) FILTER(WHERE a.currency='SHARDS' AND a.owner_wallet IS NULL AND
   ((a.kind='shard_genesis' AND a.base_id IS NULL AND e.delta=-NEW.gross)
   OR (a.kind='base_shards' AND a.base_id=source.base_id AND NEW.net>0 AND e.delta=NEW.net)
   OR (a.kind='shards_tax_escrow' AND a.base_id IS NULL AND NEW.tax>0 AND e.delta=NEW.tax))),sum(e.delta::numeric)
  INTO entry_count,good_count,delta_total FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id WHERE e.txn_id=NEW.ledger_id;
  IF entry_count<>expected_count OR good_count<>expected_count OR delta_total IS DISTINCT FROM 0::numeric
  THEN RAISE EXCEPTION 'SHARDS_CACHE_ASSESSMENT_LEDGER';END IF;
 -- BEGIN HISTORICAL MINE CHILD
 ELSIF EXISTS(SELECT 1 FROM public.shards_mine_segments WHERE id=NEW.segment_id AND recovery_parent_id IS NOT NULL) THEN
  -- Private committed source evidence, never the receipt's copied authority.
  -- Server reconstruction/replay verifies custody and hashes before money.
  SELECT s.*,p.id AS parent_id,p.gross AS parent_gross,p.first_unit AS parent_first,p.last_unit AS parent_last,
   (ROW(s.mine_id,s.base_id,s.wallet,s.anchor_at,s.quota) IS NOT DISTINCT FROM ROW(p.mine_id,p.base_id,p.wallet,p.anchor_at,p.quota)
    AND p.recovery_parent_id IS NULL AND p.admission_id IS NULL AND p.wallet IS NOT NULL
    AND p.buffer=0 AND p.reserved=0 AND p.issued=0 AND p.discarded=0 AND p.resolved=p.gross
    AND (to_jsonb(p)-ARRAY['buffer','reserved','issued','discarded','resolved'])=(h.parent_original-ARRAY['buffer','reserved','issued','discarded','resolved'])
    AND h.parent_original->>'buffer'=h.parent_original->>'gross' AND h.parent_original->>'reserved'='0'
    AND h.parent_original->>'issued'='0' AND h.parent_original->>'discarded'='0' AND h.parent_original->>'resolved'='0') IS TRUE AS original_matches,
   h.verified_at,h.term_source,h.custody,c.term_id,c.term_hash,c.certificate,t.snapshot,t.starts_at AS term_start,t.ends_at AS term_end,
   d.gross AS delivered_gross,d.net AS delivered_net,d.tax AS delivered_tax,d.ledger_id,d.destination_base_id,
   l.idempotency_key AS ledger_key,l.type AS ledger_type,l.metadata AS ledger_metadata,
   (SELECT count(*) FROM jsonb_array_elements(t.snapshot->'spots') spot WHERE spot->>'ownerWallet' IS NOT NULL) AS winners
  INTO historical FROM public.shards_mine_segments s
   JOIN public.shards_mine_resolutions h ON h.parent_id=s.recovery_parent_id
   JOIN public.shards_mine_segments p ON p.id=h.parent_id
   JOIN public.shards_mine_resolution_terms c ON c.segment_id=s.id AND c.parent_id=p.id
   JOIN public.expedition_term_snapshots t ON t.term_id=c.term_id AND t.snapshot_hash=c.term_hash
   JOIN public.shards_mine_deliveries d ON d.segment_id=s.id AND d.operation_key=NEW.operation_key
   JOIN public.ledger_transactions l ON l.id=d.ledger_id WHERE s.id=NEW.segment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SHARDS_MINE_HISTORICAL_SOURCE';END IF;
  IF NOT historical.original_matches OR historical.admission_id IS NOT NULL OR historical.ownership_status<>'confirmed'
  OR historical.resolved<>0 OR historical.quota<=0 OR historical.first_unit<historical.parent_first OR historical.last_unit>historical.parent_last
  OR historical.gross<>historical.last_unit-historical.first_unit+1 OR NEW.gross>historical.gross
  OR historical.source_key IS DISTINCT FROM 'mine-recovered:'||historical.parent_id::text||':u'||historical.first_unit::text||coalesce(substring(historical.source_key from ':p[0-9a-f-]+$'),'')
  OR historical.starts_at IS DISTINCT FROM public.shardkeep_mine_production_completion(historical.id,historical.first_unit)
  OR historical.ends_at IS DISTINCT FROM public.shardkeep_mine_production_completion(historical.id,historical.last_unit)
  OR ROW(NEW.wallet,NEW.gross,NEW.net,NEW.tax,NEW.term_id,NEW.term_hash,NEW.ledger_id)
   IS DISTINCT FROM ROW(historical.wallet,historical.delivered_gross,historical.delivered_net,historical.delivered_tax,historical.term_id,historical.term_hash,historical.ledger_id)
  OR historical.custody->>'wallet' IS DISTINCT FROM historical.wallet OR historical.custody->>'baseId' IS DISTINCT FROM historical.base_id::text
  OR historical.custody#>>'{evidence,segment,id}' IS DISTINCT FROM historical.parent_id::text
  OR (historical.snapshot->'source')-ARRAY['kind','round'] IS DISTINCT FROM historical.term_source
  OR historical.certificate->'snapshot' IS DISTINCT FROM historical.snapshot OR historical.certificate->>'termHash' IS DISTINCT FROM historical.term_hash
  OR historical.certificate->>'purpose' IS DISTINCT FROM 'historical_shards_attribution'
  OR historical.certificate->'operatingAdmissionAuthorized' IS DISTINCT FROM 'false'::jsonb
  OR historical.starts_at<historical.term_start OR historical.ends_at>=historical.term_end
  OR NOT coalesce((historical.certificate->>'completedAt')::timestamptz<=historical.starts_at
   AND (historical.certificate#>>'{finality,observedAt}')::timestamptz>=historical.ends_at
   AND (historical.certificate#>>'{finality,observedAt}')::timestamptz<=historical.verified_at,false)
  OR NEW.receipt->'version' IS DISTINCT FROM '2'::jsonb OR NEW.receipt->>'purpose' IS DISTINCT FROM 'historical_physical_mine'
  OR NEW.receipt->'sourceVerified' IS DISTINCT FROM 'false'::jsonb OR NEW.receipt->'postingAuthorized' IS DISTINCT FROM 'false'::jsonb
  OR NEW.receipt->'payoutAuthorized' IS DISTINCT FROM 'false'::jsonb OR NEW.receipt->'operatingAdmissionAuthorized' IS DISTINCT FROM 'false'::jsonb
  OR NEW.receipt->'term' IS DISTINCT FROM historical.certificate
  OR NEW.receipt#>>'{source,kind}' IS DISTINCT FROM 'physical_mine'
  OR NEW.receipt#>>'{source,key}' IS DISTINCT FROM historical.source_key||':'||NEW.operation_key
  OR NEW.receipt#>>'{source,baseId}' IS DISTINCT FROM historical.base_id::text
  OR NEW.receipt#>>'{source,authority,classification}' IS DISTINCT FROM 'new_earning'
  OR NEW.receipt#>>'{source,authority,decisionRef}' IS DISTINCT FROM 'physical-mine-historical-source-v1'
  OR NOT coalesce(NEW.receipt#>>'{source,authority,evidenceSha256}'~'^[0-9a-f]{64}$' AND NEW.receipt->>'historicalCertificateHash'~'^[0-9a-f]{64}$',false)
  OR NEW.receipt#>'{source,earning}' IS DISTINCT FROM (CASE WHEN historical.starts_at=historical.ends_at
   THEN jsonb_build_object('kind','instant','at',to_char(historical.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
   ELSE jsonb_build_object('kind','interval','startsAt',to_char(historical.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endsAt',to_char((historical.ends_at+interval '1 millisecond') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END)
  OR NEW.receipt->'policy' IS DISTINCT FROM jsonb_build_object('lineage','d150-resource-tax-v1','version',1,'basisPoints',10000,'islandPoolBps',2000)
  OR NEW.receipt#>>'{carryBefore,wallet}' IS DISTINCT FROM NEW.wallet OR NEW.receipt#>>'{carryAfter,wallet}' IS DISTINCT FROM NEW.wallet
  OR NEW.receipt#>>'{carryBefore,currency}' IS DISTINCT FROM 'SHARDS' OR NEW.receipt#>>'{carryAfter,currency}' IS DISTINCT FROM 'SHARDS'
  OR NEW.receipt#>>'{carryBefore,lineage}' IS DISTINCT FROM NEW.lineage OR NEW.receipt#>>'{carryAfter,lineage}' IS DISTINCT FROM NEW.lineage
  OR NEW.receipt#>>'{pool,termHash}' IS DISTINCT FROM NEW.term_hash OR NEW.receipt#>>'{pool,amount}' IS DISTINCT FROM NEW.tax::text
  OR NEW.receipt#>>'{pool,winnerCount}' IS DISTINCT FROM historical.winners::text
  OR NEW.receipt#>>'{pool,disposition}' IS DISTINCT FROM (CASE WHEN historical.winners=0 THEN 'held_zero_winners' ELSE 'original_winning_spots' END)
  THEN RAISE EXCEPTION 'SHARDS_MINE_HISTORICAL_SOURCE';END IF;
  -- One posting may contain several source parts and raid-liquid legs. The
  -- application verifies its complete entry group; SQL binds this delivery to
  -- that actual operation/destination without pretending one part is the group.
  IF historical.ledger_key IS DISTINCT FROM NEW.operation_key OR historical.ledger_type NOT IN ('mine.collect','raid.loot.settle')
  OR (historical.ledger_type='mine.collect' AND (historical.ledger_metadata->>'baseId' IS DISTINCT FROM historical.destination_base_id::text
   OR historical.ledger_metadata->>'mineBuildingId' IS DISTINCT FROM historical.mine_id::text))
  OR (historical.ledger_type='raid.loot.settle' AND (historical.ledger_metadata->>'defenderBaseId' IS DISTINCT FROM historical.base_id::text
   OR historical.ledger_metadata->>'attackerBaseId' IS DISTINCT FROM historical.destination_base_id::text))
  THEN RAISE EXCEPTION 'SHARDS_MINE_HISTORICAL_LEDGER';END IF;
 -- END HISTORICAL MINE CHILD
 ELSE
  SELECT s.wallet,s.base_id,s.source_key,s.ownership_status,m.wallet AS admitted_wallet,m.term_id,m.term_hash,
   d.gross,d.net,d.tax,d.ledger_id INTO STRICT mine FROM public.shards_mine_segments s
   JOIN public.shards_mine_admissions m ON m.id=s.admission_id
   JOIN public.shards_mine_deliveries d ON d.segment_id=s.id AND d.operation_key=NEW.operation_key WHERE s.id=NEW.segment_id;
  IF mine.ownership_status<>'confirmed' OR mine.wallet IS DISTINCT FROM mine.admitted_wallet
  OR ROW(NEW.wallet,NEW.gross,NEW.net,NEW.tax,NEW.term_id,NEW.term_hash,NEW.ledger_id)
  IS DISTINCT FROM ROW(mine.wallet,mine.gross,mine.net,mine.tax,mine.term_id,mine.term_hash,mine.ledger_id)
  OR NEW.receipt#>>'{source,kind}' IS DISTINCT FROM 'physical_mine'
  OR NEW.receipt#>>'{source,key}' IS DISTINCT FROM mine.source_key||':'||NEW.operation_key
  OR NEW.receipt#>>'{source,baseId}' IS DISTINCT FROM mine.base_id::text THEN RAISE EXCEPTION 'SHARDS_MINE_ASSESSMENT_SOURCE';END IF;
 END IF;
 IF NEW.receipt#>>'{source,wallet}' IS DISTINCT FROM NEW.wallet OR NEW.receipt#>>'{source,gross}' IS DISTINCT FROM NEW.gross::text
 OR NEW.receipt#>>'{source,ledger,transactionId}' IS DISTINCT FROM NEW.ledger_id::text
 OR NEW.receipt#>>'{source,ledger,idempotencyKey}' IS DISTINCT FROM NEW.operation_key
 OR NEW.receipt#>>'{carryBefore,sequence}' IS DISTINCT FROM (NEW.wallet_sequence-1)::text
 OR NEW.receipt#>>'{carryAfter,sequence}' IS DISTINCT FROM NEW.wallet_sequence::text
 OR NEW.receipt#>>'{carryBefore,value}' IS DISTINCT FROM NEW.carry_before::text
 OR NEW.receipt#>>'{carryAfter,value}' IS DISTINCT FROM NEW.carry_after::text
 OR NEW.receipt->>'net' IS DISTINCT FROM NEW.net::text OR NEW.receipt->>'tax' IS DISTINCT FROM NEW.tax::text
 OR NEW.receipt->>'termHash' IS DISTINCT FROM NEW.term_hash
 OR NEW.receipt#>>'{pool,termId}' IS DISTINCT FROM NEW.term_id::text
 THEN RAISE EXCEPTION 'SHARDS_TAX_ASSESSMENT_RECEIPT';END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
CREATE OR REPLACE TRIGGER shards_mine_resolutions_guard BEFORE INSERT OR UPDATE OR DELETE ON public.shards_mine_resolutions FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mine_resolution_header_guard_production_v2();
CREATE OR REPLACE TRIGGER shards_mine_resolution_child_guard BEFORE INSERT ON public.shards_mine_segments FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mine_resolution_child_guard_production_v2();
CREATE OR REPLACE TRIGGER shards_tax_assessments_insert_guard BEFORE INSERT ON public.shards_tax_assessments FOR EACH ROW EXECUTE FUNCTION public.shardkeep_shards_assessment_insert_guard_production_v2();
CREATE OR REPLACE TRIGGER shards_cache_assessments_insert_guard BEFORE INSERT ON public.shards_cache_assessments FOR EACH ROW EXECUTE FUNCTION public.shardkeep_shards_assessment_insert_guard_production_v2();
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.shards_mine_segments'::regclass AND tgname='mine_production_original_guard') THEN
  CREATE TRIGGER mine_production_original_guard BEFORE INSERT ON public.shards_mine_segments FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mine_production_original_guard();
  CREATE CONSTRAINT TRIGGER mine_production_original_complete AFTER INSERT ON public.shards_mine_segments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mine_production_original_complete();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mine_accrual_states'::regclass AND tgname='mine_production_state_truncate') THEN
  CREATE TRIGGER mine_production_state_truncate BEFORE TRUNCATE ON public.mine_accrual_states FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mine_production_state_truncate();
 END IF;
END $$;
-- Guard shape is part of the private consistency boundary. Quota and provider
-- provenance are still the trusted API's responsibility, never an SQL claim.
CREATE OR REPLACE FUNCTION public.shardkeep_mine_production_hooks() RETURNS void
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM (VALUES
  ('shards_mine_production_settlements','mine_production_settlement_guard','shardkeep_mine_production_settlement_guard',31,false),
  ('shards_mine_production_settlements','mine_production_complete','shardkeep_mine_production_complete',5,true),
  ('shards_mine_production_settlements','shards_mine_production_settlements_no_truncate','shardkeep_shards_mine_immutable',34,false),
  ('shards_mine_segment_production','mine_production_segment_guard','shardkeep_mine_production_segment_guard',31,false),
  ('shards_mine_segment_production','shards_mine_segment_production_no_truncate','shardkeep_shards_mine_immutable',34,false),
  ('mine_accrual_states','mine_production_state_guard','shardkeep_mine_production_state_guard',31,false),
  ('mine_accrual_states','mine_production_state_applied','shardkeep_mine_production_state_applied',17,false),
  ('mine_accrual_states','mine_production_state_truncate','shardkeep_mine_production_state_truncate',34,false),
  ('shards_mine_segments','mine_production_original_guard','shardkeep_mine_production_original_guard',7,false),
  ('shards_mine_segments','mine_production_original_complete','shardkeep_mine_production_original_complete',5,true),
  ('shards_mine_segments','mine_production_child_clock','shardkeep_mine_production_child_clock',5,false),
  ('shards_mine_resolutions','shards_mine_resolutions_guard','shardkeep_mine_resolution_header_guard_production_v2',31,false),
  ('shards_mine_segments','shards_mine_resolution_child_guard','shardkeep_mine_resolution_child_guard_production_v2',7,false),
  ('shards_tax_assessments','shards_tax_assessments_insert_guard','shardkeep_shards_assessment_insert_guard_production_v2',7,false),
  ('shards_cache_assessments','shards_cache_assessments_insert_guard','shardkeep_shards_assessment_insert_guard_production_v2',7,false)
 ) e(tab,name,fn,typ,deferred)
 LEFT JOIN pg_class c ON c.oid=to_regclass('public.'||e.tab)
 LEFT JOIN pg_trigger t ON t.tgrelid=c.oid AND t.tgname=e.name
 LEFT JOIN pg_proc f ON f.oid=t.tgfoid
 WHERE t.oid IS NULL OR t.tgenabled<>'O' OR t.tgtype<>e.typ OR t.tgattr<>''::int2vector
  OR t.tgqual IS NOT NULL OR t.tgnargs<>0 OR t.tgisinternal OR t.tgdeferrable<>e.deferred OR t.tginitdeferred<>e.deferred
  OR f.proname<>e.fn OR f.pronamespace<>'public'::regnamespace OR f.proowner<>c.relowner
  OR f.prorettype<>'trigger'::regtype OR f.prosecdef OR f.pronargs<>0)
 THEN RAISE EXCEPTION 'MINE_PRODUCTION_HOOKS_REQUIRED';END IF;
END $$;
SELECT public.shardkeep_mine_production_hooks();
