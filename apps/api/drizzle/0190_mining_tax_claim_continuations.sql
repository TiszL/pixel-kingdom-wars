-- Explicit D-153.97 consent link, never payment/absence proof or signature erasure.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS mining_tax_claim_continuations (
 parent_claim_id uuid PRIMARY KEY REFERENCES mining_tax_claim_preparations(claim_id),
 child_claim_id uuid NOT NULL UNIQUE REFERENCES mining_tax_claim_preparations(claim_id),
 wallet text NOT NULL,expiry_height bigint NOT NULL CHECK(expiry_height BETWEEN 0 AND 9007199254740991),
 expiry_slot bigint NOT NULL CHECK(expiry_slot BETWEEN 0 AND 9007199254740991),created_at timestamptz NOT NULL CHECK(isfinite(created_at)),
 CHECK(parent_claim_id<>child_claim_id)
);
--> statement-breakpoint
-- A narrowly scoped row lock avoids granting runtime UPDATE on preparations.
CREATE OR REPLACE FUNCTION public.shardkeep_mining_tax_continuation_lock(parent_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_TAX_CONTINUATION_READ_COMMITTED';END IF;
 PERFORM 1 FROM public.mining_tax_claim_preparations WHERE claim_id=parent_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MINING_TAX_CONTINUATION_PARENT';END IF;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_mining_tax_continuation_lock(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_tax_signed_parent_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID<>'public.mining_tax_claim_signed_wires'::regclass OR TG_NAME<>'mining_tax_claim_signed_parent_lock'
 OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'MINING_TAX_CONTINUATION_TRIGGER';END IF;
 PERFORM public.shardkeep_mining_tax_continuation_lock(NEW.claim_id);
 -- A prior link suppresses future admission, never custody of a late signature.
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_mining_tax_signed_parent_lock() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_tax_continuation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.mining_tax_claim_preparations%ROWTYPE;c public.mining_tax_claim_preparations%ROWTYPE;s jsonb;k text;
BEGIN
 IF TG_RELID<>'public.mining_tax_claim_continuations'::regclass OR TG_WHEN<>'BEFORE'
 OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'mining_tax_claim_continuations_no_truncate' ELSE 'mining_tax_claim_continuations_immutable' END)
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'MINING_TAX_CONTINUATION_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_TAX_CONTINUATION_IMMUTABLE';END IF;
 IF NEW.wallet IS NOT NULL OR NEW.created_at IS NOT NULL THEN RAISE EXCEPTION 'MINING_TAX_CONTINUATION_DERIVED';END IF;
 PERFORM public.shardkeep_mining_tax_continuation_lock(NEW.parent_claim_id);
 SELECT * INTO STRICT p FROM public.mining_tax_claim_preparations WHERE claim_id=NEW.parent_claim_id;
 SELECT * INTO STRICT c FROM public.mining_tax_claim_preparations WHERE claim_id=NEW.child_claim_id FOR UPDATE;
 SELECT receipt INTO s FROM public.mining_tax_claim_receipts WHERE claim_id=p.claim_id AND ordinal=0;
 IF p.claim_id=c.claim_id OR p.wallet IS DISTINCT FROM c.wallet OR p.idempotency_key=c.idempotency_key
 OR jsonb_array_length(p.artifact->'transactions')<>2 OR p.artifact#>>'{transactions,0,kind}' IS DISTINCT FROM 'setup'
 OR p.artifact#>>'{transactions,1,kind}' IS DISTINCT FROM 'claim' OR s->>'phase' IS DISTINCT FROM 'setup'
 THEN RAISE EXCEPTION 'MINING_TAX_CONTINUATION_PARENT';END IF;
 IF EXISTS(SELECT 1 FROM public.mining_tax_claim_signed_wires WHERE claim_id=p.claim_id AND ordinal=1)
 OR EXISTS(SELECT 1 FROM public.mining_tax_claim_receipts WHERE claim_id=p.claim_id AND ordinal=1)
 OR EXISTS(SELECT 1 FROM public.mining_tax_claim_failures WHERE claim_id=p.claim_id)
 THEN RAISE EXCEPTION 'MINING_TAX_CONTINUATION_SIGNED';END IF;
 IF EXISTS(SELECT 1 FROM public.mining_tax_claim_signed_wires WHERE claim_id=c.claim_id)
 OR EXISTS(SELECT 1 FROM public.mining_tax_claim_receipts WHERE claim_id=c.claim_id)
 OR EXISTS(SELECT 1 FROM public.mining_tax_claim_failures WHERE claim_id=c.claim_id)
 OR EXISTS(SELECT 1 FROM public.mining_tax_claim_continuations WHERE parent_claim_id=c.claim_id)
 THEN RAISE EXCEPTION 'MINING_TAX_CONTINUATION_CHILD';END IF;
 FOREACH k IN ARRAY ARRAY['round','spot','identity','term'] LOOP
  IF p.artifact->k IS DISTINCT FROM c.artifact->k THEN RAISE EXCEPTION 'MINING_TAX_CONTINUATION_SOURCE';END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['genesisHash','programId','reviewedDeploymentSlot','reviewedProgramDataSha256'] LOOP
  IF p.artifact->'source'->k IS DISTINCT FROM c.artifact->'source'->k THEN RAISE EXCEPTION 'MINING_TAX_CONTINUATION_SOURCE';END IF;
 END LOOP;
 IF NEW.expiry_height IS NULL OR NEW.expiry_slot IS NULL OR NEW.expiry_height<=(p.artifact->>'lastValidBlockHeight')::bigint
 OR (c.artifact->>'blockHeight')::bigint<NEW.expiry_height
 OR NEW.expiry_slot<greatest((p.artifact#>>'{source,snapshotSlot}')::bigint,(p.artifact#>>'{source,blockhashSlot}')::bigint,(s#>>'{source,observedAccountSlot}')::bigint)
 OR (c.artifact#>>'{source,firstSnapshotSlot}')::bigint<NEW.expiry_slot OR (c.artifact#>>'{source,snapshotSlot}')::bigint<NEW.expiry_slot
 OR (c.artifact#>>'{snapshot,unixTimestamp}')::numeric<(s#>>'{source,observedClockUnixTimestamp}')::numeric
 OR c.artifact->>'blockhash'=p.artifact->>'blockhash'
 THEN RAISE EXCEPTION 'MINING_TAX_CONTINUATION_EXPIRY';END IF;
 NEW.wallet:=p.wallet;NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_mining_tax_continuation_guard() FROM PUBLIC;
--> statement-breakpoint
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_tax_claim_signed_wires'::regclass AND tgname='mining_tax_claim_signed_parent_lock') THEN
 CREATE TRIGGER mining_tax_claim_signed_parent_lock BEFORE INSERT ON mining_tax_claim_signed_wires FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_tax_signed_parent_lock();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_tax_claim_continuations'::regclass AND tgname='mining_tax_claim_continuations_immutable') THEN
 CREATE TRIGGER mining_tax_claim_continuations_immutable BEFORE INSERT OR UPDATE OR DELETE ON mining_tax_claim_continuations FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_tax_continuation_guard();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.mining_tax_claim_continuations'::regclass AND tgname='mining_tax_claim_continuations_no_truncate') THEN
 CREATE TRIGGER mining_tax_claim_continuations_no_truncate BEFORE TRUNCATE ON mining_tax_claim_continuations FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_tax_continuation_guard();END IF;
END $$;
REVOKE ALL ON mining_tax_claim_continuations FROM PUBLIC;
--> statement-breakpoint
DO $$BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shardkeep_api_runtime') THEN
 GRANT SELECT,INSERT ON mining_tax_claim_continuations TO shardkeep_api_runtime;
 GRANT EXECUTE ON FUNCTION public.shardkeep_mining_tax_continuation_lock(uuid) TO shardkeep_api_runtime;
 END IF;
END $$;
