-- Additive unsigned consent journal only. Does not grant chain or signing authority.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS seeker_realm_sale_preparations (
 wallet text NOT NULL,idempotency_key uuid NOT NULL,sale_id text NOT NULL,
 artifact jsonb NOT NULL CHECK(jsonb_typeof(artifact)='object' AND octet_length(artifact::text)<=32768),
 inserted_at timestamptz NOT NULL CHECK(isfinite(inserted_at)),
 PRIMARY KEY(wallet,idempotency_key),UNIQUE(wallet,sale_id)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_realm_sale_preparation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a jsonb; q jsonb;
BEGIN
 IF TG_RELID<>'public.seeker_realm_sale_preparations'::regclass OR TG_WHEN<>'BEFORE'
 OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'seeker_realm_sale_preparations_no_truncate' ELSE 'seeker_realm_sale_preparations_immutable' END)
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'REALM_SALE_PREPARATION_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'REALM_SALE_PREPARATION_IMMUTABLE';END IF;
 IF NEW.wallet IS NOT NULL OR NEW.idempotency_key IS NOT NULL OR NEW.sale_id IS NOT NULL OR NEW.inserted_at IS NOT NULL THEN RAISE EXCEPTION 'REALM_SALE_PREPARATION_DERIVED';END IF;
 a:=NEW.artifact;q:=a->'quote';
 IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR octet_length(a::text)>32768 THEN RAISE EXCEPTION 'REALM_SALE_PREPARATION_INPUT';END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(a))<>12 OR EXISTS(SELECT 1 FROM jsonb_object_keys(a) k WHERE k<>ALL(ARRAY['version','wallet','idempotencyKey','saleId','spot','realm','terms','source','quote','state','currentSigningAuthorized','submissionAuthorized']))
 OR a->'version' IS DISTINCT FROM '1'::jsonb OR a->'state' IS DISTINCT FROM '"prepared"'::jsonb
 OR a->'currentSigningAuthorized' IS DISTINCT FROM 'false'::jsonb OR a->'submissionAuthorized' IS DISTINCT FROM 'false'::jsonb
 OR jsonb_typeof(a->'wallet') IS DISTINCT FROM 'string' OR (a->>'wallet' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') IS DISTINCT FROM true
 OR jsonb_typeof(a->'idempotencyKey') IS DISTINCT FROM 'string' OR (a->>'idempotencyKey' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') IS DISTINCT FROM true
 OR jsonb_typeof(a->'saleId') IS DISTINCT FROM 'string' OR (a->>'saleId' ~ '^[0-9a-f]{32}$') IS DISTINCT FROM true OR a->>'saleId'=repeat('0',32)
 OR jsonb_typeof(a->'terms') IS DISTINCT FROM 'object' OR jsonb_typeof(a->'source') IS DISTINCT FROM 'object' OR jsonb_typeof(q) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'REALM_SALE_PREPARATION_INPUT';END IF;
 IF jsonb_typeof(q->'messageHex') IS DISTINCT FROM 'string' OR length(q->>'messageHex') NOT BETWEEN 2 AND 2334 OR (q->>'messageHex' ~ '^([0-9a-f]{2})+$') IS DISTINCT FROM true
 OR q->>'messageSha256' IS DISTINCT FROM encode(sha256(decode(q->>'messageHex','hex')),'hex') THEN RAISE EXCEPTION 'REALM_SALE_PREPARATION_INPUT';END IF;
 NEW.wallet:=a->>'wallet';NEW.idempotency_key:=(a->>'idempotencyKey')::uuid;NEW.sale_id:=a->>'saleId';NEW.inserted_at:=clock_timestamp();RETURN NEW;
END $$;
--> statement-breakpoint
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.seeker_realm_sale_preparations'::regclass AND tgname='seeker_realm_sale_preparations_immutable') THEN
 CREATE TRIGGER seeker_realm_sale_preparations_immutable BEFORE INSERT OR UPDATE OR DELETE ON seeker_realm_sale_preparations FOR EACH ROW EXECUTE FUNCTION public.shardkeep_realm_sale_preparation_guard();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.seeker_realm_sale_preparations'::regclass AND tgname='seeker_realm_sale_preparations_no_truncate') THEN
 CREATE TRIGGER seeker_realm_sale_preparations_no_truncate BEFORE TRUNCATE ON seeker_realm_sale_preparations FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_realm_sale_preparation_guard();END IF;
END $$;
REVOKE ALL ON seeker_realm_sale_preparations FROM PUBLIC;
--> statement-breakpoint
DO $$BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shardkeep_api_runtime') THEN GRANT SELECT,INSERT ON seeker_realm_sale_preparations TO shardkeep_api_runtime;END IF;
END $$;
