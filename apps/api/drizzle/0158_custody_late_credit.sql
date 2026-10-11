-- HELD, fixture-only late-finality exception. No runtime role receives authority.
-- Historical journals without an F-time source roster authorize no deposits.
ALTER TABLE public.keep_custody_journal ADD COLUMN IF NOT EXISTS late_deposit_sources jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.keep_custody_late_authorizations (
  id uuid PRIMARY KEY,
  xid xid8 NOT NULL UNIQUE,
  request jsonb NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  verified_keep bigint NOT NULL CHECK (verified_keep>0),
  verified_base_units bigint NOT NULL CHECK (verified_base_units>0),
  source_before jsonb NOT NULL,
  postings jsonb NOT NULL,
  accounts_before jsonb NOT NULL,
  retirement_minted_before numeric NOT NULL
);
CREATE TABLE IF NOT EXISTS public.keep_custody_late_journal (
  id uuid PRIMARY KEY REFERENCES public.keep_custody_late_authorizations(id),
  result jsonb NOT NULL
);
REVOKE ALL ON public.keep_custody_late_authorizations,public.keep_custody_late_journal FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_fixture_late_owner()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
 SELECT current_database() ~ '^shardkeep_custody_apply_[0-9a-f]{32}_test$'
 AND coalesce(nullif(current_setting('role',true),'none'),session_user)
   =(SELECT pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid='public.keep_custody_journal'::regclass)
 AND coalesce(nullif(current_setting('role',true),'none'),session_user)
   =(SELECT pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid='public.keep_custody_cutover_state'::regclass)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_fixture_late_active()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
 SELECT to_jsonb(a) FROM public.keep_custody_late_authorizations a
 WHERE public.shardkeep_fixture_late_owner() AND a.xid=pg_current_xact_id()
 AND NOT EXISTS(SELECT 1 FROM public.keep_custody_late_journal j WHERE j.id=a.id)
 AND (SELECT phase FROM public.keep_custody_cutover_state WHERE id)='frozen'
AND current_setting('shardkeep.deed_economy_writer',true)='v1'
AND current_setting('shardkeep.keep_custody_cutover',true) IN ('late-credit','operator-settle')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_fixture_late_receipt(txn uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
 SELECT jsonb_build_object('id',t.id,'idempotencyKey',t.idempotency_key,'type',t.type,'metadata',t.metadata,
   'createdAt',t.created_at,'entries',coalesce((SELECT jsonb_agg(jsonb_build_object(
     'id',e.id::text,'account',a.id,'kind',a.kind,'currency',a.currency,'wallet',a.owner_wallet,
     'baseId',a.base_id,'delta',e.delta::text,'balanceAfter',e.balance_after::text) ORDER BY e.id)
     FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id WHERE e.txn_id=t.id),'[]'::jsonb))
 FROM public.ledger_transactions t WHERE t.id=txn
$$;
REVOKE ALL ON FUNCTION public.shardkeep_fixture_late_receipt(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_fixture_late_barrier()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
BEGIN
 IF NOT public.shardkeep_fixture_late_owner() OR current_user<>(SELECT pg_get_userbyid(relowner)
 FROM pg_catalog.pg_class WHERE oid='public.keep_custody_journal'::regclass)
 THEN RAISE EXCEPTION 'CUSTODY_LATE_OWNER_REQUIRED'; END IF;
 LOCK TABLE public.ledger_transactions,public.accounts,public.ledger_entries,public.players,public.bases,public.base_slots,
 public.deed_ownership_observations,public.base_forge_positions,public.forge_contributions,public.raid_loot_reservations,
 public.base_raid_locks,public.mail_messages,public.mail_attachments,public.base_league_entitlements,
 public.withdrawals,public.withdrawal_attempts,public.withdrawal_payout_reservations,public.deposits,
 public.player_items,public.item_listings,public.keep_custody_journal,public.mail_keep_retirements,
 public.keep_custody_late_authorizations,public.keep_custody_late_journal IN ACCESS EXCLUSIVE MODE NOWAIT;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_fixture_late_barrier() FROM PUBLIC;
--> statement-breakpoint
-- Invoker authority is checked before the barrier, and the full barrier before
-- the phase latch. NOWAIT rolls back rather than reversing a writer lock order.
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
 OR retirement.dry_run OR retirement.subcommand NOT IN ('retire-l1','retire-l1-mail','retire-l1-mail-forge')
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_fixture_late_auth_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE expected jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CUSTODY_LATE_IMMUTABLE'; END IF;
 expected:=public.shardkeep_fixture_late_context(NEW.request,NEW.input_hash,NEW.verified_keep,NEW.verified_base_units);
 IF NEW.id IS DISTINCT FROM (NEW.request->>'fixtureId')::uuid OR NEW.xid<>pg_current_xact_id()
 OR NEW.source_before IS DISTINCT FROM expected->'source_before' OR NEW.postings IS DISTINCT FROM expected->'postings'
 OR NEW.accounts_before IS DISTINCT FROM expected->'accounts_before'
 OR NEW.retirement_minted_before IS DISTINCT FROM (expected->>'retirement_minted_before')::numeric
 THEN RAISE EXCEPTION 'CUSTODY_LATE_AUTH_INVALID'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS keep_custody_late_authorizations_guard ON public.keep_custody_late_authorizations;
CREATE TRIGGER keep_custody_late_authorizations_guard BEFORE INSERT OR UPDATE OR DELETE ON public.keep_custody_late_authorizations
 FOR EACH ROW EXECUTE FUNCTION public.shardkeep_fixture_late_auth_guard();
DROP TRIGGER IF EXISTS keep_custody_late_authorizations_no_truncate ON public.keep_custody_late_authorizations;
CREATE TRIGGER keep_custody_late_authorizations_no_truncate BEFORE TRUNCATE ON public.keep_custody_late_authorizations
 FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_fixture_late_auth_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.prepare_fixture_keep_late_credit(request jsonb,input_hash text,verified_keep bigint,verified_base_units bigint)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
#variable_conflict use_variable
DECLARE context jsonb; saved public.keep_custody_late_authorizations%ROWTYPE; completed jsonb; receipt jsonb;
BEGIN
 IF NOT public.shardkeep_fixture_late_owner() OR current_user<>(SELECT pg_get_userbyid(relowner)
 FROM pg_catalog.pg_class WHERE oid='public.keep_custody_journal'::regclass)
 THEN RAISE EXCEPTION 'CUSTODY_LATE_OWNER_REQUIRED'; END IF;
 PERFORM public.shardkeep_fixture_late_barrier();
 SELECT * INTO saved FROM public.keep_custody_late_authorizations WHERE id=(request->>'fixtureId')::uuid;
 IF saved.id IS NOT NULL THEN
   IF saved.request IS DISTINCT FROM request OR saved.input_hash IS DISTINCT FROM input_hash
   OR saved.verified_keep IS DISTINCT FROM verified_keep OR saved.verified_base_units IS DISTINCT FROM verified_base_units
   THEN RAISE EXCEPTION 'CUSTODY_LATE_REPLAY_MISMATCH'; END IF;
   SELECT result INTO completed FROM public.keep_custody_late_journal WHERE id=saved.id;
   IF completed IS NULL OR completed->'sourceAfter' IS DISTINCT FROM (SELECT to_jsonb(d)||jsonb_build_object('amount',d.amount::text) FROM public.deposits d WHERE id=(request->>'depositId')::uuid)
   OR NOT coalesce((SELECT phase FROM public.keep_custody_cutover_state WHERE id) IN ('frozen','retired'),false)
   THEN RAISE EXCEPTION 'CUSTODY_LATE_REPLAY_INVALID'; END IF;
   FOR receipt IN SELECT value FROM jsonb_array_elements(completed->'receipts') LOOP
     IF receipt IS DISTINCT FROM public.shardkeep_fixture_late_receipt((receipt->>'id')::uuid)
     THEN RAISE EXCEPTION 'CUSTODY_LATE_REPLAY_INVALID'; END IF;
   END LOOP;
   RETURN jsonb_build_object('replay',completed);
 END IF;
 context:=public.shardkeep_fixture_late_context(request,input_hash,verified_keep,verified_base_units);
 INSERT INTO public.keep_custody_late_authorizations(id,xid,request,input_hash,verified_keep,verified_base_units,
 source_before,postings,accounts_before,retirement_minted_before) VALUES((request->>'fixtureId')::uuid,pg_current_xact_id(),request,
 input_hash,verified_keep,verified_base_units,context->'source_before',context->'postings',context->'accounts_before',
 (context->>'retirement_minted_before')::numeric);
 RETURN jsonb_build_object('postings',context->'postings');
END $$;
REVOKE ALL ON FUNCTION public.prepare_fixture_keep_late_credit(jsonb,text,bigint,bigint) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_assert_keep_custody_post(account_ids uuid[], posting_type text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE touched boolean:=false; candidate record; phase text; auth jsonb;
BEGIN
 FOR candidate IN SELECT id,kind FROM public.accounts WHERE id=ANY(account_ids) ORDER BY id FOR KEY SHARE LOOP
 touched:=touched OR candidate.kind IN ('player_keep','withdrawal_escrow','forge_payout_escrow','mail_keep_escrow','league_entitlement_escrow','forge_escrow','base_forge_escrow');
 END LOOP;
 IF NOT touched THEN RETURN; END IF;
 phase:=public.shardkeep_keep_custody_phase_locked();
 IF phase IN ('frozen','retired') THEN
   auth:=public.shardkeep_fixture_late_active();
   IF auth IS NULL OR current_setting('shardkeep.keep_custody_cutover',true) IS DISTINCT FROM
    (CASE posting_type WHEN 'deposit.keep' THEN 'late-credit' WHEN 'gems.late_credit' THEN 'operator-settle' END)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(auth->'postings') p WHERE p->>'type'=posting_type
   AND (SELECT array_agg((e->>'account')::uuid ORDER BY e->>'account') FROM jsonb_array_elements(p->'entries') e)
     =(SELECT array_agg(v ORDER BY v::text) FROM unnest(account_ids) v))
   THEN RAISE EXCEPTION 'KEEP_CUSTODY_FROZEN'; END IF;
 END IF;
 IF phase<>'open' AND posting_type='gems.from_keep' THEN RAISE EXCEPTION 'KEEP_CUSTODY_CLOSING'; END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_custody_entry_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE auth jsonb; plan jsonb; receipt public.ledger_transactions%ROWTYPE; bound boolean;
BEGIN
 SELECT * INTO receipt FROM public.ledger_transactions WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.txn_id ELSE NEW.txn_id END;
 SELECT EXISTS(SELECT 1 FROM public.keep_custody_late_authorizations a CROSS JOIN LATERAL jsonb_array_elements(a.postings) p
 WHERE p->>'key'=receipt.idempotency_key OR (TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM public.ledger_transactions t WHERE t.id=OLD.txn_id AND t.idempotency_key=p->>'key'))) INTO bound;
 auth:=public.shardkeep_fixture_late_active();
 IF bound OR auth IS NOT NULL THEN
   IF TG_OP<>'INSERT' OR auth IS NULL THEN RAISE EXCEPTION 'CUSTODY_LATE_ENTRY_INVALID'; END IF;
   SELECT p INTO plan FROM jsonb_array_elements(auth->'postings') p WHERE p->>'key'=receipt.idempotency_key;
   IF plan IS NULL OR current_setting('shardkeep.keep_custody_cutover',true) IS DISTINCT FROM
    (CASE receipt.type WHEN 'deposit.keep' THEN 'late-credit' WHEN 'gems.late_credit' THEN 'operator-settle' END)
  OR plan->>'type' IS DISTINCT FROM receipt.type OR plan->'metadata' IS DISTINCT FROM receipt.metadata
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'entries') e WHERE (e->>'account')::uuid=NEW.account_id AND (e->>'delta')::bigint=NEW.delta)
   OR EXISTS(SELECT 1 FROM public.ledger_entries WHERE txn_id=NEW.txn_id AND account_id=NEW.account_id)
   OR NEW.balance_after IS DISTINCT FROM (SELECT balance+NEW.delta FROM public.accounts WHERE id=NEW.account_id)
   THEN RAISE EXCEPTION 'CUSTODY_LATE_ENTRY_INVALID'; END IF;
   RETURN NEW;
 END IF;
 IF TG_OP<>'INSERT' THEN PERFORM public.shardkeep_assert_keep_custody_post(ARRAY[OLD.account_id],(SELECT type FROM public.ledger_transactions WHERE id=OLD.txn_id)); END IF;
 IF TG_OP<>'DELETE' THEN
   PERFORM public.shardkeep_assert_keep_custody_post(ARRAY[NEW.account_id],receipt.type);
   RETURN NEW;
 END IF;
 RETURN OLD;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_custody_receipt_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE ids uuid[];
BEGIN
 IF EXISTS(SELECT 1 FROM public.keep_custody_late_authorizations a CROSS JOIN LATERAL jsonb_array_elements(a.postings) p
 WHERE p->>'key'=OLD.idempotency_key OR (TG_OP='UPDATE' AND p->>'key'=NEW.idempotency_key))
 THEN RAISE EXCEPTION 'CUSTODY_LATE_RECEIPT_IMMUTABLE'; END IF;
 SELECT array_agg(account_id) INTO ids FROM public.ledger_entries WHERE txn_id=OLD.id;
 PERFORM public.shardkeep_assert_keep_custody_post(ids,OLD.type);
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_custody_account_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE relevant boolean; phase text; auth jsonb; prior jsonb;
BEGIN
 IF TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM public.keep_custody_late_authorizations a
 CROSS JOIN LATERAL jsonb_array_elements(a.accounts_before) original WHERE original->>'id'=OLD.id::text)
 AND (TG_OP='DELETE' OR (to_jsonb(NEW)-'balance') IS DISTINCT FROM (to_jsonb(OLD)-'balance'))
 THEN RAISE EXCEPTION 'CUSTODY_LATE_ACCOUNT_IDENTITY_IMMUTABLE'; END IF;
 auth:=public.shardkeep_fixture_late_active();
 IF auth IS NOT NULL THEN
   IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'CUSTODY_LATE_ACCOUNT_INVALID'; END IF;
   SELECT a INTO prior FROM jsonb_array_elements(auth->'accounts_before') a WHERE a->>'id'=OLD.id::text;
   IF prior IS NULL OR (to_jsonb(NEW)-'balance') IS DISTINCT FROM (prior-'balance')
   OR (to_jsonb(OLD)-'balance') IS DISTINCT FROM (prior-'balance')
   OR NEW.balance IS DISTINCT FROM (SELECT coalesce(sum(delta),0) FROM public.ledger_entries WHERE account_id=OLD.id)
   OR (NEW.kind='player_keep' AND NOT ((OLD.balance=0 AND NEW.balance=(auth->>'verified_keep')::bigint)
     OR (OLD.balance=(auth->>'verified_keep')::bigint AND NEW.balance=0)))
   THEN RAISE EXCEPTION 'CUSTODY_LATE_ACCOUNT_INVALID'; END IF;
   RETURN NEW;
 END IF;
 relevant:=(TG_OP<>'INSERT' AND OLD.kind IN ('player_keep','withdrawal_escrow','forge_payout_escrow','mail_keep_escrow','league_entitlement_escrow','forge_escrow','base_forge_escrow'))
 OR (TG_OP<>'DELETE' AND NEW.kind IN ('player_keep','withdrawal_escrow','forge_payout_escrow','mail_keep_escrow','league_entitlement_escrow','forge_escrow','base_forge_escrow'));
 IF relevant THEN
 phase:=public.shardkeep_keep_custody_phase_locked();
 IF phase IN ('frozen','retired') AND (TG_OP='DELETE' OR (TG_OP='INSERT' AND NEW.balance<>0)
 OR (TG_OP='UPDATE' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)))
 THEN RAISE EXCEPTION 'KEEP_CUSTODY_FROZEN'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_fixture_late_deposit_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE auth jsonb; expected jsonb; txn uuid;
BEGIN
 IF TG_OP='TRUNCATE' THEN
   IF EXISTS(SELECT 1 FROM public.keep_custody_late_authorizations) THEN RAISE EXCEPTION 'CUSTODY_LATE_DEPOSIT_IMMUTABLE'; END IF;
   RETURN NULL;
 END IF;
 IF TG_OP='UPDATE' AND NEW.kind NOT IN ('keep_deposit','keep_vend') AND OLD.kind NOT IN ('keep_deposit','keep_vend') THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' AND OLD.kind NOT IN ('keep_deposit','keep_vend') THEN RETURN OLD; END IF;
 IF public.shardkeep_keep_custody_phase_locked() NOT IN ('frozen','retired') THEN
   IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 auth:=public.shardkeep_fixture_late_active();
 IF TG_OP<>'UPDATE' OR auth IS NULL OR OLD.id::text IS DISTINCT FROM auth->'request'->>'depositId'
 OR to_jsonb(OLD) IS DISTINCT FROM auth->'source_before' THEN RAISE EXCEPTION 'KEEP_CUSTODY_FROZEN'; END IF;
 SELECT id INTO txn FROM public.ledger_transactions WHERE idempotency_key=auth->'postings'->0->>'key';
 expected:=(auth->'source_before')||jsonb_build_object('status','credited','tx_signature',auth->'request'->'proof'->>'signature',
 'amount',(auth->>'verified_base_units')::bigint,'mint',auth->'request'->'proof'->>'mint',
 'finalized_at',((auth->'request'->'proof'->>'finalizedObservedAt')::timestamptz),'ledger_txn_id',txn);
 IF txn IS NULL OR to_jsonb(NEW) IS DISTINCT FROM expected THEN RAISE EXCEPTION 'CUSTODY_LATE_DEPOSIT_INVALID'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS deposits_keep_custody_settlement ON public.deposits;
CREATE TRIGGER deposits_keep_custody_settlement BEFORE UPDATE OR DELETE ON public.deposits
 FOR EACH ROW EXECUTE FUNCTION public.shardkeep_fixture_late_deposit_guard();
DROP TRIGGER IF EXISTS deposits_keep_custody_no_truncate ON public.deposits;
CREATE TRIGGER deposits_keep_custody_no_truncate BEFORE TRUNCATE ON public.deposits
 FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_fixture_late_deposit_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_fixture_late_result(fixture uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE auth jsonb; plan jsonb; receipt jsonb; receipts jsonb:='[]'; source jsonb; expected jsonb; prior jsonb;
 delta numeric; minted numeric; actual_entries jsonb; expected_entries jsonb;
BEGIN
 auth:=public.shardkeep_fixture_late_active();
 IF auth IS NULL OR auth->>'id' IS DISTINCT FROM fixture::text THEN RAISE EXCEPTION 'CUSTODY_LATE_AUTH_REQUIRED'; END IF;
 FOR plan IN SELECT value FROM jsonb_array_elements(auth->'postings') LOOP
   SELECT public.shardkeep_fixture_late_receipt(id) INTO receipt FROM public.ledger_transactions WHERE idempotency_key=plan->>'key';
   SELECT jsonb_agg(jsonb_build_object('account',e->>'account','delta',e->>'delta') ORDER BY e->>'account')
   INTO actual_entries FROM jsonb_array_elements(receipt->'entries') e;
   SELECT jsonb_agg(e ORDER BY e->>'account') INTO expected_entries FROM jsonb_array_elements(plan->'entries') e;
   IF receipt IS NULL OR receipt->>'type' IS DISTINCT FROM plan->>'type' OR receipt->'metadata' IS DISTINCT FROM plan->'metadata'
   OR actual_entries IS DISTINCT FROM expected_entries THEN RAISE EXCEPTION 'CUSTODY_LATE_RECEIPT_INVALID'; END IF;
   receipts:=receipts||jsonb_build_array(receipt);
 END LOOP;
 SELECT to_jsonb(d) INTO source FROM public.deposits d WHERE d.id=(auth->'request'->>'depositId')::uuid;
 expected:=(auth->'source_before')||jsonb_build_object('status','credited','tx_signature',auth->'request'->'proof'->>'signature',
 'amount',(auth->>'verified_base_units')::bigint,'mint',auth->'request'->'proof'->>'mint',
 'finalized_at',((auth->'request'->'proof'->>'finalizedObservedAt')::timestamptz),'ledger_txn_id',receipts->0->>'id');
 IF source IS DISTINCT FROM expected THEN RAISE EXCEPTION 'CUSTODY_LATE_DEPOSIT_INVALID'; END IF;
 FOR prior IN SELECT value FROM jsonb_array_elements(auth->'accounts_before') LOOP
   SELECT coalesce(sum((e->>'delta')::numeric),0) INTO delta FROM jsonb_array_elements(auth->'postings') p
     CROSS JOIN LATERAL jsonb_array_elements(p->'entries') e WHERE e->>'account'=prior->>'id';
   IF (SELECT to_jsonb(a)-'balance' FROM public.accounts a WHERE id=(prior->>'id')::uuid) IS DISTINCT FROM prior-'balance'
   OR (SELECT balance FROM public.accounts WHERE id=(prior->>'id')::uuid) IS DISTINCT FROM (prior->>'balance')::numeric+delta
   THEN RAISE EXCEPTION 'CUSTODY_LATE_BALANCE_INVALID'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.accounts WHERE kind IN ('player_keep','withdrawal_escrow','forge_payout_escrow','mail_keep_escrow','league_entitlement_escrow','forge_escrow','base_forge_escrow') AND balance<>0)
 OR EXISTS(SELECT 1 FROM public.accounts a WHERE balance<>(SELECT coalesce(sum(e.delta),0) FROM public.ledger_entries e WHERE e.account_id=a.id))
 OR EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id GROUP BY e.txn_id,a.currency HAVING sum(e.delta)<>0)
 THEN RAISE EXCEPTION 'CUSTODY_LATE_CONSERVATION_REQUIRED'; END IF;
 SELECT coalesce(sum(-e.delta),0) INTO minted FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id
 JOIN public.ledger_transactions t ON t.id=e.txn_id WHERE a.kind='gems_mint' AND t.type='gems.retirement';
 IF minted IS DISTINCT FROM (auth->>'retirement_minted_before')::numeric THEN RAISE EXCEPTION 'CUSTODY_LATE_RETIREMENT_CHANGED'; END IF;
 RETURN jsonb_build_object('fixtureOnly',true,'retirementAuthorized',false,'chainEvidence','injected-fixture','fixtureId',fixture,'retirementJournalId',auth->'request'->>'retirementJournalId',
 'depositId',auth->'request'->>'depositId','inputHash',auth->>'input_hash','keep',auth->>'verified_keep','gems',auth->>'verified_keep',
 'receipts',receipts,'sourceAfter',source||jsonb_build_object('amount',(auth->>'verified_base_units')));
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_fixture_late_result(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_fixture_late_journal_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CUSTODY_LATE_IMMUTABLE'; END IF;
 IF NEW.result IS DISTINCT FROM public.shardkeep_fixture_late_result(NEW.id) THEN RAISE EXCEPTION 'CUSTODY_LATE_JOURNAL_INVALID'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS keep_custody_late_journal_guard ON public.keep_custody_late_journal;
CREATE TRIGGER keep_custody_late_journal_guard BEFORE INSERT OR UPDATE OR DELETE ON public.keep_custody_late_journal
 FOR EACH ROW EXECUTE FUNCTION public.shardkeep_fixture_late_journal_guard();
DROP TRIGGER IF EXISTS keep_custody_late_journal_no_truncate ON public.keep_custody_late_journal;
CREATE TRIGGER keep_custody_late_journal_no_truncate BEFORE TRUNCATE ON public.keep_custody_late_journal
 FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_fixture_late_journal_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.seal_fixture_keep_late_credit(fixture_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE result jsonb;
BEGIN
 result:=public.shardkeep_fixture_late_result(fixture_id);
 INSERT INTO public.keep_custody_late_journal(id,result) VALUES(fixture_id,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.seal_fixture_keep_late_credit(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_fixture_late_seal_required()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.keep_custody_late_journal WHERE id=NEW.id) THEN RAISE EXCEPTION 'CUSTODY_LATE_SEAL_REQUIRED'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS keep_custody_late_seal_required ON public.keep_custody_late_authorizations;
CREATE CONSTRAINT TRIGGER keep_custody_late_seal_required AFTER INSERT ON public.keep_custody_late_authorizations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_fixture_late_seal_required();
