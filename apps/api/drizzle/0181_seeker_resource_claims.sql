-- B4 raw resources only. No SHARDS/SOL/KEEP source, backfill or activation.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS seeker_resource_claims (
 id uuid PRIMARY KEY,wallet text NOT NULL REFERENCES players(wallet),base_id uuid NOT NULL REFERENCES bases(id),
 term_id uuid NOT NULL,resource_id text NOT NULL CHECK(resource_id IN ('frost_quartz','heartwood_logs','sunstone_rubble','crown_iron_ore','rough_prism','storm_ore','thorn_fibre','ember_nodules')),
 spot_id integer NOT NULL CHECK(spot_id>=0 AND spot_id<100),expected_pool bigint NOT NULL CHECK(expected_pool>=0),expected_previous bigint NOT NULL CHECK(expected_previous>=0),
 term_hash text NOT NULL,winner_count integer NOT NULL CHECK(winner_count>0 AND winner_count<=100),
 pool_total bigint NOT NULL CHECK(pool_total>=0),previous_id uuid REFERENCES seeker_resource_claims(id),
 previous_total bigint NOT NULL CHECK(previous_total>=0),cumulative_total bigint NOT NULL CHECK(cumulative_total>previous_total),
 quantity bigint NOT NULL CHECK(quantity>0 AND quantity=cumulative_total-previous_total),
 stock_before bigint NOT NULL CHECK(stock_before>=0),stock_after bigint NOT NULL CHECK(stock_after>=stock_before AND stock_after-stock_before=quantity),
 claimed_at timestamptz NOT NULL CHECK(isfinite(claimed_at)),
 FOREIGN KEY(term_id,term_hash) REFERENCES expedition_term_snapshots(term_id,snapshot_hash),
 UNIQUE(term_id,resource_id,spot_id,cumulative_total)
);
CREATE INDEX IF NOT EXISTS seeker_resource_claim_wallet_idx ON seeker_resource_claims(wallet,id);
CREATE INDEX IF NOT EXISTS seeker_resource_claim_pool_idx ON seeker_resource_claims(term_id,resource_id,spot_id,cumulative_total);
CREATE TABLE IF NOT EXISTS seeker_resource_claim_entries (
 claim_id uuid NOT NULL REFERENCES seeker_resource_claims(id),bucket text NOT NULL CHECK(bucket IN ('island_pool','base_stock')),
 delta bigint NOT NULL CHECK(delta<>0),PRIMARY KEY(claim_id,bucket)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_seeker_resource_claim_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE term public.expedition_term_snapshots%ROWTYPE; dest public.bases%ROWTYPE; inventory public.resource_stocks%ROWTYPE;
 prior public.seeker_resource_claims%ROWTYPE; total numeric; paid numeric; winners integer; recipient text; source_count bigint;
BEGIN
 IF TG_RELID<>'public.seeker_resource_claims'::regclass OR TG_WHEN<>'BEFORE'
 OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'seeker_resource_claim_no_truncate' ELSE 'seeker_resource_claim_guard' END)
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'SEEKER_RESOURCE_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SEEKER_RESOURCE_IMMUTABLE';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'SEEKER_RESOURCE_ISOLATION';END IF;
 IF NEW.term_hash IS NOT NULL OR NEW.winner_count IS NOT NULL OR NEW.pool_total IS NOT NULL OR NEW.previous_id IS NOT NULL
 OR NEW.previous_total IS NOT NULL OR NEW.cumulative_total IS NOT NULL OR NEW.quantity IS NOT NULL
 OR NEW.stock_before IS NOT NULL OR NEW.stock_after IS NOT NULL OR NEW.claimed_at IS NOT NULL THEN RAISE EXCEPTION 'SEEKER_RESOURCE_DERIVED';END IF;
 -- Match the service/player/base/slot order; no pool lock precedes custody.
 PERFORM 1 FROM public.players WHERE wallet=NEW.wallet FOR UPDATE;
 SELECT * INTO STRICT dest FROM public.bases WHERE id=NEW.base_id AND owner_wallet=NEW.wallet AND status='active' FOR UPDATE;
 PERFORM 1 FROM public.base_slots WHERE base_id=dest.id AND wallet=NEW.wallet AND active FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.base_raid_locks WHERE base_id=dest.id) THEN RAISE EXCEPTION 'SEEKER_RESOURCE_DESTINATION';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('seeker-resource:'||NEW.term_id::text||':'||NEW.resource_id,0));
 SELECT * INTO STRICT term FROM public.expedition_term_snapshots WHERE term_id=NEW.term_id;
 SELECT count(*),max(CASE WHEN (s->>'spotId')::integer=NEW.spot_id THEN s->>'ownerWallet' END)
 INTO winners,recipient FROM jsonb_array_elements(term.snapshot->'spots') s WHERE s->>'ownerWallet' IS NOT NULL;
 IF winners<1 OR recipient IS DISTINCT FROM NEW.wallet THEN RAISE EXCEPTION 'SEEKER_RESOURCE_NOT_OWNER';END IF;
 -- Every committed source contributes exactly its original tax once. Original
 -- producer triggers enforce the three legs, and admission retains term proof.
 SELECT COALESCE(sum(tax),0),count(*) INTO total,source_count FROM (
  SELECT e.delta::numeric AS tax FROM public.starter_expedition_entries e
   JOIN public.starter_expedition_returns r ON r.id=e.return_id
   JOIN public.starter_expeditions s ON s.id=r.expedition_id
   WHERE e.bucket='island_pool' AND s.term_id=NEW.term_id AND s.term_hash=term.snapshot_hash AND s.resource_id=NEW.resource_id
  UNION ALL
  SELECT e.delta::numeric FROM public.harvester_entries e JOIN public.harvester_sources s ON s.id=e.source_id
   WHERE e.bucket='island_pool' AND s.term_id=NEW.term_id AND s.term_hash=term.snapshot_hash AND s.resource_id=NEW.resource_id
 ) sources;
 IF source_count<1 OR total<0 OR total>9223372036854775807 OR total IS DISTINCT FROM NEW.expected_pool::numeric THEN RAISE EXCEPTION 'SEEKER_RESOURCE_SOURCE_CHANGED';END IF;
 SELECT * INTO prior FROM public.seeker_resource_claims WHERE term_id=NEW.term_id AND resource_id=NEW.resource_id AND spot_id=NEW.spot_id ORDER BY cumulative_total DESC LIMIT 1;
 NEW.previous_id:=prior.id;NEW.previous_total:=COALESCE(prior.cumulative_total,0);
 IF NEW.previous_total<>NEW.expected_previous THEN RAISE EXCEPTION 'SEEKER_RESOURCE_CURSOR_CHANGED';END IF;
 NEW.term_hash:=term.snapshot_hash;NEW.winner_count:=winners;NEW.pool_total:=total;
 NEW.cumulative_total:=div(total,winners);NEW.quantity:=NEW.cumulative_total-NEW.previous_total;
 IF NEW.quantity<=0 THEN RAISE EXCEPTION 'SEEKER_RESOURCE_NOTHING_DUE';END IF;
 SELECT COALESCE(sum(quantity::numeric),0) INTO paid FROM public.seeker_resource_claims WHERE term_id=NEW.term_id AND resource_id=NEW.resource_id;
 IF paid+NEW.quantity>total THEN RAISE EXCEPTION 'SEEKER_RESOURCE_POOL_UNDERFLOW';END IF;
 INSERT INTO public.resource_stocks(base_id,resource_id) VALUES(NEW.base_id,NEW.resource_id) ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT inventory FROM public.resource_stocks WHERE base_id=NEW.base_id AND resource_id=NEW.resource_id FOR UPDATE;
 IF inventory.available::numeric+inventory.reserved::numeric+NEW.quantity::numeric>9223372036854775807 THEN RAISE EXCEPTION 'SEEKER_RESOURCE_STOCK_OVERFLOW';END IF;
 NEW.stock_before:=inventory.available;NEW.stock_after:=inventory.available+NEW.quantity;NEW.claimed_at:=clock_timestamp();
 UPDATE public.resource_stocks SET available=NEW.stock_after WHERE base_id=NEW.base_id AND resource_id=NEW.resource_id;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_seeker_resource_claim_entries() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID<>'public.seeker_resource_claims'::regclass OR TG_NAME<>'seeker_resource_claim_entries' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SEEKER_RESOURCE_TRIGGER';END IF;
 INSERT INTO public.seeker_resource_claim_entries(claim_id,bucket,delta) VALUES(NEW.id,'island_pool',-NEW.quantity),(NEW.id,'base_stock',NEW.quantity);
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_seeker_resource_entry_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID<>'public.seeker_resource_claim_entries'::regclass OR TG_WHEN<>'BEFORE'
 OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'seeker_resource_entry_no_truncate' ELSE 'seeker_resource_entry_guard' END)
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'SEEKER_RESOURCE_TRIGGER';END IF;
 IF TG_OP<>'INSERT' OR pg_trigger_depth()<>2 OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'SEEKER_RESOURCE_ENTRY_IMMUTABLE';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.seeker_resource_claims c WHERE c.id=NEW.claim_id AND
  ((NEW.bucket='base_stock' AND NEW.delta=c.quantity) OR (NEW.bucket='island_pool' AND NEW.delta=-c.quantity))) THEN RAISE EXCEPTION 'SEEKER_RESOURCE_ENTRY';END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.seeker_resource_claims'::regclass AND tgname='seeker_resource_claim_guard') THEN
  CREATE TRIGGER seeker_resource_claim_guard BEFORE INSERT OR UPDATE OR DELETE ON public.seeker_resource_claims FOR EACH ROW EXECUTE FUNCTION public.shardkeep_seeker_resource_claim_guard();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.seeker_resource_claims'::regclass AND tgname='seeker_resource_claim_no_truncate') THEN
  CREATE TRIGGER seeker_resource_claim_no_truncate BEFORE TRUNCATE ON public.seeker_resource_claims FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_seeker_resource_claim_guard();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.seeker_resource_claims'::regclass AND tgname='seeker_resource_claim_entries') THEN
  CREATE TRIGGER seeker_resource_claim_entries AFTER INSERT ON public.seeker_resource_claims FOR EACH ROW EXECUTE FUNCTION public.shardkeep_seeker_resource_claim_entries();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.seeker_resource_claim_entries'::regclass AND tgname='seeker_resource_entry_guard') THEN
  CREATE TRIGGER seeker_resource_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON public.seeker_resource_claim_entries FOR EACH ROW EXECUTE FUNCTION public.shardkeep_seeker_resource_entry_guard();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.seeker_resource_claim_entries'::regclass AND tgname='seeker_resource_entry_no_truncate') THEN
  CREATE TRIGGER seeker_resource_entry_no_truncate BEFORE TRUNCATE ON public.seeker_resource_claim_entries FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_seeker_resource_entry_guard();END IF;
END $$;
REVOKE ALL ON seeker_resource_claims,seeker_resource_claim_entries FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_seeker_resource_claim_guard(),public.shardkeep_seeker_resource_claim_entries(),public.shardkeep_seeker_resource_entry_guard() FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shardkeep_api_runtime') THEN
  REVOKE ALL ON seeker_resource_claims,seeker_resource_claim_entries FROM shardkeep_api_runtime;
  GRANT SELECT,INSERT ON seeker_resource_claims TO shardkeep_api_runtime;
  GRANT SELECT ON seeker_resource_claim_entries TO shardkeep_api_runtime;
 END IF;
END $$;
