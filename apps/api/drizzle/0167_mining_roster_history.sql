-- Registered stable-base facts only; installation leaves source behavior dormant.
CREATE OR REPLACE FUNCTION public.shardkeep_mining_roster_clock() RETURNS timestamptz
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$ SELECT clock_timestamp() $$;
CREATE OR REPLACE FUNCTION public.shardkeep_mining_roster_base(j jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN j IS NULL THEN NULL ELSE jsonb_build_object(
 'id',j->'id','owner_wallet',j->'owner_wallet','status',j->'status',
 'land_paid_at',to_char((j->>'land_paid_at')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'deed_asset_id',j->'deed_asset_id','deed_mint_asset_id',j->'deed_mint_asset_id',
 'deed_minting_at',to_char((j->>'deed_minting_at')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) END
$$;
CREATE TABLE IF NOT EXISTS mining_roster_transactions(tx_key text PRIMARY KEY,observed_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS mining_roster_baselines(
 wallet text PRIMARY KEY,observed_at timestamptz NOT NULL,effective_from timestamptz NOT NULL,
 bases jsonb NOT NULL,slots jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS mining_roster_events(
 id bigserial PRIMARY KEY,wallet text NOT NULL,tx_key text NOT NULL,observed_at timestamptz NOT NULL,
 source_table text NOT NULL,source_id text NOT NULL,before_state jsonb,after_state jsonb
);
CREATE INDEX IF NOT EXISTS mining_roster_events_wallet_clock ON mining_roster_events(wallet,observed_at,id);
CREATE INDEX IF NOT EXISTS mining_roster_events_transaction ON mining_roster_events(tx_key,id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_roster_history_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP<>'INSERT' OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'MINING_ROSTER_HISTORY_IMMUTABLE'; END IF;
 IF TG_RELID='public.mining_roster_transactions'::regclass THEN
  NEW.tx_key:=pg_current_xact_id()::text;NEW.observed_at:=public.shardkeep_mining_roster_clock();
 ELSIF TG_RELID='public.mining_roster_events'::regclass THEN
  IF NEW.tx_key<>pg_current_xact_id()::text OR NOT EXISTS(SELECT 1 FROM public.mining_roster_transactions WHERE tx_key=NEW.tx_key AND observed_at=NEW.observed_at)
   OR NEW.source_table NOT IN ('bases','base_slots')
   OR NOT EXISTS(SELECT 1 FROM public.mining_roster_baselines WHERE wallet=NEW.wallet AND observed_at<=NEW.observed_at)
   THEN RAISE EXCEPTION 'MINING_ROSTER_SOURCE_INVALID'; END IF;
 ELSE RAISE EXCEPTION 'MINING_ROSTER_HISTORY_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_mining_roster_baseline_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t text; n bigint; observed timestamptz;
BEGIN
 IF TG_OP<>'INSERT' OR TG_RELID<>'public.mining_roster_baselines'::regclass
  OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  THEN RAISE EXCEPTION 'MINING_ROSTER_HISTORY_IMMUTABLE'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_ROSTER_READ_COMMITTED_REQUIRED'; END IF;
 LOCK TABLE public.players,public.bases,public.base_slots IN ACCESS EXCLUSIVE MODE NOWAIT;
 LOCK TABLE public.mining_roster_baselines IN SHARE ROW EXCLUSIVE MODE NOWAIT;
 LOCK TABLE public.mining_roster_events,public.mining_roster_transactions IN SHARE MODE NOWAIT;
 IF NOT EXISTS(SELECT 1 FROM public.players WHERE wallet=NEW.wallet) THEN RAISE EXCEPTION 'MINING_ROSTER_WALLET_UNAVAILABLE'; END IF;
 SELECT count(*) INTO n FROM (SELECT id FROM public.bases WHERE owner_wallet=NEW.wallet LIMIT 10001) bounded;
 IF n>10000 THEN RAISE EXCEPTION 'MINING_ROSTER_TOO_LARGE'; END IF;
 SELECT count(*) INTO n FROM (SELECT slot FROM public.base_slots WHERE wallet=NEW.wallet LIMIT 10001) bounded;
 IF n>10000 THEN RAISE EXCEPTION 'MINING_ROSTER_TOO_LARGE'; END IF;
 IF EXISTS(SELECT 1 FROM public.mining_roster_transactions WHERE tx_key=pg_current_xact_id()::text)
  THEN RAISE EXCEPTION 'MINING_ROSTER_BASELINE_REQUIRES_FRESH_TRANSACTION'; END IF;
 INSERT INTO public.mining_roster_transactions(tx_key) VALUES(pg_current_xact_id()::text);
 SELECT observed_at INTO STRICT observed FROM public.mining_roster_transactions WHERE tx_key=pg_current_xact_id()::text;
 NEW.observed_at:=observed;NEW.effective_from:=((observed AT TIME ZONE 'UTC')::date+1)::timestamp AT TIME ZONE 'UTC';
 SELECT coalesce(jsonb_agg(public.shardkeep_mining_roster_base(to_jsonb(b)) ORDER BY id),'[]') INTO NEW.bases FROM public.bases b WHERE owner_wallet=NEW.wallet;
 SELECT coalesce(jsonb_agg(jsonb_build_object('wallet',wallet,'slot',slot,'base_id',base_id,'active',active) ORDER BY slot),'[]') INTO NEW.slots FROM public.base_slots WHERE wallet=NEW.wallet;
 FOREACH t IN ARRAY ARRAY['bases','base_slots'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER %I',t,t||'_mining_roster_capture');
  EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER %I',t,t||'_mining_roster_truncate');
 END LOOP;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_capture_mining_roster() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n jsonb;o jsonb;affected text[];target text;boundary timestamptz;observed timestamptz;key text;ref text;
BEGIN
 IF TG_RELID NOT IN ('public.bases'::regclass,'public.base_slots'::regclass)
  OR (TG_OP='TRUNCATE' AND (TG_NAME<>TG_TABLE_NAME||'_mining_roster_truncate' OR TG_LEVEL<>'STATEMENT' OR TG_WHEN<>'BEFORE'))
  OR (TG_OP<>'TRUNCATE' AND (TG_OP NOT IN ('INSERT','UPDATE','DELETE') OR TG_NAME<>TG_TABLE_NAME||'_mining_roster_capture' OR TG_LEVEL<>'ROW' OR TG_WHEN<>'AFTER'))
  THEN RAISE EXCEPTION 'MINING_ROSTER_SOURCE_INVALID'; END IF;
 -- Must precede the coverage lookup even for unrelated sources: old RR cannot
 -- hide owner activation. Before activation these triggers are disabled.
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_ROSTER_READ_COMMITTED_REQUIRED'; END IF;
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'MINING_ROSTER_SOURCE_TRUNCATE_FORBIDDEN'; END IF;
 IF TG_OP<>'DELETE' THEN n:=to_jsonb(NEW); END IF;
 IF TG_OP<>'INSERT' THEN o:=to_jsonb(OLD); END IF;
 IF TG_TABLE_NAME='bases' THEN
  n:=public.shardkeep_mining_roster_base(n);o:=public.shardkeep_mining_roster_base(o);
  affected:=ARRAY[n->>'owner_wallet',o->>'owner_wallet'];ref:=coalesce(n->>'id',o->>'id');
 ELSE
  SELECT jsonb_object_agg(k,v) INTO n FROM jsonb_each(n) e(k,v) WHERE k=ANY(ARRAY['wallet','slot','base_id','active']);
  SELECT jsonb_object_agg(k,v) INTO o FROM jsonb_each(o) e(k,v) WHERE k=ANY(ARRAY['wallet','slot','base_id','active']);
  affected:=ARRAY[n->>'wallet',o->>'wallet'];ref:=coalesce(n->>'wallet',o->>'wallet')||':'||coalesce(n->>'slot',o->>'slot');
 END IF;
 IF n IS NOT DISTINCT FROM o THEN RETURN coalesce(NEW,OLD); END IF;
 LOCK TABLE public.mining_roster_events IN ROW EXCLUSIVE MODE;
 FOR target,boundary IN SELECT wallet,observed_at FROM public.mining_roster_baselines WHERE wallet=ANY(affected) ORDER BY wallet LOOP
  IF observed IS NULL THEN
   key:=pg_current_xact_id()::text;
   INSERT INTO public.mining_roster_transactions(tx_key) VALUES(key) ON CONFLICT DO NOTHING;
   SELECT observed_at INTO STRICT observed FROM public.mining_roster_transactions WHERE tx_key=key;
  END IF;
  IF observed<boundary THEN RAISE EXCEPTION 'MINING_ROSTER_CLOCK_BEFORE_BASELINE'; END IF;
  INSERT INTO public.mining_roster_events(wallet,tx_key,observed_at,source_table,source_id,before_state,after_state) VALUES(target,key,observed,TG_TABLE_NAME,ref,o,n);
 END LOOP;
 RETURN coalesce(NEW,OLD);
END $$;
--> statement-breakpoint
DO $migration$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['mining_roster_transactions','mining_roster_events'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_immutable') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_roster_history_guard()',t||'_immutable',t);
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_roster_history_guard()',t||'_no_truncate',t);
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_roster_baselines'::regclass AND tgname='mining_roster_baselines_immutable') THEN
  CREATE TRIGGER mining_roster_baselines_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.mining_roster_baselines FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_roster_baseline_guard();
  CREATE TRIGGER mining_roster_baselines_no_truncate BEFORE TRUNCATE ON public.mining_roster_baselines FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_roster_baseline_guard();
 END IF;
 FOREACH t IN ARRAY ARRAY['bases','base_slots'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_mining_roster_capture') THEN
   EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_capture_mining_roster()',t||'_mining_roster_capture',t);
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_capture_mining_roster()',t||'_mining_roster_truncate',t);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.mining_roster_baselines) THEN
   EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I',t,t||'_mining_roster_capture');
   EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I',t,t||'_mining_roster_truncate');
  END IF;
 END LOOP;
END $migration$;
REVOKE ALL ON mining_roster_baselines,mining_roster_transactions,mining_roster_events FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_mining_roster_clock(),public.shardkeep_mining_roster_base(jsonb),public.shardkeep_mining_roster_history_guard(),public.shardkeep_mining_roster_baseline_guard(),public.shardkeep_capture_mining_roster() FROM PUBLIC;
