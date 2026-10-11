-- Prospective owner-only item acceleration. Actual use INSERT and inventory
-- UPDATE witnesses precede the timer change; earning/completion and S5 stay held.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS public.shards_obstacle_item_accelerations (
 use_id uuid PRIMARY KEY REFERENCES public.item_uses(id) DEFERRABLE INITIALLY DEFERRED,
 obligation_id uuid NOT NULL UNIQUE REFERENCES public.shards_obstacle_obligations(id),
 wallet text NOT NULL REFERENCES public.players(wallet),item_id text NOT NULL,idempotency_key text NOT NULL,
 inventory_id uuid NOT NULL,before_finish_at timestamptz NOT NULL CHECK(isfinite(before_finish_at)),
 after_finish_at timestamptz NOT NULL CHECK(isfinite(after_finish_at)),
 quantity_before integer NOT NULL CHECK(quantity_before>0),quantity_after integer NOT NULL CHECK(quantity_after>=0),
 max_remaining_sec integer NOT NULL CHECK(max_remaining_sec>0),
 tx_key text NOT NULL CHECK(tx_key~'^[1-9][0-9]*$'),evidence_sha256 text NOT NULL CHECK(evidence_sha256~'^[0-9a-f]{64}$'),
 CHECK(after_finish_at<before_finish_at),CHECK(quantity_after=quantity_before-1),UNIQUE(wallet,idempotency_key),UNIQUE(inventory_id,tx_key)
);
CREATE TABLE IF NOT EXISTS public.shards_obstacle_item_uses (
 use_id uuid PRIMARY KEY REFERENCES public.shards_obstacle_item_accelerations(use_id),
 tx_key text NOT NULL CHECK(tx_key~'^[1-9][0-9]*$'),original_use jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS public.shards_obstacle_item_consumptions (
 use_id uuid PRIMARY KEY REFERENCES public.shards_obstacle_item_accelerations(use_id),
 tx_key text NOT NULL CHECK(tx_key~'^[1-9][0-9]*$'),before_inventory jsonb NOT NULL,after_inventory jsonb NOT NULL
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_item_event_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE h public.shards_obstacle_obligations%ROWTYPE;b public.bases%ROWTYPE;j public.builder_jobs%ROWTYPE;
 o public.obstacles%ROWTYPE;i public.base_items%ROWTYPE;floor_start timestamptz;
BEGIN
 IF TG_RELID<>'public.shards_obstacle_item_accelerations'::regclass
 OR TG_NAME<>TG_TABLE_NAME||(CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_immutable' END) OR TG_WHEN<>'BEFORE'
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW')
 THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ITEM_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ITEM_IMMUTABLE';END IF;
 IF session_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
 OR current_user IS DISTINCT FROM session_user THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ISOLATION';END IF;
 SELECT * INTO STRICT h FROM public.shards_obstacle_obligations WHERE id=NEW.obligation_id;
 PERFORM 1 FROM public.players WHERE wallet=h.wallet FOR UPDATE;
 SELECT * INTO STRICT b FROM public.bases WHERE id=h.base_id FOR UPDATE;
 SELECT * INTO STRICT j FROM public.builder_jobs WHERE id=h.job_id FOR UPDATE;
 SELECT * INTO STRICT o FROM public.obstacles WHERE id=h.obstacle_id FOR UPDATE;
 SELECT * INTO STRICT i FROM public.base_items WHERE id=NEW.inventory_id FOR UPDATE;
 INSERT INTO public.shards_tax_wallet_locks(wallet) VALUES(h.wallet) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM public.shards_tax_wallet_locks WHERE wallet=h.wallet FOR UPDATE;
 IF NEW.tx_key IS DISTINCT FROM pg_current_xact_id()::text OR NEW.wallet IS DISTINCT FROM h.wallet
 OR NEW.before_finish_at IS DISTINCT FROM h.scheduled_finish_at
 OR NOT(h.captured_at<=NEW.after_finish_at AND NEW.after_finish_at<NEW.before_finish_at)
 OR h.started_at<>date_trunc('milliseconds',h.started_at) OR h.scheduled_finish_at<>date_trunc('milliseconds',h.scheduled_finish_at)
 OR NEW.after_finish_at<>date_trunc('milliseconds',NEW.after_finish_at)
 OR length(NEW.idempotency_key) NOT BETWEEN 8 AND 128 OR length(NEW.item_id)=0
 OR NEW.quantity_before IS DISTINCT FROM i.qty OR NEW.quantity_before<=0 OR NEW.quantity_after IS DISTINCT FROM NEW.quantity_before-1
 OR i.base_id IS DISTINCT FROM h.base_id OR i.item_id IS DISTINCT FROM NEW.item_id
 OR NEW.max_remaining_sec<=0 OR ceil(extract(epoch FROM (NEW.before_finish_at-NEW.after_finish_at)))>NEW.max_remaining_sec
 OR b.owner_wallet IS DISTINCT FROM h.wallet OR b.status<>'active' OR b.deed_asset_id IS DISTINCT FROM h.deed_asset_id
 OR j.kind<>'clear_obstacle' OR j.completed_at IS NOT NULL OR j.cancelled_at IS NOT NULL
 OR ROW(j.base_id,j.obstacle_id,j.started_at,j.finishes_at) IS DISTINCT FROM ROW(h.base_id,h.obstacle_id,h.started_at,h.scheduled_finish_at)
 OR o.base_id IS DISTINCT FROM h.base_id OR o.cleared_at IS NOT NULL
 OR EXISTS(SELECT 1 FROM public.shards_obstacle_gems_accelerations WHERE obligation_id=h.id)
 OR EXISTS(SELECT 1 FROM public.item_uses WHERE id=NEW.use_id OR idempotency_key='use:'||h.wallet||':'||h.base_id::text||':'||NEW.idempotency_key)
 THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ITEM_EVIDENCE';END IF;
 SELECT (s.snapshot->>'startsAt')::timestamptz INTO floor_start FROM public.shards_tax_all_assessments a
 JOIN public.expedition_term_snapshots s ON s.term_id=a.term_id AND s.snapshot_hash=a.term_hash
 WHERE a.wallet=h.wallet AND a.lineage='d150-resource-tax-v1' ORDER BY a.wallet_sequence DESC LIMIT 1;
 IF NEW.after_finish_at<floor_start THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ORDER_HELD';END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_item_witness_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.shards_obstacle_item_accelerations%ROWTYPE;h public.shards_obstacle_obligations%ROWTYPE;
 before_row public.base_items%ROWTYPE;after_row public.base_items%ROWTYPE;
BEGIN
 IF TG_RELID NOT IN ('public.shards_obstacle_item_uses'::regclass,'public.shards_obstacle_item_consumptions'::regclass)
 OR TG_NAME<>TG_TABLE_NAME||(CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_immutable' END) OR TG_WHEN<>'BEFORE'
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW')
 THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ITEM_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ITEM_IMMUTABLE';END IF;
 IF pg_trigger_depth()<2 OR current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
 OR NEW.tx_key IS DISTINCT FROM pg_current_xact_id()::text
 THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ITEM_WITNESS_ORIGIN' USING ERRCODE='42501';END IF;
 SELECT * INTO STRICT e FROM public.shards_obstacle_item_accelerations WHERE use_id=NEW.use_id;
 SELECT * INTO STRICT h FROM public.shards_obstacle_obligations WHERE id=e.obligation_id;
 IF e.tx_key IS DISTINCT FROM NEW.tx_key THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ITEM_WITNESS_ORIGIN';END IF;
 IF TG_RELID='public.shards_obstacle_item_uses'::regclass THEN
  IF NOT EXISTS(SELECT 1 FROM public.item_uses u WHERE u.id=e.use_id AND to_jsonb(u)=NEW.original_use
   AND u.player_wallet=e.wallet AND u.item_id=e.item_id AND u.used_at=e.after_finish_at
   AND u.idempotency_key='use:'||e.wallet||':'||h.base_id::text||':'||e.idempotency_key)
  THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ITEM_WITNESS_ORIGIN';END IF;
 ELSE
  SELECT * INTO before_row FROM jsonb_populate_record(NULL::public.base_items,NEW.before_inventory);
  SELECT * INTO after_row FROM jsonb_populate_record(NULL::public.base_items,NEW.after_inventory);
  IF NOT EXISTS(SELECT 1 FROM public.shards_obstacle_item_uses w JOIN public.item_uses u ON u.id=w.use_id
   WHERE w.use_id=e.use_id AND w.tx_key=e.tx_key AND w.original_use=to_jsonb(u))
  OR NEW.before_inventory IS DISTINCT FROM to_jsonb(before_row) OR NEW.after_inventory IS DISTINCT FROM to_jsonb(after_row)
  OR NEW.before_inventory-'qty' IS DISTINCT FROM NEW.after_inventory-'qty'
  OR before_row.id IS DISTINCT FROM e.inventory_id OR before_row.base_id IS DISTINCT FROM h.base_id OR before_row.item_id IS DISTINCT FROM e.item_id
  OR before_row.qty IS DISTINCT FROM e.quantity_before OR after_row.qty IS DISTINCT FROM e.quantity_after
  OR NOT EXISTS(SELECT 1 FROM public.base_items i WHERE i.id=e.inventory_id AND to_jsonb(i)=NEW.after_inventory)
  THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ITEM_WITNESS_ORIGIN';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_item_use_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.shards_obstacle_item_accelerations%ROWTYPE;h public.shards_obstacle_obligations%ROWTYPE;
BEGIN
 IF TG_RELID<>'public.item_uses'::regclass OR TG_NAME<>'item_uses_shards_obstacle_item_insert'
 OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ITEM_TRIGGER';END IF;
 SELECT * INTO e FROM public.shards_obstacle_item_accelerations WHERE use_id=NEW.id;
 IF e.use_id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO STRICT h FROM public.shards_obstacle_obligations WHERE id=e.obligation_id;
 IF e.tx_key IS DISTINCT FROM pg_current_xact_id()::text OR NEW.player_wallet IS DISTINCT FROM e.wallet
 OR NEW.item_id IS DISTINCT FROM e.item_id OR NEW.used_at IS DISTINCT FROM e.after_finish_at
 OR NEW.idempotency_key IS DISTINCT FROM 'use:'||e.wallet||':'||h.base_id::text||':'||e.idempotency_key
 THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ITEM_WITNESS_ORIGIN';END IF;
 INSERT INTO public.shards_obstacle_item_uses(use_id,tx_key,original_use) VALUES(e.use_id,e.tx_key,to_jsonb(NEW));
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_shards_obstacle_item_use_insert() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_item_inventory_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.shards_obstacle_item_accelerations%ROWTYPE;matches bigint;
BEGIN
 IF TG_RELID<>'public.base_items'::regclass OR TG_NAME<>'base_items_shards_obstacle_item_update'
 OR TG_WHEN<>'AFTER' OR TG_OP<>'UPDATE' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ITEM_TRIGGER';END IF;
 SELECT count(*) INTO matches FROM public.shards_obstacle_item_accelerations a
 WHERE a.inventory_id=OLD.id AND a.tx_key=pg_current_xact_id()::text
 AND NOT EXISTS(SELECT 1 FROM public.shards_obstacle_item_consumptions c WHERE c.use_id=a.use_id);
 IF matches=0 THEN RETURN NULL;END IF;
 IF matches<>1 THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ITEM_AMBIGUOUS';END IF;
 SELECT * INTO STRICT e FROM public.shards_obstacle_item_accelerations a
 WHERE a.inventory_id=OLD.id AND a.tx_key=pg_current_xact_id()::text
 AND NOT EXISTS(SELECT 1 FROM public.shards_obstacle_item_consumptions c WHERE c.use_id=a.use_id);
 IF NOT EXISTS(SELECT 1 FROM public.shards_obstacle_obligations h WHERE h.id=e.obligation_id AND h.base_id=OLD.base_id)
 OR OLD.item_id IS DISTINCT FROM e.item_id OR OLD.qty IS DISTINCT FROM e.quantity_before OR OLD.qty<=0
 OR NEW.qty IS DISTINCT FROM e.quantity_after OR NEW.qty IS DISTINCT FROM OLD.qty-1
 OR to_jsonb(OLD)-'qty' IS DISTINCT FROM to_jsonb(NEW)-'qty'
 OR NOT EXISTS(SELECT 1 FROM public.shards_obstacle_item_uses w JOIN public.item_uses u ON u.id=w.use_id
  WHERE w.use_id=e.use_id AND w.tx_key=e.tx_key AND w.original_use=to_jsonb(u))
 THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ITEM_EVIDENCE';END IF;
 INSERT INTO public.shards_obstacle_item_consumptions(use_id,tx_key,before_inventory,after_inventory)
 VALUES(e.use_id,e.tx_key,to_jsonb(OLD),to_jsonb(NEW));
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_shards_obstacle_item_inventory_update() FROM PUBLIC;
--> statement-breakpoint
-- Historical replay proves the original use and captured decrement, without
-- consulting today's transferable inventory quantity, fields or item catalog.
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_item_valid(e public.shards_obstacle_item_accelerations,same_transaction boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE h public.shards_obstacle_obligations%ROWTYPE;u public.item_uses%ROWTYPE;
 w public.shards_obstacle_item_uses%ROWTYPE;c public.shards_obstacle_item_consumptions%ROWTYPE;
 before_row public.base_items%ROWTYPE;after_row public.base_items%ROWTYPE;
BEGIN
 SELECT * INTO STRICT h FROM public.shards_obstacle_obligations WHERE id=e.obligation_id;
 SELECT * INTO STRICT u FROM public.item_uses WHERE id=e.use_id;
 SELECT * INTO STRICT w FROM public.shards_obstacle_item_uses WHERE use_id=e.use_id;
 SELECT * INTO STRICT c FROM public.shards_obstacle_item_consumptions WHERE use_id=e.use_id;
 SELECT * INTO before_row FROM jsonb_populate_record(NULL::public.base_items,c.before_inventory);
 SELECT * INTO after_row FROM jsonb_populate_record(NULL::public.base_items,c.after_inventory);
 IF EXISTS(SELECT 1 FROM public.shards_obstacle_gems_accelerations WHERE obligation_id=e.obligation_id)
 OR e.wallet IS DISTINCT FROM h.wallet OR e.before_finish_at IS DISTINCT FROM h.scheduled_finish_at
 OR NOT(h.captured_at<=e.after_finish_at AND e.after_finish_at<e.before_finish_at)
 OR h.started_at<>date_trunc('milliseconds',h.started_at) OR h.scheduled_finish_at<>date_trunc('milliseconds',h.scheduled_finish_at)
 OR e.after_finish_at<>date_trunc('milliseconds',e.after_finish_at)
 OR length(e.idempotency_key) NOT BETWEEN 8 AND 128 OR length(e.item_id)=0 OR e.evidence_sha256!~'^[0-9a-f]{64}$'
 OR e.quantity_before<=0 OR e.quantity_after IS DISTINCT FROM e.quantity_before-1 OR e.quantity_after<0
 OR e.max_remaining_sec<=0 OR ceil(extract(epoch FROM (e.before_finish_at-e.after_finish_at)))>e.max_remaining_sec
 OR w.tx_key IS DISTINCT FROM e.tx_key OR c.tx_key IS DISTINCT FROM e.tx_key
 OR (same_transaction AND e.tx_key IS DISTINCT FROM pg_current_xact_id()::text)
 OR w.original_use IS DISTINCT FROM to_jsonb(u)
 OR u.player_wallet IS DISTINCT FROM e.wallet OR u.item_id IS DISTINCT FROM e.item_id OR u.used_at IS DISTINCT FROM e.after_finish_at
 OR u.idempotency_key IS DISTINCT FROM 'use:'||e.wallet||':'||h.base_id::text||':'||e.idempotency_key
 OR c.before_inventory IS DISTINCT FROM to_jsonb(before_row) OR c.after_inventory IS DISTINCT FROM to_jsonb(after_row)
 OR c.before_inventory-'qty' IS DISTINCT FROM c.after_inventory-'qty'
 OR before_row.id IS DISTINCT FROM e.inventory_id OR before_row.base_id IS DISTINCT FROM h.base_id OR before_row.item_id IS DISTINCT FROM e.item_id
 OR before_row.qty IS DISTINCT FROM e.quantity_before OR after_row.qty IS DISTINCT FROM e.quantity_after
 THEN RETURN false;END IF;
 IF same_transaction AND NOT EXISTS(SELECT 1 FROM public.base_items i WHERE i.id=e.inventory_id AND to_jsonb(i)=c.after_inventory) THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_item_commit_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.shards_obstacle_item_accelerations%ROWTYPE;
BEGIN
 IF TG_RELID NOT IN ('public.shards_obstacle_item_accelerations'::regclass,'public.shards_obstacle_item_uses'::regclass,'public.shards_obstacle_item_consumptions'::regclass)
 OR TG_NAME<>TG_TABLE_NAME||'_commit' OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ITEM_TRIGGER';END IF;
 SELECT * INTO e FROM public.shards_obstacle_item_accelerations WHERE use_id=NEW.use_id;
 IF e.use_id IS NULL OR NOT public.shardkeep_shards_obstacle_item_valid(e,true) OR NOT EXISTS(
  SELECT 1 FROM public.shards_obstacle_obligations h JOIN public.builder_jobs j ON j.id=h.job_id
  JOIN public.bases b ON b.id=h.base_id JOIN public.obstacles o ON o.id=h.obstacle_id
  WHERE h.id=e.obligation_id AND j.kind='clear_obstacle' AND j.completed_at IS NULL AND j.cancelled_at IS NULL
  AND ROW(j.base_id,j.obstacle_id,j.started_at,j.finishes_at)=ROW(h.base_id,h.obstacle_id,h.started_at,e.after_finish_at)
  AND b.owner_wallet=h.wallet AND b.status='active' AND b.deed_asset_id IS NOT DISTINCT FROM h.deed_asset_id
  AND o.base_id=h.base_id AND o.cleared_at IS NULL)
 THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ITEM_EVIDENCE';END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
-- SET CONSTRAINTS may flush deferred checks before commit. Once witnessed,
-- these current-transaction rows cannot be restored, edited or deleted later.
-- A later transaction can change inventory normally; replay uses saved facts.
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_item_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
BEGIN
 IF TG_RELID NOT IN ('public.base_items'::regclass,'public.item_uses'::regclass) OR TG_WHEN<>'BEFORE'
 OR (TG_OP='TRUNCATE' AND (TG_LEVEL<>'STATEMENT' OR TG_NAME<>TG_TABLE_NAME||'_shards_obstacle_item_truncate'))
 OR (TG_OP IN ('UPDATE','DELETE') AND (TG_LEVEL<>'ROW' OR TG_NAME<>TG_TABLE_NAME||'_shards_obstacle_item_mutation'))
 OR TG_OP NOT IN ('UPDATE','DELETE','TRUNCATE') THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ITEM_TRIGGER';END IF;
 IF TG_OP='TRUNCATE' THEN
  IF EXISTS(SELECT 1 FROM public.shards_obstacle_item_accelerations WHERE tx_key=pg_current_xact_id()::text)
  THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ITEM_SOURCE_HELD';END IF;
  RETURN NULL;
 ELSIF TG_RELID='public.base_items'::regclass THEN
  IF EXISTS(SELECT 1 FROM public.shards_obstacle_item_accelerations e JOIN public.shards_obstacle_item_consumptions c ON c.use_id=e.use_id
   WHERE e.inventory_id=OLD.id AND e.tx_key=pg_current_xact_id()::text)
  THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ITEM_SOURCE_HELD';END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM public.shards_obstacle_item_accelerations WHERE use_id=OLD.id AND tx_key=pg_current_xact_id()::text)
  THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ITEM_SOURCE_HELD';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_shards_obstacle_item_source_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_gems_valid(e public.shards_obstacle_gems_accelerations,same_transaction boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE h public.shards_obstacle_obligations%ROWTYPE;p public.shards_obstacle_gems_posts%ROWTYPE;
 t public.ledger_transactions%ROWTYPE;m jsonb;cap text;
BEGIN
 IF EXISTS(SELECT 1 FROM public.shards_obstacle_item_accelerations WHERE obligation_id=e.obligation_id) THEN RETURN false;END IF;
 SELECT * INTO STRICT h FROM public.shards_obstacle_obligations WHERE id=e.obligation_id;
 SELECT * INTO STRICT p FROM public.shards_obstacle_gems_posts WHERE ledger_id=e.ledger_id;
 SELECT * INTO STRICT t FROM public.ledger_transactions WHERE id=e.ledger_id;
 IF p.obligation_id IS DISTINCT FROM h.id OR p.original_transaction IS DISTINCT FROM to_jsonb(t)
 OR (same_transaction AND p.tx_key IS DISTINCT FROM pg_current_xact_id()::text)
 OR e.wallet IS DISTINCT FROM h.wallet OR e.before_finish_at IS DISTINCT FROM h.scheduled_finish_at
 OR NOT(h.captured_at<=e.after_finish_at AND e.after_finish_at<e.before_finish_at)
 OR e.gems_amount<=0 OR e.evidence_sha256!~'^[0-9a-f]{64}$' OR length(e.idempotency_key) NOT BETWEEN 8 AND 128
 OR t.type<>'build.speedup' OR t.idempotency_key IS DISTINCT FROM 'speedup:'||h.wallet||':'||e.idempotency_key
 THEN RETURN false;END IF;
 m:=t.metadata;cap:=m->'builderJobSpeedup'->'request'->'consent'->>'maxCostKeep';
 IF cap IS NULL OR cap!~'^[1-9][0-9]{0,18}$' OR cap::numeric>9223372036854775807 OR e.gems_amount>cap::numeric THEN RETURN false;END IF;
 IF h.started_at<>date_trunc('milliseconds',h.started_at)
 OR h.scheduled_finish_at<>date_trunc('milliseconds',h.scheduled_finish_at)
 OR e.after_finish_at<>date_trunc('milliseconds',e.after_finish_at)
 OR m IS DISTINCT FROM jsonb_build_object('wallet',h.wallet,'currency','GEMS','baseId',h.base_id,'jobId',h.job_id,
  'remSec',ceil(extract(epoch FROM (e.before_finish_at-e.after_finish_at))),
  'builderJobSpeedup',jsonb_build_object('version',1,'request',jsonb_build_object('baseId',h.base_id,'jobId',h.job_id,
   'idempotencyKey',e.idempotency_key,'expectedCurrency','GEMS','consent',jsonb_build_object('version',1,'kind','clear_obstacle',
   'buildingId',NULL,'obstacleId',h.obstacle_id,'startedAt',to_char(h.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'finishesAt',to_char(h.scheduled_finish_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'maxCostKeep',cap)),
   'result',jsonb_build_object('jobId',h.job_id,'kind','clear_obstacle','buildingId',NULL,'obstacleId',h.obstacle_id,
   'completedAt',to_char(e.after_finish_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))))
 THEN RETURN false;END IF;
 IF (SELECT count(*) FROM public.ledger_entries WHERE txn_id=e.ledger_id)<>2
 OR (SELECT count(*) FROM public.shards_obstacle_gems_entries WHERE ledger_id=e.ledger_id)<>2
 OR EXISTS(SELECT 1 FROM public.shards_obstacle_gems_entries w LEFT JOIN public.ledger_entries l ON l.id=w.entry_id
  LEFT JOIN public.accounts a ON a.id=l.account_id WHERE w.ledger_id=e.ledger_id AND
  (w.tx_key IS DISTINCT FROM p.tx_key OR l.txn_id IS DISTINCT FROM p.ledger_id
   OR w.original_entry IS DISTINCT FROM to_jsonb(l) OR w.account_identity IS DISTINCT FROM to_jsonb(a)-'balance'))
 OR NOT EXISTS(SELECT 1 FROM public.ledger_entries l JOIN public.accounts a ON a.id=l.account_id WHERE l.txn_id=e.ledger_id
  AND l.delta=-e.gems_amount AND a.kind='player_gems' AND a.currency='GEMS' AND a.owner_wallet=h.wallet AND a.base_id IS NULL)
 OR NOT EXISTS(SELECT 1 FROM public.ledger_entries l JOIN public.accounts a ON a.id=l.account_id WHERE l.txn_id=e.ledger_id
  AND l.delta=e.gems_amount AND a.kind='gems_sink' AND a.currency='GEMS' AND a.owner_wallet IS NULL AND a.base_id IS NULL)
 THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_pending(actor_wallet text,term_start timestamptz) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.shards_obstacle_obligations h
 LEFT JOIN public.builder_jobs j ON j.id=h.job_id LEFT JOIN public.bases b ON b.id=h.base_id LEFT JOIN public.obstacles o ON o.id=h.obstacle_id
 LEFT JOIN public.shards_obstacle_gems_accelerations e ON e.obligation_id=h.id
 LEFT JOIN public.shards_obstacle_item_accelerations a ON a.obligation_id=h.id
 WHERE (h.wallet=actor_wallet OR b.owner_wallet=actor_wallet) AND
 (j.id IS NULL OR b.id IS NULL OR o.id IS NULL OR j.kind<>'clear_obstacle'
 OR ROW(j.base_id,j.obstacle_id,j.started_at,j.finishes_at) IS DISTINCT FROM ROW(h.base_id,h.obstacle_id,h.started_at,coalesce(e.after_finish_at,a.after_finish_at,h.scheduled_finish_at))
 OR (e.obligation_id IS NOT NULL AND a.obligation_id IS NOT NULL)
 OR (e.obligation_id IS NOT NULL AND NOT public.shardkeep_shards_obstacle_gems_valid(e,false))
 OR (a.obligation_id IS NOT NULL AND NOT public.shardkeep_shards_obstacle_item_valid(a,false))
 OR j.completed_at IS NOT NULL OR j.cancelled_at IS NOT NULL OR o.base_id IS DISTINCT FROM h.base_id OR o.cleared_at IS NOT NULL
 OR b.owner_wallet IS DISTINCT FROM h.wallet OR b.status<>'active' OR b.deed_asset_id IS DISTINCT FROM h.deed_asset_id
 OR coalesce(e.after_finish_at,a.after_finish_at,h.scheduled_finish_at)<term_start))
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_commit_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID<>'public.shards_obstacle_obligations'::regclass OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_TRIGGER';END IF;
 IF EXISTS(SELECT 1 FROM public.shards_obstacle_obligations h
 LEFT JOIN public.builder_jobs j ON j.id=h.job_id LEFT JOIN public.bases b ON b.id=h.base_id LEFT JOIN public.obstacles o ON o.id=h.obstacle_id
 LEFT JOIN public.shards_obstacle_gems_accelerations e ON e.obligation_id=h.id
 LEFT JOIN public.shards_obstacle_item_accelerations a ON a.obligation_id=h.id
 WHERE h.id=NEW.id AND (j.id IS NULL OR b.id IS NULL OR o.id IS NULL OR j.kind<>'clear_obstacle'
 OR ROW(j.base_id,j.obstacle_id,j.started_at,j.finishes_at) IS DISTINCT FROM ROW(h.base_id,h.obstacle_id,h.started_at,coalesce(e.after_finish_at,a.after_finish_at,h.scheduled_finish_at))
 OR (e.obligation_id IS NOT NULL AND a.obligation_id IS NOT NULL)
 OR (e.obligation_id IS NOT NULL AND NOT public.shardkeep_shards_obstacle_gems_valid(e,false))
 OR (a.obligation_id IS NOT NULL AND NOT public.shardkeep_shards_obstacle_item_valid(a,false))
 OR j.completed_at IS NOT NULL OR j.cancelled_at IS NOT NULL OR o.base_id IS DISTINCT FROM h.base_id OR o.cleared_at IS NOT NULL
 OR b.owner_wallet IS DISTINCT FROM h.wallet OR b.status<>'active' OR b.deed_asset_id IS DISTINCT FROM h.deed_asset_id))
 THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_CAPTURE_MISMATCH';END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_transition_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE changed boolean;enrolled boolean;
BEGIN
 IF TG_RELID NOT IN ('public.builder_jobs'::regclass,'public.bases'::regclass,'public.obstacles'::regclass)
 OR TG_NAME<>TG_TABLE_NAME||'_shards_obstacle_transition' OR TG_WHEN<>'BEFORE' OR TG_OP<>'UPDATE' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_TRIGGER';END IF;
 IF TG_RELID='public.builder_jobs'::regclass THEN
  changed:=ROW(NEW.id,NEW.player_wallet,NEW.base_id,NEW.kind,NEW.building_id,NEW.obstacle_id,NEW.started_at,NEW.finishes_at,NEW.completed_at,NEW.cancelled_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.player_wallet,OLD.base_id,OLD.kind,OLD.building_id,OLD.obstacle_id,OLD.started_at,OLD.finishes_at,OLD.completed_at,OLD.cancelled_at);
 ELSIF TG_RELID='public.bases'::regclass THEN
  changed:=ROW(NEW.id,NEW.owner_wallet,NEW.status,NEW.deed_asset_id) IS DISTINCT FROM ROW(OLD.id,OLD.owner_wallet,OLD.status,OLD.deed_asset_id);
 ELSE
  changed:=ROW(NEW.id,NEW.player_wallet,NEW.base_id,NEW.sprite_key,NEW.tx,NEW.ty,NEW.cleared_at) IS DISTINCT FROM ROW(OLD.id,OLD.player_wallet,OLD.base_id,OLD.sprite_key,OLD.tx,OLD.ty,OLD.cleared_at);
 END IF;
 IF NOT changed THEN RETURN NEW;END IF;
 IF TG_RELID='public.builder_jobs'::regclass THEN
  SELECT EXISTS(SELECT 1 FROM public.shards_obstacle_obligations WHERE job_id=OLD.id) INTO enrolled;
  IF enrolled AND to_jsonb(NEW)-'finishes_at'=to_jsonb(OLD)-'finishes_at' AND EXISTS(
   SELECT 1 FROM public.shards_obstacle_obligations h
   LEFT JOIN public.shards_obstacle_gems_accelerations e ON e.obligation_id=h.id
   LEFT JOIN public.shards_obstacle_item_accelerations a ON a.obligation_id=h.id
   WHERE h.job_id=OLD.id AND OLD.finishes_at=h.scheduled_finish_at
   AND ((e.obligation_id IS NOT NULL AND a.obligation_id IS NULL AND NEW.finishes_at=e.after_finish_at AND public.shardkeep_shards_obstacle_gems_valid(e,true))
    OR (a.obligation_id IS NOT NULL AND e.obligation_id IS NULL AND NEW.finishes_at=a.after_finish_at AND public.shardkeep_shards_obstacle_item_valid(a,true)))) THEN RETURN NEW;END IF;
 ELSIF TG_RELID='public.bases'::regclass THEN SELECT EXISTS(SELECT 1 FROM public.shards_obstacle_obligations WHERE base_id=OLD.id) INTO enrolled;
 ELSE SELECT EXISTS(SELECT 1 FROM public.shards_obstacle_obligations WHERE obstacle_id=OLD.id) INTO enrolled;END IF;
 IF enrolled THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_TRANSITION_HELD';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_shards_obstacle_transition_guard() FROM PUBLIC;
--> statement-breakpoint
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['shards_obstacle_item_accelerations','shards_obstacle_item_uses','shards_obstacle_item_consumptions'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname=t||'_immutable') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.%I()',t||'_immutable',t,CASE WHEN t='shards_obstacle_item_accelerations' THEN 'shardkeep_shards_obstacle_item_event_guard' ELSE 'shardkeep_shards_obstacle_item_witness_guard' END);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname=t||'_no_truncate') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.%I()',t||'_no_truncate',t,CASE WHEN t='shards_obstacle_item_accelerations' THEN 'shardkeep_shards_obstacle_item_event_guard' ELSE 'shardkeep_shards_obstacle_item_witness_guard' END);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname=t||'_commit') THEN
   EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_shards_obstacle_item_commit_guard()',t||'_commit',t);
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.item_uses'::regclass AND tgname='item_uses_shards_obstacle_item_insert') THEN
  CREATE TRIGGER item_uses_shards_obstacle_item_insert AFTER INSERT ON public.item_uses FOR EACH ROW EXECUTE FUNCTION public.shardkeep_shards_obstacle_item_use_insert();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.base_items'::regclass AND tgname='base_items_shards_obstacle_item_update') THEN
  CREATE TRIGGER base_items_shards_obstacle_item_update AFTER UPDATE ON public.base_items FOR EACH ROW EXECUTE FUNCTION public.shardkeep_shards_obstacle_item_inventory_update();
 END IF;
 FOREACH t IN ARRAY ARRAY['base_items','item_uses'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname=t||'_shards_obstacle_item_mutation') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_shards_obstacle_item_source_guard()',t||'_shards_obstacle_item_mutation',t);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname=t||'_shards_obstacle_item_truncate') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_shards_obstacle_item_source_guard()',t||'_shards_obstacle_item_truncate',t);
  END IF;
 END LOOP;
END $$;
