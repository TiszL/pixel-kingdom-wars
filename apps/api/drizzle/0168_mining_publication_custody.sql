-- S5-held existing-table guard addition; no activation, backfill or 0160 rewrite.
-- A durable attempt permanently holds its exact original reservation set. This is
-- not a terminal publication receipt: consumption/return authorization is absent.
CREATE TABLE IF NOT EXISTS public.mining_publication_attempts (
 epoch_id uuid PRIMARY KEY REFERENCES public.mining_ingot_epochs(id) ON DELETE RESTRICT,
 attempt_key text NOT NULL UNIQUE CHECK(length(attempt_key) BETWEEN 8 AND 128 AND btrim(attempt_key)=attempt_key),
 intent_bytes bytea NOT NULL CHECK(octet_length(intent_bytes) BETWEEN 1 AND 1232),
 intent_sha256 text NOT NULL CHECK(intent_sha256 ~ '^[0-9a-f]{64}$'),
 reservations jsonb NOT NULL CHECK(jsonb_typeof(reservations)='array'),
 reservations_sha256 text NOT NULL CHECK(reservations_sha256 ~ '^[0-9a-f]{64}$'),
 reservation_count integer NOT NULL CHECK(reservation_count BETWEEN 1 AND 10000),
 reserved_ingots bigint NOT NULL CHECK(reserved_ingots>0),
 prepared_at timestamptz NOT NULL CHECK(isfinite(prepared_at))
);
CREATE INDEX IF NOT EXISTS mining_ingot_reservations_epoch_order ON public.mining_ingot_reservations(epoch_id,base_id,id);
REVOKE ALL ON public.mining_publication_attempts FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_publication_attempt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source_count integer; source_rows jsonb; source_total bigint;
BEGIN
 IF TG_RELID<>'public.mining_publication_attempts'::regclass THEN
  RAISE EXCEPTION 'MINING_PUBLICATION_TRIGGER_IDENTITY' USING ERRCODE='42501'; END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_PUBLICATION_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid=TG_RELID) THEN
  RAISE EXCEPTION 'MINING_PUBLICATION_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'MINING_PUBLICATION_READ_COMMITTED_REQUIRED' USING ERRCODE='25000'; END IF;
 IF NEW.intent_sha256 IS NOT NULL OR NEW.reservations IS NOT NULL OR NEW.reservations_sha256 IS NOT NULL
  OR NEW.reservation_count IS NOT NULL OR NEW.reserved_ingots IS NOT NULL OR NEW.prepared_at IS NOT NULL THEN
  RAISE EXCEPTION 'MINING_PUBLICATION_DERIVED_FIELDS' USING ERRCODE='23514'; END IF;
 PERFORM id FROM public.mining_ingot_epochs WHERE id=NEW.epoch_id FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'MINING_PUBLICATION_EPOCH_UNAVAILABLE' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.mining_ingot_aborts WHERE epoch_id=NEW.epoch_id) THEN
  RAISE EXCEPTION 'MINING_PUBLICATION_ABORTED' USING ERRCODE='23514'; END IF;
 -- The epoch lock is also taken by reservation/abort INSERT guards. Count a
 -- bounded indexed prefix before creating JSON; never trust caller aggregates.
 SELECT count(*) INTO source_count FROM (SELECT id FROM public.mining_ingot_reservations WHERE epoch_id=NEW.epoch_id LIMIT 10001) bounded;
 IF source_count=0 THEN RAISE EXCEPTION 'MINING_PUBLICATION_EMPTY' USING ERRCODE='23514'; END IF;
 IF source_count>10000 THEN RAISE EXCEPTION 'MINING_PUBLICATION_TOO_LARGE' USING ERRCODE='23514'; END IF;
 SELECT jsonb_agg(jsonb_build_object('reservationId',id,'baseId',base_id,'actorWallet',actor_wallet,'ingots',qty) ORDER BY base_id,id),sum(qty)::bigint
  INTO source_rows,source_total FROM public.mining_ingot_reservations WHERE epoch_id=NEW.epoch_id;
 NEW.intent_sha256:=encode(sha256(NEW.intent_bytes),'hex');
 NEW.reservations:=source_rows; NEW.reservations_sha256:=encode(sha256(convert_to(source_rows::text,'UTF8')),'hex');
 NEW.reservation_count:=source_count; NEW.reserved_ingots:=source_total; NEW.prepared_at:=clock_timestamp();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_mining_publication_attempt_guard() FROM PUBLIC;
CREATE OR REPLACE TRIGGER mining_publication_attempts_history BEFORE INSERT OR UPDATE OR DELETE ON public.mining_publication_attempts
 FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_publication_attempt_guard();
CREATE OR REPLACE TRIGGER mining_publication_attempts_truncate BEFORE TRUNCATE ON public.mining_publication_attempts
 FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_publication_attempt_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_publication_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID NOT IN ('public.mining_ingot_reservations'::regclass,'public.mining_ingot_aborts'::regclass) OR TG_OP<>'INSERT' THEN
  RAISE EXCEPTION 'MINING_PUBLICATION_TRIGGER_IDENTITY' USING ERRCODE='42501'; END IF;
 -- Must precede every lookup: an old RR snapshot cannot hide a newer fence.
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'MINING_PUBLICATION_READ_COMMITTED_REQUIRED' USING ERRCODE='25000'; END IF;
 PERFORM id FROM public.mining_ingot_epochs WHERE id=NEW.epoch_id FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'MINING_PUBLICATION_EPOCH_UNAVAILABLE' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.mining_publication_attempts WHERE epoch_id=NEW.epoch_id) THEN
  RAISE EXCEPTION 'MINING_PUBLICATION_FENCED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_mining_publication_source_guard() FROM PUBLIC;
-- Alphabetically before the original history guards: fail fast before their
-- blocking lock while preserving all original source/paid-stock validation.
CREATE OR REPLACE TRIGGER aaa_mining_publication_fence BEFORE INSERT ON public.mining_ingot_reservations
 FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_publication_source_guard();
CREATE OR REPLACE TRIGGER aaa_mining_publication_fence BEFORE INSERT ON public.mining_ingot_aborts
 FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_publication_source_guard();
