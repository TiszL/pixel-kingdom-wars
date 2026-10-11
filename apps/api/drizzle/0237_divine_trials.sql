-- D153.184 immutable funded weekly tournament. Policy literal generated from
-- shared DIVINE_TRIAL_POLICY; no stock issuance or production tax.
SET LOCAL lock_timeout='10s';
DO $preflight$DECLARE tab text;any_found boolean:=false;BEGIN
 FOREACH tab IN ARRAY ARRAY['divine_trial_events','divine_trial_event_terminals','divine_trial_prize_claims','divine_trial_event_contract','divine_trial_entries','divine_trial_attempts','divine_trial_commands','divine_trial_outcomes'] LOOP IF to_regclass('public.'||tab) IS NOT NULL THEN any_found:=true;END IF;END LOOP;
 IF any_found THEN
  FOREACH tab IN ARRAY ARRAY['divine_trial_events','divine_trial_event_terminals','divine_trial_prize_claims','divine_trial_event_contract','divine_trial_entries','divine_trial_attempts','divine_trial_commands','divine_trial_outcomes'] LOOP IF to_regclass('public.'||tab) IS NULL THEN RAISE EXCEPTION 'DIVINE_TRIAL_SCHEMA';END IF;END LOOP;
  IF to_regprocedure('public.shardkeep_divine_trial_event_contract()') IS NULL OR to_regprocedure('public.shardkeep_divine_trial_event_source()') IS NULL THEN RAISE EXCEPTION 'DIVINE_TRIAL_SCHEMA';END IF;
  PERFORM public.shardkeep_divine_trial_event_source();
 END IF;
END $preflight$;

CREATE TABLE IF NOT EXISTS public.divine_trial_events(
 id uuid PRIMARY KEY,domain jsonb NOT NULL,week_start timestamptz NOT NULL,sponsor_wallet text NOT NULL REFERENCES public.players(wallet),
 policy jsonb NOT NULL,budget jsonb NOT NULL,encounter jsonb NOT NULL,funding jsonb NOT NULL,funded_at timestamptz NOT NULL,tx_key text NOT NULL,
 UNIQUE(domain,week_start),CHECK(isfinite(week_start) AND isfinite(funded_at) AND funded_at<week_start)
);
CREATE TABLE IF NOT EXISTS public.divine_trial_event_terminals(
 event_id uuid PRIMARY KEY REFERENCES public.divine_trial_events(id),record jsonb NOT NULL,completed_at timestamptz NOT NULL CHECK(isfinite(completed_at)),tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.divine_trial_prize_claims(
 event_id uuid NOT NULL REFERENCES public.divine_trial_event_terminals(event_id),wallet text NOT NULL REFERENCES public.players(wallet),
 base_id uuid NOT NULL REFERENCES public.bases(id),amounts jsonb NOT NULL,stock jsonb NOT NULL,claimed_at timestamptz NOT NULL CHECK(isfinite(claimed_at)),tx_key text NOT NULL,
 PRIMARY KEY(event_id,wallet)
);
CREATE TABLE IF NOT EXISTS public.divine_trial_event_contract(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),record jsonb NOT NULL);
-- Ordinary stock writes only look for witnesses from their own transaction.
CREATE INDEX IF NOT EXISTS divine_trial_events_tx_key_idx ON public.divine_trial_events(tx_key);
CREATE INDEX IF NOT EXISTS divine_trial_prize_claims_tx_key_idx ON public.divine_trial_prize_claims(tx_key);

CREATE TABLE IF NOT EXISTS public.divine_trial_entries(
 id uuid PRIMARY KEY,event_id uuid NOT NULL REFERENCES public.divine_trial_events(id),wallet text NOT NULL REFERENCES public.players(wallet),
 base_id uuid NOT NULL REFERENCES public.bases(id),idempotency_key uuid NOT NULL,record jsonb NOT NULL,
 source_json text NOT NULL,source_sha256 text NOT NULL,observed_at timestamptz NOT NULL,entered_at timestamptz NOT NULL,
 UNIQUE(event_id,wallet),UNIQUE(wallet,idempotency_key),CHECK(isfinite(observed_at) AND isfinite(entered_at))
);
CREATE TABLE IF NOT EXISTS public.divine_trial_attempts(
 id uuid PRIMARY KEY,event_id uuid NOT NULL,wallet text NOT NULL,base_id uuid NOT NULL REFERENCES public.bases(id),idempotency_key uuid NOT NULL,
 ordinal integer NOT NULL,record jsonb NOT NULL,admitted_at timestamptz NOT NULL CHECK(isfinite(admitted_at)),
 FOREIGN KEY(event_id,wallet) REFERENCES public.divine_trial_entries(event_id,wallet),UNIQUE(event_id,wallet,ordinal),UNIQUE(wallet,idempotency_key)
);
CREATE TABLE IF NOT EXISTS public.divine_trial_commands(
 attempt_id uuid PRIMARY KEY REFERENCES public.divine_trial_attempts(id),orders jsonb NOT NULL,input_sha256 text NOT NULL,committed_at timestamptz NOT NULL CHECK(isfinite(committed_at))
);
CREATE TABLE IF NOT EXISTS public.divine_trial_outcomes(
 attempt_id uuid PRIMARY KEY REFERENCES public.divine_trial_attempts(id),status text NOT NULL CHECK(status IN('completed','abandoned','expired')),
 result jsonb,completed_at timestamptz NOT NULL CHECK(isfinite(completed_at)),CHECK((status='completed')=(result IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS divine_trial_attempts_event_idx ON public.divine_trial_attempts(event_id,wallet,ordinal);

-- Same compact ASCII-key JSON grammar as divineTrialCanonicalJson. Only strict
-- bounded service JSON reaches this private function; arrays retain input order.
CREATE OR REPLACE FUNCTION public.divine_trial_canonical_json(v jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE output text;BEGIN
 IF jsonb_typeof(v)='object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||public.divine_trial_canonical_json(value),',' ORDER BY key COLLATE "C"),'')||'}' INTO output FROM jsonb_each(v);RETURN output;
 ELSIF jsonb_typeof(v)='array' THEN SELECT '['||coalesce(string_agg(public.divine_trial_canonical_json(value),',' ORDER BY ordinal),'')||']' INTO output FROM jsonb_array_elements(v) WITH ORDINALITY x(value,ordinal);RETURN output;
 ELSE RETURN v::text;END IF;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_divine_trial_event_contract() RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
 SELECT jsonb_build_object('tables',(SELECT jsonb_object_agg(c.relname,jsonb_build_object('owner',c.relowner,'acl',to_jsonb(c.relacl),'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid),'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY pg_get_indexdef(i.indexrelid)) FROM pg_index i WHERE i.indrelid=c.oid))) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(ARRAY['divine_trial_events','divine_trial_event_terminals','divine_trial_prize_claims','divine_trial_event_contract','divine_trial_entries','divine_trial_attempts','divine_trial_commands','divine_trial_outcomes'])),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('owner',p.proowner,'securityDefiner',p.prosecdef,'config',to_jsonb(p.proconfig),'definition',pg_get_functiondef(p.oid))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY(ARRAY['shardkeep_divine_trial_event_contract','shardkeep_divine_trial_event_source','shardkeep_divine_trial_event_guard','divine_trial_event_terms','divine_trial_event_terminal','shardkeep_divine_trial_settlement','shardkeep_divine_trial_stock_conserved','shardkeep_divine_trial_stock_guard','shardkeep_divine_trial_play_guard','divine_trial_canonical_json'])),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid,t.tgname) FROM pg_trigger t WHERE NOT t.tgisinternal AND (t.tgrelid=ANY(ARRAY['public.divine_trial_events'::regclass,'public.divine_trial_event_terminals'::regclass,'public.divine_trial_prize_claims'::regclass,'public.divine_trial_event_contract'::regclass,'public.divine_trial_entries'::regclass,'public.divine_trial_attempts'::regclass,'public.divine_trial_commands'::regclass,'public.divine_trial_outcomes'::regclass]) OR (t.tgrelid='public.crafting_stocks'::regclass AND t.tgname IN('crafting_stocks_divine_trial_guard','crafting_stocks_divine_trial_no_truncate')))))
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_divine_trial_event_source() RETURNS void LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$BEGIN
 IF current_user<>session_user OR current_setting('session_replication_role')<>'origin' THEN RAISE EXCEPTION 'DIVINE_TRIAL_SOURCE';END IF;
 IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.divine_trial_event_contract'::regclass)) OR current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'DIVINE_TRIAL_OWNER_ISOLATION';END IF;
 IF (SELECT record FROM public.divine_trial_event_contract WHERE singleton) IS DISTINCT FROM public.shardkeep_divine_trial_event_contract() THEN RAISE EXCEPTION 'DIVINE_TRIAL_SOURCE';END IF;
END $$;

CREATE OR REPLACE FUNCTION public.divine_trial_event_terms(eid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$DECLARE e public.divine_trial_events;BEGIN
 PERFORM public.shardkeep_divine_trial_event_source();SELECT * INTO STRICT e FROM public.divine_trial_events WHERE id=eid;
 RETURN jsonb_build_object('version',1,'id',e.id,'domain',e.domain,'sponsorWallet',e.sponsor_wallet,
 'entryStartsAt',to_char(e.week_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'playStartsAt',to_char((e.week_start+interval '1 day') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'playEndsAt',to_char((e.week_start+interval '2 days') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'occupationEndsAt',to_char((e.week_start+interval '9 days') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'policy',e.policy,'budget',e.budget,'encounter',e.encounter);
END $$;
CREATE OR REPLACE FUNCTION public.divine_trial_event_terminal(eid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$DECLARE r jsonb;BEGIN
 PERFORM public.shardkeep_divine_trial_event_source();SELECT record INTO STRICT r FROM public.divine_trial_event_terminals WHERE event_id=eid;
 RETURN r;
END $$;

-- Outcomes originate only from the private actual-simulator service. Closing
-- must hold on any committed input without a canonical terminal, even after pause.
CREATE OR REPLACE FUNCTION public.shardkeep_divine_trial_settlement(eid uuid,at_time timestamptz) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.divine_trial_events;rankings jsonb;occupations jsonb:='[]';entitlements jsonb:='{}';ranking jsonb;beneficiary text;item text;qty bigint;share bigint;remaining bigint;winners integer;position integer:=0;amounts jsonb;result jsonb;
BEGIN
 PERFORM public.shardkeep_divine_trial_event_source();SELECT * INTO STRICT e FROM public.divine_trial_events WHERE id=eid FOR UPDATE NOWAIT;
 IF NOT isfinite(at_time) OR at_time<e.week_start+make_interval(days=>(e.policy->>'entryDurationDays')::integer+(e.policy->>'playDurationDays')::integer) THEN RAISE EXCEPTION 'DIVINE_TRIAL_WINDOW';END IF;
 IF EXISTS(SELECT 1 FROM public.divine_trial_attempts a LEFT JOIN public.divine_trial_outcomes o ON o.attempt_id=a.id WHERE a.event_id=eid AND o.attempt_id IS NULL) THEN RAISE EXCEPTION 'DIVINE_TRIAL_UNRESOLVED';END IF;
 WITH scored AS(SELECT a.wallet,a.id,a.ordinal,(o.result->>'stars')::integer stars,(o.result->>'destruction')::integer destruction FROM public.divine_trial_attempts a JOIN public.divine_trial_outcomes o ON o.attempt_id=a.id WHERE a.event_id=eid AND o.status='completed' AND (o.result->>'stars')::integer>=(e.policy->>'minWinningStars')::integer),
 best AS(SELECT DISTINCT ON(wallet) * FROM scored ORDER BY wallet,stars DESC,destruction DESC,ordinal),
 winners AS(SELECT * FROM best ORDER BY stars DESC,destruction DESC,wallet COLLATE "C" LIMIT (e.policy->>'divineSites')::integer)
 SELECT coalesce(jsonb_agg(jsonb_build_object('wallet',wallet,'attemptId',id,'ordinal',ordinal,'stars',stars,'destruction',destruction) ORDER BY stars DESC,destruction DESC,wallet COLLATE "C"),'[]') INTO rankings FROM winners;
 winners:=jsonb_array_length(rankings);
 FOR ranking IN SELECT value FROM jsonb_array_elements(rankings) LOOP
  position:=position+1;occupations:=occupations||jsonb_build_array(jsonb_build_object('site','divine-individual-'||lpad(position::text,3,'0'),'wallet',ranking->>'wallet'));
 END LOOP;
 FOR item,qty IN SELECT key,value::bigint FROM jsonb_each_text(e.budget) LOOP
  remaining:=qty;
  IF winners>0 THEN
   share:=qty/winners;
   FOR ranking IN SELECT value FROM jsonb_array_elements(rankings) LOOP
    beneficiary:=ranking->>'wallet';amounts:=coalesce(entitlements->beneficiary,'{}');amounts:=jsonb_set(amounts,ARRAY[item],to_jsonb((coalesce((amounts->>item)::bigint,0)+share)::text));
    entitlements:=jsonb_set(entitlements,ARRAY[beneficiary],amounts);remaining:=remaining-share;
   END LOOP;
  END IF;
  amounts:=coalesce(entitlements->e.sponsor_wallet,'{}');amounts:=jsonb_set(amounts,ARRAY[item],to_jsonb((coalesce((amounts->>item)::bigint,0)+remaining)::text));entitlements:=jsonb_set(entitlements,ARRAY[e.sponsor_wallet],amounts);
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('wallet',key,'amounts',value) ORDER BY key COLLATE "C"),'[]') INTO result FROM jsonb_each(entitlements);
 RETURN jsonb_build_object('version',1,'eventId',eid,'completedAt',to_char(at_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'rankings',rankings,'occupations',occupations,'entitlements',result);
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_divine_trial_event_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE item text;qty bigint;before_qty bigint;pending bigint;stock jsonb:='[]';base uuid;actor text;proof jsonb;at_time timestamptz;expected jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'DIVINE_TRIAL_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='divine_trial_event_contract' THEN
  IF NOT EXISTS(SELECT 1 FROM public.divine_trial_event_contract) AND NEW.record=public.shardkeep_divine_trial_event_contract() THEN RETURN NEW;END IF;
  RAISE EXCEPTION 'DIVINE_TRIAL_IMMUTABLE';END IF;
 PERFORM public.shardkeep_divine_trial_event_source();
 IF TG_TABLE_NAME='divine_trial_events' THEN
  IF NEW.policy IS DISTINCT FROM '{"version":1,"entryWeekdayUtc":6,"entryDurationDays":1,"playDurationDays":1,"occupationDurationDays":7,"divineSites":500,"attemptsPerWallet":3,"maxUnfinishedAttempts":1,"minRenown":1,"minDaysAttested":1,"minWinningStars":1,"maxStars":3,"maxDestruction":100,"campaignStage":5,"simVersion":17,"seed":184,"army":{"highlander":6,"bowman":8},"levels":{"highlander":1,"bowman":1},"maxDeploys":14,"deployTimeMs":0,"observationMaxAgeMs":30000,"rpcTimeoutMs":30000,"maxSourceConcurrency":32,"discoveryPageSize":20,"localEventLimit":32,"maxSnapshotBuildings":128,"maxStringLength":256,"maxObjectKeys":64,"maxJsonDepth":16,"maxJsonNodes":1000000,"maxPayloadBytes":16777216,"maxReplayEvents":50000,"prizeItems":["frostglass","heartwood_beams","sunstone_blocks","crownsteel","prismstone_lens","stormalloy","thornsilk","embercore"],"fragments":"held","prizeSource":"funded-existing-refined-stock","tieBreak":"wallet-ascii","heroes":"none","energy":"none"}'::jsonb OR jsonb_typeof(NEW.domain)<>'object' OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.domain) key) IS DISTINCT FROM ARRAY['economyProgram','genesisHash']::text[] OR EXISTS(SELECT 1 FROM jsonb_each_text(NEW.domain) WHERE value!~'^[1-9A-HJ-NP-Za-km-z]{32,44}$') OR NEW.sponsor_wallet!~'^[1-9A-HJ-NP-Za-km-z]{32,44}$' THEN RAISE EXCEPTION 'DIVINE_TRIAL_POLICY';END IF;
  IF extract(dow FROM NEW.week_start AT TIME ZONE 'UTC')<>6 OR date_trunc('day',NEW.week_start AT TIME ZONE 'UTC')<>NEW.week_start AT TIME ZONE 'UTC' OR NOT isfinite(NEW.funded_at) OR NEW.funded_at>=NEW.week_start THEN RAISE EXCEPTION 'DIVINE_TRIAL_WINDOW';END IF;
  IF jsonb_typeof(NEW.budget)<>'object' OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.budget) key) IS DISTINCT FROM ARRAY['crownsteel','embercore','frostglass','heartwood_beams','prismstone_lens','stormalloy','sunstone_blocks','thornsilk']::text[] OR EXISTS(SELECT 1 FROM jsonb_each(NEW.budget) WHERE jsonb_typeof(value)<>'string' OR value#>>'{}'!~'^(0|[1-9][0-9]{0,18})$' OR (value#>>'{}')::numeric>9223372036854775807) OR NOT EXISTS(SELECT 1 FROM jsonb_each_text(NEW.budget) WHERE value::numeric>0) THEN RAISE EXCEPTION 'DIVINE_TRIAL_BUDGET';END IF;
  IF NEW.encounter->>'inputSha256' IS DISTINCT FROM encode(sha256(convert_to(public.divine_trial_canonical_json(NEW.encounter-'inputSha256'),'UTF8')),'hex') OR NEW.encounter->'army' IS DISTINCT FROM NEW.policy->'army' OR NEW.encounter->'levels' IS DISTINCT FROM NEW.policy->'levels' OR NEW.encounter->'simVersion' IS DISTINCT FROM NEW.policy->'simVersion' OR NEW.encounter->'seed' IS DISTINCT FROM NEW.policy->'seed' THEN RAISE EXCEPTION 'DIVINE_TRIAL_ENCOUNTER';END IF;
  LOCK TABLE public.divine_trial_events IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  IF EXISTS(SELECT 1 FROM public.divine_trial_events WHERE id=NEW.id OR (domain=NEW.domain AND week_start=NEW.week_start)) THEN RAISE EXCEPTION 'DIVINE_TRIAL_ALREADY_FUNDED';END IF;
  base:=(NEW.funding->>'baseId')::uuid;actor:=NEW.sponsor_wallet;at_time:=NEW.funded_at;proof:=NEW.budget;
 ELSIF TG_TABLE_NAME='divine_trial_event_terminals' THEN
  NEW.record:=public.shardkeep_divine_trial_settlement(NEW.event_id,NEW.completed_at);NEW.tx_key:=pg_current_xact_id()::text;RETURN NEW;
 ELSE
  expected:=public.divine_trial_event_terminal(NEW.event_id);
  IF NEW.claimed_at<(expected->>'completedAt')::timestamptz THEN RAISE EXCEPTION 'DIVINE_TRIAL_CLAIM_TIME';END IF;
  SELECT value->'amounts' INTO STRICT proof FROM jsonb_array_elements(expected->'entitlements') WHERE value->>'wallet'=NEW.wallet;
  NEW.amounts:=proof;base:=NEW.base_id;actor:=NEW.wallet;at_time:=NEW.claimed_at;
 END IF;
 -- Same player -> base -> slot order as fresh authority and deed transfer.
 PERFORM 1 FROM public.players WHERE wallet=actor FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'DIVINE_TRIAL_OWNER';END IF;
 IF TG_TABLE_NAME='divine_trial_prize_claims' THEN
  IF EXISTS(SELECT 1 FROM public.divine_trial_prize_claims WHERE event_id=NEW.event_id AND wallet=NEW.wallet) THEN RAISE EXCEPTION 'DIVINE_TRIAL_ALREADY_CLAIMED';END IF;
 END IF;
 PERFORM 1 FROM public.bases WHERE id=base AND owner_wallet=actor AND status='active' FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'DIVINE_TRIAL_OWNER';END IF;
 PERFORM 1 FROM public.base_slots WHERE base_id=base AND wallet=actor AND active FOR UPDATE NOWAIT;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.base_raid_locks WHERE base_id=base) OR EXISTS(SELECT 1 FROM public.raids WHERE attacker_base_id=base AND status IN('pending_orders','resolving')) THEN RAISE EXCEPTION 'DIVINE_TRIAL_BASE_BUSY';END IF;
 FOR item,qty IN SELECT key,value::bigint FROM jsonb_each_text(proof) ORDER BY key LOOP
  INSERT INTO public.crafting_stocks(base_id,item_id) VALUES(base,item) ON CONFLICT DO NOTHING;
  SELECT available,pending_output INTO STRICT before_qty,pending FROM public.crafting_stocks WHERE base_id=base AND item_id=item FOR UPDATE NOWAIT;
  IF TG_TABLE_NAME='divine_trial_events' THEN
   IF before_qty<qty THEN RAISE EXCEPTION 'DIVINE_TRIAL_FUNDS';END IF;
   UPDATE public.crafting_stocks SET available=available-qty WHERE base_id=base AND item_id=item;
   stock:=stock||jsonb_build_array(jsonb_build_object('itemId',item,'before',before_qty::text,'after',(before_qty-qty)::text,'quantity',qty::text));
  ELSE
   IF before_qty::numeric+pending::numeric+qty::numeric>9223372036854775807 THEN RAISE EXCEPTION 'DIVINE_TRIAL_STORAGE_FULL';END IF;
   UPDATE public.crafting_stocks SET available=available+qty WHERE base_id=base AND item_id=item;
   stock:=stock||jsonb_build_array(jsonb_build_object('itemId',item,'before',before_qty::text,'after',(before_qty+qty)::text,'quantity',qty::text));
  END IF;
 END LOOP;
 IF TG_TABLE_NAME='divine_trial_events' THEN NEW.funding:=jsonb_build_object('baseId',base,'stock',stock,'fundedAt',to_char(at_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));ELSE NEW.stock:=stock;END IF;
 NEW.tx_key:=pg_current_xact_id()::text;RETURN NEW;
END $$;
-- Prove the event's entire available-stock effect at the original commit.
-- No action in the same transaction may restore debited prize stock or erase
-- credited rights while retaining a seemingly valid immutable source receipt.
CREATE OR REPLACE FUNCTION public.shardkeep_divine_trial_stock_conserved() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE proof jsonb;base uuid;item jsonb;quantity bigint;BEGIN
 PERFORM public.shardkeep_divine_trial_event_source();
 IF TG_TABLE_NAME='divine_trial_events' THEN proof:=NEW.funding->'stock';base:=(NEW.funding->>'baseId')::uuid;ELSE proof:=NEW.stock;base:=NEW.base_id;END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(proof) LOOP
  SELECT available INTO STRICT quantity FROM public.crafting_stocks WHERE base_id=base AND item_id=item->>'itemId';
  IF quantity IS DISTINCT FROM (item->>'after')::bigint THEN RAISE EXCEPTION 'DIVINE_TRIAL_STOCK_CONSERVATION';END IF;
 END LOOP;
 RETURN NULL;
END $$;
-- A deferred proof alone can be flushed with SET CONSTRAINTS. Once its immutable
-- receipt exists, every later mutation in that same transaction must preserve
-- the witnessed row identity and available stock. Ordinary later transactions
-- remain free to consume or produce existing crafting stock.
CREATE OR REPLACE FUNCTION public.shardkeep_divine_trial_stock_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE old_base uuid;new_base uuid;old_item text;new_item text;xid text:=pg_current_xact_id()::text;
BEGIN
 IF TG_RELID<>'public.crafting_stocks'::regclass OR TG_WHEN<>'BEFORE' OR TG_NARGS<>0 OR TG_OP NOT IN('INSERT','UPDATE','DELETE','TRUNCATE')
  OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'crafting_stocks_divine_trial_no_truncate' ELSE 'crafting_stocks_divine_trial_guard' END)
  OR TG_LEVEL<>(CASE WHEN TG_OP='TRUNCATE' THEN 'STATEMENT' ELSE 'ROW' END)
 THEN RAISE EXCEPTION 'DIVINE_TRIAL_STOCK_TRIGGER';END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.base_id,NEW.item_id,NEW.available) IS NOT DISTINCT FROM (OLD.base_id,OLD.item_id,OLD.available) THEN RETURN NEW;END IF;
 END IF;
 IF TG_OP IN('UPDATE','DELETE') THEN old_base:=OLD.base_id;old_item:=OLD.item_id;END IF;
 IF TG_OP IN('UPDATE','INSERT') THEN new_base:=NEW.base_id;new_item:=NEW.item_id;END IF;
 IF EXISTS(SELECT 1 FROM public.divine_trial_events e CROSS JOIN LATERAL jsonb_array_elements(e.funding->'stock') s
   WHERE e.tx_key=xid AND (TG_OP='TRUNCATE' OR ((e.funding->>'baseId')::uuid,s->>'itemId') IN((old_base,old_item),(new_base,new_item))))
  OR EXISTS(SELECT 1 FROM public.divine_trial_prize_claims c CROSS JOIN LATERAL jsonb_array_elements(c.stock) s
   WHERE c.tx_key=xid AND (TG_OP='TRUNCATE' OR (c.base_id,s->>'itemId') IN((old_base,old_item),(new_base,new_item))))
 THEN
  IF current_setting('role')<>'none' THEN RAISE EXCEPTION 'DIVINE_TRIAL_OWNER_ISOLATION';END IF;
  PERFORM public.shardkeep_divine_trial_event_source();
  RAISE EXCEPTION 'DIVINE_TRIAL_STOCK_CONSERVATION';
 END IF;
 IF TG_OP='TRUNCATE' THEN RETURN NULL;ELSIF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_divine_trial_play_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.divine_trial_events;a public.divine_trial_attempts;c public.divine_trial_commands;proof jsonb;q jsonb;eid uuid;actor text;base uuid;n integer;deployed jsonb;start_at timestamptz;end_at timestamptz;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'DIVINE_TRIAL_IMMUTABLE';END IF;
 PERFORM public.shardkeep_divine_trial_event_source();
 IF TG_TABLE_NAME IN('divine_trial_entries','divine_trial_attempts') THEN eid:=NEW.event_id;actor:=NEW.wallet;base:=NEW.base_id;
 ELSE SELECT * INTO STRICT a FROM public.divine_trial_attempts WHERE id=NEW.attempt_id;eid:=a.event_id;actor:=a.wallet;END IF;
 SELECT * INTO STRICT e FROM public.divine_trial_events WHERE id=eid FOR UPDATE NOWAIT;
 IF EXISTS(SELECT 1 FROM public.divine_trial_event_terminals WHERE event_id=eid) THEN RAISE EXCEPTION 'DIVINE_TRIAL_CLOSED';END IF;
 start_at:=e.week_start+make_interval(days=>(e.policy->>'entryDurationDays')::integer);end_at:=start_at+make_interval(days=>(e.policy->>'playDurationDays')::integer);
 IF TG_TABLE_NAME='divine_trial_entries' THEN
  IF NEW.entered_at<e.week_start OR NEW.entered_at>=start_at OR NEW.observed_at>NEW.entered_at OR extract(epoch FROM NEW.entered_at-NEW.observed_at)*1000>(e.policy->>'observationMaxAgeMs')::integer THEN RAISE EXCEPTION 'DIVINE_TRIAL_WINDOW';END IF;
  IF octet_length(NEW.source_json)>(e.policy->>'maxPayloadBytes')::integer OR NEW.source_sha256 IS DISTINCT FROM encode(sha256(convert_to(NEW.source_json,'UTF8')),'hex') THEN RAISE EXCEPTION 'DIVINE_TRIAL_QUALIFICATION';END IF;
  proof:=NEW.source_json::jsonb;q:=NEW.record->'qualification';
  IF proof->>'wallet' IS DISTINCT FROM actor OR proof->'domain' IS DISTINCT FROM e.domain OR q->>'sourceSha256' IS DISTINCT FROM NEW.source_sha256
   OR (proof->>'observedAtMs')::numeric IS DISTINCT FROM extract(epoch FROM NEW.observed_at)*1000
   OR proof#>>'{projection,kind}' IS DISTINCT FROM 'entitlement'
   OR proof#>>'{projection,leaf,wallet}' IS DISTINCT FROM actor OR proof#>>'{snapshot,renownRecord,wallet}' IS DISTINCT FROM actor
   OR proof#>>'{projection,header,sequence}' IS DISTINCT FROM q->>'sequence'
   OR proof#>>'{snapshot,backing,config,latestSequence}' IS DISTINCT FROM q->>'sequence'
   OR proof#>>'{snapshot,renownRecord,lastSequence}' IS DISTINCT FROM q->>'sequence'
   OR (proof#>>'{projection,header,day}')::numeric IS DISTINCT FROM (q->>'day')::numeric
   OR proof#>>'{projection,leaf,cumulativeRenown}' IS DISTINCT FROM q->>'renown'
   OR proof#>>'{snapshot,renownRecord,renownTotal}' IS DISTINCT FROM q->>'renown'
   OR proof#>>'{projection,leaf,cumulativeDays}' IS DISTINCT FROM q->>'daysAttested'
   OR proof#>>'{snapshot,renownRecord,daysAttested}' IS DISTINCT FROM q->>'daysAttested'
   OR (q->>'renown')::numeric<(e.policy->>'minRenown')::integer OR (q->>'daysAttested')::numeric<(e.policy->>'minDaysAttested')::integer
   OR proof#>'{snapshot,root,revoked}' IS DISTINCT FROM 'false'::jsonb
   OR proof#>'{snapshot,backing,config,flags}' IS DISTINCT FROM '0'::jsonb
   OR proof#>'{snapshot,backing,config,correctionPending}' IS DISTINCT FROM 'false'::jsonb
   OR (proof#>>'{snapshot,chainClock,unixTimestamp}')::numeric*1000>extract(epoch FROM NEW.entered_at)*1000
   OR extract(epoch FROM NEW.entered_at)*1000-(proof#>>'{snapshot,chainClock,unixTimestamp}')::numeric*1000>(e.policy->>'observationMaxAgeMs')::integer
   THEN RAISE EXCEPTION 'DIVINE_TRIAL_QUALIFICATION';END IF;
  NEW.record:=jsonb_build_object('version',1,'id',NEW.id,'eventId',eid,'wallet',actor,'baseId',base,'idempotencyKey',NEW.idempotency_key,'enteredAt',to_char(NEW.entered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'qualification',q);
 ELSIF TG_TABLE_NAME='divine_trial_attempts' THEN
  IF NEW.admitted_at<start_at OR NEW.admitted_at>=end_at THEN RAISE EXCEPTION 'DIVINE_TRIAL_WINDOW';END IF;
  SELECT count(*) INTO n FROM public.divine_trial_attempts WHERE event_id=eid AND wallet=actor;
  IF NEW.ordinal<>n+1 OR n>=(e.policy->>'attemptsPerWallet')::integer THEN RAISE EXCEPTION 'DIVINE_TRIAL_ATTEMPT_LIMIT';END IF;
  IF EXISTS(SELECT 1 FROM public.divine_trial_attempts x LEFT JOIN public.divine_trial_outcomes o ON o.attempt_id=x.id WHERE x.event_id=eid AND x.wallet=actor AND o.attempt_id IS NULL) THEN RAISE EXCEPTION 'DIVINE_TRIAL_UNFINISHED';END IF;
  NEW.record:=jsonb_build_object('version',1,'id',NEW.id,'eventId',eid,'wallet',actor,'baseId',base,'idempotencyKey',NEW.idempotency_key,'ordinal',NEW.ordinal,'admittedAt',to_char(NEW.admitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 ELSIF TG_TABLE_NAME='divine_trial_commands' THEN
  IF NEW.committed_at<a.admitted_at OR NEW.committed_at<start_at OR NEW.committed_at>=end_at OR EXISTS(SELECT 1 FROM public.divine_trial_outcomes WHERE attempt_id=a.id) THEN RAISE EXCEPTION 'DIVINE_TRIAL_WINDOW';END IF;
  deployed:=NEW.orders->'deploys';
  IF jsonb_typeof(NEW.orders)<>'object' OR (SELECT array_agg(key) FROM jsonb_object_keys(NEW.orders) key) IS DISTINCT FROM ARRAY['deploys']::text[] OR jsonb_typeof(deployed)<>'array' OR jsonb_array_length(deployed)<>(e.policy->>'maxDeploys')::integer
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(deployed) d WHERE jsonb_typeof(d)<>'object' OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(d) key) IS DISTINCT FROM ARRAY['tMs','troop','tx','ty']::text[] OR d->'tMs' IS DISTINCT FROM e.policy->'deployTimeMs' OR NOT e.policy->'army' ? (d->>'troop') OR jsonb_typeof(d->'tx') IS DISTINCT FROM 'number' OR jsonb_typeof(d->'ty') IS DISTINCT FROM 'number' OR (d->>'tx')!~'^-?[0-9]+$' OR (d->>'ty')!~'^-?[0-9]+$')
   OR EXISTS(SELECT 1 FROM jsonb_each_text(e.policy->'army') t WHERE (SELECT count(*) FROM jsonb_array_elements(deployed) d WHERE d->>'troop'=t.key)<>t.value::integer)
   OR NEW.input_sha256 IS DISTINCT FROM encode(sha256(convert_to(public.divine_trial_canonical_json(jsonb_build_object('encounter',e.encounter,'orders',NEW.orders)),'UTF8')),'hex')
   THEN RAISE EXCEPTION 'DIVINE_TRIAL_COMMAND';END IF;
 ELSE
  SELECT * INTO c FROM public.divine_trial_commands WHERE attempt_id=a.id;
  IF NEW.completed_at<a.admitted_at THEN RAISE EXCEPTION 'DIVINE_TRIAL_RESULT_TIME';END IF;
  IF NEW.status='completed' THEN
   IF c.attempt_id IS NULL OR NEW.completed_at<c.committed_at OR (NEW.result->>'stars')::integer NOT BETWEEN 0 AND (e.policy->>'maxStars')::integer OR (NEW.result->>'destruction')::integer NOT BETWEEN 0 AND (e.policy->>'maxDestruction')::integer OR jsonb_typeof(NEW.result->'events') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.result->'events')>(e.policy->>'maxReplayEvents')::integer OR NEW.result->>'inputSha256' IS DISTINCT FROM c.input_sha256 THEN RAISE EXCEPTION 'DIVINE_TRIAL_RESULT';END IF;
  ELSE
   IF c.attempt_id IS NOT NULL OR (NEW.status='expired' AND NEW.completed_at<end_at) THEN RAISE EXCEPTION 'DIVINE_TRIAL_COMMAND_COMMITTED';END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF base IS NOT NULL THEN
  PERFORM 1 FROM public.players WHERE wallet=actor FOR UPDATE NOWAIT;IF NOT FOUND THEN RAISE EXCEPTION 'DIVINE_TRIAL_OWNER';END IF;
  PERFORM 1 FROM public.bases WHERE id=base AND owner_wallet=actor AND status='active' FOR UPDATE NOWAIT;IF NOT FOUND THEN RAISE EXCEPTION 'DIVINE_TRIAL_OWNER';END IF;
  PERFORM 1 FROM public.base_slots WHERE base_id=base AND wallet=actor AND active FOR UPDATE NOWAIT;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM public.base_raid_locks WHERE base_id=base) THEN RAISE EXCEPTION 'DIVINE_TRIAL_BASE_BUSY';END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['divine_trial_entries','divine_trial_attempts','divine_trial_commands','divine_trial_outcomes'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_guard') THEN EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_divine_trial_play_guard()',tab||'_guard',tab);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_no_truncate') THEN EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_divine_trial_play_guard()',tab||'_no_truncate',tab);END IF;
 END LOOP;
END $$;
REVOKE ALL ON TABLE public.divine_trial_entries,public.divine_trial_attempts,public.divine_trial_commands,public.divine_trial_outcomes FROM PUBLIC;

DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.crafting_stocks'::regclass AND tgname='crafting_stocks_divine_trial_guard') THEN
  CREATE TRIGGER crafting_stocks_divine_trial_guard BEFORE INSERT OR UPDATE OR DELETE ON public.crafting_stocks FOR EACH ROW EXECUTE FUNCTION public.shardkeep_divine_trial_stock_guard();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.crafting_stocks'::regclass AND tgname='crafting_stocks_divine_trial_no_truncate') THEN
  CREATE TRIGGER crafting_stocks_divine_trial_no_truncate BEFORE TRUNCATE ON public.crafting_stocks FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_divine_trial_stock_guard();
 END IF;
END $$;
DO $$DECLARE tab text;BEGIN FOREACH tab IN ARRAY ARRAY['divine_trial_events','divine_trial_prize_claims'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_stock_conserved') THEN
  EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_divine_trial_stock_conserved()',tab||'_stock_conserved',tab);
 END IF;
END LOOP;END $$;
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['divine_trial_events','divine_trial_event_terminals','divine_trial_prize_claims','divine_trial_event_contract'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_guard') THEN EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_divine_trial_event_guard()',tab||'_guard',tab);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_no_truncate') THEN EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_divine_trial_event_guard()',tab||'_no_truncate',tab);END IF;
 END LOOP;
END $$;
-- All source hooks are enabled when their immutable contract is enrolled.
REVOKE ALL ON TABLE public.divine_trial_events,public.divine_trial_event_terminals,public.divine_trial_prize_claims,public.divine_trial_event_contract FROM PUBLIC;
INSERT INTO public.divine_trial_event_contract(record) SELECT public.shardkeep_divine_trial_event_contract() WHERE NOT EXISTS(SELECT 1 FROM public.divine_trial_event_contract);
REVOKE ALL ON TABLE public.divine_trial_event_contract FROM PUBLIC;
DO $$DECLARE fn record;BEGIN FOR fn IN SELECT oid::regprocedure AS name FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('shardkeep_divine_trial_event_contract','shardkeep_divine_trial_event_source','shardkeep_divine_trial_event_guard','shardkeep_divine_trial_settlement','divine_trial_event_terms','divine_trial_event_terminal','shardkeep_divine_trial_stock_conserved','shardkeep_divine_trial_stock_guard','shardkeep_divine_trial_play_guard','divine_trial_canonical_json') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.name);END LOOP;END $$;
