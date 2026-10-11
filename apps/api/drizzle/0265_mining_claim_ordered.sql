-- D153.206 additive exact-format successor. Legacy artifacts remain byte-exact.
SET LOCAL lock_timeout='10s';
DO $$BEGIN
IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.shardkeep_mining_claim_preparation_guard()'::regprocedure) IS DISTINCT FROM 'ef4bf8e375754d044ba15bee2b3afc12252c7f757d173618c680eaa84d2a9144' THEN RAISE EXCEPTION 'MINING_CLAIM_ORDERED_PREDECESSOR';END IF;
IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.shardkeep_mining_claim_signed_guard()'::regprocedure) IS DISTINCT FROM 'c0c9cff9c25e8969bf86939974b15f54de80573ccfbbc675f589b0ee33975e48' THEN RAISE EXCEPTION 'MINING_CLAIM_ORDERED_PREDECESSOR';END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_mining_claim_format_valid(f jsonb,context_slot bigint) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t jsonb;p jsonb;BEGIN
 IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(f))<>5
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(f) k WHERE k<>ALL(ARRAY['version','preset','lookupTable','expectedLookupTable','blockhashContextSlot']))
 OR f->'version' IS DISTINCT FROM '1'::jsonb OR f->>'preset' IS DISTINCT FROM 'ordered-v0'
 OR jsonb_typeof(f->'blockhashContextSlot') IS DISTINCT FROM 'number' OR (f->>'blockhashContextSlot' ~ '^(0|[1-9][0-9]{0,15})$') IS NOT TRUE
 OR (f->>'blockhashContextSlot')::numeric>9007199254740991 OR (f->>'blockhashContextSlot')::numeric IS DISTINCT FROM context_slot
 THEN RETURN false;END IF;
 t:=f->'lookupTable';p:=f->'expectedLookupTable';
 IF jsonb_typeof(t) IS DISTINCT FROM 'object' OR jsonb_typeof(p) IS DISTINCT FROM 'object'
 OR (SELECT count(*) FROM jsonb_object_keys(t))<>5 OR (SELECT count(*) FROM jsonb_object_keys(p))<>2
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(t) k WHERE k<>ALL(ARRAY['address','owner','executable','dataHex','slot']))
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k<>ALL(ARRAY['address','dataSha256']))
 OR t->'executable' IS DISTINCT FROM 'false'::jsonb OR t->>'owner' IS DISTINCT FROM 'AddressLookupTab1e1111111111111111111111111'
 OR (t->>'address' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') IS NOT TRUE OR t->>'address' IS DISTINCT FROM p->>'address'
 OR (length(t->>'dataHex')=304) IS NOT TRUE OR (t->>'dataHex' ~ '^[0-9a-f]+$') IS NOT TRUE OR (p->>'dataSha256' ~ '^[0-9a-f]{64}$') IS NOT TRUE
 OR p->>'dataSha256' IS DISTINCT FROM encode(sha256(decode(t->>'dataHex','hex')),'hex')
 OR jsonb_typeof(t->'slot') IS DISTINCT FROM 'number' OR (t->>'slot' ~ '^(0|[1-9][0-9]{0,15})$') IS NOT TRUE
 OR (t->>'slot')::numeric>context_slot THEN RETURN false;END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_mining_claim_format_valid(jsonb,bigint) FROM PUBLIC;
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
 IF (SELECT count(*) FROM jsonb_object_keys(a))<>(CASE WHEN a?'format' THEN 24 ELSE 23 END) OR EXISTS(SELECT 1 FROM jsonb_object_keys(a) k WHERE k<>ALL(ARRAY['claimId','wallet','idempotencyKey','header','leafHex','proofHex','needsAta','needsMinerRecords','quoteVersion','preparedAt','expiresAt','snapshotSlot','blockhashContextSlot','blockhash','lastValidBlockHeight','payerBalanceLamports','feeLamports','rentLamports','totalLamports','transactions','state','currentSigningAuthorized','claimSubmissionAuthorized','format'])) THEN RAISE EXCEPTION 'MINING_CLAIM_PREPARATION_INPUT';END IF;
 -- A separate branch preserves legacy roles' original minimum grants: SQL
 -- expression initialization checks function ACLs before AND short-circuiting.
 IF a?'format' THEN
  IF public.shardkeep_mining_claim_format_valid(a->'format',(a->>'blockhashContextSlot')::bigint) IS NOT TRUE THEN RAISE EXCEPTION 'MINING_CLAIM_PREPARATION_FORMAT';END IF;
 END IF;
 -- Required values are checked without accepting JSON null/absent booleans.
 IF a->'state' IS DISTINCT FROM '"prepared"'::jsonb OR a->'currentSigningAuthorized' IS DISTINCT FROM 'false'::jsonb OR a->'claimSubmissionAuthorized' IS DISTINCT FROM 'false'::jsonb
 OR a->'quoteVersion' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(a->'needsAta') IS DISTINCT FROM 'boolean' OR jsonb_typeof(a->'needsMinerRecords') IS DISTINCT FROM 'boolean'
 OR (a->>'wallet' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') IS DISTINCT FROM true OR (a->>'blockhash' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') IS DISTINCT FROM true THEN RAISE EXCEPTION 'MINING_CLAIM_PREPARATION_INPUT';END IF;
 NEW.wallet:=a->>'wallet';NEW.idempotency_key:=(a->>'idempotencyKey')::uuid;NEW.claim_id:=(a->>'claimId')::uuid;
 -- Historical preparation lookup stays on the exact original sequence.
 IF jsonb_typeof(a#>'{header,sequence}') IS DISTINCT FROM 'string'
 OR (a#>>'{header,sequence}' ~ '^[1-9][0-9]{0,19}$') IS DISTINCT FROM true THEN RAISE EXCEPTION 'MINING_CLAIM_PREPARATION_SOURCE';END IF;
 IF (a#>>'{header,sequence}')::numeric>18446744073709551615 THEN RAISE EXCEPTION 'MINING_CLAIM_PREPARATION_SOURCE';END IF;
 SELECT * INTO h FROM public.mining_claim_entitlement_headers WHERE genesis_hash=a#>>'{header,genesisHash}' AND program_id=a#>>'{header,programId}' AND config_address=a#>>'{header,configAddress}' AND sequence=(a#>>'{header,sequence}')::numeric;
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
CREATE OR REPLACE FUNCTION public.shardkeep_mining_claim_signed_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.mining_claim_preparations%ROWTYPE; message bytea; matches integer;
BEGIN
 IF TG_RELID<>'public.mining_claim_signed_wires'::regclass OR TG_WHEN<>'BEFORE'
 OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'mining_claim_signed_wires_no_truncate' ELSE 'mining_claim_signed_wires_immutable' END)
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'MINING_CLAIM_SIGNED_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_CLAIM_SIGNED_IMMUTABLE';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_CLAIM_SIGNED_READ_COMMITTED';END IF;
 IF NEW.ordinal IS NOT NULL OR NEW.wallet IS NOT NULL OR NEW.signature IS NOT NULL OR NEW.wire_sha256 IS NOT NULL OR NEW.message_sha256 IS NOT NULL OR NEW.accepted_at IS NOT NULL THEN RAISE EXCEPTION 'MINING_CLAIM_SIGNED_DERIVED';END IF;
 IF NEW.signed_transaction IS NULL OR octet_length(NEW.signed_transaction) NOT BETWEEN 66 AND 1232 THEN RAISE EXCEPTION 'MINING_CLAIM_SIGNED_WIRE';END IF;
 IF get_byte(NEW.signed_transaction,0)<>1 THEN RAISE EXCEPTION 'MINING_CLAIM_SIGNED_WIRE';END IF;
 SELECT * INTO p FROM public.mining_claim_preparations WHERE claim_id=NEW.claim_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'MINING_CLAIM_SIGNED_PREPARATION';END IF;
 IF get_byte(NEW.signed_transaction,65)<>(CASE WHEN p.artifact?'format' THEN 128 ELSE 1 END) OR (p.artifact?'format' AND get_byte(NEW.signed_transaction,66)<>1) THEN RAISE EXCEPTION 'MINING_CLAIM_SIGNED_WIRE';END IF;
 message:=substring(NEW.signed_transaction FROM 66);
 SELECT count(*),min((n-1)::integer) INTO matches,NEW.ordinal FROM jsonb_array_elements(p.artifact->'transactions') WITH ORDINALITY t(value,n)
  WHERE value->>'messageHex'=encode(message,'hex');
 IF matches<>1 THEN RAISE EXCEPTION 'MINING_CLAIM_SIGNED_MESSAGE';END IF;
 NEW.wallet:=p.wallet;NEW.signature:=substring(NEW.signed_transaction FROM 2 FOR 64);
 IF NEW.signature=decode(repeat('00',64),'hex') THEN RAISE EXCEPTION 'MINING_CLAIM_SIGNED_WIRE';END IF;
 NEW.wire_sha256:=encode(sha256(NEW.signed_transaction),'hex');NEW.message_sha256:=encode(sha256(message),'hex');NEW.accepted_at:=clock_timestamp();
 IF NEW.message_sha256 IS DISTINCT FROM p.artifact#>>ARRAY['transactions',NEW.ordinal::text,'messageSha256'] THEN RAISE EXCEPTION 'MINING_CLAIM_SIGNED_MESSAGE';END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TABLE public.mining_claim_continuations(
 parent_claim_id uuid PRIMARY KEY REFERENCES mining_claim_preparations(claim_id),child_claim_id uuid NOT NULL UNIQUE REFERENCES mining_claim_preparations(claim_id),
 setup_claim_id uuid NOT NULL REFERENCES mining_claim_preparations(claim_id),wallet text NOT NULL,reason text NOT NULL CHECK(reason IN('unsigned-expired','failed')),
 expiry_height bigint NOT NULL CHECK(expiry_height BETWEEN 0 AND 9007199254740991),expiry_slot bigint NOT NULL CHECK(expiry_slot BETWEEN 0 AND 9007199254740991),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)),CHECK(parent_claim_id<>child_claim_id)
);
CREATE FUNCTION public.shardkeep_mining_claim_continuation_lock(parent_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_CLAIM_CONTINUATION_READ_COMMITTED';END IF;
 PERFORM 1 FROM public.mining_claim_preparations WHERE claim_id=parent_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MINING_CLAIM_CONTINUATION_PARENT';END IF;
END $$;
CREATE FUNCTION public.shardkeep_mining_claim_signed_parent_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF TG_RELID<>'public.mining_claim_signed_wires'::regclass OR TG_NAME<>'mining_claim_signed_parent_lock' OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'MINING_CLAIM_CONTINUATION_TRIGGER';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_CLAIM_SIGNED_READ_COMMITTED';END IF;
 PERFORM public.shardkeep_mining_claim_continuation_lock(NEW.claim_id);RETURN NEW;
END $$;
CREATE FUNCTION public.shardkeep_mining_claim_continuation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.mining_claim_preparations%ROWTYPE;c public.mining_claim_preparations%ROWTYPE;s jsonb;f jsonb;k text;selected_ordinal integer;sid uuid;
BEGIN
 IF TG_RELID<>'public.mining_claim_continuations'::regclass OR TG_WHEN<>'BEFORE'
 OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'mining_claim_continuations_no_truncate' ELSE 'mining_claim_continuations_immutable' END)
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'MINING_CLAIM_CONTINUATION_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_CLAIM_CONTINUATION_IMMUTABLE';END IF;
 IF NEW.wallet IS NOT NULL OR NEW.created_at IS NOT NULL OR NEW.setup_claim_id IS NOT NULL THEN RAISE EXCEPTION 'MINING_CLAIM_CONTINUATION_DERIVED';END IF;
 PERFORM public.shardkeep_mining_claim_continuation_lock(NEW.parent_claim_id);
 SELECT * INTO STRICT p FROM public.mining_claim_preparations WHERE claim_id=NEW.parent_claim_id;
 SELECT * INTO STRICT c FROM public.mining_claim_preparations WHERE claim_id=NEW.child_claim_id FOR UPDATE;
 selected_ordinal:=jsonb_array_length(p.artifact->'transactions')-1;
 IF p.claim_id=c.claim_id OR p.wallet IS DISTINCT FROM c.wallet OR p.idempotency_key=c.idempotency_key
 OR p.artifact#>>ARRAY['transactions',selected_ordinal::text,'kind'] IS DISTINCT FROM 'claim'
 OR p.artifact->'format' IS NULL OR c.artifact->'format' IS NULL
 THEN RAISE EXCEPTION 'MINING_CLAIM_CONTINUATION_PARENT';END IF;
 IF selected_ordinal=1 AND p.artifact#>>'{transactions,0,kind}'='setup' THEN sid:=p.claim_id;
 ELSE SELECT setup_claim_id INTO sid FROM public.mining_claim_continuations WHERE child_claim_id=p.claim_id AND wallet=p.wallet;END IF;
 SELECT receipt INTO s FROM public.mining_claim_receipts WHERE claim_id=sid AND ordinal=0 AND wallet=p.wallet;
 IF sid IS NULL OR s->>'kind' IS DISTINCT FROM 'setup' OR s->>'paidKeepBaseUnits' IS DISTINCT FROM '0' THEN RAISE EXCEPTION 'MINING_CLAIM_CONTINUATION_SETUP';END IF;
 IF EXISTS(SELECT 1 FROM public.mining_claim_receipts WHERE claim_id=p.claim_id AND mining_claim_receipts.ordinal=selected_ordinal)
 THEN RAISE EXCEPTION 'MINING_CLAIM_CONTINUATION_SETTLED';END IF;
 SELECT receipt INTO f FROM public.mining_claim_failures WHERE claim_id=p.claim_id AND mining_claim_failures.ordinal=selected_ordinal;
 IF NEW.reason='unsigned-expired' THEN
  IF f IS NOT NULL OR EXISTS(SELECT 1 FROM public.mining_claim_signed_wires WHERE claim_id=p.claim_id AND mining_claim_signed_wires.ordinal=selected_ordinal)
  THEN RAISE EXCEPTION 'MINING_CLAIM_CONTINUATION_SIGNED';END IF;
  IF NEW.expiry_height<=(p.artifact->>'lastValidBlockHeight')::bigint THEN RAISE EXCEPTION 'MINING_CLAIM_CONTINUATION_EXPIRY';END IF;
 ELSIF NEW.reason='failed' THEN
  IF f->>'outcome' IS DISTINCT FROM 'failed' OR f->>'kind' IS DISTINCT FROM 'claim' THEN RAISE EXCEPTION 'MINING_CLAIM_CONTINUATION_FAILURE';END IF;
 ELSE RAISE EXCEPTION 'MINING_CLAIM_CONTINUATION_INPUT';END IF;
 IF EXISTS(SELECT 1 FROM public.mining_claim_signed_wires WHERE claim_id=c.claim_id)
 OR EXISTS(SELECT 1 FROM public.mining_claim_receipts WHERE claim_id=c.claim_id)
 OR EXISTS(SELECT 1 FROM public.mining_claim_failures WHERE claim_id=c.claim_id)
 OR EXISTS(SELECT 1 FROM public.mining_claim_continuations WHERE parent_claim_id=c.claim_id)
 OR c.inserted_at<p.inserted_at OR jsonb_array_length(c.artifact->'transactions')<>1
 OR c.artifact#>>'{transactions,0,kind}' IS DISTINCT FROM 'claim' OR c.artifact->'needsAta' IS DISTINCT FROM 'false'::jsonb
 OR c.artifact->'needsMinerRecords' IS DISTINCT FROM 'false'::jsonb OR c.artifact->>'rentLamports' IS DISTINCT FROM '0'
 THEN RAISE EXCEPTION 'MINING_CLAIM_CONTINUATION_CHILD';END IF;
 FOREACH k IN ARRAY ARRAY['header','leafHex','proofHex'] LOOP
  IF p.artifact->k IS DISTINCT FROM c.artifact->k THEN RAISE EXCEPTION 'MINING_CLAIM_CONTINUATION_SOURCE';END IF;
 END LOOP;
 IF p.artifact#>'{format,expectedLookupTable}' IS DISTINCT FROM c.artifact#>'{format,expectedLookupTable}'
 OR p.artifact#>>'{format,preset}' IS DISTINCT FROM c.artifact#>>'{format,preset}'
 OR p.artifact->>'blockhash'=c.artifact->>'blockhash'
 OR NEW.expiry_height IS NULL OR NEW.expiry_slot IS NULL
 OR NEW.expiry_slot<greatest((p.artifact->>'snapshotSlot')::bigint,(p.artifact->>'blockhashContextSlot')::bigint,(s->>'observedAccountSlot')::bigint,coalesce((f->>'observedAccountSlot')::bigint,0))
 OR (c.artifact->>'snapshotSlot')::bigint<NEW.expiry_slot OR (c.artifact#>>'{format,lookupTable,slot}')::bigint<NEW.expiry_slot
 THEN RAISE EXCEPTION 'MINING_CLAIM_CONTINUATION_SOURCE';END IF;
 NEW.wallet:=p.wallet;NEW.setup_claim_id:=sid;NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER mining_claim_signed_parent_lock BEFORE INSERT ON mining_claim_signed_wires FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_claim_signed_parent_lock();
CREATE TRIGGER mining_claim_continuations_immutable BEFORE INSERT OR UPDATE OR DELETE ON mining_claim_continuations FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_claim_continuation_guard();
CREATE TRIGGER mining_claim_continuations_no_truncate BEFORE TRUNCATE ON mining_claim_continuations FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_claim_continuation_guard();
REVOKE ALL ON public.mining_claim_continuations FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_mining_claim_continuation_lock(uuid),public.shardkeep_mining_claim_signed_parent_lock(),public.shardkeep_mining_claim_continuation_guard() FROM PUBLIC;
DO $$BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shardkeep_api_runtime') THEN
 GRANT SELECT,INSERT ON mining_claim_continuations TO shardkeep_api_runtime;
 GRANT EXECUTE ON FUNCTION public.shardkeep_mining_claim_continuation_lock(uuid),public.shardkeep_mining_claim_format_valid(jsonb,bigint) TO shardkeep_api_runtime;
END IF;END $$;
