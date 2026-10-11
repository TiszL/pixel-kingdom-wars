-- A second-free entitlement is wallet-lifetime, even after a deed conversion/sale.
-- Deliberately no live player/base FK: the immutable original receipt survives.
CREATE TABLE IF NOT EXISTS mining_free_base_purchases (
 wallet text PRIMARY KEY, request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 128),
 source_base_id uuid NOT NULL, base_id uuid NOT NULL UNIQUE,
 slot integer NOT NULL CHECK(slot>0), policy_version integer NOT NULL CHECK(policy_version>0),
 shards_charged bigint NOT NULL CHECK(shards_charged>0), debit_transaction_id uuid NOT NULL UNIQUE,
 development jsonb NOT NULL CHECK(jsonb_typeof(development)='object'),
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(source_base_id<>base_id)
);
--> statement-breakpoint
-- Receipt insertion and source identity edits serialize by the same debit.
-- Fail fast instead of waiting while a caller already holds ledger row locks.
CREATE OR REPLACE FUNCTION public.shardkeep_lock_free_base_debits(ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target uuid;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'FREE_BASE_READ_COMMITTED_REQUIRED' USING ERRCODE='25000'; END IF;
 FOR target IN SELECT DISTINCT id FROM unnest(ids) id WHERE id IS NOT NULL ORDER BY id LOOP
  IF NOT pg_try_advisory_xact_lock(hashtextextended('shardkeep:free-base-debit:'||target::text,0)) THEN
   RAISE EXCEPTION 'FREE_BASE_DEBIT_BUSY' USING ERRCODE='55P03'; END IF;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_assert_free_base_debit(r public.mining_free_base_purchases) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 -- A concurrent identity rewrite can predate visibility of the new entries;
 -- retaining these rows closes that race even when it found no debit key.
 PERFORM a.id FROM public.accounts a JOIN public.ledger_entries e ON e.account_id=a.id
  WHERE e.txn_id=r.debit_transaction_id ORDER BY a.id FOR SHARE OF a NOWAIT;
 IF NOT EXISTS(SELECT 1 FROM public.ledger_transactions t WHERE t.id=r.debit_transaction_id
  AND t.type='base.free_purchase' AND t.idempotency_key='free-base:'||r.wallet||':'||r.request_key
  AND t.metadata=jsonb_build_object('baseId',r.source_base_id,'wallet',r.wallet,'sourceBaseId',r.source_base_id,
   'purchasedBaseId',r.base_id,'policyVersion',r.policy_version,'development',r.development))
  OR (SELECT count(*) FROM public.ledger_entries WHERE txn_id=r.debit_transaction_id)<>2
  OR NOT EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id
   WHERE e.txn_id=r.debit_transaction_id AND a.kind='base_shards' AND a.currency='SHARDS'
   AND a.owner_wallet IS NULL AND a.base_id=r.source_base_id AND e.delta=-r.shards_charged)
  OR NOT EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id
   WHERE e.txn_id=r.debit_transaction_id AND a.kind='shard_burn' AND a.currency='SHARDS'
   AND a.owner_wallet IS NULL AND a.base_id IS NULL AND e.delta=r.shards_charged)
 THEN RAISE EXCEPTION 'FREE_BASE_DEBIT_INVALID' USING ERRCODE='23514'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_free_base_receipt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'FREE_BASE_RECEIPT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN
  RAISE EXCEPTION 'FREE_BASE_RECEIPT_OWNER_REQUIRED' USING ERRCODE='23514'; END IF;
 PERFORM public.shardkeep_lock_free_base_debits(ARRAY[NEW.debit_transaction_id]);
 PERFORM public.shardkeep_assert_free_base_debit(NEW);
 NEW.accepted_at:=clock_timestamp(); RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mining_free_base_receipt_guard ON mining_free_base_purchases;
CREATE TRIGGER mining_free_base_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON mining_free_base_purchases
 FOR EACH ROW EXECUTE FUNCTION public.shardkeep_free_base_receipt_guard();
DROP TRIGGER IF EXISTS mining_free_base_receipt_truncate ON mining_free_base_purchases;
CREATE TRIGGER mining_free_base_receipt_truncate BEFORE TRUNCATE ON mining_free_base_purchases
 FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_free_base_receipt_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_free_base_debit_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE ids uuid[];
BEGIN
 IF TG_TABLE_NAME='ledger_transactions' THEN
  IF TG_OP='UPDATE' AND to_jsonb(NEW)=to_jsonb(OLD) THEN RETURN NEW; END IF;
  ids:=ARRAY[OLD.id]; IF TG_OP='UPDATE' THEN ids:=array_append(ids,NEW.id); END IF;
 ELSIF TG_TABLE_NAME='ledger_entries' THEN
  IF TG_OP='UPDATE' AND to_jsonb(NEW)=to_jsonb(OLD) THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
   -- Lock classification itself: an old snapshot cannot hide a concurrent
   -- ordinary-to-purchase retype. Unrelated new ledger postings stay unchanged.
   PERFORM id FROM public.ledger_transactions WHERE id=NEW.txn_id FOR SHARE NOWAIT;
   IF NOT FOUND THEN RAISE EXCEPTION 'FREE_BASE_DEBIT_UNAVAILABLE' USING ERRCODE='23514'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.ledger_transactions WHERE id=NEW.txn_id AND type='base.free_purchase')
    AND NOT EXISTS(SELECT 1 FROM public.mining_free_base_purchases WHERE debit_transaction_id=NEW.txn_id)
   THEN RETURN NEW; END IF;
  END IF;
  ids:=ARRAY[]::uuid[];
  IF TG_OP<>'INSERT' THEN ids:=array_append(ids,OLD.txn_id); END IF;
  IF TG_OP<>'DELETE' THEN ids:=array_append(ids,NEW.txn_id); END IF;
 ELSE
  IF TG_OP='UPDATE' AND ROW(OLD.id,OLD.kind,OLD.currency,OLD.owner_wallet,OLD.base_id)
   IS NOT DISTINCT FROM ROW(NEW.id,NEW.kind,NEW.currency,NEW.owner_wallet,NEW.base_id) THEN RETURN NEW; END IF;
  SELECT array_agg(DISTINCT txn_id ORDER BY txn_id) INTO ids FROM public.ledger_entries
   WHERE account_id=OLD.id OR (TG_OP='UPDATE' AND account_id=NEW.id);
 END IF;
 PERFORM public.shardkeep_lock_free_base_debits(ids);
 IF EXISTS(SELECT 1 FROM public.mining_free_base_purchases WHERE debit_transaction_id=ANY(ids)) THEN
  RAISE EXCEPTION 'FREE_BASE_DEBIT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_free_base_debit_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN PERFORM public.shardkeep_assert_free_base_debit(NEW); RETURN NULL; END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_free_base_source_truncate_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 -- Native TRUNCATE locks already exclude a concurrent purchase's ledger writes.
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'FREE_BASE_READ_COMMITTED_REQUIRED' USING ERRCODE='25000'; END IF;
 IF EXISTS(SELECT 1 FROM public.mining_free_base_purchases) THEN
  RAISE EXCEPTION 'FREE_BASE_DEBIT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
DO $migration$
DECLARE name text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_free_base_purchases'::regclass AND tgname='mining_free_base_debit_check') THEN
  CREATE CONSTRAINT TRIGGER mining_free_base_debit_check AFTER INSERT ON mining_free_base_purchases
   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_free_base_debit_check();
 END IF;
 FOREACH name IN ARRAY ARRAY['ledger_transactions','ledger_entries','accounts'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||name)::regclass AND tgname=name||'_free_base_debit') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE %s ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_free_base_debit_guard()',
    name||'_free_base_debit',CASE WHEN name='ledger_entries' THEN 'INSERT OR UPDATE OR DELETE' ELSE 'UPDATE OR DELETE' END,name);
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_free_base_source_truncate_guard()',name||'_free_base_no_truncate',name);
  END IF;
 END LOOP;
END $migration$;
REVOKE ALL ON mining_free_base_purchases FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_lock_free_base_debits(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_assert_free_base_debit(public.mining_free_base_purchases) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_free_base_receipt_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_free_base_debit_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_free_base_debit_check() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_free_base_source_truncate_guard() FROM PUBLIC;
