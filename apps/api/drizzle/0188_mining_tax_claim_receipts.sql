-- Owner-verified original KEEP tax success; setup prefix is never terminal payment.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS mining_tax_claim_receipts (
 claim_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 1),wallet text NOT NULL,idempotency_key uuid NOT NULL,
 receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=16384),
 settled_at timestamptz NOT NULL CHECK(isfinite(settled_at)),PRIMARY KEY(claim_id,ordinal),UNIQUE(wallet,idempotency_key,ordinal),
 FOREIGN KEY(claim_id,ordinal) REFERENCES mining_tax_claim_signed_wires(claim_id,ordinal)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_tax_receipt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.mining_tax_claim_preparations%ROWTYPE; w public.mining_tax_claim_signed_wires%ROWTYPE;
 a jsonb; r jsonb; s jsonb; t jsonb; v text; idx integer:=0; count_tx integer; n numeric; encoded text; i integer;
 alphabet text:='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; fees numeric:=0; rents numeric:=0; paid numeric:=0; floor_slot numeric;
BEGIN
 IF TG_RELID<>'public.mining_tax_claim_receipts'::regclass OR TG_WHEN<>'BEFORE'
 OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'mining_tax_claim_receipts_no_truncate' ELSE 'mining_tax_claim_receipts_immutable' END)
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'MINING_TAX_RECEIPT_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_TAX_RECEIPT_IMMUTABLE';END IF;
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'MINING_TAX_RECEIPT_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_TAX_RECEIPT_READ_COMMITTED';END IF;
 IF NEW.wallet IS NOT NULL OR NEW.idempotency_key IS NOT NULL OR NEW.settled_at IS NOT NULL THEN RAISE EXCEPTION 'MINING_TAX_RECEIPT_DERIVED';END IF;
 SELECT * INTO STRICT p FROM public.mining_tax_claim_preparations WHERE claim_id=NEW.claim_id;
 a:=p.artifact;r:=NEW.receipt;s:=r->'source';
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR octet_length(r::text)>16384 OR jsonb_typeof(s) IS DISTINCT FROM 'object' OR jsonb_typeof(r->'transactions') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'MINING_TAX_RECEIPT_INPUT';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(r) k WHERE k<>ALL(ARRAY['version','phase','wallet','round','spot','term','pool','cursor','paidKeepBaseUnits','feeLamports','rentLamports','transactions','source','finalityAuthenticated','currentClaimsAuthorized','journalClearingAuthorized','signingAuthorized','broadcastAuthorized']))
 OR r->'version' IS DISTINCT FROM '1'::jsonb OR r->'finalityAuthenticated' IS DISTINCT FROM 'true'::jsonb
 OR r->'currentClaimsAuthorized' IS DISTINCT FROM 'false'::jsonb OR r->'journalClearingAuthorized' IS DISTINCT FROM 'false'::jsonb
 OR r->'signingAuthorized' IS DISTINCT FROM 'false'::jsonb OR r->'broadcastAuthorized' IS DISTINCT FROM 'false'::jsonb
 OR r->>'wallet' IS DISTINCT FROM p.wallet OR r->'round' IS DISTINCT FROM a->'round' OR r->'spot' IS DISTINCT FROM a->'spot'
 OR r->'term' IS DISTINCT FROM a->'identity'->'term' OR r->'pool' IS DISTINCT FROM a->'identity'->'pool' OR r->'cursor' IS DISTINCT FROM a->'identity'->'cursor'
 OR s->>'trust' IS DISTINCT FROM 'trusted-finalized-rpc-reviewed-program' OR s->'genesisHash' IS DISTINCT FROM a->'identity'->'genesisHash'
 OR s->'programId' IS DISTINCT FROM a->'identity'->'programId' OR s->'reviewedDeploymentSlot' IS DISTINCT FROM a->'source'->'reviewedDeploymentSlot'
 OR s->'reviewedProgramDataSha256' IS DISTINCT FROM a->'source'->'reviewedProgramDataSha256' THEN RAISE EXCEPTION 'MINING_TAX_RECEIPT_SOURCE';END IF;
 count_tx:=jsonb_array_length(a->'transactions');
 IF NEW.ordinal IS NULL OR NEW.ordinal<0 OR NEW.ordinal>=count_tx OR jsonb_array_length(r->'transactions')<>NEW.ordinal+1
 OR r->>'phase' IS DISTINCT FROM (CASE WHEN NEW.ordinal=count_tx-1 THEN 'settled' ELSE 'setup' END) THEN RAISE EXCEPTION 'MINING_TAX_RECEIPT_SOURCE';END IF;
 FOREACH v IN ARRAY ARRAY['paidKeepBaseUnits','feeLamports','rentLamports'] LOOP
  IF jsonb_typeof(r->v) IS DISTINCT FROM 'string' OR (r->>v ~ '^(0|[1-9][0-9]{0,19})$') IS DISTINCT FROM true OR (r->>v)::numeric>18446744073709551615 THEN RAISE EXCEPTION 'MINING_TAX_RECEIPT_INPUT';END IF;
 END LOOP;
 floor_slot:=greatest((a#>>'{source,snapshotSlot}')::numeric,(a#>>'{source,blockhashSlot}')::numeric);
 FOR t IN SELECT value FROM jsonb_array_elements(r->'transactions') LOOP
  SELECT * INTO STRICT w FROM public.mining_tax_claim_signed_wires WHERE claim_id=NEW.claim_id AND ordinal=idx;
  n:=0;encoded:='';FOR i IN 0..63 LOOP n:=n*256+get_byte(w.signature,i);END LOOP;
  WHILE n>0 LOOP encoded:=substr(alphabet,mod(n,58)::integer+1,1)||encoded;n:=div(n,58);END LOOP;
  FOR i IN 0..63 LOOP EXIT WHEN get_byte(w.signature,i)<>0;encoded:='1'||encoded;END LOOP;
  IF jsonb_typeof(t) IS DISTINCT FROM 'object' OR t->>'signature' IS DISTINCT FROM encoded OR t->>'messageSha256' IS DISTINCT FROM w.message_sha256
  OR t->>'signedTransactionSha256' IS DISTINCT FROM w.wire_sha256 OR t->>'kind' IS DISTINCT FROM a#>>ARRAY['transactions',idx::text,'kind']
  OR w.wallet IS DISTINCT FROM p.wallet OR w.idempotency_key IS DISTINCT FROM p.idempotency_key THEN RAISE EXCEPTION 'MINING_TAX_RECEIPT_SOURCE';END IF;
  FOREACH v IN ARRAY ARRAY['slot','blockTime','observedAccountSlot'] LOOP
   IF jsonb_typeof(t->v) IS DISTINCT FROM 'number' OR (t->>v ~ '^(0|[1-9][0-9]{0,15})$') IS DISTINCT FROM true OR (t->>v)::numeric>9007199254740991 THEN RAISE EXCEPTION 'MINING_TAX_RECEIPT_INPUT';END IF;
  END LOOP;
  IF (t->>'slot')::numeric<floor_slot OR (t->>'slot')::numeric<=(s->>'reviewedDeploymentSlot')::numeric OR (t->>'observedAccountSlot')::numeric<(t->>'slot')::numeric THEN RAISE EXCEPTION 'MINING_TAX_RECEIPT_SOURCE';END IF;
  floor_slot:=(t->>'slot')::numeric;
  FOREACH v IN ARRAY ARRAY['paidKeepBaseUnits','feeLamports','rentLamports','currentPoolAccrued','currentPoolPaid','currentClaimedTotal','currentGlobalTaxPaid'] LOOP
   IF jsonb_typeof(t->v) IS DISTINCT FROM 'string' OR (t->>v ~ '^(0|[1-9][0-9]{0,19})$') IS DISTINCT FROM true OR (t->>v)::numeric>18446744073709551615 THEN RAISE EXCEPTION 'MINING_TAX_RECEIPT_INPUT';END IF;
  END LOOP;
  IF t->>'kind'='setup' THEN
   IF t->>'paidKeepBaseUnits'<>'0' OR t->'claimedCumulativeBaseUnits' IS DISTINCT FROM 'null'::jsonb OR t->'poolPaidAfterClaimBaseUnits' IS DISTINCT FROM 'null'::jsonb OR t->'globalTaxPaidAfterClaimBaseUnits' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'MINING_TAX_RECEIPT_PAYMENT';END IF;
  ELSE
   IF t->'paidKeepBaseUnits' IS DISTINCT FROM a->'intended'->'claimBaseUnits' OR t->'claimedCumulativeBaseUnits' IS DISTINCT FROM a->'intended'->'cumulativeBaseUnits' THEN RAISE EXCEPTION 'MINING_TAX_RECEIPT_PAYMENT';END IF;
   FOREACH v IN ARRAY ARRAY['claimedCumulativeBaseUnits','poolPaidAfterClaimBaseUnits','globalTaxPaidAfterClaimBaseUnits'] LOOP
    IF jsonb_typeof(t->v) IS DISTINCT FROM 'string' OR (t->>v ~ '^(0|[1-9][0-9]{0,19})$') IS DISTINCT FROM true OR (t->>v)::numeric>18446744073709551615 THEN RAISE EXCEPTION 'MINING_TAX_RECEIPT_INPUT';END IF;
   END LOOP;
   IF (t->>'currentClaimedTotal')::numeric<(t->>'claimedCumulativeBaseUnits')::numeric OR (t->>'currentPoolPaid')::numeric<(t->>'poolPaidAfterClaimBaseUnits')::numeric OR (t->>'currentGlobalTaxPaid')::numeric<(t->>'globalTaxPaidAfterClaimBaseUnits')::numeric THEN RAISE EXCEPTION 'MINING_TAX_RECEIPT_PAYMENT';END IF;
  END IF;
  IF (t->>'currentPoolPaid')::numeric>(t->>'currentPoolAccrued')::numeric OR (t->>'currentClaimedTotal')::numeric>(t->>'currentPoolPaid')::numeric OR (t->>'currentPoolPaid')::numeric>(t->>'currentGlobalTaxPaid')::numeric THEN RAISE EXCEPTION 'MINING_TAX_RECEIPT_PAYMENT';END IF;
  paid:=paid+(t->>'paidKeepBaseUnits')::numeric;fees:=fees+(t->>'feeLamports')::numeric;rents:=rents+(t->>'rentLamports')::numeric;idx:=idx+1;
 END LOOP;
 IF paid<>(r->>'paidKeepBaseUnits')::numeric OR fees<>(r->>'feeLamports')::numeric OR rents<>(r->>'rentLamports')::numeric
 OR fees>(a#>>'{caps,maxFeeLamports}')::numeric OR rents>(a#>>'{caps,maxRentLamports}')::numeric OR fees+rents>(a#>>'{caps,maxTotalLamports}')::numeric THEN RAISE EXCEPTION 'MINING_TAX_RECEIPT_PAYMENT';END IF;
 NEW.wallet:=p.wallet;NEW.idempotency_key:=p.idempotency_key;NEW.settled_at:=clock_timestamp();RETURN NEW;
END $$;
--> statement-breakpoint
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_tax_claim_receipts'::regclass AND tgname='mining_tax_claim_receipts_immutable') THEN
 CREATE TRIGGER mining_tax_claim_receipts_immutable BEFORE INSERT OR UPDATE OR DELETE ON mining_tax_claim_receipts FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_tax_receipt_guard();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_tax_claim_receipts'::regclass AND tgname='mining_tax_claim_receipts_no_truncate') THEN
 CREATE TRIGGER mining_tax_claim_receipts_no_truncate BEFORE TRUNCATE ON mining_tax_claim_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_tax_receipt_guard();END IF;
END $$;
REVOKE ALL ON mining_tax_claim_receipts FROM PUBLIC;
--> statement-breakpoint
DO $$BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shardkeep_api_runtime') THEN
 REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON mining_tax_claim_receipts FROM shardkeep_api_runtime;GRANT SELECT ON mining_tax_claim_receipts TO shardkeep_api_runtime;END IF;
END $$;
