-- Prospective owner-only Gems acceleration evidence. No earning, completion,
-- runtime issuer, legacy backfill or S5 transition activation is authorized.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS public.shards_obstacle_gems_posts (
 ledger_id uuid PRIMARY KEY REFERENCES public.ledger_transactions(id),
 obligation_id uuid NOT NULL UNIQUE REFERENCES public.shards_obstacle_obligations(id),
 tx_key text NOT NULL CHECK(tx_key~'^[1-9][0-9]*$'),original_transaction jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS public.shards_obstacle_gems_entries (
 entry_id bigint PRIMARY KEY REFERENCES public.ledger_entries(id),
 ledger_id uuid NOT NULL REFERENCES public.shards_obstacle_gems_posts(ledger_id),
 tx_key text NOT NULL CHECK(tx_key~'^[1-9][0-9]*$'),original_entry jsonb NOT NULL,account_identity jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS public.shards_obstacle_gems_accelerations (
 obligation_id uuid PRIMARY KEY REFERENCES public.shards_obstacle_obligations(id),
 ledger_id uuid NOT NULL UNIQUE REFERENCES public.shards_obstacle_gems_posts(ledger_id),
 wallet text NOT NULL REFERENCES public.players(wallet),idempotency_key text NOT NULL,
 before_finish_at timestamptz NOT NULL CHECK(isfinite(before_finish_at)),
 after_finish_at timestamptz NOT NULL CHECK(isfinite(after_finish_at)),
 gems_amount bigint NOT NULL CHECK(gems_amount>0),evidence_sha256 text NOT NULL CHECK(evidence_sha256~'^[0-9a-f]{64}$'),
 CHECK(after_finish_at<before_finish_at),UNIQUE(wallet,idempotency_key)
);
--> statement-breakpoint
-- Full xid8 top-level identity survives nested ledger savepoint releases. xmin
-- is deliberately not provenance: UPDATE can replace an old tuple's xmin.
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_gems_witness_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE owner_name text;
BEGIN
 IF TG_RELID NOT IN ('public.shards_obstacle_gems_posts'::regclass,'public.shards_obstacle_gems_entries'::regclass)
 OR TG_NAME<>TG_TABLE_NAME||(CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_immutable' END) OR TG_WHEN<>'BEFORE'
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW')
 THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_GEMS_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_GEMS_IMMUTABLE';END IF;
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
 IF pg_trigger_depth()<2 OR current_user IS DISTINCT FROM owner_name
 OR NEW.tx_key IS DISTINCT FROM pg_current_xact_id()::text
 THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_GEMS_WITNESS_ORIGIN' USING ERRCODE='42501';END IF;
 IF TG_RELID='public.shards_obstacle_gems_posts'::regclass THEN
  IF NOT EXISTS(SELECT 1 FROM public.ledger_transactions t JOIN public.shards_obstacle_obligations h
   ON h.job_id::text=lower(t.metadata->>'jobId') WHERE t.id=NEW.ledger_id AND h.id=NEW.obligation_id
   AND t.type='build.speedup' AND to_jsonb(t)=NEW.original_transaction)
  THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_GEMS_WITNESS_ORIGIN';END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id
   JOIN public.shards_obstacle_gems_posts p ON p.ledger_id=e.txn_id
   WHERE e.id=NEW.entry_id AND p.ledger_id=NEW.ledger_id AND p.tx_key=NEW.tx_key
   AND to_jsonb(e)=NEW.original_entry AND to_jsonb(a)-'balance'=NEW.account_identity)
  THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_GEMS_WITNESS_ORIGIN';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_gems_witness_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE obligation uuid;post_tx text;
BEGIN
 IF TG_RELID NOT IN ('public.ledger_transactions'::regclass,'public.ledger_entries'::regclass)
 OR TG_NAME<>TG_TABLE_NAME||'_shards_obstacle_gems_insert' OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_GEMS_TRIGGER';END IF;
 IF TG_RELID='public.ledger_transactions'::regclass THEN
  IF NEW.type<>'build.speedup' THEN RETURN NULL;END IF;
  SELECT id INTO obligation FROM public.shards_obstacle_obligations WHERE job_id::text=lower(NEW.metadata->>'jobId');
  IF obligation IS NULL THEN RETURN NULL;END IF;
  INSERT INTO public.shards_obstacle_gems_posts(ledger_id,obligation_id,tx_key,original_transaction)
   VALUES(NEW.id,obligation,pg_current_xact_id()::text,to_jsonb(NEW));
 ELSE
  SELECT tx_key INTO post_tx FROM public.shards_obstacle_gems_posts WHERE ledger_id=NEW.txn_id;
  IF post_tx IS NULL THEN RETURN NULL;END IF;
  IF post_tx IS DISTINCT FROM pg_current_xact_id()::text THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_GEMS_WITNESS_ORIGIN';END IF;
  INSERT INTO public.shards_obstacle_gems_entries(entry_id,ledger_id,tx_key,original_entry,account_identity)
   SELECT NEW.id,NEW.txn_id,post_tx,to_jsonb(NEW),to_jsonb(a)-'balance' FROM public.accounts a WHERE a.id=NEW.account_id;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_shards_obstacle_gems_witness_insert() FROM PUBLIC;
--> statement-breakpoint
-- Replays use the same immutable insert evidence without pretending an old
-- transaction is current. This helper authenticates no live parent transition.
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_gems_valid(e public.shards_obstacle_gems_accelerations,same_transaction boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE h public.shards_obstacle_obligations%ROWTYPE;p public.shards_obstacle_gems_posts%ROWTYPE;
 t public.ledger_transactions%ROWTYPE;m jsonb;cap text;
BEGIN
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
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_gems_event_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE h public.shards_obstacle_obligations%ROWTYPE;b public.bases%ROWTYPE;j public.builder_jobs%ROWTYPE;o public.obstacles%ROWTYPE;floor_start timestamptz;
BEGIN
 IF TG_RELID<>'public.shards_obstacle_gems_accelerations'::regclass OR TG_NAME<>'shards_obstacle_gems_accelerations'||(CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_immutable' END) OR TG_WHEN<>'BEFORE'
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_GEMS_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_GEMS_IMMUTABLE';END IF;
 IF session_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
 OR current_user IS DISTINCT FROM session_user THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ISOLATION';END IF;
 SELECT * INTO STRICT h FROM public.shards_obstacle_obligations WHERE id=NEW.obligation_id;
 PERFORM 1 FROM public.players WHERE wallet=h.wallet FOR UPDATE;
 SELECT * INTO STRICT b FROM public.bases WHERE id=h.base_id FOR UPDATE;
 SELECT * INTO STRICT j FROM public.builder_jobs WHERE id=h.job_id FOR UPDATE;
 SELECT * INTO STRICT o FROM public.obstacles WHERE id=h.obstacle_id FOR UPDATE;
 INSERT INTO public.shards_tax_wallet_locks(wallet) VALUES(h.wallet) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM public.shards_tax_wallet_locks WHERE wallet=h.wallet FOR UPDATE;
 IF NOT public.shardkeep_shards_obstacle_gems_valid(NEW,true)
 OR b.owner_wallet IS DISTINCT FROM h.wallet OR b.status<>'active' OR b.deed_asset_id IS DISTINCT FROM h.deed_asset_id
 OR j.kind<>'clear_obstacle' OR j.completed_at IS NOT NULL OR j.cancelled_at IS NOT NULL
 OR ROW(j.base_id,j.obstacle_id,j.started_at,j.finishes_at) IS DISTINCT FROM ROW(h.base_id,h.obstacle_id,h.started_at,h.scheduled_finish_at)
 OR o.base_id IS DISTINCT FROM h.base_id OR o.cleared_at IS NOT NULL THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_GEMS_EVIDENCE';END IF;
 SELECT (s.snapshot->>'startsAt')::timestamptz INTO floor_start FROM public.shards_tax_all_assessments a
 JOIN public.expedition_term_snapshots s ON s.term_id=a.term_id AND s.snapshot_hash=a.term_hash
 WHERE a.wallet=h.wallet AND a.lineage='d150-resource-tax-v1' ORDER BY a.wallet_sequence DESC LIMIT 1;
 IF NEW.after_finish_at<floor_start THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ORDER_HELD';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_gems_commit_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.shards_obstacle_gems_accelerations%ROWTYPE;
BEGIN
 IF TG_RELID NOT IN ('public.shards_obstacle_gems_posts'::regclass,'public.shards_obstacle_gems_entries'::regclass,'public.shards_obstacle_gems_accelerations'::regclass)
 OR TG_NAME<>TG_TABLE_NAME||'_commit' OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_GEMS_TRIGGER';END IF;
 SELECT * INTO e FROM public.shards_obstacle_gems_accelerations WHERE ledger_id=NEW.ledger_id;
 IF e.obligation_id IS NULL OR NOT public.shardkeep_shards_obstacle_gems_valid(e,true) OR NOT EXISTS(
  SELECT 1 FROM public.shards_obstacle_obligations h JOIN public.builder_jobs j ON j.id=h.job_id
  JOIN public.bases b ON b.id=h.base_id JOIN public.obstacles o ON o.id=h.obstacle_id
  WHERE h.id=e.obligation_id AND j.kind='clear_obstacle' AND j.completed_at IS NULL AND j.cancelled_at IS NULL
  AND ROW(j.base_id,j.obstacle_id,j.started_at,j.finishes_at)=ROW(h.base_id,h.obstacle_id,h.started_at,e.after_finish_at)
  AND b.owner_wallet=h.wallet AND b.status='active' AND b.deed_asset_id IS NOT DISTINCT FROM h.deed_asset_id
  AND o.base_id=h.base_id AND o.cleared_at IS NULL)
 THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_GEMS_EVIDENCE';END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_pending(actor_wallet text,term_start timestamptz) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.shards_obstacle_obligations h
 LEFT JOIN public.builder_jobs j ON j.id=h.job_id LEFT JOIN public.bases b ON b.id=h.base_id LEFT JOIN public.obstacles o ON o.id=h.obstacle_id
 LEFT JOIN public.shards_obstacle_gems_accelerations e ON e.obligation_id=h.id
 WHERE (h.wallet=actor_wallet OR b.owner_wallet=actor_wallet) AND
 (j.id IS NULL OR b.id IS NULL OR o.id IS NULL OR j.kind<>'clear_obstacle'
 OR ROW(j.base_id,j.obstacle_id,j.started_at,j.finishes_at) IS DISTINCT FROM ROW(h.base_id,h.obstacle_id,h.started_at,coalesce(e.after_finish_at,h.scheduled_finish_at))
 OR (e.obligation_id IS NOT NULL AND NOT public.shardkeep_shards_obstacle_gems_valid(e,false))
 OR j.completed_at IS NOT NULL OR j.cancelled_at IS NOT NULL OR o.base_id IS DISTINCT FROM h.base_id OR o.cleared_at IS NOT NULL
 OR b.owner_wallet IS DISTINCT FROM h.wallet OR b.status<>'active' OR b.deed_asset_id IS DISTINCT FROM h.deed_asset_id
 OR coalesce(e.after_finish_at,h.scheduled_finish_at)<term_start))
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_commit_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID<>'public.shards_obstacle_obligations'::regclass OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_TRIGGER';END IF;
 IF EXISTS(SELECT 1 FROM public.shards_obstacle_obligations h
 LEFT JOIN public.builder_jobs j ON j.id=h.job_id LEFT JOIN public.bases b ON b.id=h.base_id LEFT JOIN public.obstacles o ON o.id=h.obstacle_id
 LEFT JOIN public.shards_obstacle_gems_accelerations e ON e.obligation_id=h.id
 WHERE h.id=NEW.id AND (j.id IS NULL OR b.id IS NULL OR o.id IS NULL OR j.kind<>'clear_obstacle'
 OR ROW(j.base_id,j.obstacle_id,j.started_at,j.finishes_at) IS DISTINCT FROM ROW(h.base_id,h.obstacle_id,h.started_at,coalesce(e.after_finish_at,h.scheduled_finish_at))
 OR (e.obligation_id IS NOT NULL AND NOT public.shardkeep_shards_obstacle_gems_valid(e,false))
 OR j.completed_at IS NOT NULL OR j.cancelled_at IS NOT NULL OR o.base_id IS DISTINCT FROM h.base_id OR o.cleared_at IS NOT NULL
 OR b.owner_wallet IS DISTINCT FROM h.wallet OR b.status<>'active' OR b.deed_asset_id IS DISTINCT FROM h.deed_asset_id))
 THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_CAPTURE_MISMATCH';END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_transition_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
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
   SELECT 1 FROM public.shards_obstacle_obligations h JOIN public.shards_obstacle_gems_accelerations e ON e.obligation_id=h.id
   WHERE h.job_id=OLD.id AND OLD.finishes_at=h.scheduled_finish_at AND NEW.finishes_at=e.after_finish_at
   AND public.shardkeep_shards_obstacle_gems_valid(e,true)) THEN RETURN NEW;END IF;
 ELSIF TG_RELID='public.bases'::regclass THEN SELECT EXISTS(SELECT 1 FROM public.shards_obstacle_obligations WHERE base_id=OLD.id) INTO enrolled;
 ELSE SELECT EXISTS(SELECT 1 FROM public.shards_obstacle_obligations WHERE obstacle_id=OLD.id) INTO enrolled;END IF;
 IF enrolled THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_TRANSITION_HELD';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_shards_obstacle_transition_guard() FROM PUBLIC;
--> statement-breakpoint
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['shards_obstacle_gems_posts','shards_obstacle_gems_entries','shards_obstacle_gems_accelerations'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname=t||'_immutable') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.%I()',t||'_immutable',t,CASE WHEN t='shards_obstacle_gems_accelerations' THEN 'shardkeep_shards_obstacle_gems_event_guard' ELSE 'shardkeep_shards_obstacle_gems_witness_guard' END);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname=t||'_no_truncate') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.%I()',t||'_no_truncate',t,CASE WHEN t='shards_obstacle_gems_accelerations' THEN 'shardkeep_shards_obstacle_gems_event_guard' ELSE 'shardkeep_shards_obstacle_gems_witness_guard' END);
  END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['ledger_transactions','ledger_entries'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname=t||'_shards_obstacle_gems_insert') THEN EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_shards_obstacle_gems_witness_insert()',t||'_shards_obstacle_gems_insert',t);END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['shards_obstacle_gems_posts','shards_obstacle_gems_entries','shards_obstacle_gems_accelerations'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname=t||'_commit') THEN EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_shards_obstacle_gems_commit_guard()',t||'_commit',t);END IF;
 END LOOP;
END $$;
