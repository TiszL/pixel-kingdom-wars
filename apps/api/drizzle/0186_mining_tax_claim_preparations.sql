-- Immutable original unsigned KEEP tax consent; private proof is not finality authority.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS mining_tax_claim_preparations (
 wallet text NOT NULL,idempotency_key uuid NOT NULL,claim_id uuid NOT NULL,
 artifact jsonb NOT NULL CHECK(jsonb_typeof(artifact)='object' AND octet_length(artifact::text)<=32768),
 snapshot_text text NOT NULL CHECK(octet_length(snapshot_text)<=524288),snapshot_sha256 text NOT NULL,
 prepared_at timestamptz NOT NULL CHECK(isfinite(prepared_at)),expires_at timestamptz NOT NULL CHECK(isfinite(expires_at) AND expires_at>prepared_at),
 inserted_at timestamptz NOT NULL CHECK(isfinite(inserted_at)),PRIMARY KEY(wallet,idempotency_key),UNIQUE(claim_id)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_tax_preparation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a jsonb; s jsonb; t jsonb; n integer:=0;
BEGIN
 IF TG_RELID<>'public.mining_tax_claim_preparations'::regclass OR TG_WHEN<>'BEFORE'
 OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'mining_tax_claim_preparations_no_truncate' ELSE 'mining_tax_claim_preparations_immutable' END)
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'MINING_TAX_PREPARATION_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_TAX_PREPARATION_IMMUTABLE';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_TAX_PREPARATION_READ_COMMITTED';END IF;
 IF NEW.wallet IS NOT NULL OR NEW.idempotency_key IS NOT NULL OR NEW.claim_id IS NOT NULL OR NEW.snapshot_sha256 IS NOT NULL
 OR NEW.prepared_at IS NOT NULL OR NEW.expires_at IS NOT NULL OR NEW.inserted_at IS NOT NULL THEN RAISE EXCEPTION 'MINING_TAX_PREPARATION_DERIVED';END IF;
 a:=NEW.artifact;
 IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR octet_length(a::text)>32768 OR NEW.snapshot_text IS NULL OR octet_length(NEW.snapshot_text)>524288 THEN RAISE EXCEPTION 'MINING_TAX_PREPARATION_INPUT';END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(a))<>25 OR EXISTS(SELECT 1 FROM jsonb_object_keys(a) k WHERE k<>ALL(ARRAY['version','wallet','idempotencyKey','claimId','round','spot','caps','quoteVersion','quoteTtlSec','preparedAt','expiresAt','identity','term','source','snapshot','intended','setup','blockhash','lastValidBlockHeight','blockHeight','fees','transactions','state','currentSigningAuthorized','submissionAuthorized']))
 OR a->'version' IS DISTINCT FROM '1'::jsonb OR a->'quoteVersion' IS DISTINCT FROM '1'::jsonb OR a->'state' IS DISTINCT FROM '"prepared"'::jsonb
 OR a->'currentSigningAuthorized' IS DISTINCT FROM 'false'::jsonb OR a->'submissionAuthorized' IS DISTINCT FROM 'false'::jsonb
 OR jsonb_typeof(a->'wallet') IS DISTINCT FROM 'string' OR (a->>'wallet' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') IS DISTINCT FROM true
 OR jsonb_typeof(a->'idempotencyKey') IS DISTINCT FROM 'string' OR (a->>'idempotencyKey' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') IS DISTINCT FROM true
 OR jsonb_typeof(a->'claimId') IS DISTINCT FROM 'string' OR (a->>'claimId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') IS DISTINCT FROM true
 OR jsonb_typeof(a->'round') IS DISTINCT FROM 'string' OR (a->>'round' ~ '^(0|[1-9][0-9]{0,19})$') IS DISTINCT FROM true
 OR jsonb_typeof(a->'spot') IS DISTINCT FROM 'number' OR (a->>'spot' ~ '^(0|[1-9][0-9]{0,2})$') IS DISTINCT FROM true
 OR jsonb_typeof(a->'identity') IS DISTINCT FROM 'object' OR jsonb_typeof(a->'term') IS DISTINCT FROM 'object'
 OR jsonb_typeof(a->'source') IS DISTINCT FROM 'object' OR jsonb_typeof(a->'snapshot') IS DISTINCT FROM 'object'
 OR jsonb_typeof(a->'transactions') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'MINING_TAX_PREPARATION_INPUT';END IF;
 IF (a->>'round')::numeric>18446744073709551615 OR (a->>'spot')::integer>255 OR jsonb_array_length(a->'transactions') NOT BETWEEN 1 AND 2 THEN RAISE EXCEPTION 'MINING_TAX_PREPARATION_INPUT';END IF;
 IF jsonb_typeof(a->'preparedAt') IS DISTINCT FROM 'string' OR (a->>'preparedAt' ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$') IS DISTINCT FROM true
 OR jsonb_typeof(a->'expiresAt') IS DISTINCT FROM 'string' OR (a->>'expiresAt' ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$') IS DISTINCT FROM true
 OR jsonb_typeof(a->'quoteTtlSec') IS DISTINCT FROM 'number' OR (a->>'quoteTtlSec' ~ '^[1-9][0-9]{0,8}$') IS DISTINCT FROM true THEN RAISE EXCEPTION 'MINING_TAX_PREPARATION_INPUT';END IF;
 NEW.prepared_at:=(a->>'preparedAt')::timestamptz;NEW.expires_at:=(a->>'expiresAt')::timestamptz;
 IF NOT isfinite(NEW.prepared_at) OR NOT isfinite(NEW.expires_at) OR extract(epoch FROM NEW.expires_at-NEW.prepared_at)<>(a->>'quoteTtlSec')::numeric THEN RAISE EXCEPTION 'MINING_TAX_PREPARATION_INPUT';END IF;
 s:=NEW.snapshot_text::jsonb;
 IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR s->'wallet' IS DISTINCT FROM a->'wallet' OR s->'spot' IS DISTINCT FROM a->'spot'
 OR s->'claimsAuthorized' IS DISTINCT FROM 'false'::jsonb OR s->'signingAuthorized' IS DISTINCT FROM 'false'::jsonb
 OR s->'slot' IS DISTINCT FROM a->'source'->'snapshotSlot' OR s->'source'->'programId' IS DISTINCT FROM a->'identity'->'programId'
 OR s->'source'->'genesisHash' IS DISTINCT FROM a->'identity'->'genesisHash' OR s->'term'->'term' IS DISTINCT FROM a->'identity'->'term'
 OR s->'term'->'source'->'round'->>'$bigint' IS DISTINCT FROM a->>'round' THEN RAISE EXCEPTION 'MINING_TAX_PREPARATION_SOURCE';END IF;
 FOR t IN SELECT value FROM jsonb_array_elements(a->'transactions') LOOP
  IF jsonb_typeof(t) IS DISTINCT FROM 'object' OR t->'ordinal' IS DISTINCT FROM to_jsonb(n)
  OR jsonb_typeof(t->'messageHex') IS DISTINCT FROM 'string' OR length(t->>'messageHex') NOT BETWEEN 2 AND 2334 OR (t->>'messageHex' ~ '^01([0-9a-f]{2})+$') IS DISTINCT FROM true
  OR t->>'messageSha256' IS DISTINCT FROM encode(sha256(decode(t->>'messageHex','hex')),'hex')
  OR t->'packetBytes' IS DISTINCT FROM to_jsonb(65+length(t->>'messageHex')/2)
  THEN RAISE EXCEPTION 'MINING_TAX_PREPARATION_INPUT';END IF;n:=n+1;
 END LOOP;
 NEW.wallet:=a->>'wallet';NEW.idempotency_key:=(a->>'idempotencyKey')::uuid;NEW.claim_id:=(a->>'claimId')::uuid;
 NEW.snapshot_sha256:=encode(sha256(convert_to(NEW.snapshot_text,'UTF8')),'hex');NEW.inserted_at:=clock_timestamp();RETURN NEW;
END $$;
--> statement-breakpoint
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_tax_claim_preparations'::regclass AND tgname='mining_tax_claim_preparations_immutable') THEN
 CREATE TRIGGER mining_tax_claim_preparations_immutable BEFORE INSERT OR UPDATE OR DELETE ON mining_tax_claim_preparations FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_tax_preparation_guard();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_tax_claim_preparations'::regclass AND tgname='mining_tax_claim_preparations_no_truncate') THEN
 CREATE TRIGGER mining_tax_claim_preparations_no_truncate BEFORE TRUNCATE ON mining_tax_claim_preparations FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_tax_preparation_guard();END IF;
END $$;
REVOKE ALL ON mining_tax_claim_preparations FROM PUBLIC;
--> statement-breakpoint
DO $$BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shardkeep_api_runtime') THEN GRANT SELECT,INSERT ON mining_tax_claim_preparations TO shardkeep_api_runtime;END IF;
END $$;
