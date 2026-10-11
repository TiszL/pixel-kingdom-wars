-- Owner-attested finalized success; runtime recovery only, no failure release.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS seeker_realm_sale_receipts (
 wallet text NOT NULL,idempotency_key uuid NOT NULL,sale_id text NOT NULL,
 receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=16384),
 settled_at timestamptz NOT NULL CHECK(isfinite(settled_at)),PRIMARY KEY(wallet,idempotency_key),UNIQUE(wallet,sale_id),
 FOREIGN KEY(wallet,idempotency_key) REFERENCES seeker_realm_sale_signed_wires(wallet,idempotency_key),
 FOREIGN KEY(wallet,sale_id) REFERENCES seeker_realm_sale_signed_wires(wallet,sale_id)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_realm_sale_receipt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.seeker_realm_sale_preparations%ROWTYPE;w public.seeker_realm_sale_signed_wires%ROWTYPE;
 r jsonb;s jsonb;a jsonb;n numeric:=0;encoded text:='';alphabet text:='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';i integer;v text;total numeric:=0;
BEGIN
 IF TG_RELID<>'public.seeker_realm_sale_receipts'::regclass OR TG_WHEN<>'BEFORE'
 OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'seeker_realm_sale_receipts_no_truncate' ELSE 'seeker_realm_sale_receipts_immutable' END)
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'REALM_SALE_RECEIPT_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'REALM_SALE_RECEIPT_IMMUTABLE';END IF;
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'REALM_SALE_RECEIPT_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'REALM_SALE_RECEIPT_READ_COMMITTED';END IF;
 IF NEW.sale_id IS NOT NULL OR NEW.settled_at IS NOT NULL THEN RAISE EXCEPTION 'REALM_SALE_RECEIPT_DERIVED';END IF;
 SELECT * INTO w FROM public.seeker_realm_sale_signed_wires WHERE wallet=NEW.wallet AND idempotency_key=NEW.idempotency_key;
 IF NOT FOUND THEN RAISE EXCEPTION 'REALM_SALE_RECEIPT_SIGNED';END IF;
 SELECT * INTO STRICT p FROM public.seeker_realm_sale_preparations WHERE wallet=w.wallet AND idempotency_key=w.idempotency_key;
 r:=NEW.receipt;s:=r->'source';a:=p.artifact;
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR octet_length(r::text)>16384 OR jsonb_typeof(s) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'REALM_SALE_RECEIPT_INPUT';END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(r))<>14 OR EXISTS(SELECT 1 FROM jsonb_object_keys(r) k WHERE k<>ALL(ARRAY['version','signature','slot','blockTime','originalMessageSha256','signedTransactionSha256','receiptAccountHex','feeLamports','actualRentLamports','buyerNetPaymentLamports','accountRentIncreases','observedAccountSlot','proofClockUnixTimestamp','source']))
 OR (SELECT count(*) FROM jsonb_object_keys(s))<>8 OR EXISTS(SELECT 1 FROM jsonb_object_keys(s) k WHERE k<>ALL(ARRAY['trust','stateProvenance','genesisHash','programId','reviewedDeploymentSlot','reviewedProgramDataSha256','upgradeAuthority','accounts'])) THEN RAISE EXCEPTION 'REALM_SALE_RECEIPT_INPUT';END IF;
 FOR i IN 0..63 LOOP n:=n*256+get_byte(w.signature,i);END LOOP;
 WHILE n>0 LOOP encoded:=substr(alphabet,mod(n,58)::integer+1,1)||encoded;n:=div(n,58);END LOOP;
 FOR i IN 0..63 LOOP EXIT WHEN get_byte(w.signature,i)<>0;encoded:='1'||encoded;END LOOP;
 IF r->'version' IS DISTINCT FROM '1'::jsonb OR r->>'signature' IS DISTINCT FROM encoded OR w.sale_id IS DISTINCT FROM p.sale_id
 OR r->>'originalMessageSha256' IS DISTINCT FROM w.message_sha256 OR r->>'signedTransactionSha256' IS DISTINCT FROM w.wire_sha256
 OR s->>'trust' IS DISTINCT FROM 'trusted-finalized-rpc-reviewed-program' OR s->>'stateProvenance' IS DISTINCT FROM 'fresh-reviewed-deployment'
 OR s->>'genesisHash' IS DISTINCT FROM a#>>'{source,genesisHash}' OR s->>'programId' IS DISTINCT FROM a#>>'{source,programId}'
 OR s->'reviewedDeploymentSlot' IS DISTINCT FROM a#>'{source,reviewedDeploymentSlot}' OR s->>'reviewedProgramDataSha256' IS DISTINCT FROM a#>>'{source,programDataSha256}'
 OR length(r->>'receiptAccountHex') IS DISTINCT FROM 588 OR (r->>'receiptAccountHex'~'^[0-9a-f]+$') IS DISTINCT FROM true THEN RAISE EXCEPTION 'REALM_SALE_RECEIPT_SOURCE';END IF;
 IF jsonb_typeof(s->'accounts') IS DISTINCT FROM 'array' OR jsonb_array_length(s->'accounts')<>6
 OR s#>>'{accounts,5,dataSha256}' IS DISTINCT FROM encode(sha256(decode(r->>'receiptAccountHex','hex')),'hex')
 OR s#>>'{accounts,1,dataSha256}' IS DISTINCT FROM s->>'reviewedProgramDataSha256' THEN RAISE EXCEPTION 'REALM_SALE_RECEIPT_SOURCE';END IF;
 FOREACH v IN ARRAY ARRAY['slot','observedAccountSlot'] LOOP
  IF jsonb_typeof(r->v) IS DISTINCT FROM 'number' OR (r->>v~'^(0|[1-9][0-9]{0,15})$') IS DISTINCT FROM true OR (r->>v)::numeric>9007199254740991 THEN RAISE EXCEPTION 'REALM_SALE_RECEIPT_INPUT';END IF;
 END LOOP;
 IF (r->>'slot')::numeric<=(s->>'reviewedDeploymentSlot')::numeric OR (r->>'slot')::numeric<(a#>>'{source,admissionSlot}')::numeric OR (r->>'observedAccountSlot')::numeric<(r->>'slot')::numeric THEN RAISE EXCEPTION 'REALM_SALE_RECEIPT_SOURCE';END IF;
 FOREACH v IN ARRAY ARRAY['feeLamports','actualRentLamports','buyerNetPaymentLamports','proofClockUnixTimestamp'] LOOP
  IF jsonb_typeof(r->v) IS DISTINCT FROM 'string' OR (r->>v~'^(0|[1-9][0-9]{0,19})$') IS DISTINCT FROM true OR (r->>v)::numeric>18446744073709551615 THEN RAISE EXCEPTION 'REALM_SALE_RECEIPT_INPUT';END IF;
 END LOOP;
 IF (r->>'feeLamports')::numeric>(a#>>'{quote,feeLamports}')::numeric OR r->>'buyerNetPaymentLamports' IS DISTINCT FROM a#>>'{quote,paymentDebitLamports}'
 OR jsonb_typeof(r->'accountRentIncreases') IS DISTINCT FROM 'array' OR jsonb_array_length(r->'accountRentIncreases') IS DISTINCT FROM jsonb_array_length(a#>'{quote,rents}') THEN RAISE EXCEPTION 'REALM_SALE_RECEIPT_PAYMENT';END IF;
 FOR i IN 0..jsonb_array_length(r->'accountRentIncreases')-1 LOOP
  IF r#>>ARRAY['accountRentIncreases',i::text,'address'] IS DISTINCT FROM a#>>ARRAY['quote','rents',i::text,'address']
  OR (r#>>ARRAY['accountRentIncreases',i::text,'lamports']~'^(0|[1-9][0-9]{0,19})$') IS DISTINCT FROM true THEN RAISE EXCEPTION 'REALM_SALE_RECEIPT_PAYMENT';END IF;
  n:=(r#>>ARRAY['accountRentIncreases',i::text,'lamports'])::numeric;
  IF n>(a#>>ARRAY['quote','rents',i::text,'maxIncreaseLamports'])::numeric THEN RAISE EXCEPTION 'REALM_SALE_RECEIPT_PAYMENT';END IF;total:=total+n;
 END LOOP;
 IF total<>(r->>'actualRentLamports')::numeric OR total+(r->>'feeLamports')::numeric+(r->>'buyerNetPaymentLamports')::numeric>(a#>>'{quote,requiredLamports}')::numeric THEN RAISE EXCEPTION 'REALM_SALE_RECEIPT_PAYMENT';END IF;
 NEW.sale_id:=w.sale_id;NEW.settled_at:=clock_timestamp();RETURN NEW;
END $$;
--> statement-breakpoint
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.seeker_realm_sale_receipts'::regclass AND tgname='seeker_realm_sale_receipts_immutable') THEN
  CREATE TRIGGER seeker_realm_sale_receipts_immutable BEFORE INSERT OR UPDATE OR DELETE ON seeker_realm_sale_receipts FOR EACH ROW EXECUTE FUNCTION public.shardkeep_realm_sale_receipt_guard();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.seeker_realm_sale_receipts'::regclass AND tgname='seeker_realm_sale_receipts_no_truncate') THEN
  CREATE TRIGGER seeker_realm_sale_receipts_no_truncate BEFORE TRUNCATE ON seeker_realm_sale_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_realm_sale_receipt_guard();
 END IF;
END $$;
REVOKE ALL ON seeker_realm_sale_receipts FROM PUBLIC;
--> statement-breakpoint
DO $$BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shardkeep_api_runtime') THEN
  REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON seeker_realm_sale_receipts FROM shardkeep_api_runtime;
  GRANT SELECT ON seeker_realm_sale_receipts TO shardkeep_api_runtime;
 END IF;
END $$;
