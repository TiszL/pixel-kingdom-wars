-- D-153.165 / S5 held: dormant private fixture schema. No backfill, posting,
-- source adoption, phase transition or production operator surface.
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['keep_custody_withdrawal_drains','keep_custody_withdrawal_sources'] LOOP
  IF to_regclass('public.'||tab) IS NOT NULL AND obj_description(to_regclass('public.'||tab),'pg_class') IS DISTINCT FROM 'shardkeep:fixture-withdrawal-drain:v1' THEN
   RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_SCHEMA_CONFLICT' USING ERRCODE='P0001'; END IF;
 END LOOP;
END $$;
CREATE TABLE IF NOT EXISTS public.keep_custody_withdrawal_drains (
 id uuid PRIMARY KEY, operation text NOT NULL, database_name text NOT NULL, operator_name text NOT NULL,
 input_hash text NOT NULL, request jsonb NOT NULL, receipts jsonb NOT NULL, result jsonb NOT NULL,
 before_state jsonb NOT NULL, after_state jsonb NOT NULL, opening_xid bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE TABLE IF NOT EXISTS public.keep_custody_withdrawal_sources (
 withdrawal_id uuid PRIMARY KEY REFERENCES public.withdrawals(id),
 fixture_id uuid NOT NULL REFERENCES public.keep_custody_withdrawal_drains(id) DEFERRABLE INITIALLY DEFERRED,
 as_of timestamptz NOT NULL, opening_xid bigint NOT NULL, original_withdrawal jsonb NOT NULL,
 request_receipt jsonb NOT NULL, original_reservation jsonb, before_accounts jsonb NOT NULL,
 cancel_ledger_id uuid UNIQUE REFERENCES public.ledger_transactions(id)
);
DO $$ DECLARE item record; actual text[]; found_count integer; BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('keep_custody_withdrawal_drains',ARRAY['id:uuid','operation:text','database_name:text','operator_name:text','input_hash:text','request:jsonb','receipts:jsonb','result:jsonb','before_state:jsonb','after_state:jsonb','opening_xid:bigint','created_at:timestamp with time zone'],ARRAY['id','operation','database_name','operator_name','input_hash','request','receipts','result','before_state','after_state','opening_xid','created_at']),
  ('keep_custody_withdrawal_sources',ARRAY['withdrawal_id:uuid','fixture_id:uuid','as_of:timestamp with time zone','opening_xid:bigint','original_withdrawal:jsonb','request_receipt:jsonb','original_reservation:jsonb','before_accounts:jsonb','cancel_ledger_id:uuid'],ARRAY['withdrawal_id','fixture_id','as_of','opening_xid','original_withdrawal','request_receipt','before_accounts'])
 ) required(tab,cols,nonnull) LOOP
  SELECT array_agg(a.attname::text||':'||format_type(a.atttypid,a.atttypmod) ORDER BY a.attnum) INTO actual
   FROM pg_attribute a WHERE a.attrelid=to_regclass('public.'||item.tab) AND a.attnum>0 AND NOT a.attisdropped;
  IF actual IS DISTINCT FROM item.cols OR (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a
   WHERE a.attrelid=to_regclass('public.'||item.tab) AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull) IS DISTINCT FROM item.nonnull THEN
   RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_SCHEMA_CONFLICT' USING ERRCODE='P0001'; END IF;
 END LOOP;
 FOR item IN SELECT * FROM (VALUES
  ('keep_custody_withdrawal_drains','p',ARRAY['id'],NULL,NULL,false),
  ('keep_custody_withdrawal_sources','p',ARRAY['withdrawal_id'],NULL,NULL,false),
  ('keep_custody_withdrawal_sources','u',ARRAY['cancel_ledger_id'],NULL,NULL,false),
  ('keep_custody_withdrawal_sources','f',ARRAY['withdrawal_id'],'withdrawals',ARRAY['id'],false),
  ('keep_custody_withdrawal_sources','f',ARRAY['fixture_id'],'keep_custody_withdrawal_drains',ARRAY['id'],true),
  ('keep_custody_withdrawal_sources','f',ARRAY['cancel_ledger_id'],'ledger_transactions',ARRAY['id'],false)
 ) required(tab,kind,cols,ref_tab,ref_cols,deferred) LOOP
  SELECT count(*) INTO found_count FROM pg_constraint c WHERE c.conrelid=to_regclass('public.'||item.tab)
   AND c.contype::text=item.kind AND c.condeferrable=item.deferred AND c.condeferred=item.deferred AND c.convalidated
   AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num,ord)
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord)=item.cols
   AND (item.ref_tab IS NULL OR (c.confrelid=to_regclass('public.'||item.ref_tab) AND c.confupdtype='a' AND c.confdeltype='a'
    AND ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num,ord)
     JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord)=item.ref_cols));
  IF found_count<>1 THEN RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_SCHEMA_CONFLICT' USING ERRCODE='P0001'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM (VALUES ('keep_custody_withdrawal_drains',1),('keep_custody_withdrawal_sources',5)) required(tab,n)
  WHERE (SELECT count(*) FROM pg_constraint c WHERE c.conrelid=to_regclass('public.'||required.tab) AND c.contype<>'t')<>required.n) THEN
  RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_SCHEMA_CONFLICT' USING ERRCODE='P0001'; END IF;
END $$;
COMMENT ON TABLE public.keep_custody_withdrawal_drains IS 'shardkeep:fixture-withdrawal-drain:v1';
COMMENT ON TABLE public.keep_custody_withdrawal_sources IS 'shardkeep:fixture-withdrawal-drain:v1';
REVOKE ALL ON public.keep_custody_withdrawal_drains,public.keep_custody_withdrawal_sources FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_withdrawal_drain_rc() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_READ_COMMITTED_REQUIRED' USING ERRCODE='P0001'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_withdrawal_drain_barrier() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE tab text;
BEGIN
 FOREACH tab IN ARRAY ARRAY['ledger_transactions','accounts','ledger_entries','players','bases','base_slots','deed_ownership_observations',
 'base_forge_positions','forge_contributions','raid_loot_reservations','base_raid_locks','mail_messages','mail_attachments','base_league_entitlements',
 'withdrawals','withdrawal_attempts','withdrawal_payout_reservations','withdrawal_authorizations','deposits','player_items','item_listings',
 'keep_custody_journal','mail_keep_retirements','keep_custody_league_bridge','keep_custody_league_weeks','keep_custody_league_retirements',
 'keep_custody_withdrawal_drains','keep_custody_withdrawal_sources'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='relation' AND relation=to_regclass('public.'||tab)
   AND mode='AccessExclusiveLock' AND granted) THEN
   RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_BARRIER_REQUIRED' USING ERRCODE='P0001'; END IF;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_withdrawal_drain_receipt(txn uuid) RETURNS jsonb
LANGUAGE sql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
 SELECT jsonb_build_object('id',t.id,'key',t.idempotency_key,'type',t.type,'metadata',t.metadata,'createdAt',t.created_at,
  'entries',(SELECT jsonb_agg(jsonb_build_object('id',e.id::text,'account',a.id,'kind',a.kind::text,'currency',a.currency::text,
   'wallet',a.owner_wallet,'baseId',a.base_id,'accountCreatedAt',a.created_at,'delta',e.delta::text,'balanceAfter',e.balance_after::text) ORDER BY e.id)
   FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id WHERE e.txn_id=t.id))
 FROM public.ledger_transactions t WHERE t.id=txn
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_withdrawal_drain_hooks() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE item record;
BEGIN
 FOR item IN SELECT * FROM (
  SELECT tab,'a_keep_custody_withdrawal_source'::text AS trigger_name,'shardkeep_withdrawal_drain_source_guard'::text AS fn,31 AS bits,false AS deferred,true AS definer
   FROM unnest(ARRAY['withdrawals','withdrawal_attempts','withdrawal_payout_reservations','ledger_transactions','ledger_entries','accounts']) tab
  UNION ALL SELECT tab,'a_keep_custody_withdrawal_truncate','shardkeep_withdrawal_drain_source_guard',34,false,true
   FROM unnest(ARRAY['withdrawals','withdrawal_attempts','withdrawal_payout_reservations','ledger_transactions','ledger_entries','accounts']) tab
  UNION ALL SELECT tab,'keep_custody_withdrawal_private','shardkeep_withdrawal_drain_private_guard',31,false,false
   FROM unnest(ARRAY['keep_custody_withdrawal_drains','keep_custody_withdrawal_sources']) tab
  UNION ALL SELECT tab,'keep_custody_withdrawal_no_truncate','shardkeep_withdrawal_drain_private_guard',34,false,false
   FROM unnest(ARRAY['keep_custody_withdrawal_drains','keep_custody_withdrawal_sources']) tab
  UNION ALL SELECT tab,'keep_custody_withdrawal_complete','shardkeep_withdrawal_drain_complete',21,true,false
   FROM unnest(ARRAY['keep_custody_withdrawal_drains','keep_custody_withdrawal_sources']) tab
  UNION ALL SELECT 'ledger_transactions','keep_custody_withdrawal_bind_post','shardkeep_withdrawal_drain_bind_post',5,false,true
 ) required LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
   WHERE t.tgrelid=to_regclass('public.'||item.tab) AND t.tgname=item.trigger_name AND t.tgfoid=to_regprocedure('public.'||item.fn||'()')
    AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgattr=''::int2vector AND t.tgnargs=0 AND (t.tgconstraint<>0)=item.deferred
    AND t.tgtype=item.bits AND t.tgdeferrable=item.deferred AND t.tginitdeferred=item.deferred
    AND p.proowner=(SELECT c.relowner FROM pg_class c WHERE c.oid=t.tgrelid)
    AND p.proowner=(SELECT c.relowner FROM pg_class c WHERE c.oid='public.keep_custody_withdrawal_sources'::regclass)
    AND p.prosecdef=item.definer AND cardinality(p.proconfig)=2
    AND EXISTS(SELECT 1 FROM unnest(p.proconfig) setting WHERE replace(setting,' ','')='search_path=pg_catalog,public,pg_temp')
    AND EXISTS(SELECT 1 FROM unnest(p.proconfig) setting WHERE lower(setting)='timezone=utc')) THEN
   RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_HOOKS_REQUIRED' USING ERRCODE='P0001'; END IF;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_withdrawal_drain_plan(wid uuid,fid uuid,at_time timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE w public.withdrawals; r public.withdrawal_payout_reservations; original jsonb; header jsonb; accts jsonb; escrow uuid; player uuid; amount bigint;
BEGIN
 PERFORM public.shardkeep_withdrawal_drain_rc(); PERFORM public.shardkeep_withdrawal_drain_hooks();
 IF current_database()!~'^shardkeep_custody_apply_[0-9a-f]{32}_test$'
  OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.keep_custody_withdrawal_sources'::regclass) THEN
  RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_FIXTURE_REQUIRED' USING ERRCODE='P0001'; END IF;
 PERFORM public.shardkeep_withdrawal_drain_barrier();
 IF (SELECT phase FROM public.keep_custody_cutover_state WHERE id) IS DISTINCT FROM 'fenced' THEN
  RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_PHASE_REQUIRED' USING ERRCODE='P0001'; END IF;
 SELECT * INTO w FROM public.withdrawals WHERE id=wid FOR UPDATE;
 IF w.id IS NULL OR w.status::text<>'unbonding' OR w.tx_signature IS NOT NULL OR w.mint IS NOT NULL
  OR w.payout_ledger_txn_id IS NOT NULL OR w.refund_ledger_txn_id IS NOT NULL OR w.completed_at IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.withdrawal_attempts a WHERE a.withdrawal_id=wid) THEN
  RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_HELD' USING ERRCODE='P0001'; END IF;
 IF fid IS NULL OR at_time IS NULL OR NOT isfinite(at_time) OR at_time<w.created_at OR w.currency::text<>'KEEP' OR w.amount<=0
  OR w.fee_burned<0 OR w.fee_burned>=w.amount OR w.request_ledger_txn_id IS NULL
  OR EXISTS(SELECT 1 FROM public.ledger_transactions t WHERE t.idempotency_key IN ('withdrawal:'||wid::text||':cancel','withdrawal:'||wid::text||':payout','withdrawal:'||wid::text||':refund')) THEN
  RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
 amount:=w.amount; original:=to_jsonb(w); header:=public.shardkeep_withdrawal_drain_receipt(w.request_ledger_txn_id);
 SELECT id INTO escrow FROM public.accounts WHERE kind::text='withdrawal_escrow' AND currency::text='KEEP' AND owner_wallet IS NULL AND base_id IS NULL;
 SELECT id INTO player FROM public.accounts WHERE kind::text='player_keep' AND currency::text='KEEP' AND owner_wallet=w.player_wallet AND base_id IS NULL;
 IF escrow IS NULL OR player IS NULL OR header IS NULL OR header->>'type' IS DISTINCT FROM 'withdrawal.request'
  OR NOT starts_with(header->>'key','withdrawal.request:'||w.player_wallet||':')
  OR length(header->>'key')<=length('withdrawal.request:'||w.player_wallet||':')
  OR jsonb_typeof(header->'metadata'->'instant') IS DISTINCT FROM 'boolean'
  OR header->'metadata' IS DISTINCT FROM jsonb_build_object('wallet',w.player_wallet,'destination',w.destination,'instant',header->'metadata'->'instant')
  OR jsonb_typeof(header->'entries') IS DISTINCT FROM 'array' OR jsonb_array_length(header->'entries')<>2
  OR (SELECT count(*) FROM jsonb_array_elements(header->'entries') leg WHERE
   (leg->>'account'=player::text AND leg->>'delta'=(-amount)::text)
   OR (leg->>'account'=escrow::text AND leg->>'delta'=amount::text))<>2
  OR (SELECT count(DISTINCT leg->>'account') FROM jsonb_array_elements(header->'entries') leg)<>2 THEN
  RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
 SELECT * INTO r FROM public.withdrawal_payout_reservations WHERE withdrawal_id=wid FOR UPDATE;
 IF r.withdrawal_id IS NOT NULL AND (r.player_wallet<>w.player_wallet OR r.gross_keep<>amount OR r.status NOT IN ('reserved','released')) THEN
  RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_HELD' USING ERRCODE='P0001'; END IF;
 PERFORM id FROM public.accounts WHERE id IN (escrow,player) ORDER BY id FOR UPDATE;
 SELECT jsonb_agg(to_jsonb(a)||jsonb_build_object('balance',a.balance::text) ORDER BY a.id) INTO accts FROM public.accounts a WHERE a.id IN (escrow,player);
 IF EXISTS(SELECT 1 FROM public.accounts a WHERE a.id IN (escrow,player)
   AND (a.balance<0 OR a.balance<>coalesce((SELECT sum(e.delta) FROM public.ledger_entries e WHERE e.account_id=a.id),0)))
  OR (SELECT balance FROM public.accounts WHERE id=escrow)<amount THEN
  RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
 RETURN jsonb_build_object('withdrawal_id',wid,'fixture_id',fid,'as_of',at_time,'opening_xid',txid_current(),
  'original_withdrawal',original,'request_receipt',header,'original_reservation',CASE WHEN r.withdrawal_id IS NULL THEN NULL ELSE to_jsonb(r) END,
  'before_accounts',accts,'cancel_ledger_id',null);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_prepare_fixture_withdrawal_drain(wid uuid,fid uuid,at_time timestamptz) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
BEGIN
 INSERT INTO public.keep_custody_withdrawal_sources SELECT * FROM jsonb_populate_record(null::public.keep_custody_withdrawal_sources,
  public.shardkeep_withdrawal_drain_plan(wid,fid,at_time));
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_withdrawal_drain_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE p public.keep_custody_withdrawal_sources; oldj jsonb; newj jsonb; before_account jsonb; delta bigint; protected boolean;
BEGIN
 -- This must precede even the empty-enrollment lookup: a pre-enrollment RR
 -- snapshot cannot make a later conflicting writer invisible to the fence.
 PERFORM public.shardkeep_withdrawal_drain_rc();
 IF TG_RELID NOT IN ('public.withdrawals'::regclass,'public.withdrawal_attempts'::regclass,'public.withdrawal_payout_reservations'::regclass,
  'public.ledger_transactions'::regclass,'public.ledger_entries'::regclass,'public.accounts'::regclass)
  OR TG_WHEN<>'BEFORE' OR NOT ((TG_NAME='a_keep_custody_withdrawal_source' AND TG_LEVEL='ROW' AND TG_OP IN ('INSERT','UPDATE','DELETE'))
   OR (TG_NAME='a_keep_custody_withdrawal_truncate' AND TG_LEVEL='STATEMENT' AND TG_OP='TRUNCATE'))
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc fn ON fn.oid=t.tgfoid WHERE t.tgrelid=TG_RELID AND t.tgname=TG_NAME
   AND t.tgfoid='public.shardkeep_withdrawal_drain_source_guard()'::regprocedure AND t.tgenabled='O' AND NOT t.tgisinternal
   AND t.tgqual IS NULL AND t.tgattr=''::int2vector AND t.tgnargs=0 AND t.tgconstraint=0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred
   AND t.tgtype=CASE WHEN TG_OP='TRUNCATE' THEN 34 ELSE 31 END
   AND fn.proowner=(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
   AND fn.proowner=(SELECT relowner FROM pg_class WHERE oid='public.keep_custody_withdrawal_sources'::regclass)) THEN
  RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_SOURCE_FROZEN' USING ERRCODE='P0001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.keep_custody_withdrawal_sources) THEN
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 PERFORM public.shardkeep_withdrawal_drain_hooks();
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_SOURCE_FROZEN' USING ERRCODE='P0001'; END IF;
 IF TG_OP<>'INSERT' THEN oldj:=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN newj:=to_jsonb(NEW); END IF;
 IF TG_TABLE_NAME='withdrawals' THEN
  SELECT * INTO p FROM public.keep_custody_withdrawal_sources s WHERE s.withdrawal_id::text IN (oldj->>'id',newj->>'id');
  IF p.withdrawal_id IS NOT NULL THEN
   IF TG_OP='UPDATE' AND p.opening_xid=txid_current() AND p.cancel_ledger_id IS NULL AND oldj=p.original_withdrawal
    AND newj=p.original_withdrawal||jsonb_build_object('status','cancelled','completed_at',p.as_of) THEN RETURN NEW; END IF;
   RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_SOURCE_FROZEN' USING ERRCODE='P0001';
  END IF;
 ELSIF TG_TABLE_NAME IN ('withdrawal_attempts','withdrawal_payout_reservations') THEN
  SELECT * INTO p FROM public.keep_custody_withdrawal_sources s WHERE s.withdrawal_id::text IN (oldj->>'withdrawal_id',newj->>'withdrawal_id');
  IF p.withdrawal_id IS NOT NULL THEN
   IF TG_TABLE_NAME='withdrawal_payout_reservations' AND TG_OP='UPDATE' AND p.opening_xid=txid_current()
    AND oldj=p.original_reservation AND oldj->>'status'='reserved' AND newj->>'status'='released'
    AND (newj-ARRAY['status','updated_at'])=(oldj-ARRAY['status','updated_at'])
    AND (newj->>'updated_at')::timestamptz=statement_timestamp()
    AND (SELECT to_jsonb(w) FROM public.withdrawals w WHERE w.id=p.withdrawal_id)=p.original_withdrawal||jsonb_build_object('status','cancelled','completed_at',p.as_of) THEN RETURN NEW; END IF;
   RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_SOURCE_FROZEN' USING ERRCODE='P0001';
  END IF;
 ELSIF TG_TABLE_NAME='ledger_transactions' THEN
  SELECT * INTO p FROM public.keep_custody_withdrawal_sources s WHERE
   s.request_receipt->>'id' IN (oldj->>'id',newj->>'id') OR s.cancel_ledger_id::text IN (oldj->>'id',newj->>'id')
   OR oldj->>'idempotency_key' IN ('withdrawal:'||s.withdrawal_id::text||':cancel','withdrawal:'||s.withdrawal_id::text||':refund','withdrawal:'||s.withdrawal_id::text||':payout')
   OR newj->>'idempotency_key' IN ('withdrawal:'||s.withdrawal_id::text||':cancel','withdrawal:'||s.withdrawal_id::text||':refund','withdrawal:'||s.withdrawal_id::text||':payout')
   OR s.withdrawal_id::text IN (oldj->'metadata'->>'withdrawalId',newj->'metadata'->>'withdrawalId');
  IF p.withdrawal_id IS NOT NULL THEN
   IF TG_OP='INSERT' AND p.opening_xid=txid_current() AND p.cancel_ledger_id IS NULL
    AND newj->>'idempotency_key'='withdrawal:'||p.withdrawal_id::text||':cancel' AND newj->>'type'='withdrawal.cancel'
    AND newj->'metadata'=jsonb_build_object('wallet',p.original_withdrawal->>'player_wallet','withdrawalId',p.withdrawal_id)
    AND (SELECT to_jsonb(w) FROM public.withdrawals w WHERE w.id=p.withdrawal_id)=p.original_withdrawal||jsonb_build_object('status','cancelled','completed_at',p.as_of)
    AND NOT EXISTS(SELECT 1 FROM public.ledger_transactions t WHERE t.idempotency_key=newj->>'idempotency_key') THEN RETURN NEW; END IF;
   RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_SOURCE_FROZEN' USING ERRCODE='P0001';
  END IF;
 ELSIF TG_TABLE_NAME='ledger_entries' THEN
  protected:=EXISTS(SELECT 1 FROM public.keep_custody_withdrawal_sources s WHERE
   s.request_receipt->>'id' IN (oldj->>'txn_id',newj->>'txn_id') OR s.cancel_ledger_id::text IN (oldj->>'txn_id',newj->>'txn_id')
   OR (s.opening_xid=txid_current() AND EXISTS(SELECT 1 FROM jsonb_array_elements(s.before_accounts) a WHERE a->>'id' IN (oldj->>'account_id',newj->>'account_id'))));
  IF protected THEN
   SELECT * INTO p FROM public.keep_custody_withdrawal_sources s WHERE s.cancel_ledger_id::text=newj->>'txn_id' AND s.opening_xid=txid_current();
   IF TG_OP='INSERT' AND p.withdrawal_id IS NOT NULL THEN
    SELECT value INTO before_account FROM jsonb_array_elements(p.before_accounts) WHERE value->>'id'=newj->>'account_id';
    delta:=(p.original_withdrawal->>'amount')::bigint*(CASE WHEN before_account->>'kind'='withdrawal_escrow' THEN -1 ELSE 1 END);
    IF before_account IS NOT NULL AND (newj->>'delta')::bigint=delta
     AND (newj->>'balance_after')::bigint=(before_account->>'balance')::bigint+delta
     AND (newj->>'balance_after')::bigint>=0
     AND NOT EXISTS(SELECT 1 FROM public.ledger_entries e WHERE e.txn_id=p.cancel_ledger_id AND e.account_id::text=newj->>'account_id')
     AND (SELECT count(*) FROM public.ledger_entries e WHERE e.txn_id=p.cancel_ledger_id)<2 THEN RETURN NEW; END IF;
   END IF;
   RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_SOURCE_FROZEN' USING ERRCODE='P0001';
  END IF;
 ELSIF TG_TABLE_NAME='accounts' THEN
  protected:=EXISTS(SELECT 1 FROM public.keep_custody_withdrawal_sources s CROSS JOIN LATERAL jsonb_array_elements(s.before_accounts) a
   WHERE a->>'id' IN (oldj->>'id',newj->>'id'));
  IF protected THEN
   IF TG_OP<>'UPDATE' OR (oldj-'balance') IS DISTINCT FROM (newj-'balance') THEN
    RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_SOURCE_FROZEN' USING ERRCODE='P0001'; END IF;
   IF EXISTS(SELECT 1 FROM public.keep_custody_withdrawal_sources s CROSS JOIN LATERAL jsonb_array_elements(s.before_accounts) a
    WHERE s.opening_xid=txid_current() AND a->>'id'=newj->>'id') AND NOT EXISTS(
     SELECT 1 FROM public.keep_custody_withdrawal_sources s CROSS JOIN LATERAL jsonb_array_elements(s.before_accounts) a
     JOIN public.ledger_entries e ON e.account_id::text=a->>'id' AND e.txn_id=s.cancel_ledger_id
     WHERE s.opening_xid=txid_current() AND a->>'id'=newj->>'id'
      AND (oldj->>'balance')::bigint=(a->>'balance')::bigint AND (newj->>'balance')::bigint=e.balance_after
      AND e.delta=(s.original_withdrawal->>'amount')::bigint*(CASE WHEN a->>'kind'='withdrawal_escrow' THEN -1 ELSE 1 END)
      AND e.balance_after=(a->>'balance')::bigint+e.delta) THEN
    RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_SOURCE_FROZEN' USING ERRCODE='P0001'; END IF;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_withdrawal_drain_bind_post() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE p public.keep_custody_withdrawal_sources;
BEGIN
 PERFORM public.shardkeep_withdrawal_drain_rc();
 IF TG_RELID<>'public.ledger_transactions'::regclass OR TG_NAME<>'keep_custody_withdrawal_bind_post' OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN
  RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_SOURCE_FROZEN' USING ERRCODE='P0001'; END IF;
 SELECT * INTO p FROM public.keep_custody_withdrawal_sources s WHERE NEW.idempotency_key='withdrawal:'||s.withdrawal_id::text||':cancel';
 IF p.withdrawal_id IS NULL THEN RETURN NEW; END IF;
 PERFORM public.shardkeep_withdrawal_drain_hooks(); PERFORM public.shardkeep_withdrawal_drain_barrier();
 IF p.opening_xid<>txid_current() OR p.cancel_ledger_id IS NOT NULL OR NEW.type<>'withdrawal.cancel'
  OR NEW.metadata IS DISTINCT FROM jsonb_build_object('wallet',p.original_withdrawal->>'player_wallet','withdrawalId',p.withdrawal_id) THEN
  RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_SOURCE_FROZEN' USING ERRCODE='P0001'; END IF;
 UPDATE public.keep_custody_withdrawal_sources SET cancel_ledger_id=NEW.id WHERE withdrawal_id=p.withdrawal_id;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_withdrawal_drain_result(fid uuid) RETURNS jsonb
LANGUAGE sql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
 SELECT jsonb_build_object('fixtureOnly',true,'retirementAuthorized',false,'fixtureId',fid,'phase','withdrawals_closed',
  'totalKeepReturned',coalesce(sum((s.original_withdrawal->>'amount')::bigint),0)::text,
  'cancelled',coalesce(jsonb_agg(jsonb_build_object('withdrawalId',s.withdrawal_id,'wallet',s.original_withdrawal->>'player_wallet',
   'keep',s.original_withdrawal->>'amount','requestLedgerTxnId',s.original_withdrawal->>'request_ledger_txn_id',
   'cancelLedgerTxnId',s.cancel_ledger_id) ORDER BY s.withdrawal_id),'[]'::jsonb)) FROM public.keep_custody_withdrawal_sources s WHERE s.fixture_id=fid
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_withdrawal_drain_receipts(fid uuid) RETURNS jsonb
LANGUAGE sql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('withdrawalId',s.withdrawal_id,'request',s.request_receipt,
  'cancellation',public.shardkeep_withdrawal_drain_receipt(s.cancel_ledger_id),
  'reservation',(SELECT to_jsonb(r) FROM public.withdrawal_payout_reservations r WHERE r.withdrawal_id=s.withdrawal_id)) ORDER BY s.withdrawal_id),'[]'::jsonb)
 FROM public.keep_custody_withdrawal_sources s WHERE s.fixture_id=fid
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_withdrawal_drain_zero() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.withdrawals WHERE status::text IN ('unbonding','processing','failed'))
  OR EXISTS(SELECT 1 FROM public.withdrawal_attempts WHERE status::text IN ('prepared','broadcast'))
  OR EXISTS(SELECT 1 FROM public.withdrawal_payout_reservations WHERE status='reserved')
  OR (SELECT count(*) FROM public.accounts WHERE kind::text='withdrawal_escrow' AND currency::text='KEEP' AND owner_wallet IS NULL AND base_id IS NULL)<>1
  OR EXISTS(SELECT 1 FROM public.accounts WHERE kind::text='withdrawal_escrow' AND balance<>0)
  OR EXISTS(SELECT 1 FROM public.accounts a WHERE a.balance<>coalesce((SELECT sum(e.delta) FROM public.ledger_entries e WHERE e.account_id=a.id),0))
  OR EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id GROUP BY e.txn_id,a.currency HAVING sum(e.delta)<>0) THEN
  RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_INCOMPLETE' USING ERRCODE='P0001'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_assert_fixture_withdrawal_drain(fid uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE j public.keep_custody_withdrawal_drains; p public.keep_custody_withdrawal_sources; receipt jsonb; entry jsonb; before_account jsonb;
 ids jsonb; total bigint; n integer; amount bigint; actual_reservation jsonb; phase text;
BEGIN
 PERFORM public.shardkeep_withdrawal_drain_hooks();
 SELECT * INTO j FROM public.keep_custody_withdrawal_drains WHERE id=fid;
 SELECT count(*),jsonb_agg(s.withdrawal_id ORDER BY s.withdrawal_id),sum((s.original_withdrawal->>'amount')::bigint) INTO n,ids,total
  FROM public.keep_custody_withdrawal_sources s WHERE s.fixture_id=fid;
 IF j.id IS NULL OR n=0 THEN RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_INCOMPLETE' USING ERRCODE='P0001'; END IF;
 IF j.operation<>'fixture:unbonding-withdrawal-drain' OR j.database_name<>current_database()
  OR j.operator_name<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.keep_custody_withdrawal_sources'::regclass)
  OR jsonb_typeof(j.request) IS DISTINCT FROM 'object'
  OR j.request IS DISTINCT FROM jsonb_build_object('fixtureId',fid,'asOf',j.request->>'asOf','withdrawalIds',ids)
  OR j.input_hash IS DISTINCT FROM encode(sha256(convert_to(j.request::text,'UTF8')),'hex')
  OR j.before_state IS DISTINCT FROM jsonb_build_object('phase','fenced','unbonding',n,'withdrawalEscrow',total::text)
  OR j.after_state IS DISTINCT FROM jsonb_build_object('phase','withdrawals_closed','unresolvedWithdrawals',0,'unresolvedAttempts',0,'reservedAllowances',0,'withdrawalEscrow','0')
  OR j.result IS DISTINCT FROM public.shardkeep_withdrawal_drain_result(fid)
  OR j.receipts IS DISTINCT FROM public.shardkeep_withdrawal_drain_receipts(fid) THEN
  RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_INCOMPLETE' USING ERRCODE='P0001'; END IF;
 FOR p IN SELECT * FROM public.keep_custody_withdrawal_sources s WHERE s.fixture_id=fid ORDER BY s.withdrawal_id LOOP
  amount:=(p.original_withdrawal->>'amount')::bigint;
  IF p.cancel_ledger_id IS NULL OR p.opening_xid<>j.opening_xid OR amount<=0
   OR j.request->>'asOf' IS DISTINCT FROM to_char(p.as_of AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   OR (SELECT to_jsonb(w) FROM public.withdrawals w WHERE w.id=p.withdrawal_id) IS DISTINCT FROM p.original_withdrawal||jsonb_build_object('status','cancelled','completed_at',p.as_of)
   OR p.request_receipt IS DISTINCT FROM public.shardkeep_withdrawal_drain_receipt((p.original_withdrawal->>'request_ledger_txn_id')::uuid)
   OR EXISTS(SELECT 1 FROM public.withdrawal_attempts a WHERE a.withdrawal_id=p.withdrawal_id)
   OR EXISTS(SELECT 1 FROM public.ledger_transactions t WHERE t.idempotency_key IN ('withdrawal:'||p.withdrawal_id::text||':payout','withdrawal:'||p.withdrawal_id::text||':refund')) THEN
   RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_INCOMPLETE' USING ERRCODE='P0001'; END IF;
  SELECT to_jsonb(r) INTO actual_reservation FROM public.withdrawal_payout_reservations r WHERE r.withdrawal_id=p.withdrawal_id;
  IF p.original_reservation IS NULL THEN
   IF actual_reservation IS NOT NULL THEN RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_INCOMPLETE' USING ERRCODE='P0001'; END IF;
  ELSIF p.original_reservation->>'status'='released' THEN
   IF actual_reservation IS DISTINCT FROM p.original_reservation THEN RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_INCOMPLETE' USING ERRCODE='P0001'; END IF;
  ELSE
   IF actual_reservation IS NULL OR actual_reservation->>'status' IS DISTINCT FROM 'released'
    OR (actual_reservation-ARRAY['status','updated_at']) IS DISTINCT FROM (p.original_reservation-ARRAY['status','updated_at'])
    OR (actual_reservation->>'updated_at')::timestamptz<(p.original_reservation->>'updated_at')::timestamptz THEN
    RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_INCOMPLETE' USING ERRCODE='P0001'; END IF;
  END IF;
  receipt:=public.shardkeep_withdrawal_drain_receipt(p.cancel_ledger_id);
  IF receipt IS NULL OR receipt->>'key' IS DISTINCT FROM 'withdrawal:'||p.withdrawal_id::text||':cancel'
   OR receipt->>'type' IS DISTINCT FROM 'withdrawal.cancel'
   OR receipt->'metadata' IS DISTINCT FROM jsonb_build_object('wallet',p.original_withdrawal->>'player_wallet','withdrawalId',p.withdrawal_id)
   OR jsonb_typeof(receipt->'entries') IS DISTINCT FROM 'array' OR jsonb_array_length(receipt->'entries')<>2
   OR (SELECT count(DISTINCT leg->>'account') FROM jsonb_array_elements(receipt->'entries') leg)<>2 THEN
   RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_INCOMPLETE' USING ERRCODE='P0001'; END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(receipt->'entries') LOOP
   SELECT value INTO before_account FROM jsonb_array_elements(p.before_accounts) WHERE value->>'id'=entry->>'account';
   IF before_account IS NULL OR ROW(entry->>'kind',entry->>'currency',entry->>'wallet',entry->>'baseId',entry->>'accountCreatedAt')
    IS DISTINCT FROM ROW(before_account->>'kind',before_account->>'currency',before_account->>'owner_wallet',before_account->>'base_id',before_account->>'created_at')
    OR (entry->>'delta')::bigint<>amount*(CASE WHEN before_account->>'kind'='withdrawal_escrow' THEN -1 ELSE 1 END)
    OR (entry->>'balanceAfter')::bigint<>(before_account->>'balance')::bigint+(entry->>'delta')::bigint THEN
    RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_INCOMPLETE' USING ERRCODE='P0001'; END IF;
  END LOOP;
 END LOOP;
 SELECT c.phase INTO phase FROM public.keep_custody_cutover_state c WHERE c.id;
 IF j.opening_xid=txid_current() THEN
  PERFORM public.shardkeep_withdrawal_drain_barrier(); PERFORM public.shardkeep_withdrawal_drain_zero();
  IF phase IS DISTINCT FROM 'withdrawals_closed' OR EXISTS(
   SELECT 1 FROM public.accounts a WHERE EXISTS(SELECT 1 FROM public.keep_custody_withdrawal_sources s
    CROSS JOIN LATERAL jsonb_array_elements(s.before_accounts) b WHERE s.fixture_id=fid AND b->>'id'=a.id::text)
    AND a.balance IS DISTINCT FROM (SELECT e.balance_after FROM public.ledger_entries e JOIN public.keep_custody_withdrawal_sources s ON s.cancel_ledger_id=e.txn_id
     WHERE s.fixture_id=fid AND e.account_id=a.id ORDER BY e.id DESC LIMIT 1)) THEN
   RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_INCOMPLETE' USING ERRCODE='P0001'; END IF;
 ELSIF phase NOT IN ('withdrawals_closed','frozen','retired') OR phase IS NULL THEN
  RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_INCOMPLETE' USING ERRCODE='P0001';
 END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_withdrawal_drain_private_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE wanted jsonb; oldj jsonb; newj jsonb;
BEGIN
 PERFORM public.shardkeep_withdrawal_drain_rc(); PERFORM public.shardkeep_withdrawal_drain_hooks();
 IF TG_RELID NOT IN ('public.keep_custody_withdrawal_sources'::regclass,'public.keep_custody_withdrawal_drains'::regclass)
  OR TG_WHEN<>'BEFORE' OR NOT ((TG_NAME='keep_custody_withdrawal_private' AND TG_LEVEL='ROW' AND TG_OP IN ('INSERT','UPDATE','DELETE'))
   OR (TG_NAME='keep_custody_withdrawal_no_truncate' AND TG_LEVEL='STATEMENT' AND TG_OP='TRUNCATE'))
  OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  OR current_database()!~'^shardkeep_custody_apply_[0-9a-f]{32}_test$' THEN
  RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_FIXTURE_REQUIRED' USING ERRCODE='P0001'; END IF;
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_JOURNAL_IMMUTABLE' USING ERRCODE='P0001'; END IF;
 newj:=to_jsonb(NEW);
 IF TG_OP='UPDATE' THEN oldj:=to_jsonb(OLD); END IF;
 IF TG_TABLE_NAME='keep_custody_withdrawal_sources' THEN
  IF TG_OP='INSERT' THEN
   wanted:=public.shardkeep_withdrawal_drain_plan(NEW.withdrawal_id,NEW.fixture_id,NEW.as_of);
   IF newj IS DISTINCT FROM wanted THEN RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
   RETURN NEW;
  END IF;
  IF OLD.cancel_ledger_id IS NULL AND NEW.cancel_ledger_id IS NOT NULL AND OLD.opening_xid=txid_current()
   AND (newj-'cancel_ledger_id')=(oldj-'cancel_ledger_id') AND EXISTS(SELECT 1 FROM public.ledger_transactions t
    WHERE t.id=NEW.cancel_ledger_id AND t.idempotency_key='withdrawal:'||OLD.withdrawal_id::text||':cancel' AND t.type='withdrawal.cancel'
     AND t.metadata=jsonb_build_object('wallet',OLD.original_withdrawal->>'player_wallet','withdrawalId',OLD.withdrawal_id))
   AND (SELECT to_jsonb(w) FROM public.withdrawals w WHERE w.id=OLD.withdrawal_id)=OLD.original_withdrawal||jsonb_build_object('status','cancelled','completed_at',OLD.as_of) THEN
   PERFORM public.shardkeep_withdrawal_drain_barrier(); RETURN NEW;
  END IF;
 ELSIF TG_OP='INSERT' THEN
  PERFORM public.shardkeep_withdrawal_drain_barrier();
  IF NEW.operation IS DISTINCT FROM 'fixture:unbonding-withdrawal-drain' OR NEW.database_name IS DISTINCT FROM current_database()
   OR NEW.operator_name IS DISTINCT FROM current_user OR NEW.opening_xid IS DISTINCT FROM txid_current()
   OR NOT EXISTS(SELECT 1 FROM public.keep_custody_withdrawal_sources s WHERE s.fixture_id=NEW.id AND s.opening_xid=txid_current()) THEN
   RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_INCOMPLETE' USING ERRCODE='P0001'; END IF;
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_JOURNAL_IMMUTABLE' USING ERRCODE='P0001';
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_withdrawal_drain_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
BEGIN
 PERFORM public.shardkeep_withdrawal_drain_rc(); PERFORM public.shardkeep_withdrawal_drain_hooks();
 IF TG_NAME<>'keep_custody_withdrawal_complete' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP NOT IN ('INSERT','UPDATE') THEN
  RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_INCOMPLETE' USING ERRCODE='P0001'; END IF;
 IF TG_RELID='public.keep_custody_withdrawal_sources'::regclass THEN
  PERFORM public.shardkeep_assert_fixture_withdrawal_drain(NEW.fixture_id);
 ELSIF TG_RELID='public.keep_custody_withdrawal_drains'::regclass THEN
  PERFORM public.shardkeep_assert_fixture_withdrawal_drain(NEW.id);
 ELSE RAISE EXCEPTION 'CUSTODY_WITHDRAWAL_INCOMPLETE' USING ERRCODE='P0001'; END IF;
 RETURN NULL;
END $$;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['withdrawals','withdrawal_attempts','withdrawal_payout_reservations','ledger_transactions','ledger_entries','accounts'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS a_keep_custody_withdrawal_source ON public.%I',tab);
  EXECUTE format('CREATE TRIGGER a_keep_custody_withdrawal_source BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_withdrawal_drain_source_guard()',tab);
  EXECUTE format('DROP TRIGGER IF EXISTS a_keep_custody_withdrawal_truncate ON public.%I',tab);
  EXECUTE format('CREATE TRIGGER a_keep_custody_withdrawal_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_withdrawal_drain_source_guard()',tab);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['keep_custody_withdrawal_drains','keep_custody_withdrawal_sources'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS keep_custody_withdrawal_private ON public.%I',tab);
  EXECUTE format('CREATE TRIGGER keep_custody_withdrawal_private BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_withdrawal_drain_private_guard()',tab);
  EXECUTE format('DROP TRIGGER IF EXISTS keep_custody_withdrawal_no_truncate ON public.%I',tab);
  EXECUTE format('CREATE TRIGGER keep_custody_withdrawal_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_withdrawal_drain_private_guard()',tab);
  EXECUTE format('DROP TRIGGER IF EXISTS keep_custody_withdrawal_complete ON public.%I',tab);
  EXECUTE format('CREATE CONSTRAINT TRIGGER keep_custody_withdrawal_complete AFTER INSERT OR UPDATE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_withdrawal_drain_complete()',tab);
 END LOOP;
END $$;
DROP TRIGGER IF EXISTS keep_custody_withdrawal_bind_post ON public.ledger_transactions;
CREATE TRIGGER keep_custody_withdrawal_bind_post AFTER INSERT ON public.ledger_transactions
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_withdrawal_drain_bind_post();
REVOKE ALL ON FUNCTION public.shardkeep_withdrawal_drain_rc(),public.shardkeep_withdrawal_drain_barrier(),
 public.shardkeep_withdrawal_drain_receipt(uuid),public.shardkeep_withdrawal_drain_hooks(),
 public.shardkeep_withdrawal_drain_plan(uuid,uuid,timestamptz),public.shardkeep_prepare_fixture_withdrawal_drain(uuid,uuid,timestamptz),
 public.shardkeep_withdrawal_drain_source_guard(),public.shardkeep_withdrawal_drain_bind_post(),
 public.shardkeep_withdrawal_drain_result(uuid),public.shardkeep_withdrawal_drain_receipts(uuid),public.shardkeep_withdrawal_drain_zero(),
 public.shardkeep_assert_fixture_withdrawal_drain(uuid),public.shardkeep_withdrawal_drain_private_guard(),public.shardkeep_withdrawal_drain_complete() FROM PUBLIC;
