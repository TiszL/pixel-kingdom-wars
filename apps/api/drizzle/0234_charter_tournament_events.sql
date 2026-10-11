-- D153.181 immutable funded weekly tournament. Policy literal generated from
-- shared CHARTER_TOURNAMENT_POLICY; no stock issuance or production tax.
SET LOCAL lock_timeout='10s';
DO $preflight$DECLARE tab text;any_found boolean:=false;BEGIN
 FOREACH tab IN ARRAY ARRAY['charter_tournament_events','charter_tournament_event_terminals','charter_tournament_prize_claims','charter_tournament_event_contract'] LOOP IF to_regclass('public.'||tab) IS NOT NULL THEN any_found:=true;END IF;END LOOP;
 IF any_found THEN
  FOREACH tab IN ARRAY ARRAY['charter_tournament_events','charter_tournament_event_terminals','charter_tournament_prize_claims','charter_tournament_event_contract'] LOOP IF to_regclass('public.'||tab) IS NULL THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_SCHEMA';END IF;END LOOP;
  IF to_regprocedure('public.shardkeep_charter_tournament_event_contract()') IS NULL OR to_regprocedure('public.shardkeep_charter_tournament_event_source()') IS NULL THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_SCHEMA';END IF;
  PERFORM public.shardkeep_charter_tournament_event_source();
 END IF;
END $preflight$;

CREATE TABLE IF NOT EXISTS public.charter_tournament_events(
 id uuid PRIMARY KEY,domain jsonb NOT NULL,week_start timestamptz NOT NULL,sponsor_wallet text NOT NULL REFERENCES public.players(wallet),
 policy jsonb NOT NULL,budget jsonb NOT NULL,funding jsonb NOT NULL,funded_at timestamptz NOT NULL,tx_key text NOT NULL,
 UNIQUE(domain,week_start),CHECK(isfinite(week_start) AND isfinite(funded_at) AND funded_at<week_start)
);
CREATE TABLE IF NOT EXISTS public.charter_tournament_event_terminals(
 event_id uuid PRIMARY KEY REFERENCES public.charter_tournament_events(id),record jsonb NOT NULL,completed_at timestamptz NOT NULL CHECK(isfinite(completed_at)),tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_tournament_prize_claims(
 event_id uuid NOT NULL REFERENCES public.charter_tournament_event_terminals(event_id),wallet text NOT NULL REFERENCES public.players(wallet),
 base_id uuid NOT NULL REFERENCES public.bases(id),amounts jsonb NOT NULL,stock jsonb NOT NULL,claimed_at timestamptz NOT NULL CHECK(isfinite(claimed_at)),tx_key text NOT NULL,
 PRIMARY KEY(event_id,wallet)
);
CREATE TABLE IF NOT EXISTS public.charter_tournament_event_contract(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),record jsonb NOT NULL);
-- Ordinary stock writes only look for witnesses from their own transaction.
CREATE INDEX IF NOT EXISTS charter_tournament_events_tx_key_idx ON public.charter_tournament_events(tx_key);
CREATE INDEX IF NOT EXISTS charter_tournament_prize_claims_tx_key_idx ON public.charter_tournament_prize_claims(tx_key);

CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_event_contract() RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
 SELECT jsonb_build_object('tables',(SELECT jsonb_object_agg(c.relname,jsonb_build_object('owner',c.relowner,'acl',to_jsonb(c.relacl),'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid),'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY pg_get_indexdef(i.indexrelid)) FROM pg_index i WHERE i.indrelid=c.oid))) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(ARRAY['charter_tournament_events','charter_tournament_event_terminals','charter_tournament_prize_claims','charter_tournament_event_contract'])),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('owner',p.proowner,'securityDefiner',p.prosecdef,'config',to_jsonb(p.proconfig),'definition',pg_get_functiondef(p.oid))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY(ARRAY['shardkeep_charter_tournament_event_contract','shardkeep_charter_tournament_event_source','shardkeep_charter_tournament_event_guard','charter_tournament_event_terms','charter_tournament_event_terminal','shardkeep_charter_tournament_settlement','shardkeep_charter_tournament_stock_conserved','shardkeep_charter_tournament_stock_guard'])),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid,t.tgname) FROM pg_trigger t WHERE NOT t.tgisinternal AND (t.tgrelid=ANY(ARRAY['public.charter_tournament_events'::regclass,'public.charter_tournament_event_terminals'::regclass,'public.charter_tournament_prize_claims'::regclass,'public.charter_tournament_event_contract'::regclass]) OR (t.tgrelid='public.crafting_stocks'::regclass AND t.tgname IN('crafting_stocks_charter_tournament_guard','crafting_stocks_charter_tournament_no_truncate')))))
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_event_source() RETURNS void LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$BEGIN
 IF current_user<>session_user OR current_setting('session_replication_role')<>'origin' THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_SOURCE';END IF;
 IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.charter_tournament_event_contract'::regclass)) OR current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_OWNER_ISOLATION';END IF;
 IF (SELECT record FROM public.charter_tournament_event_contract WHERE singleton) IS DISTINCT FROM public.shardkeep_charter_tournament_event_contract() THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_SOURCE';END IF;
END $$;

CREATE OR REPLACE FUNCTION public.charter_tournament_event_terms(eid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$DECLARE e public.charter_tournament_events;BEGIN
 PERFORM public.shardkeep_charter_tournament_event_source();SELECT * INTO STRICT e FROM public.charter_tournament_events WHERE id=eid;
 RETURN jsonb_build_object('version',1,'id',e.id,'domain',e.domain,'sponsorWallet',e.sponsor_wallet,
 'entryStartsAt',to_char(e.week_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'playStartsAt',to_char((e.week_start+interval '1 day') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'playEndsAt',to_char((e.week_start+interval '2 days') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'occupationEndsAt',to_char((e.week_start+interval '9 days') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'policy',e.policy,'budget',e.budget);
END $$;
CREATE OR REPLACE FUNCTION public.charter_tournament_event_terminal(eid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$DECLARE r jsonb;BEGIN
 PERFORM public.shardkeep_charter_tournament_event_source();SELECT record INTO STRICT r FROM public.charter_tournament_event_terminals WHERE event_id=eid;
 RETURN r;
END $$;

-- Input scores can only come from the original admission/replay source hook in
-- 0236. Missing source or pending admitted battle means no terminal. Unresolved
-- private lock operations stay fenced but cannot hold the whole event open.
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_settlement(eid uuid,at_time timestamptz) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.charter_tournament_events;entries jsonb;scores jsonb;rankings jsonb;occupations jsonb:='[]';entitlements jsonb:='{}';ranking jsonb;entry jsonb;wallet text;item text;qty bigint;share bigint;member_share bigint;remaining bigint;winners integer;position integer:=0;amounts jsonb;result jsonb;
BEGIN
 PERFORM public.shardkeep_charter_tournament_event_source();SELECT * INTO STRICT e FROM public.charter_tournament_events WHERE id=eid FOR UPDATE NOWAIT;
 IF NOT isfinite(at_time) OR at_time<e.week_start+interval '2 days' THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_WINDOW';END IF;
 PERFORM public.shardkeep_charter_tournament_assert_closable(eid);
 entries:=public.shardkeep_charter_tournament_entries(eid);
 scores:=public.shardkeep_charter_tournament_scores(eid);
 WITH valueset AS(SELECT x.value AS score,(SELECT jsonb_array_length(en->'roster') FROM jsonb_array_elements(entries) en WHERE en->>'clanId'=x.value->>'clanId') AS n FROM jsonb_array_elements(scores) x),
 ranked AS(SELECT a.score||jsonb_build_object('rosterSize',a.n) AS score,(SELECT count(*) FROM valueset b WHERE (b.score->>'stars')::bigint*a.n>(a.score->>'stars')::bigint*b.n OR ((b.score->>'stars')::bigint*a.n=(a.score->>'stars')::bigint*b.n AND ((b.score->>'destruction')::bigint*a.n>(a.score->>'destruction')::bigint*b.n OR ((b.score->>'destruction')::bigint*a.n=(a.score->>'destruction')::bigint*b.n AND (b.score->>'clanId') COLLATE "C"<(a.score->>'clanId') COLLATE "C")))) AS ordinal FROM valueset a)
 SELECT coalesce(jsonb_agg(score ORDER BY ordinal),'[]') INTO rankings FROM ranked;
 winners:=least(jsonb_array_length(rankings),(e.policy->>'divineSites')::integer);
 FOR ranking IN SELECT value FROM jsonb_array_elements(rankings) LIMIT winners LOOP
  position:=position+1;occupations:=occupations||jsonb_build_array(jsonb_build_object('site',position,'clanId',ranking->>'clanId'));
 END LOOP;
 FOR item,qty IN SELECT key,value::text::bigint FROM jsonb_each_text(e.budget) LOOP
  remaining:=qty;
  IF winners>0 THEN
   share:=qty/winners;
   FOR ranking IN SELECT value FROM jsonb_array_elements(rankings) LIMIT winners LOOP
    SELECT value INTO STRICT entry FROM jsonb_array_elements(entries) WHERE value->>'clanId'=ranking->>'clanId';
    member_share:=share/jsonb_array_length(entry->'roster');
    FOR wallet IN SELECT jsonb_array_elements_text(entry->'roster') LOOP
     amounts:=coalesce(entitlements->wallet,'{}');amounts:=jsonb_set(amounts,ARRAY[item],to_jsonb((coalesce((amounts->>item)::bigint,0)+member_share)::text));
     entitlements:=jsonb_set(entitlements,ARRAY[wallet],amounts);remaining:=remaining-member_share;
    END LOOP;
   END LOOP;
  END IF;
  amounts:=coalesce(entitlements->e.sponsor_wallet,'{}');amounts:=jsonb_set(amounts,ARRAY[item],to_jsonb((coalesce((amounts->>item)::bigint,0)+remaining)::text));entitlements:=jsonb_set(entitlements,ARRAY[e.sponsor_wallet],amounts);
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('wallet',key,'amounts',value) ORDER BY key COLLATE "C"),'[]') INTO result FROM jsonb_each(entitlements);
 RETURN jsonb_build_object('version',1,'eventId',eid,'completedAt',to_char(at_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'rankings',rankings,'occupations',occupations,'entitlements',result);
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_event_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE item text;qty bigint;before_qty bigint;pending bigint;stock jsonb:='[]';base uuid;actor text;proof jsonb;at_time timestamptz;expected jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='charter_tournament_event_contract' THEN
  IF NOT EXISTS(SELECT 1 FROM public.charter_tournament_event_contract) AND NEW.record=public.shardkeep_charter_tournament_event_contract() THEN RETURN NEW;END IF;
  RAISE EXCEPTION 'CHARTER_TOURNAMENT_IMMUTABLE';END IF;
 PERFORM public.shardkeep_charter_tournament_event_source();
 IF TG_TABLE_NAME='charter_tournament_events' THEN
  IF NEW.policy IS DISTINCT FROM '{"version":1,"entryWeekdayUtc":6,"entryDurationDays":1,"playDurationDays":1,"occupationDurationDays":7,"raidsPerWallet":3,"maxPendingRequestsPerWallet":1,"maxRequestIdentitiesPerWallet":16,"divineSites":50,"maxStarsPerRaid":3,"maxDestructionPerRaid":100,"maxReplayInputBytes":16777216,"rosterCap":20,"freeRaidsPerBaseDay":6,"prizeItems":["frostglass","heartwood_beams","sunstone_blocks","crownsteel","prismstone_lens","stormalloy","thornsilk","embercore"],"fragments":"held","prizeSource":"funded-existing-refined-stock"}'::jsonb OR jsonb_typeof(NEW.domain)<>'object' OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.domain) key) IS DISTINCT FROM ARRAY['craftProgram','economyProgram','genesisHash','treasury']::text[] OR EXISTS(SELECT 1 FROM jsonb_each_text(NEW.domain) WHERE value!~'^[1-9A-HJ-NP-Za-km-z]{32,44}$') OR NEW.sponsor_wallet!~'^[1-9A-HJ-NP-Za-km-z]{32,44}$' THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_POLICY';END IF;
  IF extract(dow FROM NEW.week_start AT TIME ZONE 'UTC')<>6 OR date_trunc('day',NEW.week_start AT TIME ZONE 'UTC')<>NEW.week_start AT TIME ZONE 'UTC' OR NOT isfinite(NEW.funded_at) OR NEW.funded_at>=NEW.week_start THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_WINDOW';END IF;
  IF jsonb_typeof(NEW.budget)<>'object' OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.budget) key) IS DISTINCT FROM ARRAY['crownsteel','embercore','frostglass','heartwood_beams','prismstone_lens','stormalloy','sunstone_blocks','thornsilk']::text[] OR EXISTS(SELECT 1 FROM jsonb_each(NEW.budget) WHERE jsonb_typeof(value)<>'string' OR value#>>'{}'!~'^(0|[1-9][0-9]{0,18})$' OR (value#>>'{}')::numeric>9223372036854775807) OR NOT EXISTS(SELECT 1 FROM jsonb_each_text(NEW.budget) WHERE value::numeric>0) THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_BUDGET';END IF;
  LOCK TABLE public.charter_tournament_events IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  IF EXISTS(SELECT 1 FROM public.charter_tournament_events WHERE id=NEW.id OR (domain=NEW.domain AND week_start=NEW.week_start)) THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_ALREADY_FUNDED';END IF;
  base:=(NEW.funding->>'baseId')::uuid;actor:=NEW.sponsor_wallet;at_time:=NEW.funded_at;proof:=NEW.budget;
 ELSIF TG_TABLE_NAME='charter_tournament_event_terminals' THEN
  NEW.record:=public.shardkeep_charter_tournament_settlement(NEW.event_id,NEW.completed_at);NEW.tx_key:=pg_current_xact_id()::text;RETURN NEW;
 ELSE
  expected:=public.charter_tournament_event_terminal(NEW.event_id);
  IF NEW.claimed_at<(expected->>'completedAt')::timestamptz THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_CLAIM_TIME';END IF;
  SELECT value->'amounts' INTO STRICT proof FROM jsonb_array_elements(expected->'entitlements') WHERE value->>'wallet'=NEW.wallet;
  NEW.amounts:=proof;base:=NEW.base_id;actor:=NEW.wallet;at_time:=NEW.claimed_at;
 END IF;
 -- Same player -> base -> slot order as fresh authority and deed transfer.
 PERFORM 1 FROM public.players WHERE wallet=actor FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_OWNER';END IF;
 IF TG_TABLE_NAME='charter_tournament_prize_claims' THEN
  IF EXISTS(SELECT 1 FROM public.charter_tournament_prize_claims WHERE event_id=NEW.event_id AND wallet=NEW.wallet) THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_ALREADY_CLAIMED';END IF;
 END IF;
 PERFORM 1 FROM public.bases WHERE id=base AND owner_wallet=actor AND status='active' FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_OWNER';END IF;
 PERFORM 1 FROM public.base_slots WHERE base_id=base AND wallet=actor AND active FOR UPDATE NOWAIT;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.base_raid_locks WHERE base_id=base) OR EXISTS(SELECT 1 FROM public.raids WHERE attacker_base_id=base AND status IN('pending_orders','resolving')) THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_BASE_BUSY';END IF;
 FOR item,qty IN SELECT key,value::bigint FROM jsonb_each_text(proof) ORDER BY key LOOP
  INSERT INTO public.crafting_stocks(base_id,item_id) VALUES(base,item) ON CONFLICT DO NOTHING;
  SELECT available,pending_output INTO STRICT before_qty,pending FROM public.crafting_stocks WHERE base_id=base AND item_id=item FOR UPDATE NOWAIT;
  IF TG_TABLE_NAME='charter_tournament_events' THEN
   IF before_qty<qty THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_FUNDS';END IF;
   UPDATE public.crafting_stocks SET available=available-qty WHERE base_id=base AND item_id=item;
   stock:=stock||jsonb_build_array(jsonb_build_object('itemId',item,'before',before_qty::text,'after',(before_qty-qty)::text,'quantity',qty::text));
  ELSE
   IF before_qty::numeric+pending::numeric+qty::numeric>9223372036854775807 THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_STORAGE_FULL';END IF;
   UPDATE public.crafting_stocks SET available=available+qty WHERE base_id=base AND item_id=item;
   stock:=stock||jsonb_build_array(jsonb_build_object('itemId',item,'before',before_qty::text,'after',(before_qty+qty)::text,'quantity',qty::text));
  END IF;
 END LOOP;
 IF TG_TABLE_NAME='charter_tournament_events' THEN NEW.funding:=jsonb_build_object('baseId',base,'stock',stock,'fundedAt',to_char(at_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));ELSE NEW.stock:=stock;END IF;
 NEW.tx_key:=pg_current_xact_id()::text;RETURN NEW;
END $$;
-- Prove the event's entire available-stock effect at the original commit.
-- No action in the same transaction may restore debited prize stock or erase
-- credited rights while retaining a seemingly valid immutable source receipt.
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_stock_conserved() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE proof jsonb;base uuid;item jsonb;quantity bigint;BEGIN
 PERFORM public.shardkeep_charter_tournament_event_source();
 IF TG_TABLE_NAME='charter_tournament_events' THEN proof:=NEW.funding->'stock';base:=(NEW.funding->>'baseId')::uuid;ELSE proof:=NEW.stock;base:=NEW.base_id;END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(proof) LOOP
  SELECT available INTO STRICT quantity FROM public.crafting_stocks WHERE base_id=base AND item_id=item->>'itemId';
  IF quantity IS DISTINCT FROM (item->>'after')::bigint THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_STOCK_CONSERVATION';END IF;
 END LOOP;
 RETURN NULL;
END $$;
-- A deferred proof alone can be flushed with SET CONSTRAINTS. Once its immutable
-- receipt exists, every later mutation in that same transaction must preserve
-- the witnessed row identity and available stock. Ordinary later transactions
-- remain free to consume or produce existing crafting stock.
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_stock_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE old_base uuid;new_base uuid;old_item text;new_item text;xid text:=pg_current_xact_id()::text;
BEGIN
 IF TG_RELID<>'public.crafting_stocks'::regclass OR TG_WHEN<>'BEFORE' OR TG_NARGS<>0 OR TG_OP NOT IN('INSERT','UPDATE','DELETE','TRUNCATE')
  OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'crafting_stocks_charter_tournament_no_truncate' ELSE 'crafting_stocks_charter_tournament_guard' END)
  OR TG_LEVEL<>(CASE WHEN TG_OP='TRUNCATE' THEN 'STATEMENT' ELSE 'ROW' END)
 THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_STOCK_TRIGGER';END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.base_id,NEW.item_id,NEW.available) IS NOT DISTINCT FROM (OLD.base_id,OLD.item_id,OLD.available) THEN RETURN NEW;END IF;
 END IF;
 IF TG_OP IN('UPDATE','DELETE') THEN old_base:=OLD.base_id;old_item:=OLD.item_id;END IF;
 IF TG_OP IN('UPDATE','INSERT') THEN new_base:=NEW.base_id;new_item:=NEW.item_id;END IF;
 IF EXISTS(SELECT 1 FROM public.charter_tournament_events e CROSS JOIN LATERAL jsonb_array_elements(e.funding->'stock') s
   WHERE e.tx_key=xid AND (TG_OP='TRUNCATE' OR ((e.funding->>'baseId')::uuid,s->>'itemId') IN((old_base,old_item),(new_base,new_item))))
  OR EXISTS(SELECT 1 FROM public.charter_tournament_prize_claims c CROSS JOIN LATERAL jsonb_array_elements(c.stock) s
   WHERE c.tx_key=xid AND (TG_OP='TRUNCATE' OR (c.base_id,s->>'itemId') IN((old_base,old_item),(new_base,new_item))))
 THEN
  IF current_setting('role')<>'none' THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_OWNER_ISOLATION';END IF;
  PERFORM public.shardkeep_charter_tournament_event_source();
  RAISE EXCEPTION 'CHARTER_TOURNAMENT_STOCK_CONSERVATION';
 END IF;
 IF TG_OP='TRUNCATE' THEN RETURN NULL;ELSIF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.crafting_stocks'::regclass AND tgname='crafting_stocks_charter_tournament_guard') THEN
  CREATE TRIGGER crafting_stocks_charter_tournament_guard BEFORE INSERT OR UPDATE OR DELETE ON public.crafting_stocks FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_tournament_stock_guard();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.crafting_stocks'::regclass AND tgname='crafting_stocks_charter_tournament_no_truncate') THEN
  CREATE TRIGGER crafting_stocks_charter_tournament_no_truncate BEFORE TRUNCATE ON public.crafting_stocks FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_tournament_stock_guard();
 END IF;
END $$;
DO $$DECLARE tab text;BEGIN FOREACH tab IN ARRAY ARRAY['charter_tournament_events','charter_tournament_prize_claims'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_stock_conserved') THEN
  EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_tournament_stock_conserved()',tab||'_stock_conserved',tab);
 END IF;
END LOOP;END $$;
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['charter_tournament_events','charter_tournament_event_terminals','charter_tournament_prize_claims','charter_tournament_event_contract'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_guard') THEN EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_tournament_event_guard()',tab||'_guard',tab);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_no_truncate') THEN EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_tournament_event_guard()',tab||'_no_truncate',tab);END IF;
 END LOOP;
END $$;
-- All source hooks are enabled when their immutable contract is enrolled.
REVOKE ALL ON TABLE public.charter_tournament_events,public.charter_tournament_event_terminals,public.charter_tournament_prize_claims,public.charter_tournament_event_contract FROM PUBLIC;
INSERT INTO public.charter_tournament_event_contract(record) SELECT public.shardkeep_charter_tournament_event_contract() WHERE NOT EXISTS(SELECT 1 FROM public.charter_tournament_event_contract);
REVOKE ALL ON TABLE public.charter_tournament_event_contract FROM PUBLIC;
DO $$DECLARE fn record;BEGIN FOR fn IN SELECT oid::regprocedure AS name FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('shardkeep_charter_tournament_event_contract','shardkeep_charter_tournament_event_source','shardkeep_charter_tournament_event_guard','shardkeep_charter_tournament_settlement','charter_tournament_event_terms','charter_tournament_event_terminal','shardkeep_charter_tournament_stock_conserved','shardkeep_charter_tournament_stock_guard') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.name);END LOOP;END $$;
