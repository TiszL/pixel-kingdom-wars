-- Prospective cache source evidence; no money rewrite, reclassification or backfill.
-- Frozen SQL arithmetic bounds match PHASE_E_HARVESTER.v1 taxBasisPoints /
-- islandPoolBps and d150-resource-tax-v1; they are not independent game tuning.
-- Existing assessment insert guards and payout function changes remain held
-- under the Phase E S5 migration/release gate.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS shards_cache_sources (
 operation_key text PRIMARY KEY,base_id uuid NOT NULL REFERENCES bases(id),wallet text NOT NULL REFERENCES players(wallet),
 earned_at timestamptz NOT NULL CHECK(isfinite(earned_at)),day text NOT NULL CHECK(day~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
 streak_days integer NOT NULL CHECK(streak_days>0),ever_completed_week1_before boolean NOT NULL,
 gross bigint NOT NULL CHECK(gross>0),term_id uuid NOT NULL,term_hash text NOT NULL,observation jsonb NOT NULL,
 ledger_id uuid NOT NULL UNIQUE REFERENCES ledger_transactions(id),UNIQUE(base_id,day),
 CHECK(day=to_char(earned_at AT TIME ZONE 'UTC','YYYY-MM-DD')),
 CHECK(operation_key='cache.claim:'||base_id::text||':'||day),
 FOREIGN KEY(term_id,term_hash) REFERENCES expedition_term_snapshots(term_id,snapshot_hash)
);
CREATE INDEX IF NOT EXISTS shards_cache_source_term_idx ON shards_cache_sources(term_id,operation_key);
CREATE INDEX IF NOT EXISTS shards_cache_source_wallet_idx ON shards_cache_sources(wallet,earned_at);
CREATE TABLE IF NOT EXISTS shards_cache_assessments (
 operation_key text PRIMARY KEY REFERENCES shards_cache_sources(operation_key),wallet text NOT NULL REFERENCES players(wallet),
 wallet_sequence bigint NOT NULL CHECK(wallet_sequence>0),lineage text NOT NULL,
 gross bigint NOT NULL CHECK(gross>0),net bigint NOT NULL CHECK(net>=0),tax bigint NOT NULL CHECK(tax>=0),
 carry_before bigint NOT NULL CHECK(carry_before>=0),carry_after bigint NOT NULL CHECK(carry_after>=0),
 term_id uuid NOT NULL,term_hash text NOT NULL,ledger_id uuid NOT NULL REFERENCES ledger_transactions(id),receipt jsonb NOT NULL,
 UNIQUE(wallet,lineage,wallet_sequence),CHECK(net::numeric+tax=gross),
 FOREIGN KEY(term_id,term_hash) REFERENCES expedition_term_snapshots(term_id,snapshot_hash)
);
CREATE INDEX IF NOT EXISTS shards_cache_assessment_term_idx ON shards_cache_assessments(term_id,wallet,wallet_sequence);
CREATE OR REPLACE VIEW shards_tax_all_assessments WITH (security_invoker=true) AS
 SELECT operation_key,segment_id::text AS segment_id,wallet,wallet_sequence,lineage,gross,net,tax,carry_before,carry_after,
 term_id,term_hash,ledger_id,receipt,'physical_mine'::text AS source_kind FROM shards_tax_assessments
 UNION ALL
 SELECT operation_key,operation_key AS segment_id,wallet,wallet_sequence,lineage,gross,net,tax,carry_before,carry_after,
 term_id,term_hash,ledger_id,receipt,'daily_cache'::text AS source_kind FROM shards_cache_assessments;
-- PUBLIC may name/read this view only when the invoker can SELECT both source
-- tables. No source-table, account or view-write privilege is conferred.
GRANT SELECT ON shards_tax_all_assessments TO PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_shards_cache_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'SHARDS_CACHE_HISTORY_IMMUTABLE';END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_shards_cache_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE term public.expedition_term_snapshots%ROWTYPE;posting public.ledger_transactions%ROWTYPE;
BEGIN
 IF TG_RELID<>'public.shards_cache_sources'::regclass OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'SHARDS_CACHE_TRIGGER';END IF;
 SELECT * INTO STRICT term FROM public.expedition_term_snapshots WHERE term_id=NEW.term_id AND snapshot_hash=NEW.term_hash;
 IF NEW.observation->'snapshot' IS DISTINCT FROM term.snapshot
 OR NEW.earned_at<(term.snapshot->>'startsAt')::timestamptz OR NEW.earned_at>=(term.snapshot->>'endsAt')::timestamptz
 THEN RAISE EXCEPTION 'SHARDS_CACHE_SOURCE_TERM';END IF;
 SELECT * INTO STRICT posting FROM public.ledger_transactions WHERE id=NEW.ledger_id;
 IF posting.idempotency_key<>NEW.operation_key OR posting.type<>'cache.claim'
 OR posting.metadata->>'baseId' IS DISTINCT FROM NEW.base_id::text
 OR posting.metadata->>'day' IS DISTINCT FROM NEW.day
 OR posting.metadata->>'streakDays' IS DISTINCT FROM NEW.streak_days::text
 THEN RAISE EXCEPTION 'SHARDS_CACHE_SOURCE_LEDGER';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_shards_assessment_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source public.shards_cache_sources%ROWTYPE;mine record;entry_count bigint;good_count bigint;expected_count bigint;delta_total numeric;
BEGIN
 IF TG_RELID NOT IN ('public.shards_tax_assessments'::regclass,'public.shards_cache_assessments'::regclass)
 OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'SHARDS_TAX_TRIGGER';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'SHARDS_TAX_ISOLATION';END IF;
 -- Service writers already take this mutex before custody/ledger locks. Direct
 -- inserts must still serialize across both assessment relations.
 INSERT INTO public.shards_tax_wallet_locks(wallet) VALUES(NEW.wallet) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM public.shards_tax_wallet_locks WHERE wallet=NEW.wallet FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.shards_tax_all_assessments WHERE wallet=NEW.wallet AND lineage=NEW.lineage AND wallet_sequence=NEW.wallet_sequence)
 THEN RAISE EXCEPTION 'SHARDS_TAX_SEQUENCE_DUPLICATE';END IF;
 IF NEW.lineage<>'d150-resource-tax-v1' OR NEW.carry_before>=10000 OR NEW.carry_after>=10000
 OR NEW.tax::numeric<>div(NEW.gross::numeric*2000+NEW.carry_before,10000)
 OR NEW.carry_after::numeric<>mod(NEW.gross::numeric*2000+NEW.carry_before,10000)
 THEN RAISE EXCEPTION 'SHARDS_TAX_ARITHMETIC';END IF;
 IF TG_RELID='public.shards_cache_assessments'::regclass THEN
  SELECT * INTO STRICT source FROM public.shards_cache_sources WHERE operation_key=NEW.operation_key;
  IF ROW(NEW.wallet,NEW.gross,NEW.term_id,NEW.term_hash,NEW.ledger_id)
  IS DISTINCT FROM ROW(source.wallet,source.gross,source.term_id,source.term_hash,source.ledger_id)
  OR NEW.receipt#>>'{source,kind}' IS DISTINCT FROM 'daily_cache'
  OR NEW.receipt#>>'{source,key}' IS DISTINCT FROM NEW.operation_key
  OR NEW.receipt#>>'{source,baseId}' IS DISTINCT FROM source.base_id::text
  OR NEW.receipt#>'{source,earning}' IS DISTINCT FROM jsonb_build_object('kind','instant','at',to_char(source.earned_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  OR NEW.receipt->'term' IS DISTINCT FROM source.observation THEN RAISE EXCEPTION 'SHARDS_CACHE_ASSESSMENT_SOURCE';END IF;
  expected_count:=1+(CASE WHEN NEW.net>0 THEN 1 ELSE 0 END)+(CASE WHEN NEW.tax>0 THEN 1 ELSE 0 END);
  SELECT count(*),count(*) FILTER(WHERE a.currency='SHARDS' AND a.owner_wallet IS NULL AND
   ((a.kind='shard_genesis' AND a.base_id IS NULL AND e.delta=-NEW.gross)
   OR (a.kind='base_shards' AND a.base_id=source.base_id AND NEW.net>0 AND e.delta=NEW.net)
   OR (a.kind='shards_tax_escrow' AND a.base_id IS NULL AND NEW.tax>0 AND e.delta=NEW.tax))),sum(e.delta::numeric)
  INTO entry_count,good_count,delta_total FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id WHERE e.txn_id=NEW.ledger_id;
  IF entry_count<>expected_count OR good_count<>expected_count OR delta_total IS DISTINCT FROM 0::numeric
  THEN RAISE EXCEPTION 'SHARDS_CACHE_ASSESSMENT_LEDGER';END IF;
 ELSE
  SELECT s.wallet,s.base_id,s.source_key,s.ownership_status,m.wallet AS admitted_wallet,m.term_id,m.term_hash,
   d.gross,d.net,d.tax,d.ledger_id INTO STRICT mine FROM public.shards_mine_segments s
   JOIN public.shards_mine_admissions m ON m.id=s.admission_id
   JOIN public.shards_mine_deliveries d ON d.segment_id=s.id AND d.operation_key=NEW.operation_key WHERE s.id=NEW.segment_id;
  IF mine.ownership_status<>'confirmed' OR mine.wallet IS DISTINCT FROM mine.admitted_wallet
  OR ROW(NEW.wallet,NEW.gross,NEW.net,NEW.tax,NEW.term_id,NEW.term_hash,NEW.ledger_id)
  IS DISTINCT FROM ROW(mine.wallet,mine.gross,mine.net,mine.tax,mine.term_id,mine.term_hash,mine.ledger_id)
  OR NEW.receipt#>>'{source,kind}' IS DISTINCT FROM 'physical_mine'
  OR NEW.receipt#>>'{source,key}' IS DISTINCT FROM mine.source_key||':'||NEW.operation_key
  OR NEW.receipt#>>'{source,baseId}' IS DISTINCT FROM mine.base_id::text THEN RAISE EXCEPTION 'SHARDS_MINE_ASSESSMENT_SOURCE';END IF;
 END IF;
 IF NEW.receipt#>>'{source,wallet}' IS DISTINCT FROM NEW.wallet OR NEW.receipt#>>'{source,gross}' IS DISTINCT FROM NEW.gross::text
 OR NEW.receipt#>>'{source,ledger,transactionId}' IS DISTINCT FROM NEW.ledger_id::text
 OR NEW.receipt#>>'{source,ledger,idempotencyKey}' IS DISTINCT FROM NEW.operation_key
 OR NEW.receipt#>>'{carryBefore,sequence}' IS DISTINCT FROM (NEW.wallet_sequence-1)::text
 OR NEW.receipt#>>'{carryAfter,sequence}' IS DISTINCT FROM NEW.wallet_sequence::text
 OR NEW.receipt#>>'{carryBefore,value}' IS DISTINCT FROM NEW.carry_before::text
 OR NEW.receipt#>>'{carryAfter,value}' IS DISTINCT FROM NEW.carry_after::text
 OR NEW.receipt->>'net' IS DISTINCT FROM NEW.net::text OR NEW.receipt->>'tax' IS DISTINCT FROM NEW.tax::text
 OR NEW.receipt->>'termHash' IS DISTINCT FROM NEW.term_hash
 OR NEW.receipt#>>'{pool,termId}' IS DISTINCT FROM NEW.term_id::text
 THEN RAISE EXCEPTION 'SHARDS_TAX_ASSESSMENT_RECEIPT';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_shards_assessment_prefix_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE prior public.shards_tax_all_assessments%ROWTYPE;following public.shards_tax_all_assessments%ROWTYPE;
 current_term jsonb;prior_term jsonb;following_term jsonb;
BEGIN
 IF TG_RELID NOT IN ('public.shards_tax_assessments'::regclass,'public.shards_cache_assessments'::regclass)
 OR TG_OP<>'INSERT' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'SHARDS_TAX_PREFIX_TRIGGER';END IF;
 -- Mine planning orders all original source parts, while posting groups parts
 -- by physical Mine. Check adjacent immutable rows only after the transaction
 -- has inserted every part; valid sequence 2-before-1 must remain admissible.
 SELECT * INTO prior FROM public.shards_tax_all_assessments WHERE wallet=NEW.wallet AND lineage=NEW.lineage AND wallet_sequence=NEW.wallet_sequence-1;
 SELECT * INTO following FROM public.shards_tax_all_assessments WHERE wallet=NEW.wallet AND lineage=NEW.lineage AND wallet_sequence=CASE WHEN NEW.wallet_sequence<9223372036854775807 THEN NEW.wallet_sequence+1 ELSE NULL END;
 IF (NEW.wallet_sequence=1 AND NEW.carry_before<>0)
 OR (NEW.wallet_sequence>1 AND (prior.wallet IS NULL OR prior.carry_after<>NEW.carry_before))
 OR (following.wallet IS NOT NULL AND following.carry_before<>NEW.carry_after)
 THEN RAISE EXCEPTION 'SHARDS_TAX_CARRY_ORDER';END IF;
 SELECT snapshot INTO STRICT current_term FROM public.expedition_term_snapshots WHERE term_id=NEW.term_id AND snapshot_hash=NEW.term_hash;
 IF prior.wallet IS NOT NULL THEN
  SELECT snapshot INTO STRICT prior_term FROM public.expedition_term_snapshots WHERE term_id=prior.term_id AND snapshot_hash=prior.term_hash;
  IF (prior.term_id=NEW.term_id AND prior.term_hash<>NEW.term_hash)
  OR (prior.term_id<>NEW.term_id AND (prior_term->>'endsAt')::timestamptz>(current_term->>'startsAt')::timestamptz)
  THEN RAISE EXCEPTION 'SHARDS_TAX_TERM_ORDER';END IF;
 END IF;
 IF following.wallet IS NOT NULL THEN
  SELECT snapshot INTO STRICT following_term FROM public.expedition_term_snapshots WHERE term_id=following.term_id AND snapshot_hash=following.term_hash;
  IF (following.term_id=NEW.term_id AND following.term_hash<>NEW.term_hash)
  OR (following.term_id<>NEW.term_id AND (current_term->>'endsAt')::timestamptz>(following_term->>'startsAt')::timestamptz)
  THEN RAISE EXCEPTION 'SHARDS_TAX_TERM_ORDER';END IF;
 END IF;
 RETURN NULL;
END $$;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['shards_cache_sources','shards_cache_assessments'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname=t||'_immutable') THEN EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_shards_cache_immutable()',t||'_immutable',t);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname=t||'_no_truncate') THEN EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_shards_cache_immutable()',t||'_no_truncate',t);END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.shards_cache_sources'::regclass AND tgname='shards_cache_source_guard') THEN CREATE TRIGGER shards_cache_source_guard BEFORE INSERT ON shards_cache_sources FOR EACH ROW EXECUTE FUNCTION public.shardkeep_shards_cache_source_guard();END IF;
 FOREACH t IN ARRAY ARRAY['shards_tax_assessments','shards_cache_assessments'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname=t||'_insert_guard') THEN EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_shards_assessment_insert_guard()',t||'_insert_guard',t);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname=t||'_prefix_guard') THEN EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_shards_assessment_prefix_guard()',t||'_prefix_guard',t);END IF;
 END LOOP;
END $$;

--> statement-breakpoint
-- Preserve every existing payout check; include both admitted earning sources.
CREATE OR REPLACE FUNCTION public.shardkeep_seeker_shards_claim_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE term public.expedition_term_snapshots%ROWTYPE;dest public.bases%ROWTYPE;
 prior public.seeker_shards_claims%ROWTYPE;posting public.ledger_transactions%ROWTYPE;
 total numeric;paid numeric;winners integer;recipient text;source_count bigint;entry_count bigint;good_count bigint;escrow_count bigint;delta_total numeric;after_balance bigint;
BEGIN
 IF TG_RELID<>'public.seeker_shards_claims'::regclass OR TG_WHEN<>'BEFORE'
 OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'seeker_shards_claim_no_truncate' ELSE 'seeker_shards_claim_guard' END)
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'SEEKER_SHARDS_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SEEKER_SHARDS_IMMUTABLE';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'SEEKER_SHARDS_ISOLATION';END IF;
 IF NEW.term_hash IS NOT NULL OR NEW.winner_count IS NOT NULL OR NEW.pool_total IS NOT NULL OR NEW.previous_id IS NOT NULL
 OR NEW.previous_total IS NOT NULL OR NEW.cumulative_total IS NOT NULL OR NEW.quantity IS NOT NULL
 OR NEW.balance_before IS NOT NULL OR NEW.balance_after IS NOT NULL OR NEW.claimed_at IS NOT NULL THEN RAISE EXCEPTION 'SEEKER_SHARDS_DERIVED';END IF;
 -- Same canonical custody order as the app; the pool mutex follows base/slot.
 PERFORM 1 FROM public.players WHERE wallet=NEW.wallet FOR UPDATE;
 SELECT * INTO STRICT dest FROM public.bases WHERE id=NEW.base_id AND owner_wallet=NEW.wallet AND status='active' FOR UPDATE;
 PERFORM 1 FROM public.base_slots WHERE base_id=dest.id AND wallet=NEW.wallet AND active FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.base_raid_locks WHERE base_id=dest.id) THEN RAISE EXCEPTION 'SEEKER_SHARDS_DESTINATION';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('seeker-shards:'||NEW.term_id::text,0));
 SELECT * INTO STRICT term FROM public.expedition_term_snapshots WHERE term_id=NEW.term_id;
 SELECT count(*),max(CASE WHEN (s->>'spotId')::integer=NEW.spot_id THEN s->>'ownerWallet' END)
 INTO winners,recipient FROM jsonb_array_elements(term.snapshot->'spots') s WHERE s->>'ownerWallet' IS NOT NULL;
 IF winners<1 OR recipient IS DISTINCT FROM NEW.wallet THEN RAISE EXCEPTION 'SEEKER_SHARDS_NOT_OWNER';END IF;
 -- The service first validates the full original source/ledger history. Since
 -- these rows are immutable, only appends can race that validation; require the
 -- exact validated total here so a changed source rolls the whole posting back.
 SELECT COALESCE(sum(tax::numeric),0),count(*) INTO total,source_count FROM public.shards_tax_all_assessments WHERE term_id=NEW.term_id AND term_hash=term.snapshot_hash;
 IF source_count<1 OR total<0 OR total>9223372036854775807 OR total IS DISTINCT FROM NEW.expected_pool::numeric THEN RAISE EXCEPTION 'SEEKER_SHARDS_SOURCE_CHANGED';END IF;
 SELECT * INTO prior FROM public.seeker_shards_claims WHERE term_id=NEW.term_id AND spot_id=NEW.spot_id ORDER BY cumulative_total DESC LIMIT 1;
 NEW.previous_id:=prior.id;NEW.previous_total:=COALESCE(prior.cumulative_total,0);
 IF NEW.previous_total<>NEW.expected_previous THEN RAISE EXCEPTION 'SEEKER_SHARDS_CURSOR_CHANGED';END IF;
 NEW.term_hash:=term.snapshot_hash;NEW.winner_count:=winners;NEW.pool_total:=total;
 NEW.cumulative_total:=div(total,winners);NEW.quantity:=NEW.cumulative_total-NEW.previous_total;
 IF NEW.quantity<=0 THEN RAISE EXCEPTION 'SEEKER_SHARDS_NOTHING_DUE';END IF;
 SELECT COALESCE(sum(quantity::numeric),0) INTO paid FROM public.seeker_shards_claims WHERE term_id=NEW.term_id;
 IF paid+NEW.quantity>total THEN RAISE EXCEPTION 'SEEKER_SHARDS_POOL_UNDERFLOW';END IF;
 SELECT * INTO STRICT posting FROM public.ledger_transactions WHERE id=NEW.ledger_id;
 IF posting.type<>'seeker.shards.claim' OR posting.idempotency_key<>'seeker.shards.claim:'||NEW.id::text
 OR posting.metadata IS DISTINCT FROM jsonb_build_object('wallet',NEW.wallet,'baseId',NEW.base_id::text,'termId',NEW.term_id::text,'spotId',NEW.spot_id)
 THEN RAISE EXCEPTION 'SEEKER_SHARDS_LEDGER';END IF;
 SELECT count(*),count(*) FILTER(WHERE a.currency='SHARDS' AND a.owner_wallet IS NULL AND
 ((a.kind='shards_tax_escrow' AND a.base_id IS NULL AND e.delta=-NEW.quantity) OR
 (a.kind='base_shards' AND a.base_id=NEW.base_id AND e.delta=NEW.quantity))),
 count(*) FILTER(WHERE a.kind='shards_tax_escrow'),sum(e.delta::numeric),
 max(e.balance_after) FILTER(WHERE a.kind='base_shards' AND a.base_id=NEW.base_id)
 INTO entry_count,good_count,escrow_count,delta_total,after_balance FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id WHERE e.txn_id=NEW.ledger_id;
 IF entry_count<>2 OR good_count<>2 OR escrow_count<>1 OR delta_total<>0 OR after_balance IS NULL OR after_balance<NEW.quantity THEN RAISE EXCEPTION 'SEEKER_SHARDS_LEDGER';END IF;
 NEW.balance_after:=after_balance;NEW.balance_before:=after_balance-NEW.quantity;NEW.claimed_at:=posting.created_at;
 RETURN NEW;
END $$;
