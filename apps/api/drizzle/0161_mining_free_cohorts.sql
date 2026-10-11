-- Prospective unboosted initial-free identity only. Source capture is S5-held.
-- No FK to a live player/base/slot: abandonment never deletes this evidence.
CREATE OR REPLACE FUNCTION public.shardkeep_mining_free_clock() RETURNS timestamptz
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$ SELECT clock_timestamp() $$;
CREATE TABLE IF NOT EXISTS mining_free_coverage (id boolean PRIMARY KEY CHECK(id), started_at timestamptz NOT NULL);
-- Coverage is initialized prospectively by an explicit owner-only operation.
CREATE TABLE IF NOT EXISTS mining_free_cohorts (
 wallet text PRIMARY KEY, base_id uuid NOT NULL UNIQUE, enrolled_at timestamptz NOT NULL,
 effective_from timestamptz NOT NULL, baseline jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS mining_free_cohort_events (
 id bigserial PRIMARY KEY, wallet text NOT NULL, observed_at timestamptz NOT NULL,
 source_table text NOT NULL, source_id text NOT NULL, operation text NOT NULL,
 before_state jsonb, after_state jsonb
);
CREATE INDEX IF NOT EXISTS mining_free_events_wallet_id ON mining_free_cohort_events(wallet,id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_free_history_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t text;
BEGIN
 IF TG_TABLE_NAME='mining_free_coverage' AND TG_OP='INSERT' AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_FREE_READ_COMMITTED_REQUIRED'; END IF;
  LOCK TABLE public.players,public.bases,public.base_slots,public.seeker_links,public.ledger_entries,public.accounts,public.ledger_transactions IN ACCESS EXCLUSIVE MODE NOWAIT;
  FOREACH t IN ARRAY ARRAY['players','bases','base_slots','seeker_links','ledger_entries'] LOOP
   EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER %I',t,t||'_mining_free_capture');
   EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER %I',t,t||'_mining_free_truncate');
  END LOOP;
  FOREACH t IN ARRAY ARRAY['accounts','ledger_transactions'] LOOP
   EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER %I',t,t||'_mining_free_attribution');
  END LOOP;
  NEW.started_at:=public.shardkeep_mining_free_clock(); RETURN NEW;
 END IF;
 IF TG_OP<>'INSERT' OR TG_TABLE_NAME<>'mining_free_cohort_events' OR pg_trigger_depth()<2
  OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN
  RAISE EXCEPTION 'MINING_FREE_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_capture_mining_free() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n jsonb; o jsonb; wallets text[]; w text; observed timestamptz; ref text;
BEGIN
 -- Enabled atomically with coverage. Reject a stale snapshot BEFORE reading it.
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_FREE_READ_COMMITTED_REQUIRED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.mining_free_coverage WHERE id) THEN
  IF TG_OP='TRUNCATE' THEN RETURN NULL; ELSIF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 IF TG_OP='TRUNCATE' THEN
  IF TG_TABLE_NAME='players' THEN RAISE EXCEPTION 'MINING_FREE_BIRTH_RETAINED'; END IF;
  SELECT array_agg(wallet) INTO wallets FROM public.mining_free_cohorts;
  ref:='truncate';
 ELSE
  IF TG_OP<>'DELETE' THEN n:=to_jsonb(NEW); END IF;
  IF TG_OP<>'INSERT' THEN o:=to_jsonb(OLD); END IF;
  IF TG_TABLE_NAME='players' THEN
   SELECT jsonb_object_agg(key,value) INTO n FROM jsonb_each(n) WHERE key=ANY(ARRAY['wallet','created_at']);
   SELECT jsonb_object_agg(key,value) INTO o FROM jsonb_each(o) WHERE key=ANY(ARRAY['wallet','created_at']);
   IF TG_OP='UPDATE' AND n IS NOT DISTINCT FROM o THEN RETURN NEW; END IF;
   wallets:=ARRAY[n->>'wallet',o->>'wallet']; ref:=coalesce(n->>'wallet',o->>'wallet');
  ELSIF TG_TABLE_NAME='bases' THEN
   SELECT jsonb_object_agg(key,value) INTO n FROM jsonb_each(n) WHERE key=ANY(ARRAY['id','owner_wallet','status','land_paid_at','deed_asset_id','deed_mint_asset_id','deed_minting_at']);
   SELECT jsonb_object_agg(key,value) INTO o FROM jsonb_each(o) WHERE key=ANY(ARRAY['id','owner_wallet','status','land_paid_at','deed_asset_id','deed_mint_asset_id','deed_minting_at']);
   IF TG_OP='UPDATE' AND n IS NOT DISTINCT FROM o THEN RETURN NEW; END IF;
   wallets:=ARRAY[n->>'owner_wallet',o->>'owner_wallet']; ref:=coalesce(n->>'id',o->>'id');
   -- Also record a cohort's original base after it transfers away.
   SELECT wallets||coalesce(array_agg(wallet),ARRAY[]::text[]) INTO wallets FROM public.mining_free_cohorts WHERE base_id=ref::uuid;
  ELSIF TG_TABLE_NAME='base_slots' THEN
   SELECT jsonb_object_agg(key,value) INTO n FROM jsonb_each(n) WHERE key=ANY(ARRAY['wallet','base_id','slot','active']);
   SELECT jsonb_object_agg(key,value) INTO o FROM jsonb_each(o) WHERE key=ANY(ARRAY['wallet','base_id','slot','active']);
   IF TG_OP='UPDATE' AND n IS NOT DISTINCT FROM o THEN RETURN NEW; END IF;
   wallets:=ARRAY[n->>'wallet',o->>'wallet']; ref:=coalesce(n->>'base_id',o->>'base_id');
   SELECT wallets||coalesce(array_agg(wallet),ARRAY[]::text[]) INTO wallets FROM public.mining_free_cohorts WHERE base_id IN ((n->>'base_id')::uuid,(o->>'base_id')::uuid);
  ELSIF TG_TABLE_NAME='seeker_links' THEN
   SELECT jsonb_object_agg(key,value) INTO n FROM jsonb_each(n) WHERE key=ANY(ARRAY['wallet','seeker_wallet','sgt_mint','revoked_at']);
   SELECT jsonb_object_agg(key,value) INTO o FROM jsonb_each(o) WHERE key=ANY(ARRAY['wallet','seeker_wallet','sgt_mint','revoked_at']);
   IF TG_OP='UPDATE' AND n IS NOT DISTINCT FROM o THEN RETURN NEW; END IF;
   wallets:=ARRAY[n->>'wallet',o->>'wallet']; ref:=coalesce(n->>'wallet',o->>'wallet');
  ELSE
   PERFORM id FROM public.accounts WHERE id IN ((n->>'account_id')::uuid,(o->>'account_id')::uuid) ORDER BY id FOR SHARE NOWAIT;
   PERFORM id FROM public.ledger_transactions WHERE id IN ((n->>'txn_id')::uuid,(o->>'txn_id')::uuid) ORDER BY id FOR SHARE NOWAIT;
   SELECT jsonb_object_agg(key,value) INTO n FROM jsonb_each(n) WHERE key=ANY(ARRAY['id','txn_id','account_id','delta']);
   SELECT jsonb_object_agg(key,value) INTO o FROM jsonb_each(o) WHERE key=ANY(ARRAY['id','txn_id','account_id','delta']);
   SELECT array_agg(DISTINCT a.owner_wallet) INTO wallets FROM public.accounts a JOIN public.ledger_transactions t
    ON t.id IN ((n->>'txn_id')::uuid,(o->>'txn_id')::uuid)
    WHERE a.id IN ((n->>'account_id')::uuid,(o->>'account_id')::uuid) AND a.kind='player_gems'
    AND t.type IN ('gems.from_keep','gems.buy') AND (coalesce((n->>'delta')::bigint,0)>0 OR coalesce((o->>'delta')::bigint,0)>0);
   IF wallets IS NULL THEN RETURN coalesce(NEW,OLD); END IF;
   ref:=coalesce(n->>'id',o->>'id');
   n:=n||jsonb_build_object('source_type',(SELECT type FROM public.ledger_transactions WHERE id=(n->>'txn_id')::uuid));
   o:=o||jsonb_build_object('source_type',(SELECT type FROM public.ledger_transactions WHERE id=(o->>'txn_id')::uuid));
  END IF;
 END IF;
 -- Snapshot readers take SHARE NOWAIT before sampling their clock.
 LOCK TABLE public.mining_free_cohort_events IN ROW EXCLUSIVE MODE;
 observed:=public.shardkeep_mining_free_clock();
 FOR w IN SELECT DISTINCT x FROM unnest(wallets) x WHERE x IS NOT NULL LOOP
  INSERT INTO public.mining_free_cohort_events(wallet,observed_at,source_table,source_id,operation,before_state,after_state)
   VALUES(w,observed,TG_TABLE_NAME,ref,TG_OP,o,n);
 END LOOP;
 IF TG_OP='TRUNCATE' THEN RETURN NULL; ELSIF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_free_enroll_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b public.bases%ROWTYPE; s public.base_slots%ROWTYPE; p public.players%ROWTYPE;
 coverage timestamptz; prior_coverage timestamptz; observed timestamptz; keep_row public.buildings%ROWTYPE; workshop_row public.buildings%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_FREE_HISTORY_IMMUTABLE'; END IF;
 IF current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'MINING_FREE_OWNER_REQUIRED'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_FREE_READ_COMMITTED_REQUIRED'; END IF;
 LOCK TABLE public.players,public.bases,public.base_slots,public.seeker_links,public.buildings,public.builder_jobs,
  public.player_action_events,public.playtest_activity_coverage,public.accounts,public.ledger_transactions,public.ledger_entries,
  public.mining_free_cohort_events,public.mining_free_coverage IN SHARE MODE NOWAIT;
 SELECT * INTO STRICT p FROM public.players WHERE wallet=NEW.wallet FOR UPDATE NOWAIT;
 SELECT * INTO STRICT b FROM public.bases WHERE id=NEW.base_id FOR UPDATE NOWAIT;
 SELECT * INTO s FROM public.base_slots WHERE base_id=b.id AND wallet=p.wallet AND active FOR UPDATE NOWAIT;
 SELECT started_at INTO coverage FROM public.mining_free_coverage WHERE id;
 SELECT started_at INTO prior_coverage FROM public.playtest_activity_coverage WHERE key='authoritative-v1';
 observed:=public.shardkeep_mining_free_clock();
 IF coverage IS NULL OR prior_coverage IS NULL OR p.created_at<coverage OR p.created_at<prior_coverage OR p.created_at>observed THEN RAISE EXCEPTION 'MINING_FREE_COVERAGE_UNAVAILABLE'; END IF;
 IF (SELECT count(*) FROM public.mining_free_cohort_events WHERE wallet=p.wallet AND source_table='players' AND operation='INSERT')<>1
  OR EXISTS(SELECT 1 FROM public.mining_free_cohort_events WHERE wallet=p.wallet AND source_table='players' AND operation<>'INSERT')
  OR NOT EXISTS(SELECT 1 FROM public.mining_free_cohort_events WHERE wallet=p.wallet AND source_table='players' AND operation='INSERT'
   AND after_state->>'wallet'=p.wallet AND (after_state->>'created_at')::timestamptz=p.created_at
   AND observed_at>=coverage AND (after_state->>'created_at')::timestamptz<=observed_at)
 THEN RAISE EXCEPTION 'MINING_FREE_COVERAGE_UNAVAILABLE'; END IF;
 IF b.owner_wallet<>p.wallet OR b.status<>'active' OR s.base_id IS NULL OR b.land_paid_at IS NOT NULL OR b.deed_asset_id IS NOT NULL
  OR b.deed_mint_asset_id IS NOT NULL OR b.deed_minting_at IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.mining_free_cohort_events e WHERE e.wallet=p.wallet AND e.source_table='bases' AND EXISTS(
   SELECT 1 FROM jsonb_each(coalesce(e.before_state,'{}')) x WHERE x.key IN ('land_paid_at','deed_asset_id','deed_mint_asset_id','deed_minting_at') AND x.value<>'null'::jsonb UNION ALL SELECT 1 FROM jsonb_each(coalesce(e.after_state,'{}')) x WHERE x.key IN ('land_paid_at','deed_asset_id','deed_mint_asset_id','deed_minting_at') AND x.value<>'null'::jsonb))
  OR EXISTS(SELECT 1 FROM public.seeker_links WHERE wallet=p.wallet)
  OR EXISTS(SELECT 1 FROM public.mining_free_cohort_events WHERE wallet=p.wallet AND source_table IN ('seeker_links','ledger_entries'))
  OR EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id JOIN public.ledger_transactions t ON t.id=e.txn_id
   WHERE a.owner_wallet=p.wallet AND a.kind='player_gems' AND e.delta>0 AND t.type IN ('gems.from_keep','gems.buy')) THEN RAISE EXCEPTION 'MINING_FREE_INELIGIBLE'; END IF;
 IF (SELECT count(*) FROM public.mining_free_cohort_events WHERE wallet=p.wallet AND source_table='bases' AND operation='INSERT')<>1
  OR NOT EXISTS(SELECT 1 FROM public.mining_free_cohort_events WHERE wallet=p.wallet AND source_table='bases' AND operation='INSERT' AND source_id=b.id::text)
  OR EXISTS(SELECT 1 FROM public.mining_free_cohort_events WHERE wallet=p.wallet AND source_table='bases' AND source_id<>b.id::text)
  OR EXISTS(SELECT 1 FROM public.bases WHERE owner_wallet=p.wallet AND id<>b.id)
  OR EXISTS(SELECT 1 FROM public.player_action_events WHERE wallet=p.wallet AND source_key='deed_eligibility' AND base_id IS DISTINCT FROM b.id)
  OR NOT EXISTS(SELECT 1 FROM public.player_action_events WHERE wallet=p.wallet AND source_key='deed_eligibility' AND base_id=b.id)
 THEN RAISE EXCEPTION 'MINING_FREE_NOT_INITIAL'; END IF;
 SELECT * INTO keep_row FROM public.buildings WHERE base_id=b.id AND type='keep' ORDER BY id LIMIT 1;
 SELECT * INTO workshop_row FROM public.buildings WHERE base_id=b.id AND type='workshop' ORDER BY id LIMIT 1;
 IF keep_row.id IS NULL OR workshop_row.id IS NULL OR keep_row.level<=0 OR workshop_row.level<=0 OR keep_row.level<>b.keep_level
  OR EXISTS(SELECT 1 FROM public.builder_jobs WHERE building_id IN (keep_row.id,workshop_row.id) AND completed_at IS NULL)
 THEN RAISE EXCEPTION 'MINING_FREE_DEVELOPMENT_REQUIRED'; END IF;
 IF (SELECT count(*) FROM public.mining_free_cohort_events WHERE wallet=p.wallet)>10000
  OR (SELECT count(*) FROM public.player_action_events WHERE wallet=p.wallet AND source_key='deed_eligibility')>10000 THEN RAISE EXCEPTION 'MINING_FREE_HISTORY_TOO_LARGE'; END IF;
 NEW.enrolled_at:=observed;
 NEW.effective_from:=((observed AT TIME ZONE 'UTC')::date+1)::timestamp AT TIME ZONE 'UTC';
 NEW.baseline:=jsonb_build_object('wallet',p.wallet,'baseId',b.id,'slot',s.slot,'keep',jsonb_build_object('id',keep_row.id,'base_id',keep_row.base_id,'player_wallet',keep_row.player_wallet,'type',keep_row.type,'level',keep_row.level),'workshop',jsonb_build_object('id',workshop_row.id,'base_id',workshop_row.base_id,'player_wallet',workshop_row.player_wallet,'type',workshop_row.type,'level',workshop_row.level),
  'coverageStartedAt',coverage,'legacyCoverageStartedAt',prior_coverage,
  'lastEventId',(SELECT coalesce(max(id),0)::text FROM public.mining_free_cohort_events WHERE wallet=p.wallet),
  'sourceEventIds',(SELECT coalesce(jsonb_agg(id::text ORDER BY id),'[]') FROM public.mining_free_cohort_events WHERE wallet=p.wallet),
  'legacyEventIds',(SELECT jsonb_agg(id ORDER BY id) FROM public.player_action_events WHERE wallet=p.wallet AND source_key='deed_eligibility'));
 RETURN NEW;
END $$;
--> statement-breakpoint
-- Once observation is enabled, a credited Gems receipt cannot be retyped or
-- reassigned after classification. Normal balance writes remain unchanged.
CREATE OR REPLACE FUNCTION public.shardkeep_mining_free_attribution_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='accounts' THEN
  IF TG_OP='UPDATE' AND ROW(OLD.id,OLD.kind,OLD.currency,OLD.owner_wallet,OLD.base_id)
   IS NOT DISTINCT FROM ROW(NEW.id,NEW.kind,NEW.currency,NEW.owner_wallet,NEW.base_id) THEN RETURN NEW; END IF;
 END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_FREE_READ_COMMITTED_REQUIRED'; END IF;
 LOCK TABLE public.mining_free_cohort_events IN ROW EXCLUSIVE MODE;
 IF TG_TABLE_NAME='accounts' THEN
  IF (OLD.kind='player_gems' OR (TG_OP='UPDATE' AND NEW.kind='player_gems'))
   AND EXISTS(SELECT 1 FROM public.ledger_entries WHERE account_id=OLD.id AND delta>0) THEN
   RAISE EXCEPTION 'MINING_FREE_ATTRIBUTION_IMMUTABLE'; END IF;
 ELSIF EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id
  WHERE e.txn_id=OLD.id AND e.delta>0 AND a.kind='player_gems') THEN
  RAISE EXCEPTION 'MINING_FREE_ATTRIBUTION_IMMUTABLE';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
--> statement-breakpoint
DO $migration$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['mining_free_coverage','mining_free_cohort_events'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_immutable') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_free_history_guard()',t||'_immutable',t);
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_free_history_guard()',t||'_no_truncate',t);
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_free_cohorts'::regclass AND tgname='mining_free_cohorts_guard') THEN
  CREATE TRIGGER mining_free_cohorts_guard BEFORE INSERT OR UPDATE OR DELETE ON public.mining_free_cohorts FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_free_enroll_guard();
  CREATE TRIGGER mining_free_cohorts_no_truncate BEFORE TRUNCATE ON public.mining_free_cohorts FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_free_history_guard();
 END IF;
 FOREACH t IN ARRAY ARRAY['players','bases','base_slots','seeker_links','ledger_entries'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_mining_free_capture') THEN
   EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_capture_mining_free()',t||'_mining_free_capture',t);
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_capture_mining_free()',t||'_mining_free_truncate',t);
  END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['accounts','ledger_transactions'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_mining_free_attribution') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_free_attribution_guard()',t||'_mining_free_attribution',t);
  END IF;
 END LOOP;
 -- Retry preserves activation. Fresh migrations observe nothing until the
 -- explicit owner initializer enables all source triggers under one barrier.
 IF NOT EXISTS(SELECT 1 FROM public.mining_free_coverage) THEN
  FOREACH t IN ARRAY ARRAY['players','bases','base_slots','seeker_links','ledger_entries'] LOOP
   EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I',t,t||'_mining_free_capture');
   EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I',t,t||'_mining_free_truncate');
  END LOOP;
  FOREACH t IN ARRAY ARRAY['accounts','ledger_transactions'] LOOP
   EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I',t,t||'_mining_free_attribution');
  END LOOP;
 END IF;
END $migration$;
REVOKE ALL ON mining_free_coverage,mining_free_cohorts,mining_free_cohort_events FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_mining_free_clock(),public.shardkeep_mining_free_history_guard(),public.shardkeep_capture_mining_free(),public.shardkeep_mining_free_enroll_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_mining_free_attribution_guard() FROM PUBLIC;
