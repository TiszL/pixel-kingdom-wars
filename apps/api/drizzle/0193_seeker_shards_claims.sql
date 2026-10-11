-- Original-spot SHARDS payout receipts. Existing ledger/account tables unchanged.
-- Frozen SQL bounds: PHASE_E_POLICY.seekerIsland.totalSpots and
-- RAW_RESOURCE_STORAGE_MAX (PostgreSQL signed-bigint domain), not new tuning.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS seeker_shards_claims (
 id uuid PRIMARY KEY,wallet text NOT NULL REFERENCES players(wallet),base_id uuid NOT NULL REFERENCES bases(id),
 term_id uuid NOT NULL,spot_id integer NOT NULL CHECK(spot_id>=0 AND spot_id<100),
 expected_pool bigint NOT NULL CHECK(expected_pool>=0),expected_previous bigint NOT NULL CHECK(expected_previous>=0),
 ledger_id uuid NOT NULL UNIQUE REFERENCES ledger_transactions(id),
 term_hash text NOT NULL,winner_count integer NOT NULL CHECK(winner_count>0 AND winner_count<=100),
 pool_total bigint NOT NULL CHECK(pool_total>=0),previous_id uuid REFERENCES seeker_shards_claims(id),
 previous_total bigint NOT NULL CHECK(previous_total>=0),cumulative_total bigint NOT NULL CHECK(cumulative_total>previous_total),
 quantity bigint NOT NULL CHECK(quantity>0 AND quantity=cumulative_total-previous_total),
 balance_before bigint NOT NULL CHECK(balance_before>=0),balance_after bigint NOT NULL CHECK(balance_after>=balance_before AND balance_after-balance_before=quantity),
 claimed_at timestamptz NOT NULL CHECK(isfinite(claimed_at)),
 FOREIGN KEY(term_id,term_hash) REFERENCES expedition_term_snapshots(term_id,snapshot_hash),
 UNIQUE(term_id,spot_id,cumulative_total)
);
CREATE INDEX IF NOT EXISTS seeker_shards_claim_wallet_idx ON seeker_shards_claims(wallet,id);
CREATE INDEX IF NOT EXISTS seeker_shards_claim_pool_idx ON seeker_shards_claims(term_id,spot_id,cumulative_total);
--> statement-breakpoint
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
 SELECT COALESCE(sum(tax::numeric),0),count(*) INTO total,source_count FROM public.shards_tax_assessments WHERE term_id=NEW.term_id AND term_hash=term.snapshot_hash;
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
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.seeker_shards_claims'::regclass AND tgname='seeker_shards_claim_guard') THEN CREATE TRIGGER seeker_shards_claim_guard BEFORE INSERT OR UPDATE OR DELETE ON public.seeker_shards_claims FOR EACH ROW EXECUTE FUNCTION public.shardkeep_seeker_shards_claim_guard();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.seeker_shards_claims'::regclass AND tgname='seeker_shards_claim_no_truncate') THEN CREATE TRIGGER seeker_shards_claim_no_truncate BEFORE TRUNCATE ON public.seeker_shards_claims FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_seeker_shards_claim_guard();END IF;
END $$;
