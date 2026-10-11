-- A new committed observation never backdates registered ownership or replaces
-- the original baseline. No capture, source activation or public grant is seeded.
CREATE TABLE IF NOT EXISTS public.mining_roster_checkpoints(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 wallet text NOT NULL,
 observed_at timestamptz NOT NULL,
 event_frontier bigint NOT NULL CHECK(event_frontier>=0),
 bases jsonb NOT NULL CHECK(jsonb_typeof(bases)='array'),
 slots jsonb NOT NULL CHECK(jsonb_typeof(slots)='array'),
 UNIQUE(wallet,event_frontier)
);
CREATE INDEX IF NOT EXISTS mining_roster_checkpoints_wallet_observed ON public.mining_roster_checkpoints(wallet,observed_at,event_frontier);
CREATE INDEX IF NOT EXISTS mining_roster_events_wallet_id ON public.mining_roster_events(wallet,id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_roster_checkpoint_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE baseline_at timestamptz; observed timestamptz; n bigint;
BEGIN
 IF TG_OP<>'INSERT' OR TG_RELID<>'public.mining_roster_checkpoints'::regclass
  OR TG_NAME<>'mining_roster_checkpoints_immutable' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
  OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  THEN RAISE EXCEPTION 'MINING_ROSTER_CHECKPOINT_IMMUTABLE'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_ROSTER_READ_COMMITTED_REQUIRED'; END IF;
 -- Source writers retain their table locks through commit. After this barrier,
 -- no previously allocated event ID can later appear behind the captured frontier.
 LOCK TABLE public.players,public.bases,public.base_slots IN ACCESS EXCLUSIVE MODE NOWAIT;
 LOCK TABLE public.mining_roster_baselines IN SHARE MODE NOWAIT;
 LOCK TABLE public.mining_roster_events,public.mining_roster_transactions IN SHARE MODE NOWAIT;
 LOCK TABLE public.mining_roster_checkpoints IN SHARE ROW EXCLUSIVE MODE NOWAIT;
 SELECT observed_at INTO baseline_at FROM public.mining_roster_baselines WHERE wallet=NEW.wallet;
 IF baseline_at IS NULL OR NOT EXISTS(SELECT 1 FROM public.players WHERE wallet=NEW.wallet)
  THEN RAISE EXCEPTION 'MINING_ROSTER_CHECKPOINT_BASELINE_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM public.mining_roster_transactions WHERE tx_key=pg_current_xact_id()::text)
  THEN RAISE EXCEPTION 'MINING_ROSTER_CHECKPOINT_REQUIRES_FRESH_TRANSACTION'; END IF;
 observed:=public.shardkeep_mining_roster_clock();
 IF observed IS NULL OR NOT isfinite(observed) OR observed<baseline_at
  OR EXISTS(SELECT 1 FROM public.mining_roster_checkpoints WHERE wallet=NEW.wallet AND observed_at>observed)
  OR EXISTS(SELECT 1 FROM public.mining_roster_events WHERE wallet=NEW.wallet AND observed_at>observed)
  THEN RAISE EXCEPTION 'MINING_ROSTER_CHECKPOINT_CLOCK_REGRESSION'; END IF;
 SELECT count(*) INTO n FROM (SELECT id FROM public.bases WHERE owner_wallet=NEW.wallet LIMIT 10001) bounded;
 IF n>10000 THEN RAISE EXCEPTION 'MINING_ROSTER_TOO_LARGE'; END IF;
 SELECT count(*) INTO n FROM (SELECT slot FROM public.base_slots WHERE wallet=NEW.wallet LIMIT 10001) bounded;
 IF n>10000 THEN RAISE EXCEPTION 'MINING_ROSTER_TOO_LARGE'; END IF;
 NEW.id:=gen_random_uuid();NEW.observed_at:=observed;
 SELECT coalesce(max(id),0) INTO NEW.event_frontier FROM public.mining_roster_events WHERE wallet=NEW.wallet;
 SELECT coalesce(jsonb_agg(public.shardkeep_mining_roster_base(to_jsonb(b)) ORDER BY id),'[]') INTO NEW.bases FROM public.bases b WHERE owner_wallet=NEW.wallet;
 SELECT coalesce(jsonb_agg(jsonb_build_object('wallet',wallet,'slot',slot,'base_id',base_id,'active',active) ORDER BY slot),'[]') INTO NEW.slots FROM public.base_slots WHERE wallet=NEW.wallet;
 RETURN NEW;
END $$;
--> statement-breakpoint
DO $migration$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_roster_checkpoints'::regclass AND tgname='mining_roster_checkpoints_immutable') THEN
  CREATE TRIGGER mining_roster_checkpoints_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.mining_roster_checkpoints FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_roster_checkpoint_guard();
  CREATE TRIGGER mining_roster_checkpoints_no_truncate BEFORE TRUNCATE ON public.mining_roster_checkpoints FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_roster_checkpoint_guard();
 END IF;
END $migration$;
REVOKE ALL ON public.mining_roster_checkpoints FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_mining_roster_checkpoint_guard() FROM PUBLIC;
