-- Prospective recorded Seeker-link coverage. Dormant until the owner initializes
-- the marker; no backfill or replacement of the 0161/0166 capture functions.
-- Existing-source BEFORE TRUNCATE guard is S5-held for separate owner approval.
CREATE TABLE IF NOT EXISTS public.mining_seeker_link_coverage (
 id boolean PRIMARY KEY CHECK(id), started_at timestamptz NOT NULL CHECK(isfinite(started_at)),
 birth_event_floor bigint NOT NULL CHECK(birth_event_floor>=0)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_seeker_link_no_truncate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID<>'public.seeker_links'::regclass OR TG_TABLE_NAME<>'seeker_links'
  OR TG_NAME<>'seeker_links_mining_history_no_truncate' OR TG_OP<>'TRUNCATE' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'STATEMENT'
  THEN RAISE EXCEPTION 'MINING_SEEKER_LINK_SOURCE_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM public.mining_seeker_link_coverage WHERE id) THEN
  RAISE EXCEPTION 'MINING_SEEKER_LINK_HISTORY_RETAINED' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_mining_seeker_link_sources_valid() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT
  (SELECT count(*)=4 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgattr::text='' AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgconstraint=0
   AND t.tgenabled IN ('O','A') AND t.tgfoid='public.shardkeep_capture_mining_free()'::regprocedure AND (
    t.tgrelid='public.players'::regclass AND t.tgname='players_mining_free_capture' AND t.tgtype=29
    OR t.tgrelid='public.players'::regclass AND t.tgname='players_mining_free_truncate' AND t.tgtype=34
    OR t.tgrelid='public.seeker_links'::regclass AND t.tgname='seeker_links_mining_free_capture' AND t.tgtype=29
    OR t.tgrelid='public.seeker_links'::regclass AND t.tgname='seeker_links_mining_free_truncate' AND t.tgtype=34))
  AND EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.seeker_links'::regclass AND t.tgname='seeker_links_mining_history_no_truncate'
   AND t.tgfoid='public.shardkeep_mining_seeker_link_no_truncate()'::regprocedure AND t.tgtype=34 AND t.tgenabled IN ('O','A')
   AND NOT t.tgisinternal AND t.tgattr::text='' AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgconstraint=0)
  AND EXISTS(SELECT 1 FROM public.mining_free_coverage WHERE id)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_seeker_link_coverage_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID<>'public.mining_seeker_link_coverage'::regclass OR TG_TABLE_NAME<>'mining_seeker_link_coverage'
  OR NOT (TG_NAME='mining_seeker_link_coverage_guard' AND TG_WHEN='BEFORE' AND TG_LEVEL='ROW' AND TG_OP IN ('INSERT','UPDATE','DELETE')
   OR TG_NAME='mining_seeker_link_coverage_no_truncate' AND TG_WHEN='BEFORE' AND TG_LEVEL='STATEMENT' AND TG_OP='TRUNCATE')
  THEN RAISE EXCEPTION 'MINING_SEEKER_LINK_SOURCE_INVALID'; END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_SEEKER_LINK_COVERAGE_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  THEN RAISE EXCEPTION 'MINING_SEEKER_LINK_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_SEEKER_LINK_READ_COMMITTED_REQUIRED'; END IF;
 LOCK TABLE public.players,public.seeker_links,public.mining_free_coverage,public.mining_free_cohort_events IN ACCESS EXCLUSIVE MODE NOWAIT;
 IF NOT public.shardkeep_mining_seeker_link_sources_valid() THEN RAISE EXCEPTION 'MINING_SEEKER_LINK_SOURCE_UNAVAILABLE'; END IF;
 NEW.started_at:=public.shardkeep_mining_free_clock();
 IF NOT isfinite(NEW.started_at) OR NEW.started_at<(SELECT started_at FROM public.mining_free_coverage WHERE id)
  THEN RAISE EXCEPTION 'MINING_SEEKER_LINK_CLOCK_INVALID'; END IF;
 SELECT coalesce(max(id),0) INTO NEW.birth_event_floor FROM public.mining_free_cohort_events;
 RETURN NEW;
END $$;
DO $migration$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.seeker_links'::regclass AND tgname='seeker_links_mining_history_no_truncate') THEN
  CREATE TRIGGER seeker_links_mining_history_no_truncate BEFORE TRUNCATE ON public.seeker_links
   FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_seeker_link_no_truncate();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_seeker_link_coverage'::regclass AND tgname='mining_seeker_link_coverage_guard') THEN
  CREATE TRIGGER mining_seeker_link_coverage_guard BEFORE INSERT OR UPDATE OR DELETE ON public.mining_seeker_link_coverage
   FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_seeker_link_coverage_guard();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_seeker_link_coverage'::regclass AND tgname='mining_seeker_link_coverage_no_truncate') THEN
  CREATE TRIGGER mining_seeker_link_coverage_no_truncate BEFORE TRUNCATE ON public.mining_seeker_link_coverage
   FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_seeker_link_coverage_guard();
 END IF;
END $migration$;
REVOKE ALL ON public.mining_seeker_link_coverage FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_mining_seeker_link_sources_valid(),public.shardkeep_mining_seeker_link_no_truncate(),public.shardkeep_mining_seeker_link_coverage_guard() FROM PUBLIC;
