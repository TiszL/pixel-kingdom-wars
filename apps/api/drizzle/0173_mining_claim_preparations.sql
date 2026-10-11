-- Runtime-written, immutable unsigned quote artifacts; no signing/send authority.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS mining_claim_preparations (
 wallet text NOT NULL,idempotency_key uuid NOT NULL,claim_id uuid NOT NULL UNIQUE,
 projection_epoch uuid NOT NULL REFERENCES mining_claim_entitlement_headers(epoch_id),
 artifact jsonb NOT NULL CHECK(jsonb_typeof(artifact)='object' AND octet_length(artifact::text)<=16384),
 inserted_at timestamptz NOT NULL CHECK(isfinite(inserted_at)),PRIMARY KEY(wallet,idempotency_key)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_claim_preparation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a jsonb; h public.mining_claim_entitlement_headers%ROWTYPE; l public.mining_claim_entitlement_leaves%ROWTYPE;
 expected jsonb; t jsonb; v text; fee numeric:=0; rent numeric:=0;
BEGIN
 IF TG_RELID<>'public.mining_claim_preparations'::regclass OR TG_WHEN<>'BEFORE'
 OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'mining_claim_preparations_no_truncate' ELSE 'mining_claim_preparations_immutable' END)
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'MINING_CLAIM_PREPARATION_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_CLAIM_PREPARATION_IMMUTABLE';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_CLAIM_PREPARATION_READ_COMMITTED';END IF;
 IF NEW.wallet IS NOT NULL OR NEW.idempotency_key IS NOT NULL OR NEW.claim_id IS NOT NULL OR NEW.projection_epoch IS NOT NULL OR NEW.inserted_at IS NOT NULL THEN RAISE EXCEPTION 'MINING_CLAIM_PREPARATION_DERIVED';END IF;
 a:=NEW.artifact;
 IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR octet_length(a::text)>16384 THEN RAISE EXCEPTION 'MINING_CLAIM_PREPARATION_INPUT';END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(a))<>23 OR EXISTS(SELECT 1 FROM jsonb_object_keys(a) k WHERE k<>ALL(ARRAY['claimId','wallet','idempotencyKey','header','leafHex','proofHex','needsAta','needsMinerRecords','quoteVersion','preparedAt','expiresAt','snapshotSlot','blockhashContextSlot','blockhash','lastValidBlockHeight','payerBalanceLamports','feeLamports','rentLamports','totalLamports','transactions','state','currentSigningAuthorized','claimSubmissionAuthorized'])) THEN RAISE EXCEPTION 'MINING_CLAIM_PREPARATION_INPUT';END IF;
 -- Required values are checked without accepting JSON null/absent booleans.
 IF a->'state' IS DISTINCT FROM '"prepared"'::jsonb OR a->'currentSigningAuthorized' IS DISTINCT FROM 'false'::jsonb OR a->'claimSubmissionAuthorized' IS DISTINCT FROM 'false'::jsonb
 OR a->'quoteVersion' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(a->'needsAta') IS DISTINCT FROM 'boolean' OR jsonb_typeof(a->'needsMinerRecords') IS DISTINCT FROM 'boolean'
 OR (a->>'wallet' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') IS DISTINCT FROM true OR (a->>'blockhash' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') IS DISTINCT FROM true THEN RAISE EXCEPTION 'MINING_CLAIM_PREPARATION_INPUT';END IF;
 NEW.wallet:=a->>'wallet';NEW.idempotency_key:=(a->>'idempotencyKey')::uuid;NEW.claim_id:=(a->>'claimId')::uuid;
 SELECT * INTO h FROM public.mining_claim_entitlement_headers WHERE genesis_hash=a#>>'{header,genesisHash}' AND program_id=a#>>'{header,programId}' AND config_address=a#>>'{header,configAddress}' AND sequence=1;
 IF NOT FOUND THEN RAISE EXCEPTION 'MINING_CLAIM_PREPARATION_SOURCE';END IF;
 SELECT * INTO l FROM public.mining_claim_entitlement_leaves WHERE epoch_id=h.epoch_id AND wallet=NEW.wallet;
 IF NOT FOUND THEN RAISE EXCEPTION 'MINING_CLAIM_PREPARATION_SOURCE';END IF;
 expected:=jsonb_build_object('genesisHash',h.genesis_hash,'programId',h.program_id,'configAddress',h.config_address,'keepMint',h.keep_mint,'reserveOwner',h.reserve_owner,'sequence',h.sequence::text,'day',h.day::text,'root',h.root,'totalCumulative',h.total_cumulative::text,'leafCount',h.leaf_count,'sourceHash',h.source_hash,'publicationSignature',h.publication_signature,'publicationSlot',h.publication_slot);
 IF a->'header' IS DISTINCT FROM expected OR a->>'leafHex' IS DISTINCT FROM encode(l.leaf_bytes,'hex') OR a->>'proofHex' IS DISTINCT FROM encode(l.proof_bytes,'hex') THEN RAISE EXCEPTION 'MINING_CLAIM_PREPARATION_SOURCE';END IF;
 NEW.projection_epoch:=h.epoch_id;NEW.inserted_at:=clock_timestamp();
 FOREACH v IN ARRAY ARRAY['snapshotSlot','blockhashContextSlot','lastValidBlockHeight'] LOOP
  IF jsonb_typeof(a->v) IS DISTINCT FROM 'number' OR (a->>v ~ '^(0|[1-9][0-9]{0,15})$') IS DISTINCT FROM true OR (a->>v)::numeric>9007199254740991 THEN RAISE EXCEPTION 'MINING_CLAIM_PREPARATION_INPUT';END IF;
 END LOOP;
 IF (a->>'snapshotSlot')::numeric<h.publication_slot OR (a->>'blockhashContextSlot')::numeric<(a->>'snapshotSlot')::numeric THEN RAISE EXCEPTION 'MINING_CLAIM_PREPARATION_SOURCE';END IF;
 IF (a->>'preparedAt' ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$') IS DISTINCT FROM true OR (a->>'expiresAt' ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$') IS DISTINCT FROM true
 OR ((a->>'expiresAt')::timestamptz>(a->>'preparedAt')::timestamptz) IS DISTINCT FROM true THEN RAISE EXCEPTION 'MINING_CLAIM_PREPARATION_INPUT';END IF;
 FOREACH v IN ARRAY ARRAY['payerBalanceLamports','feeLamports','rentLamports','totalLamports'] LOOP
  IF jsonb_typeof(a->v) IS DISTINCT FROM 'string' OR (a->>v ~ '^(0|[1-9][0-9]{0,19})$') IS DISTINCT FROM true OR (a->>v)::numeric>18446744073709551615 THEN RAISE EXCEPTION 'MINING_CLAIM_PREPARATION_INPUT';END IF;
 END LOOP;
 IF jsonb_typeof(a->'transactions') IS DISTINCT FROM 'array' OR jsonb_array_length(a->'transactions') NOT BETWEEN 1 AND 2 THEN RAISE EXCEPTION 'MINING_CLAIM_PREPARATION_INPUT';END IF;
 FOR t IN SELECT value FROM jsonb_array_elements(a->'transactions') LOOP
  IF jsonb_typeof(t) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(t))<>6 OR EXISTS(SELECT 1 FROM jsonb_object_keys(t) k WHERE k<>ALL(ARRAY['kind','messageHex','messageSha256','packetBytes','feeLamports','rentLamports']))
   OR (t->>'kind'=ANY(ARRAY['combined','setup','claim'])) IS DISTINCT FROM true OR length(t->>'messageHex') NOT BETWEEN 2 AND 2334 OR (t->>'messageHex' ~ '^([0-9a-f]{2})+$') IS DISTINCT FROM true THEN RAISE EXCEPTION 'MINING_CLAIM_PREPARATION_INPUT';END IF;
  IF t->>'messageSha256' IS DISTINCT FROM encode(sha256(decode(t->>'messageHex','hex')),'hex') OR jsonb_typeof(t->'packetBytes') IS DISTINCT FROM 'number'
   OR (t->>'packetBytes' ~ '^[1-9][0-9]{0,3}$') IS DISTINCT FROM true OR (t->>'packetBytes')::integer<>length(t->>'messageHex')/2+65 OR (t->>'packetBytes')::integer>1232 THEN RAISE EXCEPTION 'MINING_CLAIM_PREPARATION_INPUT';END IF;
  FOREACH v IN ARRAY ARRAY['feeLamports','rentLamports'] LOOP
   IF jsonb_typeof(t->v) IS DISTINCT FROM 'string' OR (t->>v ~ '^(0|[1-9][0-9]{0,19})$') IS DISTINCT FROM true OR (t->>v)::numeric>18446744073709551615 THEN RAISE EXCEPTION 'MINING_CLAIM_PREPARATION_INPUT';END IF;
  END LOOP;
  fee:=fee+(t->>'feeLamports')::numeric;rent:=rent+(t->>'rentLamports')::numeric;
 END LOOP;
 IF fee<>(a->>'feeLamports')::numeric OR rent<>(a->>'rentLamports')::numeric OR fee+rent<>(a->>'totalLamports')::numeric OR fee+rent>(a->>'payerBalanceLamports')::numeric THEN RAISE EXCEPTION 'MINING_CLAIM_PREPARATION_INPUT';END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_claim_preparations'::regclass AND tgname='mining_claim_preparations_immutable') THEN
  CREATE TRIGGER mining_claim_preparations_immutable BEFORE INSERT OR UPDATE OR DELETE ON mining_claim_preparations FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_claim_preparation_guard();
  CREATE TRIGGER mining_claim_preparations_no_truncate BEFORE TRUNCATE ON mining_claim_preparations FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_claim_preparation_guard();
 END IF;
END $$;
REVOKE ALL ON mining_claim_preparations FROM PUBLIC;
--> statement-breakpoint
DO $$BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shardkeep_api_runtime') THEN GRANT SELECT,INSERT ON mining_claim_preparations TO shardkeep_api_runtime;END IF;
END $$;
