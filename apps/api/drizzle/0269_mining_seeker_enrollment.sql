-- Prospective existing-link enrollment; no fabricated birth or chain ownership.
-- Empty until an explicit private owner capture; original checkpoint sources stay intact.
CREATE TABLE public.mining_seeker_enrollments(
 id uuid PRIMARY KEY,wallet text NOT NULL,nonce text NOT NULL UNIQUE CHECK(nonce ~ '^[0-9a-f]{64}$'),
 observed_at timestamptz NOT NULL CHECK(isfinite(observed_at)),event_frontier bigint NOT NULL CHECK(event_frontier>=0),
 coverage_started_at timestamptz NOT NULL CHECK(isfinite(coverage_started_at)),
 recorded_history_started_at timestamptz NOT NULL CHECK(isfinite(recorded_history_started_at)),
 birth_event_floor bigint NOT NULL CHECK(birth_event_floor>=0),source_seal text NOT NULL CHECK(source_seal ~ '^[0-9a-f]{64}$'),
 player jsonb NOT NULL CHECK(jsonb_typeof(player)='object'),link jsonb NOT NULL CHECK(jsonb_typeof(link)='object'),
 UNIQUE(wallet,event_frontier)
);
CREATE INDEX mining_seeker_enrollments_wallet_observed ON public.mining_seeker_enrollments(wallet,observed_at,event_frontier);
CREATE TABLE public.mining_seeker_enrollment_contract(singleton boolean PRIMARY KEY CHECK(singleton),record jsonb NOT NULL);
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_mining_seeker_enrollment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP<>'INSERT' OR TG_RELID<>'public.mining_seeker_enrollments'::regclass
  OR TG_NAME<>'mining_seeker_enrollments_immutable' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
  OR current_user<>session_user OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  OR current_setting('session_replication_role')<>'origin'
  THEN RAISE EXCEPTION 'MINING_SEEKER_ENROLLMENT_IMMUTABLE'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_SEEKER_ENROLLMENT_READ_COMMITTED_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND granted AND mode='RowExclusiveLock'
  AND relation IN ('public.players'::regclass,'public.seeker_links'::regclass,'public.mining_free_coverage'::regclass,
   'public.mining_free_cohort_events'::regclass,'public.mining_seeker_link_coverage'::regclass))
  THEN RAISE EXCEPTION 'MINING_SEEKER_ENROLLMENT_REQUIRES_FRESH_TRANSACTION'; END IF;
 LOCK TABLE public.players,public.seeker_links IN ACCESS EXCLUSIVE MODE NOWAIT;
 LOCK TABLE public.mining_free_coverage,public.mining_seeker_link_coverage,public.mining_free_cohort_events IN SHARE MODE NOWAIT;
 LOCK TABLE public.mining_seeker_enrollments,public.mining_seeker_enrollment_contract IN SHARE ROW EXCLUSIVE MODE NOWAIT;
 IF NOT public.shardkeep_mining_seeker_enrollment_sources_valid() THEN RAISE EXCEPTION 'MINING_SEEKER_ENROLLMENT_SOURCE_UNAVAILABLE'; END IF;
 SELECT sc.started_at,sc.birth_event_floor,c.started_at INTO NEW.coverage_started_at,NEW.birth_event_floor,NEW.recorded_history_started_at
  FROM public.mining_seeker_link_coverage sc CROSS JOIN public.mining_free_coverage c WHERE sc.id AND c.id;
 NEW.observed_at:=public.shardkeep_mining_free_clock();
 IF NEW.coverage_started_at IS NULL OR NEW.observed_at IS NULL OR NOT isfinite(NEW.observed_at)
  OR NEW.recorded_history_started_at>NEW.coverage_started_at OR NEW.coverage_started_at>NEW.observed_at
  OR EXISTS(SELECT 1 FROM public.mining_seeker_enrollments WHERE wallet=NEW.wallet AND observed_at>NEW.observed_at)
  THEN RAISE EXCEPTION 'MINING_SEEKER_ENROLLMENT_COVERAGE_UNAVAILABLE'; END IF;
 SELECT jsonb_build_object('wallet',p.wallet,'created_at',to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
  INTO NEW.player FROM public.players p WHERE p.wallet=NEW.wallet AND isfinite(p.created_at) AND p.created_at<=NEW.observed_at;
 SELECT jsonb_build_object('wallet',s.wallet,'seeker_wallet',s.seeker_wallet,'sgt_mint',s.sgt_mint,'revoked_at',NULL)
  INTO NEW.link FROM public.seeker_links s WHERE s.wallet=NEW.wallet AND s.revoked_at IS NULL;
 IF NEW.player IS NULL OR NEW.link IS NULL THEN RAISE EXCEPTION 'MINING_SEEKER_ENROLLMENT_LINK_UNAVAILABLE'; END IF;
 -- The original mint may never move between accounts or change for this account.
 -- Past observed claims remain disqualifying after their current row is deleted.
 IF EXISTS(SELECT 1 FROM public.mining_free_cohort_events e CROSS JOIN LATERAL
  (VALUES(e.before_state),(e.after_state)) s(state) WHERE e.id>NEW.birth_event_floor AND e.source_table='seeker_links'
  AND (s.state->>'sgt_mint'=NEW.link->>'sgt_mint' AND s.state->>'wallet'<>NEW.wallet
    OR s.state->>'wallet'=NEW.wallet AND s.state->>'sgt_mint'<>NEW.link->>'sgt_mint'))
  THEN RAISE EXCEPTION 'MINING_SEEKER_ENROLLMENT_BINDING_UNAVAILABLE'; END IF;
 IF EXISTS(SELECT 1 FROM public.mining_free_cohort_events e WHERE
  (e.wallet=NEW.wallet AND e.source_table IN ('players','seeker_links') OR e.source_table='seeker_links' AND
   (e.before_state->>'sgt_mint'=NEW.link->>'sgt_mint' OR e.after_state->>'sgt_mint'=NEW.link->>'sgt_mint')) AND e.observed_at>NEW.observed_at)
  THEN RAISE EXCEPTION 'MINING_SEEKER_ENROLLMENT_CLOCK_REGRESSION'; END IF;
 NEW.id:=gen_random_uuid();NEW.nonce:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
 SELECT coalesce(max(id),0) INTO NEW.event_frontier FROM public.mining_free_cohort_events;
 SELECT encode(sha256(convert_to(record::text,'UTF8')),'hex') INTO NEW.source_seal FROM public.mining_seeker_enrollment_contract WHERE singleton;
 RETURN NEW;
END $$;
CREATE TRIGGER mining_seeker_enrollments_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.mining_seeker_enrollments FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_seeker_enrollment_guard();
CREATE TRIGGER mining_seeker_enrollments_no_truncate BEFORE TRUNCATE ON public.mining_seeker_enrollments FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_seeker_enrollment_guard();
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_mining_seeker_enrollment_contract() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object(
 'tables',(SELECT jsonb_object_agg(c.relname,jsonb_build_object('owner',c.relowner,'acl',to_jsonb(c.relacl),
  'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid),
  'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY pg_get_indexdef(i.indexrelid)) FROM pg_index i WHERE i.indrelid=c.oid)))
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY(ARRAY['players','seeker_links','mining_free_coverage','mining_free_cohort_events','mining_seeker_link_coverage','mining_seeker_enrollments','mining_seeker_enrollment_contract'])),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('owner',p.proowner,'acl',to_jsonb(p.proacl),'securityDefiner',p.prosecdef,'config',to_jsonb(p.proconfig),'definition',pg_get_functiondef(p.oid)))
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY(ARRAY['shardkeep_mining_free_clock','shardkeep_capture_mining_free','shardkeep_mining_free_history_guard','shardkeep_mining_seeker_link_no_truncate','shardkeep_mining_seeker_link_coverage_guard','shardkeep_mining_seeker_link_sources_valid','shardkeep_mining_seeker_enrollment_guard','shardkeep_mining_seeker_enrollment_contract','shardkeep_mining_seeker_enrollment_sources_valid','shardkeep_mining_seeker_enrollment_seal_guard'])),
 -- Coverage initialization enables dormant capture sites. Their exact enabled
 -- state is checked separately when used; their definitions are pinned here.
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,
  CASE WHEN t.tgname IN('players_mining_free_capture','players_mining_free_truncate','seeker_links_mining_free_capture','seeker_links_mining_free_truncate') THEN 'coverage-enabled' ELSE t.tgenabled::text END,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid,t.tgname)
  FROM pg_trigger t WHERE NOT t.tgisinternal AND (t.tgrelid IN('public.mining_free_coverage'::regclass,'public.mining_free_cohort_events'::regclass,'public.mining_seeker_link_coverage'::regclass,'public.mining_seeker_enrollments'::regclass,'public.mining_seeker_enrollment_contract'::regclass)
   OR t.tgrelid IN('public.players'::regclass,'public.seeker_links'::regclass) AND t.tgname IN('players_mining_free_capture','players_mining_free_truncate','seeker_links_mining_free_capture','seeker_links_mining_free_truncate','seeker_links_mining_history_no_truncate'))))
$$;
CREATE FUNCTION public.shardkeep_mining_seeker_enrollment_sources_valid() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT current_user=session_user AND current_setting('session_replication_role')='origin'
 AND current_setting('transaction_isolation')='read committed'
 AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.mining_seeker_enrollments'::regclass)
 AND public.shardkeep_mining_seeker_link_sources_valid()
 AND (SELECT record FROM public.mining_seeker_enrollment_contract WHERE singleton) IS NOT DISTINCT FROM public.shardkeep_mining_seeker_enrollment_contract()
$$;
CREATE FUNCTION public.shardkeep_mining_seeker_enrollment_seal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF TG_RELID<>'public.mining_seeker_enrollment_contract'::regclass OR TG_OP<>'INSERT' OR TG_NAME<>'mining_seeker_enrollment_contract_immutable' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
 OR current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('session_replication_role')<>'origin'
 OR EXISTS(SELECT 1 FROM public.mining_seeker_enrollment_contract)
 OR NEW.singleton IS DISTINCT FROM true OR NEW.record IS DISTINCT FROM public.shardkeep_mining_seeker_enrollment_contract()
 THEN RAISE EXCEPTION 'MINING_SEEKER_ENROLLMENT_SEAL_IMMUTABLE';END IF;RETURN NEW;
END $$;
CREATE TRIGGER mining_seeker_enrollment_contract_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.mining_seeker_enrollment_contract FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_seeker_enrollment_seal_guard();
CREATE TRIGGER mining_seeker_enrollment_contract_no_truncate BEFORE TRUNCATE ON public.mining_seeker_enrollment_contract FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_seeker_enrollment_seal_guard();
REVOKE ALL ON public.mining_seeker_enrollments,public.mining_seeker_enrollment_contract FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_mining_seeker_enrollment_guard(),public.shardkeep_mining_seeker_enrollment_contract(),public.shardkeep_mining_seeker_enrollment_sources_valid(),public.shardkeep_mining_seeker_enrollment_seal_guard() FROM PUBLIC;
INSERT INTO public.mining_seeker_enrollment_contract(singleton,record) SELECT true,public.shardkeep_mining_seeker_enrollment_contract();
