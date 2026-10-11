-- Prospective committed link checkpoints reuse the immutable 0161/0180 journal.
-- No source capture, activation, public grant or historical backfill is added.
CREATE TABLE IF NOT EXISTS public.mining_seeker_checkpoints(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),wallet text NOT NULL,
 observed_at timestamptz NOT NULL CHECK(isfinite(observed_at)),
 event_frontier bigint NOT NULL CHECK(event_frontier>=0),
 coverage_started_at timestamptz NOT NULL CHECK(isfinite(coverage_started_at)),
 recorded_history_started_at timestamptz NOT NULL CHECK(isfinite(recorded_history_started_at)),
 birth_event_floor bigint NOT NULL CHECK(birth_event_floor>=0),
 birth jsonb NOT NULL CHECK(jsonb_typeof(birth)='object'),
 link jsonb NOT NULL CHECK(jsonb_typeof(link)='object'),
 UNIQUE(wallet,event_frontier)
);
CREATE INDEX IF NOT EXISTS mining_seeker_checkpoints_wallet_observed ON public.mining_seeker_checkpoints(wallet,observed_at,event_frontier);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_seeker_checkpoint_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b record; n bigint;
BEGIN
 IF TG_OP<>'INSERT' OR TG_RELID<>'public.mining_seeker_checkpoints'::regclass
  OR TG_NAME<>'mining_seeker_checkpoints_immutable' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
  OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  THEN RAISE EXCEPTION 'MINING_SEEKER_CHECKPOINT_IMMUTABLE'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_SEEKER_CHECKPOINT_READ_COMMITTED_REQUIRED'; END IF;
 -- A source barrier cannot exclude this transaction's own uncommitted writes.
 -- Reject even display-only source writes and writes before a released savepoint.
 IF EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND granted AND mode='RowExclusiveLock'
  AND relation IN ('public.players'::regclass,'public.seeker_links'::regclass,'public.mining_free_coverage'::regclass,
   'public.mining_free_cohort_events'::regclass,'public.mining_seeker_link_coverage'::regclass))
  THEN RAISE EXCEPTION 'MINING_SEEKER_CHECKPOINT_REQUIRES_FRESH_TRANSACTION'; END IF;
 LOCK TABLE public.players,public.seeker_links IN ACCESS EXCLUSIVE MODE NOWAIT;
 LOCK TABLE public.mining_free_coverage,public.mining_seeker_link_coverage,public.mining_free_cohort_events IN SHARE MODE NOWAIT;
 LOCK TABLE public.mining_seeker_checkpoints IN SHARE ROW EXCLUSIVE MODE NOWAIT;
 IF NOT public.shardkeep_mining_seeker_checkpoint_sources_valid() THEN RAISE EXCEPTION 'MINING_SEEKER_CHECKPOINT_SOURCE_UNAVAILABLE'; END IF;
 SELECT sc.started_at,sc.birth_event_floor,c.started_at INTO NEW.coverage_started_at,NEW.birth_event_floor,NEW.recorded_history_started_at
  FROM public.mining_seeker_link_coverage sc CROSS JOIN public.mining_free_coverage c WHERE sc.id AND c.id;
 NEW.observed_at:=public.shardkeep_mining_free_clock();
 IF NEW.coverage_started_at IS NULL OR NEW.observed_at IS NULL OR NOT isfinite(NEW.observed_at)
  OR NEW.recorded_history_started_at>NEW.coverage_started_at OR NEW.coverage_started_at>NEW.observed_at
  OR EXISTS(SELECT 1 FROM public.mining_seeker_checkpoints WHERE wallet=NEW.wallet AND observed_at>NEW.observed_at)
  THEN RAISE EXCEPTION 'MINING_SEEKER_CHECKPOINT_COVERAGE_UNAVAILABLE'; END IF;
 SELECT count(*) INTO n FROM (SELECT id FROM public.mining_free_cohort_events WHERE wallet=NEW.wallet AND source_table='players' LIMIT 2) births;
 IF n<>1 THEN RAISE EXCEPTION 'MINING_SEEKER_CHECKPOINT_BIRTH_UNAVAILABLE'; END IF;
 SELECT * INTO b FROM public.mining_free_cohort_events WHERE wallet=NEW.wallet AND source_table='players';
 IF (b.operation='INSERT' AND b.source_id=NEW.wallet AND b.before_state IS NULL AND jsonb_typeof(b.after_state)='object'
  AND (SELECT count(*) FROM jsonb_object_keys(b.after_state))=2 AND b.after_state->>'wallet'=NEW.wallet
  AND b.id>NEW.birth_event_floor AND isfinite(b.observed_at) AND b.observed_at>=NEW.coverage_started_at
  AND isfinite((b.after_state->>'created_at')::timestamptz) AND (b.after_state->>'created_at')::timestamptz>=NEW.coverage_started_at
  AND (b.after_state->>'created_at')::timestamptz<=b.observed_at AND b.observed_at<=NEW.observed_at
  AND EXISTS(SELECT 1 FROM public.players p WHERE p.wallet=NEW.wallet AND p.created_at=(b.after_state->>'created_at')::timestamptz)) IS NOT TRUE
  THEN RAISE EXCEPTION 'MINING_SEEKER_CHECKPOINT_BIRTH_UNAVAILABLE'; END IF;
 SELECT jsonb_build_object('wallet',p.wallet,'created_at',to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) INTO NEW.birth FROM public.players p WHERE p.wallet=NEW.wallet;
 SELECT jsonb_build_object('wallet',s.wallet,'seeker_wallet',s.seeker_wallet,'sgt_mint',s.sgt_mint,'revoked_at',NULL)
  INTO NEW.link FROM public.seeker_links s WHERE s.wallet=NEW.wallet AND s.revoked_at IS NULL;
 IF NEW.link IS NULL THEN RAISE EXCEPTION 'MINING_SEEKER_CHECKPOINT_LINK_UNAVAILABLE'; END IF;
 IF EXISTS(SELECT 1 FROM public.mining_free_cohort_events e WHERE
  (e.wallet=NEW.wallet AND e.source_table IN ('players','seeker_links') OR e.source_table='seeker_links' AND
   (e.before_state->>'sgt_mint'=NEW.link->>'sgt_mint' OR e.after_state->>'sgt_mint'=NEW.link->>'sgt_mint')) AND e.observed_at>NEW.observed_at)
  THEN RAISE EXCEPTION 'MINING_SEEKER_CHECKPOINT_CLOCK_REGRESSION'; END IF;
 NEW.id:=gen_random_uuid();SELECT coalesce(max(id),0) INTO NEW.event_frontier FROM public.mining_free_cohort_events;
 RETURN NEW;
END $$;
--> statement-breakpoint
-- Generated only after the original coverage marker committed. A finalized chain
-- Memo echoing this unpredictable nonce supplies causality across clock domains.
CREATE TABLE IF NOT EXISTS public.mining_seeker_coverage_challenges(
 id boolean PRIMARY KEY CHECK(id),nonce text NOT NULL CHECK(nonce ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)),
 coverage_started_at timestamptz NOT NULL CHECK(isfinite(coverage_started_at)),
 recorded_history_started_at timestamptz NOT NULL CHECK(isfinite(recorded_history_started_at)),
 birth_event_floor bigint NOT NULL CHECK(birth_event_floor>=0)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_seeker_challenge_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP<>'INSERT' OR TG_RELID<>'public.mining_seeker_coverage_challenges'::regclass
  OR TG_NAME<>'mining_seeker_coverage_challenges_immutable' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
  OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  THEN RAISE EXCEPTION 'MINING_SEEKER_CHECKPOINT_CHALLENGE_IMMUTABLE'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_SEEKER_CHECKPOINT_READ_COMMITTED_REQUIRED'; END IF;
 -- Even a released savepoint keeps its source write locks. Do not derive a
 -- causal challenge from this transaction's own uncommitted coverage marker.
 IF EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND granted AND mode='RowExclusiveLock'
  AND relation IN ('public.mining_free_coverage'::regclass,'public.mining_seeker_link_coverage'::regclass))
  THEN RAISE EXCEPTION 'MINING_SEEKER_CHECKPOINT_REQUIRES_FRESH_TRANSACTION'; END IF;
 LOCK TABLE public.players,public.seeker_links,public.mining_free_cohort_events,public.mining_free_coverage,public.mining_seeker_link_coverage,public.mining_seeker_checkpoints IN SHARE MODE NOWAIT;
 LOCK TABLE public.mining_seeker_coverage_challenges IN SHARE ROW EXCLUSIVE MODE NOWAIT;
 IF NOT public.shardkeep_mining_seeker_checkpoint_sources_valid() THEN RAISE EXCEPTION 'MINING_SEEKER_CHECKPOINT_SOURCE_UNAVAILABLE'; END IF;
 SELECT sc.started_at,sc.birth_event_floor,c.started_at INTO NEW.coverage_started_at,NEW.birth_event_floor,NEW.recorded_history_started_at
  FROM public.mining_seeker_link_coverage sc CROSS JOIN public.mining_free_coverage c WHERE sc.id AND c.id;
 IF NEW.coverage_started_at IS NULL OR NEW.recorded_history_started_at>NEW.coverage_started_at
  THEN RAISE EXCEPTION 'MINING_SEEKER_CHECKPOINT_COVERAGE_UNAVAILABLE'; END IF;
 -- Caller input never determines the challenge. Clock is audit metadata only;
 -- generation after the committed coverage read is the causal boundary.
 NEW.id:=true;NEW.nonce:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
 NEW.created_at:=public.shardkeep_mining_free_clock();
 IF NEW.created_at IS NULL OR NOT isfinite(NEW.created_at) OR NEW.created_at<NEW.coverage_started_at
  THEN RAISE EXCEPTION 'MINING_SEEKER_CHECKPOINT_CLOCK_REGRESSION'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_seeker_checkpoint_sources_valid() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT public.shardkeep_mining_seeker_link_sources_valid()
 AND (SELECT count(*)=10 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled IN ('O','A')
  AND t.tgattr::text='' AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgconstraint=0 AND (
   t.tgrelid='public.mining_free_coverage'::regclass AND t.tgfoid='public.shardkeep_mining_free_history_guard()'::regprocedure AND (t.tgname='mining_free_coverage_immutable' AND t.tgtype=31 OR t.tgname='mining_free_coverage_no_truncate' AND t.tgtype=34)
   OR t.tgrelid='public.mining_free_cohort_events'::regclass AND t.tgfoid='public.shardkeep_mining_free_history_guard()'::regprocedure AND (t.tgname='mining_free_cohort_events_immutable' AND t.tgtype=31 OR t.tgname='mining_free_cohort_events_no_truncate' AND t.tgtype=34)
   OR t.tgrelid='public.mining_seeker_link_coverage'::regclass AND t.tgfoid='public.shardkeep_mining_seeker_link_coverage_guard()'::regprocedure AND (t.tgname='mining_seeker_link_coverage_guard' AND t.tgtype=31 OR t.tgname='mining_seeker_link_coverage_no_truncate' AND t.tgtype=34)
   OR t.tgrelid='public.mining_seeker_coverage_challenges'::regclass AND t.tgfoid='public.shardkeep_mining_seeker_challenge_guard()'::regprocedure AND (t.tgname='mining_seeker_coverage_challenges_immutable' AND t.tgtype=31 OR t.tgname='mining_seeker_coverage_challenges_no_truncate' AND t.tgtype=34)
   OR t.tgrelid='public.mining_seeker_checkpoints'::regclass AND t.tgfoid='public.shardkeep_mining_seeker_checkpoint_guard()'::regprocedure AND (t.tgname='mining_seeker_checkpoints_immutable' AND t.tgtype=31 OR t.tgname='mining_seeker_checkpoints_no_truncate' AND t.tgtype=34)))
$$;

--> statement-breakpoint
DO $migration$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_seeker_checkpoints'::regclass AND tgname='mining_seeker_checkpoints_immutable') THEN
  CREATE TRIGGER mining_seeker_checkpoints_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.mining_seeker_checkpoints FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_seeker_checkpoint_guard();
  CREATE TRIGGER mining_seeker_checkpoints_no_truncate BEFORE TRUNCATE ON public.mining_seeker_checkpoints FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_seeker_checkpoint_guard();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_seeker_coverage_challenges'::regclass AND tgname='mining_seeker_coverage_challenges_immutable') THEN
  CREATE TRIGGER mining_seeker_coverage_challenges_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.mining_seeker_coverage_challenges FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_seeker_challenge_guard();
  CREATE TRIGGER mining_seeker_coverage_challenges_no_truncate BEFORE TRUNCATE ON public.mining_seeker_coverage_challenges FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_seeker_challenge_guard();
 END IF;
END $migration$;
REVOKE ALL ON public.mining_seeker_checkpoints FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_mining_seeker_checkpoint_guard(),public.shardkeep_mining_seeker_checkpoint_sources_valid() FROM PUBLIC;

REVOKE ALL ON public.mining_seeker_coverage_challenges FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_mining_seeker_challenge_guard() FROM PUBLIC;
