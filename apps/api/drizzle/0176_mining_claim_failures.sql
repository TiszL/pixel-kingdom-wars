-- Owner-verified finalized execution failure. Runtime callers may only recover receipts.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS mining_claim_failures (
 claim_id uuid NOT NULL,ordinal integer NOT NULL,wallet text NOT NULL,
 receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=8192),
 verified_at timestamptz NOT NULL CHECK(isfinite(verified_at)),PRIMARY KEY(claim_id,ordinal),
 FOREIGN KEY(claim_id,ordinal) REFERENCES mining_claim_signed_wires(claim_id,ordinal)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_claim_failure_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.mining_claim_preparations%ROWTYPE; w public.mining_claim_signed_wires%ROWTYPE; a jsonb; r jsonb; s jsonb;
 n numeric:=0; encoded text:=''; alphabet text:='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';i integer;v text;
BEGIN
 IF TG_RELID<>'public.mining_claim_failures'::regclass OR TG_WHEN<>'BEFORE'
 OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'mining_claim_failures_no_truncate' ELSE 'mining_claim_failures_immutable' END)
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'MINING_CLAIM_FAILURE_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_CLAIM_FAILURE_IMMUTABLE';END IF;
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'MINING_CLAIM_FAILURE_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_CLAIM_FAILURE_READ_COMMITTED';END IF;
 IF NEW.wallet IS NOT NULL OR NEW.verified_at IS NOT NULL THEN RAISE EXCEPTION 'MINING_CLAIM_FAILURE_DERIVED';END IF;
 SELECT * INTO STRICT w FROM public.mining_claim_signed_wires WHERE claim_id=NEW.claim_id AND ordinal=NEW.ordinal FOR UPDATE;
 SELECT * INTO STRICT p FROM public.mining_claim_preparations WHERE claim_id=NEW.claim_id;
 a:=p.artifact;r:=NEW.receipt;s:=r->'source';
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR octet_length(r::text)>8192 OR jsonb_typeof(s) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'MINING_CLAIM_FAILURE_INPUT';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(r) k WHERE k<>ALL(ARRAY['version','kind','wallet','day','sequence','root','signature','slot','blockTime','observedAccountSlot','originalMessageSha256','signedTransactionSha256','source','outcome','paymentAuthorized']))
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(s) k WHERE k<>ALL(ARRAY['trust','genesisHash','programId','configAddress','sourceHash','reviewedDeploymentSlot','reviewedProgramDataSha256'])) THEN RAISE EXCEPTION 'MINING_CLAIM_FAILURE_INPUT';END IF;
 -- Base58 encoding of the already fixed64-byte original signature is bounded.
 FOR i IN 0..63 LOOP n:=n*256+get_byte(w.signature,i);END LOOP;
 -- div is exact integer division. Numeric / may round a 512-bit quotient
 -- before truncation, changing base58 digits even though every byte is valid.
 WHILE n>0 LOOP encoded:=substr(alphabet,mod(n,58)::integer+1,1)||encoded;n:=div(n,58);END LOOP;
 FOR i IN 0..63 LOOP EXIT WHEN get_byte(w.signature,i)<>0;encoded:='1'||encoded;END LOOP;
 IF r->'version' IS DISTINCT FROM '1'::jsonb OR r->>'outcome' IS DISTINCT FROM 'failed' OR r->'paymentAuthorized' IS DISTINCT FROM 'false'::jsonb
 OR r->>'wallet' IS DISTINCT FROM w.wallet OR w.wallet IS DISTINCT FROM p.wallet OR r->>'signature' IS DISTINCT FROM encoded
 OR r->>'originalMessageSha256' IS DISTINCT FROM w.message_sha256 OR r->>'signedTransactionSha256' IS DISTINCT FROM w.wire_sha256
 OR r->>'kind' IS DISTINCT FROM a#>>ARRAY['transactions',NEW.ordinal::text,'kind'] OR r->>'sequence' IS DISTINCT FROM a#>>'{header,sequence}'
 OR r->>'day' IS DISTINCT FROM a#>>'{header,day}' OR r->>'root' IS DISTINCT FROM a#>>'{header,root}'
 OR s->>'trust' IS DISTINCT FROM 'trusted-finalized-rpc-reviewed-program' OR s->>'genesisHash' IS DISTINCT FROM a#>>'{header,genesisHash}'
 OR s->>'programId' IS DISTINCT FROM a#>>'{header,programId}' OR s->>'configAddress' IS DISTINCT FROM a#>>'{header,configAddress}' OR s->>'sourceHash' IS DISTINCT FROM a#>>'{header,sourceHash}'
 OR (s->>'reviewedProgramDataSha256' ~ '^[0-9a-f]{64}$') IS DISTINCT FROM true THEN RAISE EXCEPTION 'MINING_CLAIM_FAILURE_SOURCE';END IF;
 FOREACH v IN ARRAY ARRAY['slot','blockTime','observedAccountSlot'] LOOP
  IF jsonb_typeof(r->v) IS DISTINCT FROM 'number' OR (r->>v ~ '^(0|[1-9][0-9]{0,15})$') IS DISTINCT FROM true OR (r->>v)::numeric>9007199254740991 THEN RAISE EXCEPTION 'MINING_CLAIM_FAILURE_INPUT';END IF;
 END LOOP;
 IF jsonb_typeof(s->'reviewedDeploymentSlot') IS DISTINCT FROM 'number' OR (s->>'reviewedDeploymentSlot' ~ '^(0|[1-9][0-9]{0,15})$') IS DISTINCT FROM true OR (s->>'reviewedDeploymentSlot')::numeric>9007199254740991
 OR (r->>'slot')::numeric<=(s->>'reviewedDeploymentSlot')::numeric OR (r->>'slot')::numeric<(a->>'blockhashContextSlot')::numeric OR (r->>'observedAccountSlot')::numeric<(r->>'slot')::numeric THEN RAISE EXCEPTION 'MINING_CLAIM_FAILURE_SOURCE';END IF;
 IF EXISTS(SELECT 1 FROM public.mining_claim_receipts WHERE claim_id=NEW.claim_id AND ordinal=NEW.ordinal) THEN RAISE EXCEPTION 'MINING_CLAIM_TERMINAL_CONFLICT';END IF;
 NEW.wallet:=w.wallet;NEW.verified_at:=clock_timestamp();RETURN NEW;
END $$;
--> statement-breakpoint
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_claim_failures'::regclass AND tgname='mining_claim_failures_immutable') THEN
  CREATE TRIGGER mining_claim_failures_immutable BEFORE INSERT OR UPDATE OR DELETE ON mining_claim_failures FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_claim_failure_guard();
  CREATE TRIGGER mining_claim_failures_no_truncate BEFORE TRUNCATE ON mining_claim_failures FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_claim_failure_guard();
 END IF;
END $$;
REVOKE ALL ON mining_claim_failures FROM PUBLIC;
--> statement-breakpoint
DO $$BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shardkeep_api_runtime') THEN
  REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON mining_claim_failures FROM shardkeep_api_runtime;
  GRANT SELECT ON mining_claim_failures TO shardkeep_api_runtime;
 END IF;
END $$;

--> statement-breakpoint
-- S5 HELD: additive guard on the existing success table; no old receipt rewrite.
-- Both writers require READ COMMITTED and lock the same signed row. The volatile
-- trigger's post-lock query sees the preceding committed opposite receipt.
CREATE OR REPLACE FUNCTION public.shardkeep_mining_claim_success_terminal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID<>'public.mining_claim_receipts'::regclass OR TG_NAME<>'mining_claim_receipts_no_failed_terminal'
 OR TG_WHEN<>'BEFORE' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'MINING_CLAIM_TERMINAL_TRIGGER';END IF;
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'MINING_CLAIM_RECEIPT_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_CLAIM_RECEIPT_READ_COMMITTED';END IF;
 PERFORM 1 FROM public.mining_claim_signed_wires WHERE claim_id=NEW.claim_id AND ordinal=NEW.ordinal FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MINING_CLAIM_TERMINAL_UNSIGNED';END IF;
 IF EXISTS(SELECT 1 FROM public.mining_claim_failures WHERE claim_id=NEW.claim_id AND ordinal=NEW.ordinal) THEN RAISE EXCEPTION 'MINING_CLAIM_TERMINAL_CONFLICT';END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_claim_receipts'::regclass AND tgname='mining_claim_receipts_no_failed_terminal') THEN
  CREATE TRIGGER mining_claim_receipts_no_failed_terminal BEFORE INSERT ON mining_claim_receipts FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_claim_success_terminal_guard();
 END IF;
END $$;
