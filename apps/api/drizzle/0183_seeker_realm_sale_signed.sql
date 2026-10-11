-- Permanent buyer-signed sale packets, never broadcast or current admission authority.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS seeker_realm_sale_signed_wires (
 wallet text NOT NULL,idempotency_key uuid NOT NULL,sale_id text NOT NULL,
 signed_transaction bytea NOT NULL CHECK(octet_length(signed_transaction) BETWEEN 66 AND 1232),
 signature bytea NOT NULL UNIQUE CHECK(octet_length(signature)=64),
 wire_sha256 text NOT NULL CHECK(wire_sha256~'^[0-9a-f]{64}$'),
 message_sha256 text NOT NULL CHECK(message_sha256~'^[0-9a-f]{64}$'),
 accepted_at timestamptz NOT NULL CHECK(isfinite(accepted_at)),
 PRIMARY KEY(wallet,idempotency_key),UNIQUE(wallet,sale_id),
 FOREIGN KEY(wallet,idempotency_key) REFERENCES seeker_realm_sale_preparations(wallet,idempotency_key),
 FOREIGN KEY(wallet,sale_id) REFERENCES seeker_realm_sale_preparations(wallet,sale_id)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_realm_sale_signed_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.seeker_realm_sale_preparations%ROWTYPE; message bytea;
BEGIN
 IF TG_RELID<>'public.seeker_realm_sale_signed_wires'::regclass OR TG_WHEN<>'BEFORE'
 OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'seeker_realm_sale_signed_wires_no_truncate' ELSE 'seeker_realm_sale_signed_wires_immutable' END)
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'REALM_SALE_SIGNED_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'REALM_SALE_SIGNED_IMMUTABLE';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'REALM_SALE_SIGNED_READ_COMMITTED';END IF;
 IF NEW.sale_id IS NOT NULL OR NEW.signature IS NOT NULL OR NEW.wire_sha256 IS NOT NULL OR NEW.message_sha256 IS NOT NULL OR NEW.accepted_at IS NOT NULL THEN RAISE EXCEPTION 'REALM_SALE_SIGNED_DERIVED';END IF;
 IF NEW.signed_transaction IS NULL OR octet_length(NEW.signed_transaction) NOT BETWEEN 66 AND 1232 THEN RAISE EXCEPTION 'REALM_SALE_SIGNED_WIRE';END IF;
 IF get_byte(NEW.signed_transaction,0)<>1 OR get_byte(NEW.signed_transaction,65)<>1 THEN RAISE EXCEPTION 'REALM_SALE_SIGNED_WIRE';END IF;
 SELECT * INTO p FROM public.seeker_realm_sale_preparations WHERE wallet=NEW.wallet AND idempotency_key=NEW.idempotency_key;
 IF NOT FOUND THEN RAISE EXCEPTION 'REALM_SALE_SIGNED_PREPARATION';END IF;
 message:=substring(NEW.signed_transaction FROM 66);
 IF encode(message,'hex') IS DISTINCT FROM p.artifact#>>'{quote,messageHex}' THEN RAISE EXCEPTION 'REALM_SALE_SIGNED_MESSAGE';END IF;
 NEW.sale_id:=p.sale_id;NEW.signature:=substring(NEW.signed_transaction FROM 2 FOR 64);
 IF NEW.signature=decode(repeat('00',64),'hex') THEN RAISE EXCEPTION 'REALM_SALE_SIGNED_WIRE';END IF;
 NEW.wire_sha256:=encode(sha256(NEW.signed_transaction),'hex');NEW.message_sha256:=encode(sha256(message),'hex');NEW.accepted_at:=clock_timestamp();
 IF NEW.message_sha256 IS DISTINCT FROM p.artifact#>>'{quote,messageSha256}' THEN RAISE EXCEPTION 'REALM_SALE_SIGNED_MESSAGE';END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.seeker_realm_sale_signed_wires'::regclass AND tgname='seeker_realm_sale_signed_wires_immutable') THEN
  CREATE TRIGGER seeker_realm_sale_signed_wires_immutable BEFORE INSERT OR UPDATE OR DELETE ON seeker_realm_sale_signed_wires FOR EACH ROW EXECUTE FUNCTION public.shardkeep_realm_sale_signed_guard();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.seeker_realm_sale_signed_wires'::regclass AND tgname='seeker_realm_sale_signed_wires_no_truncate') THEN
  CREATE TRIGGER seeker_realm_sale_signed_wires_no_truncate BEFORE TRUNCATE ON seeker_realm_sale_signed_wires FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_realm_sale_signed_guard();
 END IF;
END $$;
REVOKE ALL ON seeker_realm_sale_signed_wires FROM PUBLIC;
--> statement-breakpoint
DO $$BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shardkeep_api_runtime') THEN GRANT SELECT,INSERT ON seeker_realm_sale_signed_wires TO shardkeep_api_runtime;END IF;
END $$;
