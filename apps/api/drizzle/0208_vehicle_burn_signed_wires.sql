-- D-153.128: immutable private signed consent. SQL binds bytes, not Ed25519.
-- Application reads independently verify signatures; storage never permits relay.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS vehicle_burn_signed_wires (
 reservation_id uuid PRIMARY KEY REFERENCES vehicle_burn_preparations(reservation_id) ON DELETE RESTRICT,
 wallet text NOT NULL,signed_transaction bytea NOT NULL CHECK(octet_length(signed_transaction) BETWEEN 66 AND 1232),
 signature bytea NOT NULL UNIQUE CHECK(octet_length(signature)=64),
 wire_sha256 text NOT NULL UNIQUE CHECK(wire_sha256~'^[0-9a-f]{64}$'),
 message_sha256 text NOT NULL CHECK(message_sha256~'^[0-9a-f]{64}$'),
 accepted_at timestamptz NOT NULL CHECK(isfinite(accepted_at))
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_vehicle_signed_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.vehicle_burn_preparations%ROWTYPE;message bytea;
BEGIN
 IF TG_RELID<>'public.vehicle_burn_signed_wires'::regclass OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'vehicle_burn_signed_wires_no_truncate' ELSE 'vehicle_burn_signed_wires_guard' END)
 OR TG_WHEN<>'BEFORE' OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'VEHICLE_SIGNED_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'VEHICLE_SIGNED_IMMUTABLE';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'VEHICLE_SIGNED_OWNER' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'VEHICLE_SIGNED_READ_COMMITTED';END IF;
 IF NEW.wallet IS NOT NULL OR NEW.signature IS NOT NULL OR NEW.wire_sha256 IS NOT NULL OR NEW.message_sha256 IS NOT NULL OR NEW.accepted_at IS NOT NULL THEN RAISE EXCEPTION 'VEHICLE_SIGNED_DERIVED';END IF;
 IF NEW.signed_transaction IS NULL OR octet_length(NEW.signed_transaction) NOT BETWEEN 66 AND 1232 THEN RAISE EXCEPTION 'VEHICLE_SIGNED_WIRE';END IF;
 IF get_byte(NEW.signed_transaction,0)<>1 OR get_byte(NEW.signed_transaction,65)<>1 THEN RAISE EXCEPTION 'VEHICLE_SIGNED_WIRE';END IF;
 PERFORM id FROM public.vehicle_activation_reservations WHERE id=NEW.reservation_id FOR UPDATE;
 SELECT * INTO STRICT p FROM public.vehicle_burn_preparations WHERE reservation_id=NEW.reservation_id FOR UPDATE;
 message:=substring(NEW.signed_transaction FROM 66);
 IF message IS DISTINCT FROM p.message_bytes THEN RAISE EXCEPTION 'VEHICLE_SIGNED_MESSAGE';END IF;
 NEW.signature:=substring(NEW.signed_transaction FROM 2 FOR 64);
 IF NEW.signature=decode(repeat('00',64),'hex') THEN RAISE EXCEPTION 'VEHICLE_SIGNED_WIRE';END IF;
 NEW.wallet:=p.wallet;NEW.wire_sha256:=encode(sha256(NEW.signed_transaction),'hex');NEW.message_sha256:=encode(sha256(message),'hex');NEW.accepted_at:=clock_timestamp();
 IF NEW.message_sha256 IS DISTINCT FROM p.message_sha256 THEN RAISE EXCEPTION 'VEHICLE_SIGNED_MESSAGE';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_vehicle_signed_guard() FROM PUBLIC;
DO $migration$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.vehicle_burn_signed_wires'::regclass AND tgname='vehicle_burn_signed_wires_guard') THEN
 CREATE TRIGGER vehicle_burn_signed_wires_guard BEFORE INSERT OR UPDATE OR DELETE ON public.vehicle_burn_signed_wires FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_signed_guard();
 CREATE TRIGGER vehicle_burn_signed_wires_no_truncate BEFORE TRUNCATE ON public.vehicle_burn_signed_wires FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_vehicle_signed_guard();END IF;
END $migration$;
REVOKE ALL ON vehicle_burn_signed_wires FROM PUBLIC;
