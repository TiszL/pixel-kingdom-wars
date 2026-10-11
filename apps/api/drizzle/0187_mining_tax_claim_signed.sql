-- Exact original KEEP tax signatures, retained without relay/payment authority.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS mining_tax_claim_signed_wires (
 claim_id uuid NOT NULL REFERENCES mining_tax_claim_preparations(claim_id),
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 1),wallet text NOT NULL,idempotency_key uuid NOT NULL,
 signed_transaction bytea NOT NULL CHECK(octet_length(signed_transaction) BETWEEN 66 AND 1232),
 signature bytea NOT NULL UNIQUE CHECK(octet_length(signature)=64),
 wire_sha256 text NOT NULL UNIQUE CHECK(wire_sha256~'^[0-9a-f]{64}$'),message_sha256 text NOT NULL CHECK(message_sha256~'^[0-9a-f]{64}$'),
 accepted_at timestamptz NOT NULL CHECK(isfinite(accepted_at)),PRIMARY KEY(claim_id,ordinal),UNIQUE(wallet,idempotency_key,ordinal)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_tax_signed_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.mining_tax_claim_preparations%ROWTYPE; message bytea; matches integer; tx_count integer;
BEGIN
 IF TG_RELID<>'public.mining_tax_claim_signed_wires'::regclass OR TG_WHEN<>'BEFORE'
 OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'mining_tax_claim_signed_wires_no_truncate' ELSE 'mining_tax_claim_signed_wires_immutable' END)
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'MINING_TAX_SIGNED_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_TAX_SIGNED_IMMUTABLE';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_TAX_SIGNED_READ_COMMITTED';END IF;
 IF NEW.ordinal IS NOT NULL OR NEW.wallet IS NOT NULL OR NEW.idempotency_key IS NOT NULL OR NEW.signature IS NOT NULL OR NEW.wire_sha256 IS NOT NULL OR NEW.message_sha256 IS NOT NULL OR NEW.accepted_at IS NOT NULL THEN RAISE EXCEPTION 'MINING_TAX_SIGNED_DERIVED';END IF;
 IF NEW.signed_transaction IS NULL OR octet_length(NEW.signed_transaction) NOT BETWEEN 66 AND 1232 THEN RAISE EXCEPTION 'MINING_TAX_SIGNED_WIRE';END IF;
 IF get_byte(NEW.signed_transaction,0)<>1 OR get_byte(NEW.signed_transaction,65)<>1 THEN RAISE EXCEPTION 'MINING_TAX_SIGNED_WIRE';END IF;
 SELECT * INTO p FROM public.mining_tax_claim_preparations WHERE claim_id=NEW.claim_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'MINING_TAX_SIGNED_PREPARATION';END IF;
 tx_count:=jsonb_array_length(p.artifact->'transactions');
 IF tx_count NOT BETWEEN 1 AND 2 OR p.artifact#>'{transactions,0,ordinal}' IS DISTINCT FROM '0'::jsonb
 OR (tx_count=1 AND (p.artifact#>>'{transactions,0,kind}' IN ('claim','combined')) IS DISTINCT FROM true)
 OR (tx_count=2 AND (p.artifact#>>'{transactions,0,kind}' IS DISTINCT FROM 'setup' OR p.artifact#>>'{transactions,1,kind}' IS DISTINCT FROM 'claim' OR p.artifact#>'{transactions,1,ordinal}' IS DISTINCT FROM '1'::jsonb)) THEN RAISE EXCEPTION 'MINING_TAX_SIGNED_ROSTER';END IF;
 message:=substring(NEW.signed_transaction FROM 66);
 SELECT count(*),min((n-1)::integer) INTO matches,NEW.ordinal FROM jsonb_array_elements(p.artifact->'transactions') WITH ORDINALITY t(value,n)
  WHERE value->>'messageHex'=encode(message,'hex');
 IF matches<>1 THEN RAISE EXCEPTION 'MINING_TAX_SIGNED_MESSAGE';END IF;
 NEW.wallet:=p.wallet;NEW.idempotency_key:=p.idempotency_key;NEW.signature:=substring(NEW.signed_transaction FROM 2 FOR 64);
 IF NEW.signature=decode(repeat('00',64),'hex') THEN RAISE EXCEPTION 'MINING_TAX_SIGNED_WIRE';END IF;
 NEW.wire_sha256:=encode(sha256(NEW.signed_transaction),'hex');NEW.message_sha256:=encode(sha256(message),'hex');NEW.accepted_at:=clock_timestamp();
 IF NEW.message_sha256 IS DISTINCT FROM p.artifact#>>ARRAY['transactions',NEW.ordinal::text,'messageSha256'] THEN RAISE EXCEPTION 'MINING_TAX_SIGNED_MESSAGE';END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_tax_claim_signed_wires'::regclass AND tgname='mining_tax_claim_signed_wires_immutable') THEN
 CREATE TRIGGER mining_tax_claim_signed_wires_immutable BEFORE INSERT OR UPDATE OR DELETE ON mining_tax_claim_signed_wires FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_tax_signed_guard();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_tax_claim_signed_wires'::regclass AND tgname='mining_tax_claim_signed_wires_no_truncate') THEN
 CREATE TRIGGER mining_tax_claim_signed_wires_no_truncate BEFORE TRUNCATE ON mining_tax_claim_signed_wires FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_tax_signed_guard();END IF;
END $$;
REVOKE ALL ON mining_tax_claim_signed_wires FROM PUBLIC;
--> statement-breakpoint
DO $$BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shardkeep_api_runtime') THEN GRANT SELECT,INSERT ON mining_tax_claim_signed_wires TO shardkeep_api_runtime;END IF;
END $$;
