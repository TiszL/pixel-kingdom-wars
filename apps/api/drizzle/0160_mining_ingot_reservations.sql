-- Pending-only custody, never an allocation authority. Existing-table guards
-- affect only explicitly admitted bases and remain held for separate S5 approval.
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS mining_ingot_epochs (
 id uuid PRIMARY KEY, epoch_key text NOT NULL UNIQUE CHECK(length(epoch_key) BETWEEN 8 AND 128), created_at timestamptz NOT NULL CHECK(isfinite(created_at))
);
CREATE TABLE IF NOT EXISTS mining_ingot_admissions (base_id uuid PRIMARY KEY REFERENCES bases(id) ON DELETE RESTRICT);
CREATE TABLE IF NOT EXISTS mining_ingot_reservations (
 id uuid PRIMARY KEY, epoch_id uuid NOT NULL REFERENCES mining_ingot_epochs(id) ON DELETE RESTRICT,
 base_id uuid NOT NULL REFERENCES mining_ingot_admissions(base_id) ON DELETE RESTRICT,
 actor_wallet text NOT NULL REFERENCES players(wallet), idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
 qty integer NOT NULL CHECK(qty>0), created_at timestamptz NOT NULL CHECK(isfinite(created_at)),
 CONSTRAINT mining_ingot_actor_key_uq UNIQUE(actor_wallet,idempotency_key)
);
CREATE INDEX IF NOT EXISTS mining_ingot_reservations_base_idx ON mining_ingot_reservations(base_id);
CREATE TABLE IF NOT EXISTS mining_ingot_aborts (
 epoch_id uuid PRIMARY KEY REFERENCES mining_ingot_epochs(id), decision_key text NOT NULL UNIQUE CHECK(length(decision_key) BETWEEN 8 AND 128),
 reason text NOT NULL CHECK(length(reason) BETWEEN 8 AND 128), created_at timestamptz NOT NULL CHECK(isfinite(created_at))
);
CREATE TABLE IF NOT EXISTS mining_ingot_releases (
 reservation_id uuid PRIMARY KEY REFERENCES mining_ingot_reservations(id), abort_epoch_id uuid NOT NULL REFERENCES mining_ingot_aborts(epoch_id),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at))
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_assert_mining_ingot_stock(target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE minted bigint; held bigint; reserved bigint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.mining_ingot_admissions WHERE base_id=target) THEN RETURN; END IF;
 -- Receipt identity and BOTH exact ledger legs are required; acquired_via is
 -- merely a label. No uncollected or malformed job supplies earned inventory.
 IF EXISTS(SELECT 1 FROM public.workshop_jobs j WHERE j.base_id=target AND j.collected_at IS NOT NULL AND (
  j.collected_by_wallet IS NULL OR j.collect_idempotency_key IS NULL OR j.collected_at<j.ready_at OR
  NOT EXISTS(SELECT 1 FROM public.ledger_transactions t WHERE t.id=j.debit_ledger_txn_id AND t.type='workshop.refine'
   AND t.idempotency_key='workshop:'||j.base_id::text||':'||j.started_by_wallet||':'||j.start_idempotency_key
   AND t.metadata=jsonb_build_object('baseId',j.base_id,'wallet',j.started_by_wallet,'ingots',j.ingots,'shards',j.shards_charged::text,'recipeVersion',j.recipe_version,'workshopLevel',j.workshop_level_at_start)) OR
  (SELECT count(*) FROM public.ledger_entries e WHERE e.txn_id=j.debit_ledger_txn_id)<>2 OR
  NOT EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id WHERE e.txn_id=j.debit_ledger_txn_id
   AND a.kind='base_shards' AND a.currency='SHARDS' AND a.base_id=target AND a.owner_wallet IS NULL AND e.delta=-j.shards_charged) OR
  NOT EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id WHERE e.txn_id=j.debit_ledger_txn_id
   AND a.kind='shard_burn' AND a.currency='SHARDS' AND a.base_id IS NULL AND a.owner_wallet IS NULL AND e.delta=j.shards_charged)
 )) THEN RAISE EXCEPTION 'MINING_INGOT_SOURCE_INVALID' USING ERRCODE='23514'; END IF;
 SELECT coalesce(sum(ingots),0) INTO minted FROM public.workshop_jobs WHERE base_id=target AND collected_at IS NOT NULL;
 SELECT coalesce(sum(qty),0) INTO held FROM public.base_items WHERE base_id=target AND item_id='forge_ingot';
 SELECT coalesce(sum(r.qty),0) INTO reserved FROM public.mining_ingot_reservations r
  WHERE r.base_id=target AND NOT EXISTS(SELECT 1 FROM public.mining_ingot_releases x WHERE x.reservation_id=r.id);
 IF held+reserved<>minted THEN RAISE EXCEPTION 'MINING_INGOT_CONSERVATION' USING ERRCODE='23514'; END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_ingot_history_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r public.mining_ingot_reservations%ROWTYPE; a public.mining_ingot_aborts%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_INGOT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN
  RAISE EXCEPTION 'MINING_INGOT_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
 IF TG_TABLE_NAME='mining_ingot_admissions' THEN
  -- Identity edits use this same serialization point; a waiting statement must
  -- see the latest committed admission rather than an older transaction snapshot.
  IF current_setting('transaction_isolation')<>'read committed' THEN
   RAISE EXCEPTION 'MINING_INGOT_READ_COMMITTED_REQUIRED' USING ERRCODE='25000'; END IF;
  PERFORM 1 FROM public.bases WHERE id=NEW.base_id FOR UPDATE;
 ELSIF TG_TABLE_NAME='mining_ingot_reservations' THEN
  PERFORM 1 FROM public.mining_ingot_epochs WHERE id=NEW.epoch_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.mining_ingot_aborts WHERE epoch_id=NEW.epoch_id) THEN RAISE EXCEPTION 'MINING_EPOCH_ABORTED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.bases b JOIN public.base_slots s ON s.base_id=b.id WHERE b.id=NEW.base_id
   AND b.owner_wallet=NEW.actor_wallet AND b.status='active' AND s.wallet=NEW.actor_wallet AND s.active)
   OR EXISTS(SELECT 1 FROM public.base_raid_locks WHERE base_id=NEW.base_id)
   OR NEW.created_at<(SELECT created_at FROM public.mining_ingot_epochs WHERE id=NEW.epoch_id)
   OR NEW.created_at<(SELECT max(collected_at) FROM public.workshop_jobs WHERE base_id=NEW.base_id) THEN
   RAISE EXCEPTION 'MINING_INGOT_CUSTODY_INVALID'; END IF;
 ELSIF TG_TABLE_NAME='mining_ingot_aborts' THEN
  PERFORM 1 FROM public.mining_ingot_epochs WHERE id=NEW.epoch_id FOR UPDATE;
  IF NEW.created_at<(SELECT max(created_at) FROM public.mining_ingot_reservations WHERE epoch_id=NEW.epoch_id) THEN RAISE EXCEPTION 'MINING_ABORT_TIME_INVALID'; END IF;
 ELSIF TG_TABLE_NAME='mining_ingot_releases' THEN
  SELECT * INTO STRICT r FROM public.mining_ingot_reservations WHERE id=NEW.reservation_id;
  SELECT * INTO STRICT a FROM public.mining_ingot_aborts WHERE epoch_id=NEW.abort_epoch_id;
  IF r.epoch_id<>NEW.abort_epoch_id OR NEW.created_at<>a.created_at THEN RAISE EXCEPTION 'MINING_RELEASE_INVALID'; END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_ingot_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target uuid; prior uuid; epoch uuid;
BEGIN
 IF TG_TABLE_NAME IN ('base_items','workshop_jobs') THEN
  IF TG_OP<>'INSERT' THEN prior:=OLD.base_id; PERFORM public.shardkeep_assert_mining_ingot_stock(prior); END IF;
  IF TG_OP<>'DELETE' THEN target:=NEW.base_id; END IF;
 ELSIF TG_TABLE_NAME IN ('mining_ingot_admissions','mining_ingot_reservations') THEN target:=NEW.base_id;
 ELSIF TG_TABLE_NAME='mining_ingot_releases' THEN
  SELECT base_id INTO target FROM public.mining_ingot_reservations WHERE id=NEW.reservation_id;
 ELSIF TG_TABLE_NAME='mining_ingot_aborts' THEN
  epoch:=NEW.epoch_id;
  IF EXISTS(SELECT 1 FROM public.mining_ingot_reservations r WHERE r.epoch_id=epoch
   AND NOT EXISTS(SELECT 1 FROM public.mining_ingot_releases x WHERE x.reservation_id=r.id)) THEN
   RAISE EXCEPTION 'MINING_ABORT_INCOMPLETE'; END IF;
 END IF;
 IF target IS NOT NULL AND target IS DISTINCT FROM prior THEN PERFORM public.shardkeep_assert_mining_ingot_stock(target); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
-- Keep the original payment proof immutable after its output enters custody.
-- Resolve ALL linked jobs before locking bases: collection may be in flight.
-- A separate post-lock query sees the admission/collection committed by the
-- prior lock holder. Non-READ-COMMITTED identity edits fail closed; balances
-- and unrelated transactions retain their existing behavior.
CREATE OR REPLACE FUNCTION public.shardkeep_mining_ingot_receipt_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE receipts uuid[]; targets uuid[];
BEGIN
 IF TG_TABLE_NAME='ledger_transactions' THEN
  IF TG_OP='UPDATE' AND to_jsonb(OLD)=to_jsonb(NEW) THEN RETURN NEW; END IF;
  receipts:=ARRAY[OLD.id];
  IF TG_OP='UPDATE' THEN receipts:=array_append(receipts,NEW.id); END IF;
 ELSIF TG_TABLE_NAME='ledger_entries' THEN
  receipts:=ARRAY[]::uuid[];
  IF TG_OP<>'INSERT' THEN receipts:=array_append(receipts,OLD.txn_id); END IF;
  IF TG_OP<>'DELETE' THEN receipts:=array_append(receipts,NEW.txn_id); END IF;
 ELSE
  IF TG_OP='UPDATE' AND ROW(OLD.id,OLD.kind,OLD.currency,OLD.owner_wallet,OLD.base_id)
   IS NOT DISTINCT FROM ROW(NEW.id,NEW.kind,NEW.currency,NEW.owner_wallet,NEW.base_id) THEN RETURN NEW; END IF;
  SELECT array_agg(DISTINCT e.txn_id) INTO receipts FROM public.ledger_entries e
   WHERE e.account_id=OLD.id OR (TG_OP='UPDATE' AND e.account_id=NEW.id);
 END IF;
 SELECT array_agg(DISTINCT j.base_id ORDER BY j.base_id) INTO targets FROM public.workshop_jobs j
  WHERE j.debit_ledger_txn_id=ANY(receipts);
 IF cardinality(targets)>0 THEN
  IF current_setting('transaction_isolation')<>'read committed' THEN
   RAISE EXCEPTION 'MINING_INGOT_READ_COMMITTED_REQUIRED' USING ERRCODE='25000'; END IF;
  PERFORM b.id FROM public.bases b WHERE b.id=ANY(targets) ORDER BY b.id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.workshop_jobs j JOIN public.mining_ingot_admissions a ON a.base_id=j.base_id
   WHERE j.debit_ledger_txn_id=ANY(receipts) AND j.collected_at IS NOT NULL) THEN
   RAISE EXCEPTION 'MINING_INGOT_RECEIPT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_ingot_source_truncate_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'MINING_INGOT_READ_COMMITTED_REQUIRED' USING ERRCODE='25000'; END IF;
 IF EXISTS(SELECT 1 FROM public.mining_ingot_admissions) THEN
  RAISE EXCEPTION 'MINING_INGOT_RECEIPT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
DO $migration$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['mining_ingot_epochs','mining_ingot_admissions','mining_ingot_reservations','mining_ingot_aborts','mining_ingot_releases'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||name)::regclass AND tgname=name||'_immutable') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_ingot_history_guard()',name||'_immutable',name);
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_ingot_history_guard()',name||'_no_truncate',name);
  END IF;
 END LOOP;
 FOREACH name IN ARRAY ARRAY['mining_ingot_admissions','mining_ingot_reservations','mining_ingot_aborts','mining_ingot_releases','base_items','workshop_jobs'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||name)::regclass AND tgname=name||'_mining_conservation') THEN
   EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_ingot_check()',name||'_mining_conservation',name);
  END IF;
 END LOOP;
 FOREACH name IN ARRAY ARRAY['ledger_transactions','ledger_entries','accounts'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||name)::regclass AND tgname=name||'_mining_receipt') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE %s ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_ingot_receipt_guard()',
    name||'_mining_receipt',CASE WHEN name='ledger_entries' THEN 'INSERT OR UPDATE OR DELETE' ELSE 'UPDATE OR DELETE' END,name);
  END IF;
 END LOOP;
 FOREACH name IN ARRAY ARRAY['ledger_transactions','ledger_entries','accounts','workshop_jobs','base_items'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||name)::regclass AND tgname=name||'_mining_no_truncate') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_ingot_source_truncate_guard()',name||'_mining_no_truncate',name);
  END IF;
 END LOOP;
END $migration$;
--> statement-breakpoint
REVOKE ALL ON mining_ingot_epochs,mining_ingot_admissions,mining_ingot_reservations,mining_ingot_aborts,mining_ingot_releases FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_assert_mining_ingot_stock(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_mining_ingot_history_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_mining_ingot_check() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_mining_ingot_receipt_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_mining_ingot_source_truncate_guard() FROM PUBLIC;
