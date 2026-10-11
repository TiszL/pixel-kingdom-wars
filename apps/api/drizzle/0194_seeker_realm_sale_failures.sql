-- Owner-attested exact failed original purchase. Custody is never released.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS seeker_realm_sale_failures (
 wallet text NOT NULL,idempotency_key uuid NOT NULL,sale_id text NOT NULL,
 receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=16384),
 verified_at timestamptz NOT NULL CHECK(isfinite(verified_at)),PRIMARY KEY(wallet,idempotency_key),UNIQUE(wallet,sale_id),
 FOREIGN KEY(wallet,idempotency_key) REFERENCES seeker_realm_sale_signed_wires(wallet,idempotency_key),
 FOREIGN KEY(wallet,sale_id) REFERENCES seeker_realm_sale_signed_wires(wallet,sale_id)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_realm_sale_failure_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.seeker_realm_sale_preparations%ROWTYPE;w public.seeker_realm_sale_signed_wires%ROWTYPE;
 r jsonb;s jsonb;a jsonb;entry jsonb;n numeric:=0;encoded text:='';alphabet text:='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';i integer;v text;
BEGIN
 IF TG_RELID<>'public.seeker_realm_sale_failures'::regclass OR TG_WHEN<>'BEFORE'
 OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'seeker_realm_sale_failures_no_truncate' ELSE 'seeker_realm_sale_failures_immutable' END)
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'REALM_SALE_FAILURE_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'REALM_SALE_FAILURE_IMMUTABLE';END IF;
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'REALM_SALE_FAILURE_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'REALM_SALE_FAILURE_READ_COMMITTED';END IF;
 IF NEW.sale_id IS NOT NULL OR NEW.verified_at IS NOT NULL THEN RAISE EXCEPTION 'REALM_SALE_FAILURE_DERIVED';END IF;
 SELECT * INTO w FROM public.seeker_realm_sale_signed_wires WHERE wallet=NEW.wallet AND idempotency_key=NEW.idempotency_key;
 IF NOT FOUND THEN RAISE EXCEPTION 'REALM_SALE_FAILURE_SIGNED';END IF;
 SELECT * INTO STRICT p FROM public.seeker_realm_sale_preparations WHERE wallet=w.wallet AND idempotency_key=w.idempotency_key;
 r:=NEW.receipt;s:=r->'source';a:=p.artifact;
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR octet_length(r::text)>16384 OR jsonb_typeof(s) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'REALM_SALE_FAILURE_INPUT';END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(r))<>28 OR EXISTS(SELECT 1 FROM jsonb_object_keys(r) k WHERE k<>ALL(ARRAY['version','wallet','saleId','spot','realm','round','day','signature','originalMessageSha256','signedTransactionSha256','slot','blockTime','feeLamports','actualRentLamports','buyerNetPaymentLamports','accessChanged','quotaConsumed','observedAccountSlot','proofClockUnixTimestamp','source','outcome','transactionFailed','finalityVerified','paymentAuthorized','admissionAuthorized','signingAuthorized','broadcastAuthorized','journalClearingAuthorized']))
 OR (SELECT count(*) FROM jsonb_object_keys(s))<>8 OR EXISTS(SELECT 1 FROM jsonb_object_keys(s) k WHERE k<>ALL(ARRAY['trust','stateProvenance','genesisHash','programId','reviewedDeploymentSlot','reviewedProgramDataSha256','upgradeAuthority','accounts'])) THEN RAISE EXCEPTION 'REALM_SALE_FAILURE_INPUT';END IF;
 FOR i IN 0..63 LOOP n:=n*256+get_byte(w.signature,i);END LOOP;
 WHILE n>0 LOOP encoded:=substr(alphabet,mod(n,58)::integer+1,1)||encoded;n:=div(n,58);END LOOP;
 FOR i IN 0..63 LOOP EXIT WHEN get_byte(w.signature,i)<>0;encoded:='1'||encoded;END LOOP;
 IF r->'version' IS DISTINCT FROM '1'::jsonb OR r->'wallet' IS DISTINCT FROM to_jsonb(NEW.wallet) OR r->'saleId' IS DISTINCT FROM to_jsonb(w.sale_id)
 OR r->'signature' IS DISTINCT FROM to_jsonb(encoded) OR w.sale_id IS DISTINCT FROM p.sale_id
 OR r->'spot' IS DISTINCT FROM a->'spot' OR r->'realm' IS DISTINCT FROM a->'realm' OR r->'round' IS DISTINCT FROM a#>'{terms,round}' OR r->'day' IS DISTINCT FROM a#>'{terms,day}'
 OR r->'originalMessageSha256' IS DISTINCT FROM to_jsonb(w.message_sha256) OR r->'signedTransactionSha256' IS DISTINCT FROM to_jsonb(w.wire_sha256)
 OR s->'trust' IS DISTINCT FROM '"trusted-finalized-rpc-reviewed-program"'::jsonb OR s->'stateProvenance' IS DISTINCT FROM '"fresh-reviewed-deployment"'::jsonb
 OR s->'genesisHash' IS DISTINCT FROM a#>'{source,genesisHash}' OR s->'programId' IS DISTINCT FROM a#>'{source,programId}'
 OR s->'reviewedDeploymentSlot' IS DISTINCT FROM a#>'{source,reviewedDeploymentSlot}' OR s->'reviewedProgramDataSha256' IS DISTINCT FROM a#>'{source,programDataSha256}'
 THEN RAISE EXCEPTION 'REALM_SALE_FAILURE_SOURCE';END IF;
 IF r->'actualRentLamports' IS DISTINCT FROM '"0"'::jsonb OR r->'buyerNetPaymentLamports' IS DISTINCT FROM '"0"'::jsonb OR r->'outcome' IS DISTINCT FROM '"failed"'::jsonb
 OR r->'transactionFailed' IS DISTINCT FROM 'true'::jsonb OR r->'finalityVerified' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'REALM_SALE_FAILURE_INPUT';END IF;
 FOREACH v IN ARRAY ARRAY['accessChanged','quotaConsumed','paymentAuthorized','admissionAuthorized','signingAuthorized','broadcastAuthorized','journalClearingAuthorized'] LOOP
  IF r->v IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'REALM_SALE_FAILURE_AUTHORITY';END IF;
 END LOOP;
 FOREACH v IN ARRAY ARRAY['slot','observedAccountSlot'] LOOP
  IF jsonb_typeof(r->v) IS DISTINCT FROM 'number' OR (r->>v~'^(0|[1-9][0-9]{0,15})$') IS DISTINCT FROM true OR (r->>v)::numeric>9007199254740991 THEN RAISE EXCEPTION 'REALM_SALE_FAILURE_INPUT';END IF;
 END LOOP;
 IF (r->>'slot')::numeric<=(s->>'reviewedDeploymentSlot')::numeric OR (r->>'slot')::numeric<(a#>>'{source,admissionSlot}')::numeric OR (r->>'observedAccountSlot')::numeric<(r->>'slot')::numeric THEN RAISE EXCEPTION 'REALM_SALE_FAILURE_SOURCE';END IF;
 FOREACH v IN ARRAY ARRAY['feeLamports','proofClockUnixTimestamp'] LOOP
  IF jsonb_typeof(r->v) IS DISTINCT FROM 'string' OR (r->>v~'^(0|[1-9][0-9]{0,19})$') IS DISTINCT FROM true OR (r->>v)::numeric>18446744073709551615 THEN RAISE EXCEPTION 'REALM_SALE_FAILURE_INPUT';END IF;
 END LOOP;
 IF (r->>'proofClockUnixTimestamp')::numeric NOT BETWEEN 1 AND 9223372036854775807 THEN RAISE EXCEPTION 'REALM_SALE_FAILURE_INPUT';END IF;
 IF r->'blockTime' IS DISTINCT FROM 'null'::jsonb THEN
  IF jsonb_typeof(r->'blockTime') IS DISTINCT FROM 'number' OR (r->>'blockTime'~'^-?(0|[1-9][0-9]{0,15})$') IS DISTINCT FROM true OR abs((r->>'blockTime')::numeric)>9007199254740991 OR (r->>'blockTime')::numeric>(r->>'proofClockUnixTimestamp')::numeric THEN RAISE EXCEPTION 'REALM_SALE_FAILURE_INPUT';END IF;
 END IF;
 IF s->'upgradeAuthority' IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(s->'upgradeAuthority') IS DISTINCT FROM 'string' OR (s->>'upgradeAuthority'~'^[1-9A-HJ-NP-Za-km-z]{32,44}$') IS DISTINCT FROM true) THEN RAISE EXCEPTION 'REALM_SALE_FAILURE_INPUT';END IF;
 IF jsonb_typeof(s->'accounts') IS DISTINCT FROM 'array' OR jsonb_array_length(s->'accounts')<>3 THEN RAISE EXCEPTION 'REALM_SALE_FAILURE_SOURCE';END IF;
 FOR i IN 0..2 LOOP
  entry:=s->'accounts'->i;
  IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(entry))<>5 OR EXISTS(SELECT 1 FROM jsonb_object_keys(entry) k WHERE k<>ALL(ARRAY['address','exists','owner','executable','dataSha256']))
  OR entry->'exists' IS DISTINCT FROM 'true'::jsonb OR entry->'executable' IS DISTINCT FROM to_jsonb(i=0)
  OR jsonb_typeof(entry->'address') IS DISTINCT FROM 'string' OR (entry->>'address'~'^[1-9A-HJ-NP-Za-km-z]{32,44}$') IS DISTINCT FROM true
  OR entry->'owner' IS DISTINCT FROM to_jsonb(CASE WHEN i<2 THEN 'BPFLoaderUpgradeab1e11111111111111111111111' ELSE 'Sysvar1111111111111111111111111111111111111' END)
  OR jsonb_typeof(entry->'dataSha256') IS DISTINCT FROM 'string' OR (entry->>'dataSha256'~'^[0-9a-f]{64}$') IS DISTINCT FROM true THEN RAISE EXCEPTION 'REALM_SALE_FAILURE_SOURCE';END IF;
 END LOOP;
 IF s#>'{accounts,0,address}' IS DISTINCT FROM s->'programId' OR s#>>'{accounts,2,address}' IS DISTINCT FROM 'SysvarC1ock11111111111111111111111111111111' OR s#>'{accounts,1,dataSha256}' IS DISTINCT FROM s->'reviewedProgramDataSha256' THEN RAISE EXCEPTION 'REALM_SALE_FAILURE_SOURCE';END IF;
 NEW.sale_id:=w.sale_id;NEW.verified_at:=clock_timestamp();RETURN NEW;
END $$;
--> statement-breakpoint
-- Both outcome writers serialize on the already immutable original request.
-- READ COMMITTED gives the second statement a fresh view after lock wait.
CREATE OR REPLACE FUNCTION public.shardkeep_realm_sale_outcome_exclusive() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID NOT IN ('public.seeker_realm_sale_failures'::regclass,'public.seeker_realm_sale_receipts'::regclass) OR TG_WHEN<>'BEFORE' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' OR TG_NAME<>'seeker_realm_sale_outcome_exclusive' THEN RAISE EXCEPTION 'REALM_SALE_OUTCOME_TRIGGER';END IF;
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'REALM_SALE_OUTCOME_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'REALM_SALE_OUTCOME_READ_COMMITTED';END IF;
 PERFORM 1 FROM public.seeker_realm_sale_preparations WHERE wallet=NEW.wallet AND idempotency_key=NEW.idempotency_key FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'REALM_SALE_OUTCOME_ORIGINAL';END IF;
 IF TG_RELID='public.seeker_realm_sale_failures'::regclass THEN
  IF EXISTS(SELECT 1 FROM public.seeker_realm_sale_receipts WHERE wallet=NEW.wallet AND idempotency_key=NEW.idempotency_key) THEN RAISE EXCEPTION 'REALM_SALE_OUTCOME_CONFLICT';END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM public.seeker_realm_sale_failures WHERE wallet=NEW.wallet AND idempotency_key=NEW.idempotency_key) THEN RAISE EXCEPTION 'REALM_SALE_OUTCOME_CONFLICT';END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.seeker_realm_sale_failures'::regclass AND tgname='seeker_realm_sale_failures_immutable') THEN
  CREATE TRIGGER seeker_realm_sale_failures_immutable BEFORE INSERT OR UPDATE OR DELETE ON seeker_realm_sale_failures FOR EACH ROW EXECUTE FUNCTION public.shardkeep_realm_sale_failure_guard();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.seeker_realm_sale_failures'::regclass AND tgname='seeker_realm_sale_failures_no_truncate') THEN
  CREATE TRIGGER seeker_realm_sale_failures_no_truncate BEFORE TRUNCATE ON seeker_realm_sale_failures FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_realm_sale_failure_guard();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.seeker_realm_sale_failures'::regclass AND tgname='seeker_realm_sale_outcome_exclusive') THEN
  CREATE TRIGGER seeker_realm_sale_outcome_exclusive BEFORE INSERT ON seeker_realm_sale_failures FOR EACH ROW EXECUTE FUNCTION public.shardkeep_realm_sale_outcome_exclusive();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.seeker_realm_sale_receipts'::regclass AND tgname='seeker_realm_sale_outcome_exclusive') THEN
  CREATE TRIGGER seeker_realm_sale_outcome_exclusive BEFORE INSERT ON seeker_realm_sale_receipts FOR EACH ROW EXECUTE FUNCTION public.shardkeep_realm_sale_outcome_exclusive();END IF;
END $$;
REVOKE ALL ON seeker_realm_sale_failures FROM PUBLIC;
--> statement-breakpoint
DO $$BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shardkeep_api_runtime') THEN
  REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON seeker_realm_sale_failures FROM shardkeep_api_runtime;
  GRANT SELECT ON seeker_realm_sale_failures TO shardkeep_api_runtime;
 END IF;
END $$;
