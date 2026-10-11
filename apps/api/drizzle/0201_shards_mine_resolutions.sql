-- D-153 / B4bu: private original Mine resolution evidence.
-- Local registration only; no policy activation, grants, writer mount or backfill.
-- The existing conservation and assessment replacements are separately S5-held in0202.
ALTER TABLE public.shards_mine_segments
 ADD COLUMN IF NOT EXISTS resolved bigint NOT NULL DEFAULT 0 CHECK(resolved>=0),
 ADD COLUMN IF NOT EXISTS recovery_parent_id uuid REFERENCES public.shards_mine_segments(id);
CREATE TABLE IF NOT EXISTS public.shards_mine_resolutions (
 parent_id uuid PRIMARY KEY REFERENCES public.shards_mine_segments(id),
 parent_original jsonb NOT NULL DEFAULT '{}'::jsonb,
 term_source jsonb NOT NULL,custody jsonb NOT NULL,verified_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),CHECK(isfinite(recorded_at))
);
CREATE TABLE IF NOT EXISTS public.shards_mine_resolution_terms (
 segment_id uuid PRIMARY KEY REFERENCES public.shards_mine_segments(id),
 parent_id uuid NOT NULL REFERENCES public.shards_mine_resolutions(parent_id),
 term_id uuid NOT NULL,term_hash text NOT NULL,certificate jsonb NOT NULL,
 FOREIGN KEY(term_id,term_hash) REFERENCES public.expedition_term_snapshots(term_id,snapshot_hash)
);
CREATE INDEX IF NOT EXISTS shards_mine_resolution_children ON public.shards_mine_segments(recovery_parent_id,first_unit);
REVOKE ALL ON public.shards_mine_resolutions,public.shards_mine_resolution_terms FROM PUBLIC;

-- These are consistency checks, not chain authentication. Actual table-owner
-- current_user is required even after accidental runtime INSERT/UPDATE grants.
-- There is no SECURITY DEFINER writer. A future verifier role/capability is a
-- separate trust-boundary decision; arbitrary supplied JSON cannot authorize it.
CREATE OR REPLACE FUNCTION public.shardkeep_mine_resolution_header_guard() RETURNS trigger
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
 IF p.starts_at IS DISTINCT FROM p.anchor_at+(ceil(p.first_unit::numeric*86400000/p.quota)::text||' milliseconds')::interval
 OR p.ends_at IS DISTINCT FROM p.anchor_at+(ceil(p.last_unit::numeric*86400000/p.quota)::text||' milliseconds')::interval
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

CREATE OR REPLACE FUNCTION public.shardkeep_mine_resolution_child_guard() RETURNS trigger
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
 OR NEW.source_key IS DISTINCT FROM 'mine-recovered:'||p.id::text||':u'||NEW.first_unit::text
 OR NEW.starts_at IS DISTINCT FROM p.anchor_at+(ceil(NEW.first_unit::numeric*86400000/p.quota)::text||' milliseconds')::interval
 OR NEW.ends_at IS DISTINCT FROM p.anchor_at+(ceil(NEW.last_unit::numeric*86400000/p.quota)::text||' milliseconds')::interval
 THEN RAISE EXCEPTION 'MINE_RESOLUTION_CHILD';END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_mine_resolution_term_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE s public.shards_mine_segments%ROWTYPE;r public.shards_mine_resolutions%ROWTYPE;
 t public.expedition_term_snapshots%ROWTYPE;c jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINE_RESOLUTION_IMMUTABLE';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 THEN RAISE EXCEPTION 'MINE_RESOLUTION_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 SELECT * INTO STRICT s FROM public.shards_mine_segments WHERE id=NEW.segment_id;
 SELECT * INTO STRICT r FROM public.shards_mine_resolutions WHERE parent_id=NEW.parent_id;
 SELECT * INTO STRICT t FROM public.expedition_term_snapshots WHERE term_id=NEW.term_id AND snapshot_hash=NEW.term_hash;
 c:=NEW.certificate;
 IF s.recovery_parent_id IS DISTINCT FROM NEW.parent_id OR s.admission_id IS NOT NULL
 OR c->>'version' IS DISTINCT FROM '1' OR c->>'purpose' IS DISTINCT FROM 'historical_shards_attribution'
 OR c->'operatingAdmissionAuthorized' IS DISTINCT FROM 'false'::jsonb
 OR c->'snapshot' IS DISTINCT FROM t.snapshot OR c->>'termHash' IS DISTINCT FROM NEW.term_hash
 OR (t.snapshot->'source')-ARRAY['kind','round'] IS DISTINCT FROM r.term_source
 OR s.starts_at<t.starts_at OR s.ends_at>=t.ends_at
 OR NOT coalesce(isfinite((c->>'completedAt')::timestamptz) AND (c->>'completedAt')::timestamptz>=t.starts_at AND (c->>'completedAt')::timestamptz<=s.starts_at,false)
 OR c#>>'{finality,commitment}' IS DISTINCT FROM 'finalized'
 OR NOT coalesce(isfinite((c#>>'{finality,observedAt}')::timestamptz) AND (c#>>'{finality,observedAt}')::timestamptz>=s.ends_at AND (c#>>'{finality,observedAt}')::timestamptz<=r.verified_at,false)
 OR NOT coalesce(c->>'completedSlot'~'^(0|[1-9][0-9]{0,19})$' AND c#>>'{deployment,deployedSlot}'~'^(0|[1-9][0-9]{0,19})$' AND c#>>'{finality,contextSlot}'~'^(0|[1-9][0-9]{0,19})$',false)
 OR (c#>>'{deployment,deployedSlot}')::numeric>(c->>'completedSlot')::numeric
 OR (c->>'completedSlot')::numeric>(c#>>'{finality,contextSlot}')::numeric
 OR (c#>>'{finality,contextSlot}')::numeric>18446744073709551615
 OR NOT coalesce(length(c#>>'{deployment,programDataAddress}')>0,false)
 OR NOT coalesce(c#>>'{deployment,programDataSha256}'~'^[0-9a-f]{64}$',false)
 THEN RAISE EXCEPTION 'MINE_RESOLUTION_TERM';END IF;
 RETURN NEW;
END $$;

-- Check the final graph, so no insertion order or transaction interruption can
-- leave partial parent consumption, missing proof, gaps or overlapping ordinals.
-- Read-only definer lookup preserves ordinary runtime writes without granting
-- SELECT on private recovery evidence. All recovery mutation gates above remain
-- invoker functions and require the actual caller to own their table.
CREATE OR REPLACE FUNCTION public.shardkeep_mine_resolution_complete_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE parent uuid;p public.shards_mine_segments%ROWTYPE;r public.shards_mine_resolutions%ROWTYPE;
 n bigint;first bigint;last bigint;total numeric;bad bigint;
BEGIN
 IF TG_RELID NOT IN ('public.shards_mine_resolutions'::regclass,'public.shards_mine_resolution_terms'::regclass,'public.shards_mine_segments'::regclass)
 OR TG_OP NOT IN ('INSERT','UPDATE') OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'MINE_RESOLUTION_TRIGGER';END IF;
 IF TG_RELID='public.shards_mine_resolutions'::regclass THEN parent:=NEW.parent_id;
 ELSIF TG_RELID='public.shards_mine_resolution_terms'::regclass THEN parent:=NEW.parent_id;
 ELSE parent:=coalesce(NEW.recovery_parent_id,NEW.id);END IF;
 SELECT * INTO r FROM public.shards_mine_resolutions WHERE parent_id=parent;
 IF NOT FOUND THEN
  IF TG_RELID='public.shards_mine_segments'::regclass AND NEW.resolved=0 AND NEW.recovery_parent_id IS NULL THEN RETURN NULL;END IF;
  RAISE EXCEPTION 'MINE_RESOLUTION_HEADER_REQUIRED';
 END IF;
 SELECT * INTO STRICT p FROM public.shards_mine_segments WHERE id=parent;
 IF (to_jsonb(p)-ARRAY['buffer','reserved','issued','discarded','resolved']) IS DISTINCT FROM
    (r.parent_original-ARRAY['buffer','reserved','issued','discarded','resolved'])
 OR p.buffer<>0 OR p.reserved<>0 OR p.issued<>0 OR p.discarded<>0 OR p.resolved<>p.gross
 THEN RAISE EXCEPTION 'MINE_RESOLUTION_CONSERVATION';END IF;
 SELECT count(*),min(first_unit),max(last_unit),sum(gross::numeric),
 count(*) FILTER(WHERE (previous IS NOT NULL AND first_unit<>previous+1) OR proof_id IS NULL)
 INTO n,first,last,total,bad FROM (
  SELECT s.*,lag(s.last_unit) OVER(ORDER BY s.first_unit,s.id) previous,t.segment_id proof_id
  FROM public.shards_mine_segments s LEFT JOIN public.shards_mine_resolution_terms t ON t.segment_id=s.id AND t.parent_id=parent
  WHERE s.recovery_parent_id=parent
 ) children;
 IF n=0 OR first IS DISTINCT FROM p.first_unit OR last IS DISTINCT FROM p.last_unit OR total IS DISTINCT FROM p.gross::numeric OR bad<>0
 THEN RAISE EXCEPTION 'MINE_RESOLUTION_PARTITION';END IF;
 RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.shardkeep_mine_resolution_header_guard(),public.shardkeep_mine_resolution_child_guard(),
 public.shardkeep_mine_resolution_term_guard(),public.shardkeep_mine_resolution_complete_guard() FROM PUBLIC;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['shards_mine_resolutions','shards_mine_resolution_terms'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_guard') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.%I()',t||'_guard',t,CASE WHEN t='shards_mine_resolutions' THEN 'shardkeep_mine_resolution_header_guard' ELSE 'shardkeep_mine_resolution_term_guard' END);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_no_truncate') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_shards_mine_immutable()',t||'_no_truncate',t);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_complete') THEN
   EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mine_resolution_complete_guard()',t||'_complete',t);
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.shards_mine_segments'::regclass AND tgname='shards_mine_resolution_child_guard') THEN
  CREATE TRIGGER shards_mine_resolution_child_guard BEFORE INSERT ON public.shards_mine_segments FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mine_resolution_child_guard();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.shards_mine_segments'::regclass AND tgname='shards_mine_resolution_complete') THEN
  CREATE CONSTRAINT TRIGGER shards_mine_resolution_complete AFTER INSERT OR UPDATE ON public.shards_mine_segments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mine_resolution_complete_guard();
 END IF;
END $$;
