-- Owner-verified exact packet failure; never whole-plan completion or retry consent.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS mining_tax_claim_failures (
 claim_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 1),wallet text NOT NULL,idempotency_key uuid NOT NULL,
 receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=8192),
 verified_at timestamptz NOT NULL CHECK(isfinite(verified_at)),PRIMARY KEY(claim_id,ordinal),UNIQUE(wallet,idempotency_key,ordinal),
 FOREIGN KEY(claim_id,ordinal) REFERENCES mining_tax_claim_signed_wires(claim_id,ordinal)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_tax_failure_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.mining_tax_claim_preparations%ROWTYPE; w public.mining_tax_claim_signed_wires%ROWTYPE;
 a jsonb;r jsonb;s jsonb;v text;i integer;n numeric:=0;encoded text:='';alphabet text:='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
BEGIN
 IF TG_RELID<>'public.mining_tax_claim_failures'::regclass OR TG_WHEN<>'BEFORE'
 OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'mining_tax_claim_failures_no_truncate' ELSE 'mining_tax_claim_failures_immutable' END)
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'MINING_TAX_FAILURE_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_TAX_FAILURE_IMMUTABLE';END IF;
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'MINING_TAX_FAILURE_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_TAX_FAILURE_READ_COMMITTED';END IF;
 IF NEW.wallet IS NOT NULL OR NEW.idempotency_key IS NOT NULL OR NEW.verified_at IS NOT NULL THEN RAISE EXCEPTION 'MINING_TAX_FAILURE_DERIVED';END IF;
 SELECT * INTO STRICT p FROM public.mining_tax_claim_preparations WHERE claim_id=NEW.claim_id;
 SELECT * INTO STRICT w FROM public.mining_tax_claim_signed_wires WHERE claim_id=NEW.claim_id AND ordinal=NEW.ordinal;
 a:=p.artifact;r:=NEW.receipt;s:=r->'source';
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR octet_length(r::text)>8192 OR jsonb_typeof(s) IS DISTINCT FROM 'object'
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(r) k WHERE k<>ALL(ARRAY['version','wallet','idempotencyKey','claimId','round','spot','ordinal','kind','signature','messageSha256','signedTransactionSha256','slot','blockTime','feeLamports','rentLamports','paidKeepBaseUnits','source','outcome','finalityAuthenticated','paymentAuthorized','signingAuthorized','broadcastAuthorized','journalClearingAuthorized']))
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(s) k WHERE k<>ALL(ARRAY['trust','genesisHash','programId','configAddress','reviewedDeploymentSlot','reviewedProgramDataSha256','snapshotSha256','snapshotSlot','blockhashSlot','observedAccountSlot']))
 THEN RAISE EXCEPTION 'MINING_TAX_FAILURE_INPUT';END IF;
 IF r->'version' IS DISTINCT FROM '1'::jsonb OR r->>'outcome' IS DISTINCT FROM 'failed' OR r->'finalityAuthenticated' IS DISTINCT FROM 'true'::jsonb
 OR r->'paymentAuthorized' IS DISTINCT FROM 'false'::jsonb OR r->'signingAuthorized' IS DISTINCT FROM 'false'::jsonb
 OR r->'broadcastAuthorized' IS DISTINCT FROM 'false'::jsonb OR r->'journalClearingAuthorized' IS DISTINCT FROM 'false'::jsonb
 OR r->'rentLamports' IS DISTINCT FROM '"0"'::jsonb OR r->'paidKeepBaseUnits' IS DISTINCT FROM '"0"'::jsonb
 OR r->>'wallet' IS DISTINCT FROM p.wallet OR r->>'idempotencyKey' IS DISTINCT FROM p.idempotency_key::text OR r->>'claimId' IS DISTINCT FROM p.claim_id::text
 OR r->'round' IS DISTINCT FROM a->'round' OR r->'spot' IS DISTINCT FROM a->'spot' OR r->'ordinal' IS DISTINCT FROM to_jsonb(NEW.ordinal)
 OR r->>'kind' IS DISTINCT FROM a#>>ARRAY['transactions',NEW.ordinal::text,'kind']
 OR w.wallet IS DISTINCT FROM p.wallet OR w.idempotency_key IS DISTINCT FROM p.idempotency_key
 OR r->>'messageSha256' IS DISTINCT FROM w.message_sha256 OR r->>'signedTransactionSha256' IS DISTINCT FROM w.wire_sha256
 THEN RAISE EXCEPTION 'MINING_TAX_FAILURE_SOURCE';END IF;
 FOR i IN 0..63 LOOP n:=n*256+get_byte(w.signature,i);END LOOP;
 WHILE n>0 LOOP encoded:=substr(alphabet,mod(n,58)::integer+1,1)||encoded;n:=div(n,58);END LOOP;
 FOR i IN 0..63 LOOP EXIT WHEN get_byte(w.signature,i)<>0;encoded:='1'||encoded;END LOOP;
 IF r->>'signature' IS DISTINCT FROM encoded OR s->>'trust' IS DISTINCT FROM 'trusted-finalized-rpc-reviewed-program'
 OR s->'genesisHash' IS DISTINCT FROM a->'identity'->'genesisHash' OR s->'programId' IS DISTINCT FROM a->'identity'->'programId'
 OR s->'configAddress' IS DISTINCT FROM a->'identity'->'configAddress' THEN RAISE EXCEPTION 'MINING_TAX_FAILURE_SOURCE';END IF;
 FOREACH v IN ARRAY ARRAY['reviewedDeploymentSlot','reviewedProgramDataSha256','snapshotSha256','snapshotSlot','blockhashSlot'] LOOP
  IF s->v IS DISTINCT FROM a->'source'->v THEN RAISE EXCEPTION 'MINING_TAX_FAILURE_SOURCE';END IF;
 END LOOP;
 IF jsonb_typeof(r->'feeLamports') IS DISTINCT FROM 'string' OR (r->>'feeLamports' ~ '^(0|[1-9][0-9]{0,19})$') IS DISTINCT FROM true OR (r->>'feeLamports')::numeric>18446744073709551615 THEN RAISE EXCEPTION 'MINING_TAX_FAILURE_INPUT';END IF;
 FOREACH v IN ARRAY ARRAY['slot','blockTime'] LOOP
  IF jsonb_typeof(r->v) IS DISTINCT FROM 'number' OR (r->>v ~ '^(0|[1-9][0-9]{0,15})$') IS DISTINCT FROM true OR (r->>v)::numeric>9007199254740991 THEN RAISE EXCEPTION 'MINING_TAX_FAILURE_INPUT';END IF;
 END LOOP;
 IF jsonb_typeof(s->'observedAccountSlot') IS DISTINCT FROM 'number' OR (s->>'observedAccountSlot' ~ '^(0|[1-9][0-9]{0,15})$') IS DISTINCT FROM true OR (s->>'observedAccountSlot')::numeric>9007199254740991 THEN RAISE EXCEPTION 'MINING_TAX_FAILURE_INPUT';END IF;
 IF (r->>'slot')::numeric<= (a#>>'{source,reviewedDeploymentSlot}')::numeric
 OR (r->>'slot')::numeric<greatest((a#>>'{source,snapshotSlot}')::numeric,(a#>>'{source,blockhashSlot}')::numeric)
 OR (s->>'observedAccountSlot')::numeric<(r->>'slot')::numeric OR (r->>'blockTime')::numeric<(a#>>'{snapshot,unixTimestamp}')::numeric THEN RAISE EXCEPTION 'MINING_TAX_FAILURE_SOURCE';END IF;
 NEW.wallet:=p.wallet;NEW.idempotency_key:=p.idempotency_key;NEW.verified_at:=clock_timestamp();RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_tax_outcome_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID NOT IN ('public.mining_tax_claim_failures'::regclass,'public.mining_tax_claim_receipts'::regclass)
 OR TG_NAME<>'mining_tax_outcome_exclusive' OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'MINING_TAX_OUTCOME_TRIGGER';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_TAX_OUTCOME_READ_COMMITTED';END IF;
 -- Success ordinal1 proves BOTH packets succeeded. Serialize the whole original
 -- preparation, not just one wire; read the opposite table after obtaining lock.
 PERFORM 1 FROM public.mining_tax_claim_preparations WHERE claim_id=NEW.claim_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MINING_TAX_OUTCOME_SOURCE';END IF;
 IF TG_RELID='public.mining_tax_claim_failures'::regclass THEN
  IF EXISTS(SELECT 1 FROM public.mining_tax_claim_receipts WHERE claim_id=NEW.claim_id AND ordinal>=NEW.ordinal) THEN RAISE EXCEPTION 'MINING_TAX_OUTCOME_CONFLICT';END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM public.mining_tax_claim_failures WHERE claim_id=NEW.claim_id AND ordinal<=NEW.ordinal) THEN RAISE EXCEPTION 'MINING_TAX_OUTCOME_CONFLICT';END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_tax_claim_failures'::regclass AND tgname='mining_tax_claim_failures_immutable') THEN
 CREATE TRIGGER mining_tax_claim_failures_immutable BEFORE INSERT OR UPDATE OR DELETE ON mining_tax_claim_failures FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_tax_failure_guard();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_tax_claim_failures'::regclass AND tgname='mining_tax_claim_failures_no_truncate') THEN
 CREATE TRIGGER mining_tax_claim_failures_no_truncate BEFORE TRUNCATE ON mining_tax_claim_failures FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_tax_failure_guard();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_tax_claim_failures'::regclass AND tgname='mining_tax_outcome_exclusive') THEN
 CREATE TRIGGER mining_tax_outcome_exclusive BEFORE INSERT ON mining_tax_claim_failures FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_tax_outcome_guard();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_tax_claim_receipts'::regclass AND tgname='mining_tax_outcome_exclusive') THEN
 CREATE TRIGGER mining_tax_outcome_exclusive BEFORE INSERT ON mining_tax_claim_receipts FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_tax_outcome_guard();END IF;
END $$;
REVOKE ALL ON mining_tax_claim_failures FROM PUBLIC;
--> statement-breakpoint
DO $$BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shardkeep_api_runtime') THEN
 REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON mining_tax_claim_failures FROM shardkeep_api_runtime;GRANT SELECT ON mining_tax_claim_failures TO shardkeep_api_runtime;END IF;
END $$;
