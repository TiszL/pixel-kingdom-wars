-- Dormant prospective facts only; owner initialization is a separate held action.
-- No balance/money backfill. These source guards require S5 approval before use.
CREATE TABLE IF NOT EXISTS mining_gems_flow_coverage(id boolean PRIMARY KEY CHECK(id),started_at timestamptz NOT NULL,birth_event_floor bigint NOT NULL);
CREATE TABLE IF NOT EXISTS mining_gems_flow_events(
 id bigserial PRIMARY KEY,wallet text NOT NULL,observed_at timestamptz NOT NULL,transaction_marker bigint NOT NULL,
 source_table text NOT NULL,source_id text NOT NULL,operation text NOT NULL,
 account_id uuid,transaction_id uuid,before_state jsonb,after_state jsonb,
 receipt jsonb NOT NULL,receipt_complete boolean NOT NULL
);
CREATE INDEX IF NOT EXISTS mining_gems_flow_wallet_clock ON mining_gems_flow_events(wallet,observed_at,id);
CREATE INDEX IF NOT EXISTS mining_gems_flow_account ON mining_gems_flow_events(account_id,wallet);
CREATE INDEX IF NOT EXISTS mining_gems_flow_transaction ON mining_gems_flow_events(transaction_id,wallet);
CREATE INDEX IF NOT EXISTS mining_gems_flow_transaction_clock ON mining_gems_flow_events(transaction_marker,observed_at DESC);
CREATE INDEX IF NOT EXISTS mining_gems_flow_receipt_accounts ON mining_gems_flow_events USING gin(receipt jsonb_path_ops);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_gems_flow_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t text;
BEGIN
 IF TG_OP<>'INSERT' OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'MINING_GEMS_FLOW_IMMUTABLE'; END IF;
 IF TG_RELID='public.mining_gems_flow_coverage'::regclass THEN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_GEMS_FLOW_READ_COMMITTED_REQUIRED'; END IF;
  LOCK TABLE public.players,public.accounts,public.ledger_transactions,public.ledger_entries IN ACCESS EXCLUSIVE MODE NOWAIT;
  LOCK TABLE public.mining_free_coverage,public.mining_free_cohort_events IN SHARE MODE NOWAIT;
  IF NOT EXISTS(SELECT 1 FROM public.mining_free_coverage WHERE id)
   OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.players'::regclass AND tgname='players_mining_free_capture' AND tgfoid='public.shardkeep_capture_mining_free()'::regprocedure AND tgtype=29 AND tgenabled IN ('O','A'))
   OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.players'::regclass AND tgname='players_mining_free_truncate' AND tgfoid='public.shardkeep_capture_mining_free()'::regprocedure AND tgtype=34 AND tgenabled IN ('O','A'))
   THEN RAISE EXCEPTION 'MINING_GEMS_FLOW_BIRTH_COVERAGE_REQUIRED'; END IF;
  NEW.started_at:=public.shardkeep_mining_free_clock();
  SELECT coalesce(max(id),0) INTO NEW.birth_event_floor FROM public.mining_free_cohort_events;
  IF NEW.started_at<(SELECT started_at FROM public.mining_free_coverage WHERE id) THEN RAISE EXCEPTION 'MINING_GEMS_FLOW_CLOCK_INVALID'; END IF;
  FOREACH t IN ARRAY ARRAY['accounts','ledger_transactions','ledger_entries'] LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_mining_gems_flow_capture' AND tgfoid='public.shardkeep_capture_mining_gems_flow()'::regprocedure AND tgtype=29)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_mining_gems_flow_truncate' AND tgfoid='public.shardkeep_capture_mining_gems_flow()'::regprocedure AND tgtype=34)
    THEN RAISE EXCEPTION 'MINING_GEMS_FLOW_SOURCE_INVALID'; END IF;
   EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER %I',t,t||'_mining_gems_flow_capture');
   EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER %I',t,t||'_mining_gems_flow_truncate');
  END LOOP;
  RETURN NEW;
 END IF;
 IF TG_RELID<>'public.mining_gems_flow_events'::regclass OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'MINING_GEMS_FLOW_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_capture_mining_gems_flow() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old_json jsonb; new_json jsonb; old_src jsonb; new_src jsonb; src jsonb; entry jsonb;
 a public.accounts%ROWTYPE; tx public.ledger_transactions%ROWTYPE; acct_ref uuid; txn_ref uuid;
 receipt jsonb:='[]'; complete boolean:=true; boundary timestamptz; observed timestamptz;
 wallets text[]:=ARRAY[]::text[]; w text; ref text;
BEGIN
 IF NOT (TG_RELID='public.accounts'::regclass AND TG_TABLE_NAME='accounts' OR TG_RELID='public.ledger_transactions'::regclass AND TG_TABLE_NAME='ledger_transactions' OR TG_RELID='public.ledger_entries'::regclass AND TG_TABLE_NAME='ledger_entries')
  OR (TG_OP='TRUNCATE' AND (TG_NAME<>TG_TABLE_NAME||'_mining_gems_flow_truncate' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'STATEMENT'))
  OR (TG_OP<>'TRUNCATE' AND (TG_OP NOT IN ('INSERT','UPDATE','DELETE') OR TG_NAME<>TG_TABLE_NAME||'_mining_gems_flow_capture' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW')) THEN RAISE EXCEPTION 'MINING_GEMS_FLOW_SOURCE_INVALID'; END IF;
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'MINING_GEMS_FLOW_SOURCE_RETAINED'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_GEMS_FLOW_READ_COMMITTED_REQUIRED'; END IF;
 SELECT started_at INTO STRICT boundary FROM public.mining_gems_flow_coverage WHERE id;
 IF TG_OP<>'INSERT' THEN old_json:=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN new_json:=to_jsonb(NEW); END IF;
 ref:=coalesce(new_json->>'id',old_json->>'id');
 IF TG_TABLE_NAME='ledger_entries' THEN
  -- Both sides remain evidence. Mutation is never collapsed into a new credit.
  FOR entry IN SELECT v FROM unnest(ARRAY[old_json,new_json]) v WHERE v IS NOT NULL LOOP
   SELECT * INTO STRICT a FROM public.accounts WHERE id=(entry->>'account_id')::uuid FOR SHARE NOWAIT;
   SELECT * INTO STRICT tx FROM public.ledger_transactions WHERE id=(entry->>'txn_id')::uuid FOR SHARE NOWAIT;
   src:=jsonb_build_object('entry',jsonb_build_object('id',entry->>'id','txnId',entry->>'txn_id','accountId',entry->>'account_id','delta',entry->>'delta'),
    'account',jsonb_build_object('id',a.id,'kind',a.kind,'currency',a.currency,'wallet',a.owner_wallet,'baseId',a.base_id),
    'transaction',jsonb_build_object('id',tx.id,'key',tx.idempotency_key,'type',tx.type,'metadata',tx.metadata,'createdAt',to_char(tx.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
   IF entry IS NOT DISTINCT FROM old_json AND old_src IS NULL THEN old_src:=src; ELSE new_src:=src; END IF;
   IF a.kind='player_gems' THEN wallets:=array_append(wallets,a.owner_wallet); END IF;
  END LOOP;
  acct_ref:=coalesce((new_json->>'account_id')::uuid,(old_json->>'account_id')::uuid); txn_ref:=coalesce((new_json->>'txn_id')::uuid,(old_json->>'txn_id')::uuid);
  SELECT coalesce(wallets,ARRAY[]::text[])||coalesce(array_agg(DISTINCT ev.wallet),ARRAY[]::text[]) INTO wallets
   FROM public.mining_gems_flow_events ev WHERE ev.transaction_id IN ((old_json->>'txn_id')::uuid,(new_json->>'txn_id')::uuid)
    AND (TG_OP<>'INSERT' OR NOT ev.receipt @> jsonb_build_array(jsonb_build_object('id',ref)));
  SELECT coalesce(jsonb_agg(r ORDER BY (r->>'id')::bigint),'[]'),count(*)<=32 INTO receipt,complete FROM (
   SELECT jsonb_build_object('id',e.id::text,'accountId',e.account_id,'delta',e.delta::text,'kind',ac.kind,'currency',ac.currency,'wallet',ac.owner_wallet,'baseId',ac.base_id) r
   FROM public.ledger_entries e JOIN public.accounts ac ON ac.id=e.account_id WHERE e.txn_id=txn_ref ORDER BY e.id LIMIT 33
  ) bounded;
 ELSIF TG_TABLE_NAME='accounts' THEN
  -- Normal postTransaction balance updates do not alter attribution.
  SELECT jsonb_object_agg(key,value) INTO old_src FROM jsonb_each(old_json) WHERE key=ANY(ARRAY['id','kind','currency','owner_wallet','base_id']);
  SELECT jsonb_object_agg(key,value) INTO new_src FROM jsonb_each(new_json) WHERE key=ANY(ARRAY['id','kind','currency','owner_wallet','base_id']);
  IF TG_OP='UPDATE' AND old_src IS NOT DISTINCT FROM new_src THEN RETURN NEW; END IF;
  acct_ref:=ref::uuid;
  SELECT array_agg(DISTINCT wallet) INTO wallets FROM (
   SELECT wallet FROM public.mining_gems_flow_events ev WHERE ev.account_id=acct_ref OR ev.receipt @> jsonb_build_array(jsonb_build_object('accountId',ref))
   UNION SELECT old_json->>'owner_wallet' WHERE old_json->>'kind'='player_gems'
   UNION SELECT new_json->>'owner_wallet' WHERE new_json->>'kind'='player_gems'
  ) relevant;
  IF TG_OP='INSERT' THEN new_src:=new_src||jsonb_build_object('initialBalance',new_json->>'balance'); END IF;
 ELSE
  txn_ref:=ref::uuid; old_src:=old_json;new_src:=new_json;
  IF TG_OP='UPDATE' AND old_src IS NOT DISTINCT FROM new_src THEN RETURN NEW; END IF;
  SELECT array_agg(DISTINCT wallet) INTO wallets FROM (
   SELECT wallet FROM public.mining_gems_flow_events ev WHERE ev.transaction_id=txn_ref
   UNION SELECT ac.owner_wallet FROM public.ledger_entries e JOIN public.accounts ac ON ac.id=e.account_id WHERE e.txn_id=txn_ref AND ac.kind='player_gems'
  ) relevant;
 END IF;
 IF cardinality(wallets)>10000 THEN RAISE EXCEPTION 'MINING_GEMS_FLOW_TOO_LARGE'; END IF;
 LOCK TABLE public.mining_gems_flow_events IN ROW EXCLUSIVE MODE;
 observed:=public.shardkeep_mining_free_clock(); IF observed<boundary THEN RAISE EXCEPTION 'MINING_GEMS_FLOW_CLOCK_INVALID'; END IF;
 FOR w IN SELECT DISTINCT v FROM unnest(wallets) v WHERE v IS NOT NULL LOOP
  INSERT INTO public.mining_gems_flow_events(wallet,observed_at,transaction_marker,source_table,source_id,operation,account_id,transaction_id,before_state,after_state,receipt,receipt_complete)
   VALUES(w,observed,txid_current(),TG_TABLE_NAME,ref,TG_OP,acct_ref,txn_ref,old_src,new_src,receipt,complete);
 END LOOP;
 RETURN coalesce(NEW,OLD);
END $$;
--> statement-breakpoint
DO $migration$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['mining_gems_flow_coverage','mining_gems_flow_events'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_immutable') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_gems_flow_guard()',t||'_immutable',t);
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_gems_flow_guard()',t||'_no_truncate',t);
  END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['accounts','ledger_transactions','ledger_entries'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_mining_gems_flow_capture') THEN
   EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_capture_mining_gems_flow()',t||'_mining_gems_flow_capture',t);
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_capture_mining_gems_flow()',t||'_mining_gems_flow_truncate',t);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.mining_gems_flow_coverage) THEN
   EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I',t,t||'_mining_gems_flow_capture');
   EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I',t,t||'_mining_gems_flow_truncate');
  END IF;
 END LOOP;
END $migration$;
REVOKE ALL ON mining_gems_flow_coverage,mining_gems_flow_events FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_mining_gems_flow_guard(),public.shardkeep_capture_mining_gems_flow() FROM PUBLIC;
