-- D-153.136: original resource rights include advanced returns. No new economics.
-- Private source tables remain owner-only. Runtime gets a boolean presence probe,
-- never source JSON; any header (including partial/corrupt history) holds fallback.
CREATE INDEX IF NOT EXISTS advanced_expeditions_pool_idx ON public.advanced_expeditions(term_id,resource_id,id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_has_advanced_resource_sources(term_id uuid,resource_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.advanced_expeditions s WHERE s.term_id=$1 AND s.resource_id=$2)
$$;
REVOKE ALL ON FUNCTION public.shardkeep_has_advanced_resource_sources(uuid,text) FROM PUBLIC;
-- This scalar compatibility probe is safe for existing/custom/future roles.
-- No private table privileges or raw financial evidence are exposed.
GRANT EXECUTE ON FUNCTION public.shardkeep_has_advanced_resource_sources(uuid,text) TO PUBLIC;
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
   UNION ALL
   SELECT e.delta::numeric FROM public.advanced_expedition_entries e
    JOIN public.advanced_expedition_returns r ON r.id=e.return_id
    JOIN public.advanced_expeditions s ON s.id=r.expedition_id
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

REVOKE ALL ON FUNCTION public.shardkeep_seeker_resource_claim_guard() FROM PUBLIC;
