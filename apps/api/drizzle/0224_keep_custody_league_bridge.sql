-- Dormant fixture schema; no archive, money, backfill or latch action.
-- The RC-first source restrictions are S5-held. Prefix94 fixtures install this
-- exact DDL early without adding a false Drizzle migration entry.
DO $$ DECLARE n text; BEGIN
  FOREACH n IN ARRAY ARRAY['keep_custody_league_bridge','keep_custody_league_weeks','keep_custody_league_retirements'] LOOP
    IF to_regclass('public.'||n) IS NOT NULL AND obj_description(to_regclass('public.'||n),'pg_class') IS DISTINCT FROM 'shardkeep:fixture-league-bridge:v1' THEN
      RAISE EXCEPTION 'CUSTODY_LEAGUE_SCHEMA_CONFLICT' USING ERRCODE='P0001';
    END IF;
  END LOOP;
END $$;
CREATE TABLE IF NOT EXISTS public.keep_custody_league_bridge (
  id boolean PRIMARY KEY DEFAULT true CHECK(id), fixture_id uuid NOT NULL UNIQUE,
  database_name text NOT NULL, operator_name text NOT NULL,
  source_version text NOT NULL CHECK(source_version='stable-league-pre0095-v1'),
  opening_xid bigint NOT NULL, sealed boolean NOT NULL DEFAULT false,
  result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.keep_custody_league_weeks (
  week date PRIMARY KEY, original_rows jsonb NOT NULL CHECK(jsonb_typeof(original_rows)='array'),
  reserve_receipt jsonb, paid_receipts jsonb NOT NULL CHECK(jsonb_typeof(paid_receipts)='array')
);
CREATE TABLE IF NOT EXISTS public.keep_custody_league_retirements (
  week date NOT NULL REFERENCES public.keep_custody_league_weeks(week), base_id uuid NOT NULL REFERENCES public.bases(id),
  journal_id uuid NOT NULL, wallet text NOT NULL REFERENCES public.players(wallet), keep bigint NOT NULL CHECK(keep>0),
  internal boolean NOT NULL, as_of timestamptz NOT NULL, observation jsonb NOT NULL,
  posting_key text NOT NULL UNIQUE, posting_type text NOT NULL, metadata jsonb NOT NULL,
  planned_entries jsonb NOT NULL, before_accounts jsonb NOT NULL, posting_xid bigint NOT NULL,
  ledger_id uuid UNIQUE REFERENCES public.ledger_transactions(id), PRIMARY KEY(week,base_id)
);
DO $$ DECLARE n text; expected text[]; actual text[]; BEGIN
 FOR n,expected IN VALUES
  ('keep_custody_league_bridge',ARRAY['id:boolean','fixture_id:uuid','database_name:text','operator_name:text','source_version:text','opening_xid:bigint','sealed:boolean','result:jsonb','created_at:timestamp with time zone']),
  ('keep_custody_league_weeks',ARRAY['week:date','original_rows:jsonb','reserve_receipt:jsonb','paid_receipts:jsonb']),
  ('keep_custody_league_retirements',ARRAY['week:date','base_id:uuid','journal_id:uuid','wallet:text','keep:bigint','internal:boolean','as_of:timestamp with time zone','observation:jsonb','posting_key:text','posting_type:text','metadata:jsonb','planned_entries:jsonb','before_accounts:jsonb','posting_xid:bigint','ledger_id:uuid']) LOOP
  SELECT array_agg(attname::text||':'||format_type(atttypid,atttypmod) ORDER BY attnum) INTO actual
   FROM pg_attribute WHERE attrelid=to_regclass('public.'||n) AND attnum>0 AND NOT attisdropped;
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'CUSTODY_LEAGUE_SCHEMA_CONFLICT' USING ERRCODE='P0001'; END IF;
 END LOOP;
END $$;
-- A marker is not permission to adopt a differently constrained table.
DO $$ DECLARE item record; found_count integer; BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('keep_custody_league_bridge',ARRAY['id','fixture_id','database_name','operator_name','source_version','opening_xid','sealed','result','created_at']),
  ('keep_custody_league_weeks',ARRAY['week','original_rows','paid_receipts']),
  ('keep_custody_league_retirements',ARRAY['week','base_id','journal_id','wallet','keep','internal','as_of','observation','posting_key','posting_type','metadata','planned_entries','before_accounts','posting_xid'])
 ) required(tab,cols) LOOP
  IF (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a
   WHERE a.attrelid=to_regclass('public.'||item.tab) AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull) IS DISTINCT FROM item.cols THEN
   RAISE EXCEPTION 'CUSTODY_LEAGUE_SCHEMA_CONFLICT' USING ERRCODE='P0001'; END IF;
 END LOOP;
 FOR item IN SELECT * FROM (VALUES
  ('keep_custody_league_bridge','p',ARRAY['id'],NULL,NULL,NULL),
  ('keep_custody_league_bridge','u',ARRAY['fixture_id'],NULL,NULL,NULL),
  ('keep_custody_league_bridge','c',ARRAY['id'],NULL,NULL,'id'),
  ('keep_custody_league_bridge','c',ARRAY['source_version'],NULL,NULL,'source_version = ''stable-league-pre0095-v1''::text'),
  ('keep_custody_league_weeks','p',ARRAY['week'],NULL,NULL,NULL),
  ('keep_custody_league_weeks','c',ARRAY['original_rows'],NULL,NULL,'jsonb_typeof(original_rows) = ''array''::text'),
  ('keep_custody_league_weeks','c',ARRAY['paid_receipts'],NULL,NULL,'jsonb_typeof(paid_receipts) = ''array''::text'),
  ('keep_custody_league_retirements','p',ARRAY['week','base_id'],NULL,NULL,NULL),
  ('keep_custody_league_retirements','u',ARRAY['posting_key'],NULL,NULL,NULL),
  ('keep_custody_league_retirements','u',ARRAY['ledger_id'],NULL,NULL,NULL),
  ('keep_custody_league_retirements','c',ARRAY['keep'],NULL,NULL,'keep > 0'),
  ('keep_custody_league_retirements','f',ARRAY['week'],'keep_custody_league_weeks',ARRAY['week'],NULL),
  ('keep_custody_league_retirements','f',ARRAY['base_id'],'bases',ARRAY['id'],NULL),
  ('keep_custody_league_retirements','f',ARRAY['wallet'],'players',ARRAY['wallet'],NULL),
  ('keep_custody_league_retirements','f',ARRAY['ledger_id'],'ledger_transactions',ARRAY['id'],NULL)
 ) required(tab,kind,cols,ref_tab,ref_cols,expr) LOOP
  SELECT count(*) INTO found_count FROM pg_constraint c WHERE c.conrelid=to_regclass('public.'||item.tab)
   AND c.contype::text=item.kind AND NOT c.condeferrable AND NOT c.condeferred AND c.convalidated
   AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num,ord)
     JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord)=item.cols
   AND (item.ref_tab IS NULL OR (c.confrelid=to_regclass('public.'||item.ref_tab) AND c.confupdtype='a' AND c.confdeltype='a'
     AND ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num,ord)
       JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord)=item.ref_cols))
   AND (item.expr IS NULL OR regexp_replace(pg_get_expr(c.conbin,c.conrelid),'[[:space:]()]','','g')=regexp_replace(item.expr,'[[:space:]()]','','g'));
  IF found_count<>1 THEN RAISE EXCEPTION 'CUSTODY_LEAGUE_SCHEMA_CONFLICT' USING ERRCODE='P0001'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM (VALUES ('keep_custody_league_bridge',4),('keep_custody_league_weeks',3),('keep_custody_league_retirements',8)) required(tab,n)
  WHERE (SELECT count(*) FROM pg_constraint c WHERE c.conrelid=to_regclass('public.'||required.tab) AND c.contype<>'t')<>required.n) THEN
  RAISE EXCEPTION 'CUSTODY_LEAGUE_SCHEMA_CONFLICT' USING ERRCODE='P0001'; END IF;
END $$;
COMMENT ON TABLE public.keep_custody_league_bridge IS 'shardkeep:fixture-league-bridge:v1';
COMMENT ON TABLE public.keep_custody_league_weeks IS 'shardkeep:fixture-league-bridge:v1';
COMMENT ON TABLE public.keep_custody_league_retirements IS 'shardkeep:fixture-league-bridge:v1';
REVOKE ALL ON public.keep_custody_league_bridge,public.keep_custody_league_weeks,public.keep_custody_league_retirements FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_league_rc() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CUSTODY_LEAGUE_READ_COMMITTED_REQUIRED' USING ERRCODE='P0001'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_league_receipt(txn uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('id',t.id,'key',t.idempotency_key,'type',t.type,'metadata',t.metadata,'createdAt',t.created_at,
  'entries',(SELECT jsonb_agg(jsonb_build_object('id',e.id::text,'account',a.id,'kind',a.kind::text,'currency',a.currency::text,
    'wallet',a.owner_wallet,'baseId',a.base_id,'delta',e.delta::text,'balanceAfter',e.balance_after::text) ORDER BY e.id)
   FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id WHERE e.txn_id=t.id))
 FROM public.ledger_transactions t WHERE t.id=txn
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_league_legs(receipt jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_agg(jsonb_build_object('kind',e->>'kind','currency',e->>'currency','wallet',e->'wallet','baseId',e->'baseId','delta',e->>'delta') ORDER BY e->>'kind',e->>'wallet')
 FROM jsonb_array_elements(receipt->'entries') e
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_league_original(w date,b uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT r FROM public.keep_custody_league_weeks s CROSS JOIN LATERAL jsonb_array_elements(s.original_rows) r WHERE s.week=w AND r->>'base_id'=b::text
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_league_assert_week(w date, source_rows jsonb, reserve jsonb, paid jsonb)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE total bigint; n integer; r jsonb; p jsonb; expected jsonb; recipient text; paid_count integer:=0;
BEGIN
 SELECT sum((source_row->>'keep_amount')::bigint),count(*) INTO total,n FROM jsonb_array_elements(source_rows) source_row;
 IF n=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(source_rows) source_row WHERE source_row->>'week'<>w::text OR (source_row->>'keep_amount')::bigint<0 OR (source_row->>'trophies')::integer<0)
   OR (SELECT count(DISTINCT source_row->>'base_id') FROM jsonb_array_elements(source_rows) source_row)<>n THEN RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
 IF total>0 THEN
  expected:=jsonb_build_array(jsonb_build_object('kind','league_entitlement_escrow','currency','KEEP','wallet',null,'baseId',null,'delta',total::text),
   jsonb_build_object('kind','league_pool','currency','KEEP','wallet',null,'baseId',null,'delta',(-total)::text));
  IF reserve IS NULL OR reserve->>'key'<>'league-entitlements:'||w::text OR reserve->>'type'<>'league.weekly_reserve'
    OR reserve->'metadata'<>jsonb_build_object('week',w::text,'entitlements',n) OR public.shardkeep_league_legs(reserve) IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
 ELSIF reserve IS NOT NULL THEN RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(source_rows) LOOP
  SELECT value INTO p FROM jsonb_array_elements(paid) WHERE value->>'key'='league:'||w::text||':'||(r->>'base_id');
  IF (r->>'keep_amount')::bigint>0 AND r->>'paid_at' IS NOT NULL THEN
   paid_count:=paid_count+1; recipient:=p->'metadata'->>'wallet';
   expected:=jsonb_build_array(jsonb_build_object('kind','league_entitlement_escrow','currency','KEEP','wallet',null,'baseId',null,'delta',(-((r->>'keep_amount')::bigint))::text),
    jsonb_build_object('kind','player_keep','currency','KEEP','wallet',recipient,'baseId',null,'delta',r->>'keep_amount'));
   IF p IS NULL OR recipient IS NULL OR p->>'type'<>'league.weekly_prize'
     OR p->'metadata'<>jsonb_build_object('wallet',recipient,'tier',r->>'tier','baseId',r->>'base_id','week',w::text)
     OR public.shardkeep_league_legs(p) IS DISTINCT FROM expected THEN RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
  ELSIF p IS NOT NULL THEN RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
 END LOOP;
 IF jsonb_array_length(paid)<>paid_count THEN RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
END $$;
--> statement-breakpoint
-- Retirement authority is added below through exact plans; before it exists the
-- source fence deliberately admits no escrow changes.
CREATE OR REPLACE FUNCTION public.shardkeep_league_source_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE h public.keep_custody_league_bridge; original jsonb; item jsonb; protected boolean:=false;
BEGIN
 PERFORM public.shardkeep_league_rc();
 IF TG_RELID NOT IN ('public.base_league_entitlements'::regclass,'public.ledger_transactions'::regclass,'public.ledger_entries'::regclass,'public.accounts'::regclass)
  OR TG_WHEN<>'BEFORE' OR NOT ((TG_NAME='a_keep_custody_league_source' AND TG_LEVEL='ROW' AND TG_OP IN ('INSERT','UPDATE','DELETE'))
    OR (TG_NAME='a_keep_custody_league_truncate' AND TG_LEVEL='STATEMENT' AND TG_OP='TRUNCATE'))
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=TG_RELID AND t.tgname=TG_NAME
    AND t.tgfoid='public.shardkeep_league_source_guard()'::regprocedure AND NOT t.tgisinternal AND t.tgenabled='O'
    AND t.tgtype=CASE WHEN TG_OP='TRUNCATE' THEN 34 ELSE 31 END) THEN
  RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_FROZEN' USING ERRCODE='P0001'; END IF;
 SELECT * INTO h FROM public.keep_custody_league_bridge WHERE id;
 IF h.id IS NULL THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
 PERFORM public.shardkeep_league_assert_hooks();
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_FROZEN' USING ERRCODE='P0001'; END IF;
 IF TG_TABLE_NAME='base_league_entitlements' THEN
  IF TG_OP<>'INSERT' THEN original:=public.shardkeep_league_original(OLD.week,OLD.base_id); END IF;
  IF TG_OP='DELETE' AND NOT h.sealed AND h.opening_xid=txid_current() AND original=to_jsonb(OLD) AND OLD.keep_amount>0 THEN RETURN OLD; END IF;
  protected:=original IS NOT NULL OR (TG_OP<>'DELETE' AND (NEW.keep_amount>0 OR public.shardkeep_league_original(NEW.week,NEW.base_id) IS NOT NULL));
 ELSIF TG_TABLE_NAME='ledger_transactions' THEN
  protected:=(TG_OP<>'INSERT' AND (OLD.idempotency_key LIKE 'league-entitlements:%' OR OLD.idempotency_key LIKE 'league:%' OR OLD.type IN ('league.weekly_reserve','league.weekly_prize')))
   OR (TG_OP<>'DELETE' AND (NEW.idempotency_key LIKE 'league-entitlements:%' OR NEW.idempotency_key LIKE 'league:%' OR NEW.type IN ('league.weekly_reserve','league.weekly_prize')));
 ELSIF TG_TABLE_NAME='ledger_entries' THEN
  FOR item IN SELECT value FROM jsonb_array_elements(CASE WHEN TG_OP='INSERT' THEN jsonb_build_array(to_jsonb(NEW)) WHEN TG_OP='DELETE' THEN jsonb_build_array(to_jsonb(OLD)) ELSE jsonb_build_array(to_jsonb(OLD),to_jsonb(NEW)) END) LOOP
   protected:=protected OR EXISTS(SELECT 1 FROM public.accounts a WHERE a.id=(item->>'account_id')::uuid AND a.kind::text='league_entitlement_escrow')
    OR EXISTS(SELECT 1 FROM public.ledger_transactions t WHERE t.id=(item->>'txn_id')::uuid AND (t.idempotency_key LIKE 'league-entitlements:%' OR t.idempotency_key LIKE 'league:%' OR t.type IN ('league.weekly_reserve','league.weekly_prize')));
  END LOOP;
 ELSE
  protected:=(TG_OP<>'INSERT' AND OLD.kind::text='league_entitlement_escrow') OR (TG_OP<>'DELETE' AND NEW.kind::text='league_entitlement_escrow');
  IF TG_OP='INSERT' THEN
   IF NEW.kind::text='league_entitlement_escrow' AND NEW.currency::text='KEEP' AND NEW.owner_wallet IS NULL AND NEW.base_id IS NULL AND NEW.balance=0
    AND EXISTS(SELECT 1 FROM public.accounts a WHERE a.kind::text='league_entitlement_escrow' AND a.currency::text='KEEP' AND a.owner_wallet IS NULL AND a.base_id IS NULL) THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.kind,NEW.currency,NEW.owner_wallet,NEW.base_id,NEW.created_at)
    IS NOT DISTINCT FROM ROW(OLD.id,OLD.kind,OLD.currency,OLD.owner_wallet,OLD.base_id,OLD.created_at) AND NEW.balance=OLD.balance THEN protected:=false;
  ELSIF TG_OP<>'INSERT' THEN
   protected:=protected OR EXISTS(SELECT 1 FROM public.keep_custody_league_weeks w CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(w.reserve_receipt)||w.paid_receipts) p
    CROSS JOIN LATERAL jsonb_array_elements(p->'entries') e WHERE e->>'account'=OLD.id::text AND (TG_OP='DELETE' OR ROW(NEW.id,NEW.kind,NEW.currency,NEW.owner_wallet,NEW.base_id,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.kind,OLD.currency,OLD.owner_wallet,OLD.base_id,OLD.created_at)));
  END IF;
  IF TG_OP<>'INSERT' THEN
   protected:=protected OR EXISTS(SELECT 1 FROM public.keep_custody_league_retirements z CROSS JOIN LATERAL jsonb_array_elements(z.before_accounts) a
    WHERE a->>'id'=OLD.id::text AND (TG_OP='DELETE' OR ROW(NEW.id,NEW.kind,NEW.currency,NEW.owner_wallet,NEW.base_id,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.kind,OLD.currency,OLD.owner_wallet,OLD.base_id,OLD.created_at)));
  END IF;
 END IF;
 IF protected AND public.shardkeep_league_money_write(TG_TABLE_NAME,TG_OP,CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END) THEN protected:=false; END IF;
 IF protected THEN RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_FROZEN' USING ERRCODE='P0001'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['base_league_entitlements','ledger_transactions','ledger_entries','accounts'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS a_keep_custody_league_source ON public.%I',n);
  EXECUTE format('CREATE TRIGGER a_keep_custody_league_source BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_league_source_guard()',n);
  EXECUTE format('DROP TRIGGER IF EXISTS a_keep_custody_league_truncate ON public.%I',n);
  EXECUTE format('CREATE TRIGGER a_keep_custody_league_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_league_source_guard()',n);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_league_private_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE h public.keep_custody_league_bridge; actual jsonb; n integer; paid integer; unpaid_count integer; zero_count integer; unpaid bigint;
BEGIN
 PERFORM public.shardkeep_league_rc();
 PERFORM public.shardkeep_league_assert_hooks();
 IF TG_RELID NOT IN ('public.keep_custody_league_bridge'::regclass,'public.keep_custody_league_weeks'::regclass,'public.keep_custody_league_retirements'::regclass)
   OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
   OR current_database()!~'^shardkeep_custody_apply_[0-9a-f]{32}_test$' THEN RAISE EXCEPTION 'CUSTODY_LEAGUE_FIXTURE_REQUIRED' USING ERRCODE='P0001'; END IF;
 SELECT * INTO h FROM public.keep_custody_league_bridge WHERE id;
 IF TG_TABLE_NAME='keep_custody_league_bridge' AND TG_OP='INSERT' AND h.id IS NULL THEN
  IF NEW.sealed OR NEW.opening_xid<>txid_current() OR NEW.database_name<>current_database() OR NEW.operator_name<>current_user
    OR (SELECT count(*) FROM drizzle.__drizzle_migrations)<>95 OR (SELECT max(created_at) FROM drizzle.__drizzle_migrations)<>1788030484374
    OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.base_league_entitlements'::regclass AND attname='cache_shards_granted' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'CUSTODY_LEAGUE_OPENING_REQUIRED' USING ERRCODE='P0001'; END IF;
  FOR actual IN SELECT to_jsonb(c) FROM (VALUES ('base_league_entitlements'),('ledger_transactions'),('ledger_entries'),('accounts'),('players'),('bases')) c(name) LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND relation=to_regclass('public.'||(actual->>'name')) AND mode='AccessExclusiveLock' AND granted) THEN
    RAISE EXCEPTION 'CUSTODY_LEAGUE_BARRIER_REQUIRED' USING ERRCODE='P0001'; END IF;
  END LOOP;
  SELECT count(*),count(*) FILTER(WHERE keep_amount=0),count(*) FILTER(WHERE keep_amount>0 AND paid_at IS NOT NULL),
    count(*) FILTER(WHERE keep_amount>0 AND paid_at IS NULL),coalesce(sum(keep_amount) FILTER(WHERE keep_amount>0 AND paid_at IS NULL),0)
    INTO n,zero_count,paid,unpaid_count,unpaid FROM public.base_league_entitlements;
  actual:=jsonb_build_object('fixtureOnly',true,'retirementAuthorized',false,'fixtureId',NEW.fixture_id,'sourceVersion','stable-league-pre0095-v1',
    'weeks',(SELECT count(DISTINCT week) FROM public.base_league_entitlements),'rows',n,'zeroRows',zero_count,'paidPositiveRows',paid,'unpaidPositiveRows',unpaid_count,'unpaidKeep',unpaid::text);
  IF NEW.result<>actual THEN RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
  RETURN NEW;
 END IF;
 IF h.id AND NOT h.sealed AND h.opening_xid=txid_current() THEN
  IF TG_TABLE_NAME='keep_custody_league_weeks' AND TG_OP='INSERT' THEN
   SELECT jsonb_agg(to_jsonb(e) ORDER BY base_id) INTO actual FROM public.base_league_entitlements e WHERE week=NEW.week;
   IF actual IS DISTINCT FROM NEW.original_rows OR NEW.reserve_receipt IS DISTINCT FROM
    (SELECT public.shardkeep_league_receipt(id) FROM public.ledger_transactions WHERE idempotency_key='league-entitlements:'||NEW.week::text)
    OR NEW.paid_receipts IS DISTINCT FROM (SELECT coalesce(jsonb_agg(public.shardkeep_league_receipt(t.id) ORDER BY t.idempotency_key),'[]'::jsonb)
     FROM public.ledger_transactions t JOIN public.base_league_entitlements e ON t.idempotency_key='league:'||e.week::text||':'||e.base_id::text WHERE e.week=NEW.week) THEN
    RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
   PERFORM public.shardkeep_league_assert_week(NEW.week,NEW.original_rows,NEW.reserve_receipt,NEW.paid_receipts);
   RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='keep_custody_league_bridge' AND TG_OP='UPDATE' THEN
   IF NEW.sealed AND (to_jsonb(NEW)-'sealed')=(to_jsonb(OLD)-'sealed') THEN RETURN NEW; END IF;
  END IF;
 END IF;
 RAISE EXCEPTION 'CUSTODY_LEAGUE_IMMUTABLE' USING ERRCODE='P0001';
END $$;
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['keep_custody_league_bridge','keep_custody_league_weeks','keep_custody_league_retirements'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS keep_custody_league_private ON public.%I',n);
  EXECUTE format('CREATE TRIGGER keep_custody_league_private BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_league_private_guard()',n);
  EXECUTE format('DROP TRIGGER IF EXISTS keep_custody_league_no_truncate ON public.%I',n);
  EXECUTE format('CREATE TRIGGER keep_custody_league_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_league_private_guard()',n);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_league_bridge_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE h public.keep_custody_league_bridge; w record; r jsonb; n integer; unpaid bigint;
BEGIN
 PERFORM public.shardkeep_league_rc();
 PERFORM public.shardkeep_league_assert_hooks();
 SELECT * INTO h FROM public.keep_custody_league_bridge WHERE id;
 IF h.id IS NULL OR NOT h.sealed THEN RAISE EXCEPTION 'CUSTODY_LEAGUE_INCOMPLETE' USING ERRCODE='P0001'; END IF;
 SELECT count(*),coalesce(sum((source_row->>'keep_amount')::bigint) FILTER(WHERE source_row->>'paid_at' IS NULL),0) INTO n,unpaid
   FROM public.keep_custody_league_weeks source_week CROSS JOIN LATERAL jsonb_array_elements(source_week.original_rows) source_row;
 IF n<>(h.result->>'rows')::integer OR (SELECT count(*) FROM public.keep_custody_league_weeks)<>(h.result->>'weeks')::integer
   OR EXISTS(SELECT 1 FROM public.base_league_entitlements WHERE keep_amount<>0)
   OR EXISTS(SELECT 1 FROM public.base_league_entitlements e WHERE public.shardkeep_league_original(e.week,e.base_id) IS NULL) THEN
   RAISE EXCEPTION 'CUSTODY_LEAGUE_INCOMPLETE' USING ERRCODE='P0001'; END IF;
 FOR w IN SELECT * FROM public.keep_custody_league_weeks LOOP
  FOR r IN SELECT value FROM jsonb_array_elements(w.original_rows) LOOP
   IF (r->>'keep_amount')::bigint=0 AND r IS DISTINCT FROM (SELECT to_jsonb(e) FROM public.base_league_entitlements e WHERE e.week=w.week AND e.base_id=(r->>'base_id')::uuid) THEN
    RAISE EXCEPTION 'CUSTODY_LEAGUE_INCOMPLETE' USING ERRCODE='P0001'; END IF;
  END LOOP;
 END LOOP;
 IF unpaid IS DISTINCT FROM (SELECT balance FROM public.accounts WHERE kind::text='league_entitlement_escrow' AND owner_wallet IS NULL AND base_id IS NULL) THEN
  RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS keep_custody_league_opening_complete ON public.keep_custody_league_bridge;
CREATE CONSTRAINT TRIGGER keep_custody_league_opening_complete AFTER INSERT OR UPDATE ON public.keep_custody_league_bridge
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_league_bridge_complete();
REVOKE ALL ON FUNCTION public.shardkeep_league_rc(),public.shardkeep_league_receipt(uuid),public.shardkeep_league_legs(jsonb),public.shardkeep_league_original(date,uuid),public.shardkeep_league_assert_week(date,jsonb,jsonb,jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_assert_league_archive() RETURNS void LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE h public.keep_custody_league_bridge; w record; r jsonb; p jsonb; actual jsonb; n integer; unpaid bigint;
BEGIN
 PERFORM public.shardkeep_league_assert_hooks();
 SELECT * INTO h FROM public.keep_custody_league_bridge WHERE id;
 IF h.id IS NULL THEN
  IF EXISTS(SELECT 1 FROM public.keep_custody_league_weeks) OR EXISTS(SELECT 1 FROM public.keep_custody_league_retirements) THEN
   RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
  RETURN;
 END IF;
 IF NOT h.sealed THEN RAISE EXCEPTION 'CUSTODY_LEAGUE_INCOMPLETE' USING ERRCODE='P0001'; END IF;
 SELECT count(*) INTO n FROM public.keep_custody_league_weeks source_week CROSS JOIN LATERAL jsonb_array_elements(source_week.original_rows) source_row;
 IF n<>(h.result->>'rows')::integer OR (SELECT count(*) FROM public.keep_custody_league_weeks)<>(h.result->>'weeks')::integer THEN
  RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
 FOR w IN SELECT * FROM public.keep_custody_league_weeks LOOP
  PERFORM public.shardkeep_league_assert_week(w.week,w.original_rows,w.reserve_receipt,w.paid_receipts);
  FOR p IN SELECT value FROM jsonb_array_elements(jsonb_build_array(w.reserve_receipt)||w.paid_receipts) WHERE value<>'null'::jsonb LOOP
   IF p IS DISTINCT FROM public.shardkeep_league_receipt((p->>'id')::uuid) THEN RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
  END LOOP;
  FOR r IN SELECT value FROM jsonb_array_elements(w.original_rows) LOOP
   IF (r->>'keep_amount')::bigint=0 THEN
    SELECT jsonb_object_agg(k,to_jsonb(e)->k) INTO actual FROM public.base_league_entitlements e CROSS JOIN LATERAL jsonb_object_keys(r) k WHERE e.week=w.week AND e.base_id=(r->>'base_id')::uuid;
    IF actual IS DISTINCT FROM r THEN RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
   ELSIF EXISTS(SELECT 1 FROM public.base_league_entitlements e WHERE e.week=w.week AND e.base_id=(r->>'base_id')::uuid) THEN
    RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_CONFLICT' USING ERRCODE='P0001';
   END IF;
   IF r->>'paid_at' IS NULL AND EXISTS(SELECT 1 FROM public.ledger_transactions WHERE idempotency_key='league:'||w.week::text||':'||(r->>'base_id')) THEN
    RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
  END LOOP;
 END LOOP;
 SELECT coalesce(sum((source_row->>'keep_amount')::bigint),0) INTO unpaid FROM public.keep_custody_league_weeks source_week CROSS JOIN LATERAL jsonb_array_elements(source_week.original_rows) source_row
  WHERE source_row->>'paid_at' IS NULL AND NOT EXISTS(SELECT 1 FROM public.keep_custody_league_retirements z WHERE z.week=source_week.week AND z.base_id=(source_row->>'base_id')::uuid);
 IF unpaid IS DISTINCT FROM (SELECT balance FROM public.accounts WHERE kind::text='league_entitlement_escrow' AND owner_wallet IS NULL AND base_id IS NULL) THEN
  RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
END $$;
--> statement-breakpoint
-- This computes every planned field from live protected sources. The fixture
-- facade supplies as_of/internal only after its independent current-time and
-- census/config checks; SQL does not claim to authenticate environment policy.
CREATE OR REPLACE FUNCTION public.shardkeep_league_retirement_plan(w date,b uuid,journal uuid,at_time timestamptz,is_internal boolean)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE original jsonb; v_owner text; asset text; observation jsonb; amount bigint; posting_key text; entries jsonb; before_accounts jsonb;
 escrow uuid; emission uuid; mint uuid; destination uuid; name text; meta jsonb; typ text;
BEGIN
 PERFORM public.shardkeep_league_rc();
 PERFORM public.shardkeep_league_assert_hooks();
 IF current_database()!~'^shardkeep_custody_apply_[0-9a-f]{32}_test$'
  OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.keep_custody_league_retirements'::regclass)
  OR NOT EXISTS(SELECT 1 FROM public.keep_custody_league_bridge WHERE id AND sealed) THEN
  RAISE EXCEPTION 'CUSTODY_LEAGUE_FIXTURE_REQUIRED' USING ERRCODE='P0001'; END IF;
 FOREACH name IN ARRAY ARRAY['ledger_transactions','accounts','ledger_entries','players','bases','base_slots','deed_ownership_observations',
   'base_forge_positions','forge_contributions','raid_loot_reservations','base_raid_locks','mail_messages','mail_attachments','base_league_entitlements',
   'withdrawals','withdrawal_attempts','withdrawal_payout_reservations','deposits','player_items','item_listings','keep_custody_journal',
   'keep_custody_league_bridge','keep_custody_league_weeks','keep_custody_league_retirements'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND relation=to_regclass('public.'||name) AND mode='AccessExclusiveLock' AND granted) THEN
   RAISE EXCEPTION 'CUSTODY_LEAGUE_BARRIER_REQUIRED' USING ERRCODE='P0001'; END IF;
 END LOOP;
 IF (SELECT phase FROM public.keep_custody_cutover_state WHERE id) IS DISTINCT FROM 'withdrawals_closed' THEN
  RAISE EXCEPTION 'CUSTODY_LEAGUE_PHASE_REQUIRED' USING ERRCODE='P0001'; END IF;
 original:=public.shardkeep_league_original(w,b); amount:=(original->>'keep_amount')::bigint;
 IF original IS NULL OR amount<=0 OR original->>'paid_at' IS NOT NULL THEN RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
 posting_key:='league:retire:'||b::text||':'||w::text;
 IF EXISTS(SELECT 1 FROM public.ledger_transactions t WHERE t.idempotency_key IN (posting_key,'league:'||w::text||':'||b::text)) THEN
  RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
 SELECT x.owner_wallet,x.deed_asset_id INTO v_owner,asset FROM public.bases x WHERE x.id=b AND x.land_paid_at IS NOT NULL;
 SELECT to_jsonb(o) INTO observation FROM public.deed_ownership_observations o WHERE base_id=b ORDER BY checked_at DESC,id DESC LIMIT 1;
 IF v_owner IS NULL OR asset IS NULL OR observation IS NULL OR observation->>'owner' IS DISTINCT FROM v_owner
   OR observation->>'asset_id' IS DISTINCT FROM asset OR observation->>'status' IS DISTINCT FROM 'owned'
   OR observation->>'slot' IS NULL OR (observation->>'slot')::bigint<0 OR (observation->>'checked_at')::timestamptz>at_time THEN
  RAISE EXCEPTION 'CUSTODY_LEAGUE_OWNERSHIP_UNRESOLVED' USING ERRCODE='P0001'; END IF;
 SELECT id INTO escrow FROM public.accounts WHERE kind::text='league_entitlement_escrow' AND currency::text='KEEP' AND owner_wallet IS NULL AND base_id IS NULL;
 SELECT id INTO emission FROM public.accounts WHERE kind::text='emission_pool' AND currency::text='KEEP' AND owner_wallet IS NULL AND base_id IS NULL;
 IF escrow IS NULL OR emission IS NULL THEN RAISE EXCEPTION 'CUSTODY_LEAGUE_ACCOUNT_IDENTITY_REQUIRED' USING ERRCODE='P0001'; END IF;
 entries:=jsonb_build_array(jsonb_build_object('account',escrow,'delta',(-amount)::text),jsonb_build_object('account',emission,'delta',amount::text));
 IF is_internal THEN
  typ:='gems.retirement.sweep'; meta:=jsonb_build_object('wallet',v_owner,'keep',amount::text,'reason','internal-wallet','fixtureId',journal,'week',w::text,'baseId',b);
 ELSE
  SELECT id INTO mint FROM public.accounts WHERE kind::text='gems_mint' AND currency::text='GEMS' AND owner_wallet IS NULL AND base_id IS NULL;
  SELECT id INTO destination FROM public.accounts a WHERE kind::text='player_gems' AND currency::text='GEMS' AND a.owner_wallet=v_owner AND base_id IS NULL;
  IF mint IS NULL OR destination IS NULL THEN RAISE EXCEPTION 'CUSTODY_LEAGUE_ACCOUNT_IDENTITY_REQUIRED' USING ERRCODE='P0001'; END IF;
  -- D-152 same-amount conversion. The facade independently checks against
  -- GEMS.gemsPerKeep; no SQL game-number constant or caller Gems quote exists.
  entries:=entries||jsonb_build_array(jsonb_build_object('account',mint,'delta',(-amount)::text),jsonb_build_object('account',destination,'delta',amount::text));
  typ:='gems.retirement'; meta:=jsonb_build_object('wallet',v_owner,'class','L5','keep',amount::text,'gems',amount::text,'reason','retirement','fixtureId',journal,'week',w::text,'baseId',b);
 END IF;
 SELECT jsonb_agg(jsonb_build_object('id',a.id,'kind',a.kind::text,'currency',a.currency::text,'wallet',a.owner_wallet,'baseId',a.base_id,'balance',a.balance::text) ORDER BY a.id)
  INTO before_accounts FROM public.accounts a WHERE a.id IN (SELECT (e->>'account')::uuid FROM jsonb_array_elements(entries) e);
 IF EXISTS(SELECT 1 FROM public.accounts a WHERE a.id IN (SELECT (e->>'account')::uuid FROM jsonb_array_elements(entries) e)
  AND a.balance<>coalesce((SELECT sum(delta) FROM public.ledger_entries WHERE account_id=a.id),0))
  OR (SELECT balance FROM public.accounts WHERE id=escrow)<amount THEN
  RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
 RETURN jsonb_build_object('week',w,'base_id',b,'journal_id',journal,'wallet',v_owner,'keep',amount,'internal',is_internal,'as_of',at_time,
  'observation',observation,'posting_key',posting_key,'posting_type',typ,'metadata',meta,'planned_entries',entries,'before_accounts',before_accounts,
  'posting_xid',txid_current(),'ledger_id',null);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_league_retirement_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE wanted jsonb;
BEGIN
 PERFORM public.shardkeep_league_rc();
 PERFORM public.shardkeep_league_assert_hooks();
 IF TG_RELID<>'public.keep_custody_league_retirements'::regclass OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN
  RAISE EXCEPTION 'CUSTODY_LEAGUE_FIXTURE_REQUIRED' USING ERRCODE='P0001'; END IF;
 IF TG_OP='INSERT' THEN
  wanted:=public.shardkeep_league_retirement_plan(NEW.week,NEW.base_id,NEW.journal_id,NEW.as_of,NEW.internal);
  IF to_jsonb(NEW) IS DISTINCT FROM wanted THEN RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.ledger_id IS NULL AND NEW.ledger_id IS NOT NULL AND OLD.posting_xid=txid_current()
   AND (to_jsonb(NEW)-'ledger_id')=(to_jsonb(OLD)-'ledger_id') AND EXISTS(SELECT 1 FROM public.ledger_transactions t
    WHERE t.id=NEW.ledger_id AND t.idempotency_key=OLD.posting_key AND t.type=OLD.posting_type AND t.metadata=OLD.metadata) THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'CUSTODY_LEAGUE_IMMUTABLE' USING ERRCODE='P0001';
END $$;
DROP TRIGGER keep_custody_league_private ON public.keep_custody_league_retirements;
CREATE TRIGGER keep_custody_league_private BEFORE INSERT OR UPDATE OR DELETE ON public.keep_custody_league_retirements FOR EACH ROW EXECUTE FUNCTION public.shardkeep_league_retirement_guard();
DROP TRIGGER keep_custody_league_no_truncate ON public.keep_custody_league_retirements;
CREATE TRIGGER keep_custody_league_no_truncate BEFORE TRUNCATE ON public.keep_custody_league_retirements FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_league_retirement_guard();
CREATE OR REPLACE FUNCTION public.shardkeep_prepare_fixture_league_retirement(w date,b uuid,journal uuid,as_of timestamptz,internal boolean)
RETURNS TABLE(wallet text,keep text,posting_key text,posting_type text,metadata jsonb,entries jsonb)
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE plan jsonb;
BEGIN
 plan:=public.shardkeep_league_retirement_plan(w,b,journal,as_of,internal);
 INSERT INTO public.keep_custody_league_retirements SELECT * FROM jsonb_populate_record(null::public.keep_custody_league_retirements,plan);
 RETURN QUERY SELECT plan->>'wallet',plan->>'keep',plan->>'posting_key',plan->>'posting_type',plan->'metadata',plan->'planned_entries';
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_league_money_write(tab text,op text,old_row jsonb,new_row jsonb)
RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.keep_custody_league_retirements; leg jsonb; before jsonb;
BEGIN
 IF tab='ledger_transactions' AND op='INSERT' THEN
  SELECT * INTO p FROM public.keep_custody_league_retirements WHERE posting_key=new_row->>'idempotency_key';
  RETURN p.week IS NOT NULL AND p.posting_xid=txid_current() AND p.ledger_id IS NULL
    AND p.posting_type=new_row->>'type' AND p.metadata=new_row->'metadata';
 ELSIF tab='ledger_entries' AND op='INSERT' THEN
  SELECT * INTO p FROM public.keep_custody_league_retirements WHERE ledger_id=(new_row->>'txn_id')::uuid;
  IF p.week IS NULL OR p.posting_xid<>txid_current() THEN RETURN false; END IF;
  SELECT value INTO leg FROM jsonb_array_elements(p.planned_entries) WHERE value->>'account'=new_row->>'account_id';
  SELECT value INTO before FROM jsonb_array_elements(p.before_accounts) WHERE value->>'id'=new_row->>'account_id';
  RETURN leg IS NOT NULL AND before IS NOT NULL AND (new_row->>'delta')::bigint=(leg->>'delta')::bigint
   AND (new_row->>'balance_after')::bigint=(before->>'balance')::bigint+(leg->>'delta')::bigint
   AND NOT EXISTS(SELECT 1 FROM public.ledger_entries WHERE txn_id=p.ledger_id AND account_id=(new_row->>'account_id')::uuid);
 ELSIF tab='accounts' AND op='UPDATE' THEN
  IF (old_row-'balance')<>(new_row-'balance') THEN RETURN false; END IF;
  FOR p IN SELECT * FROM public.keep_custody_league_retirements WHERE posting_xid=txid_current() AND ledger_id IS NOT NULL LOOP
   SELECT value INTO leg FROM jsonb_array_elements(p.planned_entries) WHERE value->>'account'=new_row->>'id';
   SELECT value INTO before FROM jsonb_array_elements(p.before_accounts) WHERE value->>'id'=new_row->>'id';
   IF leg IS NOT NULL AND before IS NOT NULL AND (old_row->>'balance')::bigint=(before->>'balance')::bigint
    AND (new_row->>'balance')::bigint=(before->>'balance')::bigint+(leg->>'delta')::bigint
    AND EXISTS(SELECT 1 FROM public.ledger_entries WHERE txn_id=p.ledger_id AND account_id=(new_row->>'id')::uuid
      AND delta=(leg->>'delta')::bigint AND balance_after=(new_row->>'balance')::bigint) THEN RETURN true; END IF;
  END LOOP;
 END IF;
 RETURN false;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_league_bind_post() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM public.shardkeep_league_rc();
 IF TG_RELID<>'public.ledger_transactions'::regclass OR TG_OP<>'INSERT' OR TG_NAME<>'keep_custody_league_bind_post'
   OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR NOT EXISTS(SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid=TG_RELID AND t.tgname=TG_NAME AND t.tgfoid='public.shardkeep_league_bind_post()'::regprocedure
      AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgtype=5) THEN
  RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_FROZEN' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT 1 FROM public.keep_custody_league_retirements WHERE posting_key=NEW.idempotency_key) THEN
  UPDATE public.keep_custody_league_retirements SET ledger_id=NEW.id WHERE posting_key=NEW.idempotency_key AND ledger_id IS NULL
    AND posting_xid=txid_current() AND posting_type=NEW.type AND metadata=NEW.metadata;
  IF NOT FOUND THEN RAISE EXCEPTION 'CUSTODY_LEAGUE_SOURCE_FROZEN' USING ERRCODE='P0001'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS keep_custody_league_bind_post ON public.ledger_transactions;
CREATE TRIGGER keep_custody_league_bind_post AFTER INSERT ON public.ledger_transactions FOR EACH ROW EXECUTE FUNCTION public.shardkeep_league_bind_post();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_league_assert_post(w date,b uuid,journal uuid,require_final boolean)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.keep_custody_league_retirements; actual jsonb; original jsonb; e jsonb; before jsonb; j jsonb; saved jsonb; phase text; own_projection boolean:=false; n text;
BEGIN
 SELECT * INTO p FROM public.keep_custody_league_retirements WHERE week=w AND base_id=b;
 original:=public.shardkeep_league_original(w,b);
 IF p.week IS NULL OR p.journal_id<>journal OR p.ledger_id IS NULL OR original IS NULL OR original->>'paid_at' IS NOT NULL
   OR p.keep<>(original->>'keep_amount')::bigint OR p.keep<=0 THEN RAISE EXCEPTION 'CUSTODY_LEAGUE_INCOMPLETE' USING ERRCODE='P0001'; END IF;
 actual:=public.shardkeep_league_receipt(p.ledger_id);
 IF actual IS NULL OR actual->>'key' IS DISTINCT FROM p.posting_key OR actual->>'type' IS DISTINCT FROM p.posting_type OR actual->'metadata' IS DISTINCT FROM p.metadata
   OR jsonb_array_length(actual->'entries')<>jsonb_array_length(p.planned_entries) THEN
   RAISE EXCEPTION 'CUSTODY_LEAGUE_POSTING_CONFLICT' USING ERRCODE='P0001'; END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(actual->'entries') LOOP
  SELECT value INTO before FROM jsonb_array_elements(p.before_accounts) WHERE value->>'id'=e->>'account';
  IF before IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.planned_entries) leg WHERE leg->>'account'=e->>'account' AND leg->>'delta'=e->>'delta')
   OR ROW(e->>'kind',e->>'currency',e->>'wallet',e->>'baseId') IS DISTINCT FROM ROW(before->>'kind',before->>'currency',before->>'wallet',before->>'baseId')
   OR (e->>'balanceAfter')::bigint<>(before->>'balance')::bigint+(e->>'delta')::bigint THEN
   RAISE EXCEPTION 'CUSTODY_LEAGUE_POSTING_CONFLICT' USING ERRCODE='P0001'; END IF;
 END LOOP;
 SELECT c.phase INTO phase FROM public.keep_custody_cutover_state c WHERE c.id;
 SELECT to_jsonb(c) INTO j FROM public.keep_custody_journal c WHERE id=journal;
 IF NOT require_final AND p.posting_xid=txid_current() AND j IS NULL AND phase='withdrawals_closed' THEN
  -- Actual complete money under the still-held barrier is visible to the
  -- caller's projected after-census. Deferred checks never use this branch.
  own_projection:=true;
  FOREACH n IN ARRAY ARRAY['ledger_transactions','ledger_entries','accounts','keep_custody_journal','keep_custody_league_bridge','keep_custody_league_weeks','keep_custody_league_retirements'] LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND relation=to_regclass('public.'||n) AND mode='AccessExclusiveLock' AND granted) THEN own_projection:=false; END IF;
  END LOOP;
 END IF;
 IF NOT own_projection THEN
  IF phase IS DISTINCT FROM 'frozen' OR jsonb_typeof(j) IS DISTINCT FROM 'object'
    OR j->>'operation' IS DISTINCT FROM 'fixture:l1-mail-forge-league-retirement'
    OR j->>'subcommand' IS DISTINCT FROM 'retire-l1-mail-forge-league'
    OR j->>'scope' IS DISTINCT FROM 'fixture' OR (j->>'dry_run')::boolean IS DISTINCT FROM false
    OR j->>'database_name' IS DISTINCT FROM current_database() OR jsonb_typeof(j->'request') IS DISTINCT FROM 'object'
    OR j->'request'->>'fixtureId' IS DISTINCT FROM journal::text OR (j->'request'->>'asOf')::timestamptz IS DISTINCT FROM p.as_of
    OR jsonb_typeof(j->'request'->'league') IS DISTINCT FROM 'array' OR jsonb_typeof(j->'receipts') IS DISTINCT FROM 'array'
    OR (j->'request'->'league' @> jsonb_build_array(jsonb_build_object('week',w::text,'baseId',b,'wallet',p.wallet,'keep',p.keep::text,'internal',p.internal))) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'CUSTODY_LEAGUE_JOURNAL_REQUIRED' USING ERRCODE='P0001'; END IF;
  SELECT value INTO saved FROM jsonb_array_elements(j->'receipts') WHERE value->>'id'=p.ledger_id::text;
  IF saved IS NULL OR (SELECT count(*) FROM jsonb_array_elements(j->'receipts') WHERE value->>'id'=p.ledger_id::text)<>1
    OR saved->>'idempotencyKey' IS DISTINCT FROM p.posting_key OR saved->>'type' IS DISTINCT FROM p.posting_type OR saved->'metadata' IS DISTINCT FROM p.metadata
    OR (saved->>'createdAt')::timestamptz IS DISTINCT FROM (actual->>'createdAt')::timestamptz OR saved->'entries' IS DISTINCT FROM actual->'entries' THEN
    RAISE EXCEPTION 'CUSTODY_LEAGUE_JOURNAL_REQUIRED' USING ERRCODE='P0001'; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(j->'request'->'league'))<>(SELECT count(*) FROM public.keep_custody_league_retirements WHERE journal_id=journal)
    OR EXISTS(SELECT 1 FROM public.keep_custody_league_weeks s CROSS JOIN LATERAL jsonb_array_elements(s.original_rows) r WHERE (r->>'keep_amount')::bigint>0 AND r->>'paid_at' IS NULL
      AND NOT EXISTS(SELECT 1 FROM public.keep_custody_league_retirements z WHERE z.week=s.week AND z.base_id=(r->>'base_id')::uuid AND z.journal_id=journal)) THEN
    RAISE EXCEPTION 'CUSTODY_LEAGUE_JOURNAL_REQUIRED' USING ERRCODE='P0001'; END IF;
 END IF;
 -- Current operation checks all actual ordered postings against its final
 -- caches, including overlapping L1/L5 accounts. Historical replay checks its
 -- immutable before/entry transition above, never today's old after value.
 IF p.posting_xid=txid_current() AND EXISTS(SELECT 1 FROM public.accounts a WHERE a.id IN(SELECT (v->>'id')::uuid FROM jsonb_array_elements(p.before_accounts) v)
  AND a.balance<>coalesce((SELECT sum(delta) FROM public.ledger_entries WHERE account_id=a.id),0)) THEN
  RAISE EXCEPTION 'CUSTODY_LEAGUE_POSTING_CONFLICT' USING ERRCODE='P0001'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_assert_fixture_league_retirement(w date,b uuid,journal uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN PERFORM public.shardkeep_assert_league_archive(); PERFORM public.shardkeep_league_assert_post(w,b,journal,true); END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_assert_league_census() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p record;
BEGIN
 PERFORM public.shardkeep_assert_league_archive();
 FOR p IN SELECT week,base_id,journal_id FROM public.keep_custody_league_retirements LOOP
  PERFORM public.shardkeep_league_assert_post(p.week,p.base_id,p.journal_id,false);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_league_retirement_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM public.shardkeep_league_rc();
 PERFORM public.shardkeep_league_assert_hooks();
 IF TG_RELID<>'public.keep_custody_league_retirements'::regclass THEN RAISE EXCEPTION 'CUSTODY_LEAGUE_INCOMPLETE' USING ERRCODE='P0001'; END IF;
 PERFORM public.shardkeep_assert_fixture_league_retirement(NEW.week,NEW.base_id,NEW.journal_id);
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS keep_custody_league_retirement_complete ON public.keep_custody_league_retirements;
CREATE CONSTRAINT TRIGGER keep_custody_league_retirement_complete AFTER INSERT OR UPDATE ON public.keep_custody_league_retirements
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_league_retirement_complete();
REVOKE ALL ON FUNCTION public.shardkeep_league_money_write(text,text,jsonb,jsonb),public.shardkeep_league_retirement_plan(date,uuid,uuid,timestamptz,boolean),
 public.shardkeep_prepare_fixture_league_retirement(date,uuid,uuid,timestamptz,boolean),public.shardkeep_league_assert_post(date,uuid,uuid,boolean),
 public.shardkeep_assert_fixture_league_retirement(date,uuid,uuid),public.shardkeep_assert_league_archive(),public.shardkeep_assert_league_census() FROM PUBLIC;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_league_assert_hooks() RETURNS void LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE item record;
BEGIN
 FOR item IN SELECT * FROM (
  SELECT tab,'a_keep_custody_league_source'::text AS trigger_name,'shardkeep_league_source_guard'::text AS fn,31 AS bits,false AS deferred,true AS definer
   FROM unnest(ARRAY['base_league_entitlements','ledger_transactions','ledger_entries','accounts']) tab
  UNION ALL SELECT tab,'a_keep_custody_league_truncate','shardkeep_league_source_guard',34,false,true
   FROM unnest(ARRAY['base_league_entitlements','ledger_transactions','ledger_entries','accounts']) tab
  UNION ALL SELECT tab,'keep_custody_league_private','shardkeep_league_private_guard',31,false,false
   FROM unnest(ARRAY['keep_custody_league_bridge','keep_custody_league_weeks']) tab
  UNION ALL SELECT tab,'keep_custody_league_no_truncate','shardkeep_league_private_guard',34,false,false
   FROM unnest(ARRAY['keep_custody_league_bridge','keep_custody_league_weeks']) tab
  UNION ALL SELECT 'keep_custody_league_retirements','keep_custody_league_private','shardkeep_league_retirement_guard',31,false,false
  UNION ALL SELECT 'keep_custody_league_retirements','keep_custody_league_no_truncate','shardkeep_league_retirement_guard',34,false,false
  UNION ALL SELECT 'keep_custody_league_bridge','keep_custody_league_opening_complete','shardkeep_league_bridge_complete',21,true,false
  UNION ALL SELECT 'keep_custody_league_retirements','keep_custody_league_retirement_complete','shardkeep_league_retirement_complete',21,true,false
  UNION ALL SELECT 'ledger_transactions','keep_custody_league_bind_post','shardkeep_league_bind_post',5,false,true
 ) required LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid=to_regclass('public.'||item.tab) AND t.tgname=item.trigger_name
     AND t.tgfoid=to_regprocedure('public.'||item.fn||'()') AND t.tgenabled='O' AND NOT t.tgisinternal
     AND t.tgqual IS NULL AND t.tgnargs=0 AND (t.tgconstraint<>0)=item.deferred
     AND p.proowner=(SELECT c.relowner FROM pg_class c WHERE c.oid='public.keep_custody_league_bridge'::regclass)
     AND p.proowner=(SELECT c.relowner FROM pg_class c WHERE c.oid=t.tgrelid)
     AND t.tgtype=item.bits AND t.tgdeferrable=item.deferred AND t.tginitdeferred=item.deferred
     AND p.prosecdef=item.definer AND cardinality(p.proconfig)=1
     AND replace(p.proconfig[1],' ','')='search_path=pg_catalog,public,pg_temp') THEN
   RAISE EXCEPTION 'CUSTODY_LEAGUE_HOOKS_REQUIRED' USING ERRCODE='P0001'; END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_league_assert_hooks(),public.shardkeep_league_source_guard(),public.shardkeep_league_bind_post() FROM PUBLIC;

--> statement-breakpoint
-- Prefix94 has no mail/journal schema yet. Normal ordered0224 extends the
-- existing exact proof predicates after0157; it never changes old SQL files.
DO $league_compat$ BEGIN
 IF to_regclass('public.keep_custody_journal') IS NOT NULL THEN
 EXECUTE $definition$
CREATE OR REPLACE FUNCTION public.shardkeep_mail_keep_retired(attachment uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.mail_keep_retirements p
 JOIN public.mail_attachments a ON a.id=p.attachment_id
 JOIN public.mail_messages m ON m.id=p.message_id
 JOIN public.keep_custody_journal j ON j.id=p.journal_id
 JOIN public.ledger_transactions t ON t.id=p.ledger_txn_id
 CROSS JOIN LATERAL (SELECT sum(x.amount)::text AS keep FROM public.mail_attachments x
   WHERE x.message_id=m.id AND x.kind='KEEP') total
 WHERE p.attachment_id=attachment AND a.message_id=p.message_id AND a.kind='KEEP'
 AND a.amount=p.amount AND m.recipient_wallet=p.recipient_wallet AND m.expires_at=p.original_expires_at
 AND j.scope='fixture' AND j.subcommand IN ('retire-l1-mail','retire-l1-mail-forge','retire-l1-mail-forge-league') AND NOT j.dry_run
 AND j.operation=CASE j.subcommand WHEN 'retire-l1-mail' THEN 'fixture:l1-mail-retirement' WHEN 'retire-l1-mail-forge' THEN 'fixture:l1-mail-forge-retirement' ELSE 'fixture:l1-mail-forge-league-retirement' END AND j.database_name=current_database()
 AND j.request->>'fixtureId'=j.id::text
 AND j.request->'mails' @> jsonb_build_array(jsonb_build_object('messageId',m.id::text,
   'wallet',m.recipient_wallet,'keep',total.keep,'internal',t.type='gems.retirement.sweep'))
 AND j.receipts @> jsonb_build_array(p.receipt)
 AND t.idempotency_key='mail:retire:'||m.id::text
 AND t.type IN ('gems.retirement','gems.retirement.sweep')
 AND t.metadata->>'messageId'=m.id::text AND t.metadata->>'wallet'=m.recipient_wallet
 AND t.metadata->>'fixtureId'=j.id::text
 -- G-9 locks whole KEEP and Gems to identical units; independently prove the
 -- complete L4 posting, not merely agreement between two saved receipts.
 AND t.metadata=CASE WHEN t.type='gems.retirement.sweep' THEN
   jsonb_build_object('wallet',m.recipient_wallet,'keep',total.keep,'reason','internal-wallet','fixtureId',j.id::text,'messageId',m.id::text)
 ELSE jsonb_build_object('wallet',m.recipient_wallet,'class','L4','keep',total.keep,'gems',total.keep,'reason','retirement','fixtureId',j.id::text,'messageId',m.id::text) END
 AND (SELECT jsonb_agg(jsonb_build_array(a.kind,a.currency,a.owner_wallet,a.base_id,e.delta::text) ORDER BY a.kind::text)
   FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id WHERE e.txn_id=t.id)
 = CASE WHEN t.type='gems.retirement.sweep' THEN jsonb_build_array(
     jsonb_build_array('emission_pool','KEEP',NULL,NULL,total.keep),
     jsonb_build_array('mail_keep_escrow','KEEP',NULL,NULL,'-'||total.keep))
   ELSE jsonb_build_array(
     jsonb_build_array('emission_pool','KEEP',NULL,NULL,total.keep),
     jsonb_build_array('gems_mint','GEMS',NULL,NULL,'-'||total.keep),
     jsonb_build_array('mail_keep_escrow','KEEP',NULL,NULL,'-'||total.keep),
     jsonb_build_array('player_gems','GEMS',m.recipient_wallet,NULL,total.keep)) END
 AND p.receipt->>'id'=t.id::text AND p.receipt->>'type'=t.type
 AND p.receipt->>'idempotencyKey'=t.idempotency_key AND p.receipt->'metadata'=t.metadata
 AND (p.receipt->>'createdAt')::timestamptz=t.created_at
 AND p.receipt->'entries'=(SELECT jsonb_agg(jsonb_build_object('id',e.id::text,'account',a.id,'kind',a.kind,'currency',a.currency,
   'wallet',a.owner_wallet,'baseId',a.base_id,'delta',e.delta::text,'balanceAfter',e.balance_after::text) ORDER BY e.id)
   FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id WHERE e.txn_id=t.id))
$$;
$definition$;
 EXECUTE $definition$
CREATE OR REPLACE FUNCTION public.shardkeep_keep_custody_journal_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CUSTODY_JOURNAL_IMMUTABLE' USING ERRCODE='P0001'; END IF;
  IF current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid='public.keep_custody_journal'::regclass)
    OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid='public.keep_custody_cutover_state'::regclass)
    THEN RAISE EXCEPTION 'CUSTODY_JOURNAL_OWNER_REQUIRED' USING ERRCODE='P0001'; END IF;
  -- No production command is admitted by this initial implementation. Custom
  -- GUCs and broad runtime DML grants do not confer journal authority.
  IF current_database() !~ '^shardkeep_custody_apply_[0-9a-f]{32}_test$'
    OR NEW.database_name<>current_database() OR NEW.operator_name<>current_user
    OR NEW.scope<>'fixture' OR NEW.subcommand NOT IN ('retire-l1','retire-l1-mail','retire-l1-mail-forge','retire-l1-mail-forge-league') OR NEW.dry_run
    OR NEW.operation IS DISTINCT FROM (CASE NEW.subcommand WHEN 'retire-l1' THEN 'fixture:l1-retirement' WHEN 'retire-l1-mail' THEN 'fixture:l1-mail-retirement' WHEN 'retire-l1-mail-forge' THEN 'fixture:l1-mail-forge-retirement' ELSE 'fixture:l1-mail-forge-league-retirement' END)
    THEN RAISE EXCEPTION 'CUSTODY_JOURNAL_FIXTURE_REQUIRED' USING ERRCODE='P0001'; END IF;
  IF (SELECT phase FROM public.keep_custody_cutover_state WHERE id) IS DISTINCT FROM 'withdrawals_closed'
    THEN RAISE EXCEPTION 'CUSTODY_JOURNAL_PHASE_REQUIRED' USING ERRCODE='P0001'; END IF;
  RETURN NEW;
END $$;
$definition$;
 END IF;
END $league_compat$;

--> statement-breakpoint
DO $league_late$ BEGIN
 IF to_regclass('public.keep_custody_late_authorizations') IS NOT NULL THEN
 EXECUTE $definition$
CREATE OR REPLACE FUNCTION public.shardkeep_fixture_late_context(req jsonb,hash text,k bigint,units bigint)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE source jsonb; retirement public.keep_custody_journal%ROWTYPE; plans jsonb; snapshots jsonb;
  pk uuid; pg uuid; inflow uuid; emission uuid; mint uuid; wallet text; minted numeric; found_count integer;
BEGIN
 IF NOT public.shardkeep_fixture_late_owner() OR current_user<>(SELECT pg_get_userbyid(relowner)
 FROM pg_catalog.pg_class WHERE oid='public.keep_custody_journal'::regclass)
 THEN RAISE EXCEPTION 'CUSTODY_LATE_OWNER_REQUIRED'; END IF;
 PERFORM public.shardkeep_fixture_late_barrier();
 IF public.shardkeep_keep_custody_phase_locked()<>'frozen' THEN RAISE EXCEPTION 'CUSTODY_LATE_FROZEN_REQUIRED'; END IF;
 IF jsonb_typeof(req)<>'object' OR jsonb_typeof(req->'proof')<>'object'
 OR req->>'fixtureId' IS NULL OR req->>'retirementJournalId' IS NULL OR req->>'depositId' IS NULL
 OR hash IS NULL OR hash !~ '^[a-f0-9]{64}$' OR k IS NULL OR k<=0 OR units IS NULL OR units<=0
 OR req->'proof'->>'signature' IS NULL OR req->'proof'->>'mint' IS NULL
 OR req->'proof'->>'custodyOwner' IS NULL OR req->'proof'->>'destination' IS NULL
 OR jsonb_typeof(req->'proof'->'transaction') IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'CUSTODY_LATE_REQUEST_INVALID'; END IF;
 SELECT * INTO retirement FROM public.keep_custody_journal WHERE id=(req->>'retirementJournalId')::uuid;
 SELECT to_jsonb(d) INTO source FROM public.deposits d WHERE id=(req->>'depositId')::uuid;
 IF retirement.id IS NULL OR retirement.database_name<>current_database() OR retirement.scope<>'fixture'
 OR retirement.dry_run OR retirement.subcommand NOT IN ('retire-l1','retire-l1-mail','retire-l1-mail-forge','retire-l1-mail-forge-league')
 OR retirement.request->>'fixtureId' IS DISTINCT FROM retirement.id::text
 OR source IS NULL OR source->>'kind'<>'keep_deposit' OR source->>'status'<>'expired'
 OR source->>'payment_signature' IS NOT NULL OR source->>'tx_signature' IS NOT NULL
 OR source->>'amount' IS NOT NULL OR source->>'mint' IS NOT NULL
 OR source->>'finalized_at' IS NOT NULL OR source->>'ledger_txn_id' IS NOT NULL
 OR (SELECT count(*) FROM jsonb_array_elements(retirement.late_deposit_sources) s WHERE s=source)<>1
 THEN RAISE EXCEPTION 'CUSTODY_LATE_SOURCE_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM public.deposits WHERE payment_signature=req->'proof'->>'signature' OR tx_signature=req->'proof'->>'signature')
 THEN RAISE EXCEPTION 'CUSTODY_LATE_SIGNATURE_ALREADY_USED'; END IF;
 IF NOT coalesce((source->>'created_at')::timestamptz <= (req->'proof'->>'broadcastObservedAt')::timestamptz
 AND (req->'proof'->>'broadcastObservedAt')::timestamptz < (req->'proof'->>'withdrawalsClosedAt')::timestamptz
 AND (req->'proof'->>'withdrawalsClosedAt')::timestamptz <= (retirement.request->>'asOf')::timestamptz
 AND (retirement.request->>'asOf')::timestamptz < (req->'proof'->>'finalizedObservedAt')::timestamptz,false)
 THEN RAISE EXCEPTION 'CUSTODY_LATE_TIME_ORDER_REQUIRED'; END IF;
 wallet:=source->>'player_wallet';
 SELECT count(*),max(id::text)::uuid INTO found_count,pk FROM public.accounts WHERE kind='player_keep' AND currency='KEEP' AND owner_wallet=wallet AND base_id IS NULL;
 IF found_count<>1 OR (SELECT balance FROM public.accounts WHERE id=pk)<>0 THEN RAISE EXCEPTION 'CUSTODY_LATE_ACCOUNT_REQUIRED'; END IF;
 INSERT INTO public.accounts(owner_wallet,kind,currency,balance)
SELECT wallet,'player_gems','GEMS',0 WHERE NOT EXISTS(SELECT 1 FROM public.accounts WHERE kind='player_gems' AND owner_wallet=wallet AND base_id IS NULL);
SELECT count(*),max(id::text)::uuid INTO found_count,pg FROM public.accounts WHERE kind='player_gems' AND currency='GEMS' AND owner_wallet=wallet AND base_id IS NULL;
 IF found_count<>1 THEN RAISE EXCEPTION 'CUSTODY_LATE_ACCOUNT_REQUIRED'; END IF;
 SELECT count(*),max(id::text)::uuid INTO found_count,inflow FROM public.accounts WHERE kind='onchain_inflow' AND currency='KEEP' AND owner_wallet IS NULL AND base_id IS NULL;
 IF found_count<>1 THEN RAISE EXCEPTION 'CUSTODY_LATE_ACCOUNT_REQUIRED'; END IF;
 SELECT count(*),max(id::text)::uuid INTO found_count,emission FROM public.accounts WHERE kind='emission_pool' AND currency='KEEP' AND owner_wallet IS NULL AND base_id IS NULL;
 IF found_count<>1 THEN RAISE EXCEPTION 'CUSTODY_LATE_ACCOUNT_REQUIRED'; END IF;
 SELECT count(*),max(id::text)::uuid INTO found_count,mint FROM public.accounts WHERE kind='gems_mint' AND currency='GEMS' AND owner_wallet IS NULL AND base_id IS NULL;
 IF found_count<>1 THEN RAISE EXCEPTION 'CUSTODY_LATE_ACCOUNT_REQUIRED'; END IF;
 plans:=jsonb_build_array(jsonb_build_object('key','deposit:'||(req->>'depositId')||':credit','type','deposit.keep',
 'metadata',jsonb_build_object('wallet',wallet,'txSignature',req->'proof'->>'signature','baseUnits',units::text),
 'entries',jsonb_build_array(jsonb_build_object('account',inflow,'delta',(-k)::text),jsonb_build_object('account',pk,'delta',k::text))),
 jsonb_build_object('key','late-credit:deposit:'||(req->>'depositId')||':convert','type','gems.late_credit',
 'metadata',jsonb_build_object('wallet',wallet,'depositId',req->>'depositId','txSignature',req->'proof'->>'signature',
 'keep',k::text,'gems',k::text,'reason','keep_conversion','proofHash',hash,
 'retirementJournalId',req->>'retirementJournalId','fixtureId',req->>'fixtureId'),
 'entries',jsonb_build_array(jsonb_build_object('account',pk,'delta',(-k)::text),jsonb_build_object('account',emission,'delta',k::text),
 jsonb_build_object('account',mint,'delta',(-k)::text),jsonb_build_object('account',pg,'delta',k::text))));
 IF EXISTS(SELECT 1 FROM public.ledger_transactions t JOIN jsonb_array_elements(plans) p ON p->>'key'=t.idempotency_key)
 THEN RAISE EXCEPTION 'CUSTODY_LATE_RECEIPT_ALREADY_EXISTS'; END IF;
 SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) INTO snapshots FROM public.accounts a WHERE id=ANY(ARRAY[pk,pg,inflow,emission,mint]);
 SELECT coalesce(sum(-e.delta),0) INTO minted FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id
 JOIN public.ledger_transactions t ON t.id=e.txn_id WHERE a.kind='gems_mint' AND t.type='gems.retirement';
 RETURN jsonb_build_object('source_before',source,'postings',plans,'accounts_before',snapshots,'retirement_minted_before',minted);
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_fixture_late_context(jsonb,text,bigint,bigint) FROM PUBLIC;
$definition$;
 END IF;
END $league_late$;
