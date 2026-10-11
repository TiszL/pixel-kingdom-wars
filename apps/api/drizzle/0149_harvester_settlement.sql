-- Frozen D153.28 v1 accounting. No source replacement, public issuer or worker.
-- All economic literals project PHASE_E_HARVESTER.v1; drift is tested.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS harvester_wallet_locks (wallet text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS harvester_events (
 source_id uuid NOT NULL REFERENCES harvester_sources(id), ordinal integer NOT NULL,
 actor_wallet text NOT NULL REFERENCES harvester_wallet_locks(wallet), wallet_sequence bigint NOT NULL,
 policy_version integer NOT NULL, resource_id text NOT NULL, earned_at timestamptz NOT NULL, utc_day timestamptz NOT NULL,
 tax_policy_version integer NOT NULL, tax_basis_points integer NOT NULL, island_pool_bps integer NOT NULL,
 gross bigint NOT NULL, net bigint NOT NULL, tax bigint NOT NULL, carry_before bigint NOT NULL, carry_after bigint NOT NULL,
 custody_wallet text NOT NULL, settled_at timestamptz NOT NULL,
 PRIMARY KEY(source_id,ordinal), CONSTRAINT harvester_event_wallet_sequence_uq UNIQUE(actor_wallet,wallet_sequence),
 CONSTRAINT harvester_event_amount_ck CHECK(gross>=0 AND net>=0 AND tax>=0 AND net::numeric+tax::numeric=gross::numeric)
);
CREATE INDEX IF NOT EXISTS harvester_event_day_idx ON harvester_events(actor_wallet,policy_version,utc_day);
CREATE INDEX IF NOT EXISTS harvester_event_carry_idx ON harvester_events(actor_wallet,resource_id,tax_policy_version,wallet_sequence);
CREATE TABLE IF NOT EXISTS harvester_entries (
 source_id uuid NOT NULL, ordinal integer NOT NULL, bucket text NOT NULL, delta bigint NOT NULL,
 PRIMARY KEY(source_id,ordinal,bucket),
 CONSTRAINT harvester_entry_event_fk FOREIGN KEY(source_id,ordinal) REFERENCES harvester_events(source_id,ordinal),
 CONSTRAINT harvester_entry_bucket_ck CHECK(bucket IN ('issued','base_stock','island_pool'))
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_harvester_accounting_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Harvester accounting history is immutable' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION public.shardkeep_harvester_accounting_immutable() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_wallet_locks'::regclass AND tgname = 'harvester_wallet_immutable') THEN
    CREATE TRIGGER harvester_wallet_immutable BEFORE UPDATE OR DELETE ON harvester_wallet_locks FOR EACH ROW EXECUTE FUNCTION public.shardkeep_harvester_accounting_immutable();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_wallet_locks'::regclass AND tgname = 'harvester_wallet_no_truncate') THEN
    CREATE TRIGGER harvester_wallet_no_truncate BEFORE TRUNCATE ON harvester_wallet_locks FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_harvester_accounting_immutable();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_events'::regclass AND tgname = 'harvester_event_immutable') THEN
    CREATE TRIGGER harvester_event_immutable BEFORE UPDATE OR DELETE ON harvester_events FOR EACH ROW EXECUTE FUNCTION public.shardkeep_harvester_accounting_immutable();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_events'::regclass AND tgname = 'harvester_event_no_truncate') THEN
    CREATE TRIGGER harvester_event_no_truncate BEFORE TRUNCATE ON harvester_events FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_harvester_accounting_immutable();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_entries'::regclass AND tgname = 'harvester_entry_immutable') THEN
    CREATE TRIGGER harvester_entry_immutable BEFORE UPDATE OR DELETE ON harvester_entries FOR EACH ROW EXECUTE FUNCTION public.shardkeep_harvester_accounting_immutable();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_entries'::regclass AND tgname = 'harvester_entry_no_truncate') THEN
    CREATE TRIGGER harvester_entry_no_truncate BEFORE TRUNCATE ON harvester_entries FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_harvester_accounting_immutable();
  END IF;
END;
$migration$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_harvester_event_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE src public.harvester_sources%ROWTYPE; custody text; sequence_before bigint; last_earned timestamptz;
 ordinal_before integer; used numeric; carry bigint; expected_gross bigint; numerator numeric;
BEGIN
 SELECT * INTO STRICT src FROM public.harvester_sources WHERE id=NEW.source_id;
 -- Same base -> dedicated wallet order as the application. No player lock/FK.
 SELECT owner_wallet INTO STRICT custody FROM public.bases WHERE id=src.base_id FOR UPDATE;
 PERFORM wallet FROM public.harvester_wallet_locks WHERE wallet=src.actor_wallet FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Harvester wallet accounting lock missing' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.harvester_source_heads WHERE source_id=src.id AND wallet=src.actor_wallet AND base_id=src.base_id) THEN
  RAISE EXCEPTION 'Harvester pending original source missing' USING ERRCODE='23514'; END IF;
 SELECT coalesce(max(ordinal),0) INTO ordinal_before FROM public.harvester_events WHERE source_id=src.id;
 SELECT wallet_sequence,earned_at INTO sequence_before,last_earned FROM public.harvester_events
  WHERE actor_wallet=src.actor_wallet ORDER BY wallet_sequence DESC LIMIT 1;
 SELECT coalesce(sum(gross::numeric),0) INTO used FROM public.harvester_events
  WHERE actor_wallet=src.actor_wallet AND policy_version=src.policy_version AND utc_day=NEW.utc_day;
 SELECT carry_after INTO carry FROM public.harvester_events
  WHERE actor_wallet=src.actor_wallet AND resource_id=src.resource_id AND tax_policy_version=1 ORDER BY wallet_sequence DESC LIMIT 1;
 carry:=coalesce(carry,0);
 expected_gross:=CASE WHEN used+1<=15 THEN 1 ELSE 0 END;
 numerator:=expected_gross::numeric*2000+carry;
 IF (NEW.actor_wallet=src.actor_wallet AND NEW.policy_version=src.policy_version AND NEW.policy_version=1
  AND NEW.resource_id=src.resource_id AND NEW.ordinal=ordinal_before+1 AND NEW.ordinal BETWEEN 1 AND 15
  AND NEW.wallet_sequence=coalesce(sequence_before,0)+1 AND (last_earned IS NULL OR NEW.earned_at>last_earned)
  AND NEW.earned_at=src.admitted_at+NEW.ordinal*interval '5760 seconds'
  AND NEW.earned_at<=src.lease_expires_at AND NEW.earned_at<(SELECT ends_at FROM public.expedition_term_snapshots WHERE term_id=src.term_id)
  AND NEW.utc_day=(date_trunc('day',NEW.earned_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
  AND NEW.tax_policy_version=1 AND NEW.tax_basis_points=10000 AND NEW.island_pool_bps=2000
  AND used BETWEEN 0 AND 15 AND NEW.gross=expected_gross AND NEW.carry_before=carry
  AND NEW.tax=floor(numerator/10000) AND NEW.net=NEW.gross-NEW.tax AND NEW.carry_after=mod(numerator,10000)
  AND NEW.custody_wallet=custody AND isfinite(NEW.settled_at) AND NEW.settled_at>=NEW.earned_at
  AND NEW.settled_at=date_trunc('milliseconds',NEW.settled_at)) IS NOT TRUE THEN
  RAISE EXCEPTION 'Harvester original cadence, allowance or carry mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_harvester_event_guard() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_events'::regclass AND tgname = 'harvester_event_guard') THEN
    CREATE TRIGGER harvester_event_guard BEFORE INSERT ON harvester_events FOR EACH ROW EXECUTE FUNCTION public.shardkeep_harvester_event_guard();
  END IF;
END;
$migration$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_harvester_event_proof() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event public.harvester_events%ROWTYPE;
BEGIN
 SELECT * INTO STRICT event FROM public.harvester_events WHERE source_id=NEW.source_id AND ordinal=NEW.ordinal;
 IF (SELECT count(*) FROM public.harvester_entries WHERE source_id=event.source_id AND ordinal=event.ordinal)<>3
  OR NOT EXISTS(SELECT 1 FROM public.harvester_entries WHERE source_id=event.source_id AND ordinal=event.ordinal AND bucket='issued' AND delta=-event.gross)
  OR NOT EXISTS(SELECT 1 FROM public.harvester_entries WHERE source_id=event.source_id AND ordinal=event.ordinal AND bucket='base_stock' AND delta=event.net)
  OR NOT EXISTS(SELECT 1 FROM public.harvester_entries WHERE source_id=event.source_id AND ordinal=event.ordinal AND bucket='island_pool' AND delta=event.tax)
 THEN RAISE EXCEPTION 'Harvester event requires original balanced entries' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_harvester_event_proof() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_events'::regclass AND tgname = 'harvester_event_proof') THEN
    CREATE CONSTRAINT TRIGGER harvester_event_proof AFTER INSERT ON harvester_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_harvester_event_proof();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_entries'::regclass AND tgname = 'harvester_entry_proof') THEN
    CREATE CONSTRAINT TRIGGER harvester_entry_proof AFTER INSERT ON harvester_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_harvester_event_proof();
  END IF;
END;
$migration$;
