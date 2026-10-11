-- Prospective all-origin evidence only. No money backfill or default capture.
CREATE TABLE IF NOT EXISTS mining_free_gems_coverage(id boolean PRIMARY KEY CHECK(id),started_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS mining_free_gems_origins(
 id bigserial PRIMARY KEY,ledger_entry_id bigint NOT NULL,origin_hash text NOT NULL,wallet text NOT NULL,
 observed_at timestamptz NOT NULL,operation text NOT NULL,source jsonb NOT NULL,receipt jsonb NOT NULL,
 UNIQUE(ledger_entry_id,origin_hash)
);
CREATE INDEX IF NOT EXISTS mining_free_gems_origins_wallet_clock ON mining_free_gems_origins(wallet,observed_at,id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_free_gems_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP<>'INSERT' OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN
  RAISE EXCEPTION 'MINING_FREE_GEMS_IMMUTABLE'; END IF;
 IF TG_RELID='public.mining_free_gems_coverage'::regclass THEN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_FREE_GEMS_READ_COMMITTED_REQUIRED'; END IF;
  LOCK TABLE public.players,public.ledger_entries,public.accounts,public.ledger_transactions IN ACCESS EXCLUSIVE MODE NOWAIT;
  LOCK TABLE public.mining_free_coverage,public.mining_free_cohort_events IN SHARE MODE NOWAIT;
  IF NOT EXISTS(SELECT 1 FROM public.mining_free_coverage WHERE id)
   OR (SELECT count(*) FROM pg_trigger WHERE tgenabled IN ('O','A') AND
    (tgrelid='public.players'::regclass AND tgname='players_mining_free_capture'
    OR tgrelid='public.ledger_entries'::regclass AND tgname='ledger_entries_mining_free_capture'
    OR tgrelid='public.accounts'::regclass AND tgname='accounts_mining_free_attribution'
    OR tgrelid='public.ledger_transactions'::regclass AND tgname='ledger_transactions_mining_free_attribution'))<>4
   THEN RAISE EXCEPTION 'MINING_FREE_GEMS_COHORT_COVERAGE_REQUIRED'; END IF;
  NEW.started_at:=public.shardkeep_mining_free_clock();
  IF NEW.started_at<(SELECT started_at FROM public.mining_free_coverage WHERE id) THEN RAISE EXCEPTION 'MINING_FREE_GEMS_CLOCK_INVALID'; END IF;
  ALTER TABLE public.ledger_entries ENABLE TRIGGER ledger_entries_mining_free_gems_capture;
  RETURN NEW;
 END IF;
 IF TG_RELID<>'public.mining_free_gems_origins'::regclass OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'MINING_FREE_GEMS_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_capture_mining_free_gems() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE entry jsonb; a public.accounts%ROWTYPE; t public.ledger_transactions%ROWTYPE;
 src jsonb; receipt jsonb; observed timestamptz; boundary timestamptz;
BEGIN
 IF TG_RELID<>'public.ledger_entries'::regclass OR TG_NAME<>'ledger_entries_mining_free_gems_capture'
  OR TG_LEVEL<>'ROW' OR TG_WHEN<>'AFTER' OR TG_OP NOT IN ('INSERT','UPDATE','DELETE') THEN
  RAISE EXCEPTION 'MINING_FREE_GEMS_SOURCE_INVALID'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_FREE_GEMS_READ_COMMITTED_REQUIRED'; END IF;
 SELECT started_at INTO STRICT boundary FROM public.mining_free_gems_coverage WHERE id;
 LOCK TABLE public.mining_free_gems_origins IN ROW EXCLUSIVE MODE;
 observed:=public.shardkeep_mining_free_clock();
 IF observed<boundary THEN RAISE EXCEPTION 'MINING_FREE_GEMS_CLOCK_INVALID'; END IF;
 -- OLD first preserves a positive origin even if the same statement destroys
 -- or replaces it. Repeated observations cannot overwrite its first receipt.
 FOR entry IN SELECT v FROM unnest(ARRAY[CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,
  CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END]) v WHERE v IS NOT NULL LOOP
  IF (entry->>'delta')::bigint<=0 THEN CONTINUE; END IF;
  SELECT * INTO STRICT a FROM public.accounts WHERE id=(entry->>'account_id')::uuid FOR SHARE NOWAIT;
  IF a.kind<>'player_gems' THEN CONTINUE; END IF;
  SELECT * INTO STRICT t FROM public.ledger_transactions WHERE id=(entry->>'txn_id')::uuid FOR SHARE NOWAIT;
  src:=jsonb_build_object('entry',jsonb_build_object('id',entry->>'id','txnId',entry->>'txn_id','accountId',entry->>'account_id','delta',entry->>'delta'),
   'account',jsonb_build_object('id',a.id,'kind',a.kind,'currency',a.currency,'wallet',a.owner_wallet,'baseId',a.base_id),
   'transaction',jsonb_build_object('id',t.id,'key',t.idempotency_key,'type',t.type,'metadata',t.metadata,
    'createdAt',to_char(t.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
  -- postTransaction writes all legs in one INSERT; AFTER ROW sees that whole
  -- statement. Limit before JSON aggregation; >4 entries will refuse grants.
  SELECT coalesce(jsonb_agg(r ORDER BY r->>'id'),'[]') INTO receipt FROM (
   SELECT jsonb_build_object('id',e.id::text,'accountId',e.account_id,'delta',e.delta::text,
    'kind',ac.kind,'currency',ac.currency,'wallet',ac.owner_wallet,'baseId',ac.base_id) r
   FROM public.ledger_entries e JOIN public.accounts ac ON ac.id=e.account_id
   WHERE e.txn_id=t.id ORDER BY e.id LIMIT 5
  ) bounded;
  INSERT INTO public.mining_free_gems_origins(ledger_entry_id,origin_hash,wallet,observed_at,operation,source,receipt)
   VALUES((entry->>'id')::bigint,encode(sha256(convert_to(src::text,'UTF8')),'hex'),a.owner_wallet,observed,TG_OP,src,receipt)
   ON CONFLICT(ledger_entry_id,origin_hash) DO NOTHING;
 END LOOP;
 RETURN coalesce(NEW,OLD);
END $$;
--> statement-breakpoint
DO $migration$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['mining_free_gems_coverage','mining_free_gems_origins'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_immutable') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_free_gems_guard()',t||'_immutable',t);
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_free_gems_guard()',t||'_no_truncate',t);
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.ledger_entries'::regclass AND tgname='ledger_entries_mining_free_gems_capture') THEN
  CREATE TRIGGER ledger_entries_mining_free_gems_capture AFTER INSERT OR UPDATE OR DELETE ON public.ledger_entries FOR EACH ROW EXECUTE FUNCTION public.shardkeep_capture_mining_free_gems();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.mining_free_gems_coverage) THEN ALTER TABLE public.ledger_entries DISABLE TRIGGER ledger_entries_mining_free_gems_capture; END IF;
END $migration$;
REVOKE ALL ON mining_free_gems_coverage,mining_free_gems_origins FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_mining_free_gems_guard(),public.shardkeep_capture_mining_free_gems() FROM PUBLIC;

--> statement-breakpoint
-- Additive hardening of the reused 0161 birth authority; its prior body is unchanged.
CREATE OR REPLACE FUNCTION public.shardkeep_capture_mining_free() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n jsonb; o jsonb; wallets text[]; w text; observed timestamptz; ref text;
BEGIN
 -- Bind this definer to its original public-table trigger sites. Names alone
 -- would let a runtime-owned temporary table forge prospective birth evidence.
 IF NOT (
   TG_RELID='public.players'::regclass AND TG_TABLE_NAME='players'
   OR TG_RELID='public.bases'::regclass AND TG_TABLE_NAME='bases'
   OR TG_RELID='public.base_slots'::regclass AND TG_TABLE_NAME='base_slots'
   OR TG_RELID='public.seeker_links'::regclass AND TG_TABLE_NAME='seeker_links'
   OR TG_RELID='public.ledger_entries'::regclass AND TG_TABLE_NAME='ledger_entries')
  OR (TG_OP='TRUNCATE' AND (TG_NAME<>TG_TABLE_NAME||'_mining_free_truncate' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'STATEMENT'))
  OR (TG_OP<>'TRUNCATE' AND (TG_OP NOT IN ('INSERT','UPDATE','DELETE') OR TG_NAME<>TG_TABLE_NAME||'_mining_free_capture' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW'))
  THEN RAISE EXCEPTION 'MINING_FREE_SOURCE_INVALID'; END IF;
 -- Enabled atomically with coverage. Reject a stale snapshot BEFORE reading it.
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_FREE_READ_COMMITTED_REQUIRED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.mining_free_coverage WHERE id) THEN
  IF TG_OP='TRUNCATE' THEN RETURN NULL; ELSIF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 IF TG_OP='TRUNCATE' THEN
  IF TG_TABLE_NAME='players' THEN RAISE EXCEPTION 'MINING_FREE_BIRTH_RETAINED'; END IF;
  SELECT array_agg(wallet) INTO wallets FROM public.mining_free_cohorts;
  ref:='truncate';
 ELSE
  IF TG_OP<>'DELETE' THEN n:=to_jsonb(NEW); END IF;
  IF TG_OP<>'INSERT' THEN o:=to_jsonb(OLD); END IF;
  IF TG_TABLE_NAME='players' THEN
   SELECT jsonb_object_agg(key,value) INTO n FROM jsonb_each(n) WHERE key=ANY(ARRAY['wallet','created_at']);
   SELECT jsonb_object_agg(key,value) INTO o FROM jsonb_each(o) WHERE key=ANY(ARRAY['wallet','created_at']);
   IF TG_OP='UPDATE' AND n IS NOT DISTINCT FROM o THEN RETURN NEW; END IF;
   wallets:=ARRAY[n->>'wallet',o->>'wallet']; ref:=coalesce(n->>'wallet',o->>'wallet');
  ELSIF TG_TABLE_NAME='bases' THEN
   SELECT jsonb_object_agg(key,value) INTO n FROM jsonb_each(n) WHERE key=ANY(ARRAY['id','owner_wallet','status','land_paid_at','deed_asset_id','deed_mint_asset_id','deed_minting_at']);
   SELECT jsonb_object_agg(key,value) INTO o FROM jsonb_each(o) WHERE key=ANY(ARRAY['id','owner_wallet','status','land_paid_at','deed_asset_id','deed_mint_asset_id','deed_minting_at']);
   IF TG_OP='UPDATE' AND n IS NOT DISTINCT FROM o THEN RETURN NEW; END IF;
   wallets:=ARRAY[n->>'owner_wallet',o->>'owner_wallet']; ref:=coalesce(n->>'id',o->>'id');
   -- Also record a cohort's original base after it transfers away.
   SELECT wallets||coalesce(array_agg(wallet),ARRAY[]::text[]) INTO wallets FROM public.mining_free_cohorts WHERE base_id=ref::uuid;
  ELSIF TG_TABLE_NAME='base_slots' THEN
   SELECT jsonb_object_agg(key,value) INTO n FROM jsonb_each(n) WHERE key=ANY(ARRAY['wallet','base_id','slot','active']);
   SELECT jsonb_object_agg(key,value) INTO o FROM jsonb_each(o) WHERE key=ANY(ARRAY['wallet','base_id','slot','active']);
   IF TG_OP='UPDATE' AND n IS NOT DISTINCT FROM o THEN RETURN NEW; END IF;
   wallets:=ARRAY[n->>'wallet',o->>'wallet']; ref:=coalesce(n->>'base_id',o->>'base_id');
   SELECT wallets||coalesce(array_agg(wallet),ARRAY[]::text[]) INTO wallets FROM public.mining_free_cohorts WHERE base_id IN ((n->>'base_id')::uuid,(o->>'base_id')::uuid);
  ELSIF TG_TABLE_NAME='seeker_links' THEN
   SELECT jsonb_object_agg(key,value) INTO n FROM jsonb_each(n) WHERE key=ANY(ARRAY['wallet','seeker_wallet','sgt_mint','revoked_at']);
   SELECT jsonb_object_agg(key,value) INTO o FROM jsonb_each(o) WHERE key=ANY(ARRAY['wallet','seeker_wallet','sgt_mint','revoked_at']);
   IF TG_OP='UPDATE' AND n IS NOT DISTINCT FROM o THEN RETURN NEW; END IF;
   wallets:=ARRAY[n->>'wallet',o->>'wallet']; ref:=coalesce(n->>'wallet',o->>'wallet');
  ELSE
   PERFORM id FROM public.accounts WHERE id IN ((n->>'account_id')::uuid,(o->>'account_id')::uuid) ORDER BY id FOR SHARE NOWAIT;
   PERFORM id FROM public.ledger_transactions WHERE id IN ((n->>'txn_id')::uuid,(o->>'txn_id')::uuid) ORDER BY id FOR SHARE NOWAIT;
   SELECT jsonb_object_agg(key,value) INTO n FROM jsonb_each(n) WHERE key=ANY(ARRAY['id','txn_id','account_id','delta']);
   SELECT jsonb_object_agg(key,value) INTO o FROM jsonb_each(o) WHERE key=ANY(ARRAY['id','txn_id','account_id','delta']);
   SELECT array_agg(DISTINCT a.owner_wallet) INTO wallets FROM public.accounts a JOIN public.ledger_transactions t
    ON t.id IN ((n->>'txn_id')::uuid,(o->>'txn_id')::uuid)
    WHERE a.id IN ((n->>'account_id')::uuid,(o->>'account_id')::uuid) AND a.kind='player_gems'
    AND t.type IN ('gems.from_keep','gems.buy') AND (coalesce((n->>'delta')::bigint,0)>0 OR coalesce((o->>'delta')::bigint,0)>0);
   IF wallets IS NULL THEN RETURN coalesce(NEW,OLD); END IF;
   ref:=coalesce(n->>'id',o->>'id');
   n:=n||jsonb_build_object('source_type',(SELECT type FROM public.ledger_transactions WHERE id=(n->>'txn_id')::uuid));
   o:=o||jsonb_build_object('source_type',(SELECT type FROM public.ledger_transactions WHERE id=(o->>'txn_id')::uuid));
  END IF;
 END IF;
 -- Snapshot readers take SHARE NOWAIT before sampling their clock.
 LOCK TABLE public.mining_free_cohort_events IN ROW EXCLUSIVE MODE;
 observed:=public.shardkeep_mining_free_clock();
 FOR w IN SELECT DISTINCT x FROM unnest(wallets) x WHERE x IS NOT NULL LOOP
  INSERT INTO public.mining_free_cohort_events(wallet,observed_at,source_table,source_id,operation,before_state,after_state)
   VALUES(w,observed,TG_TABLE_NAME,ref,TG_OP,o,n);
 END LOOP;
 IF TG_OP='TRUNCATE' THEN RETURN NULL; ELSIF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
