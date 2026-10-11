-- Cumulative public claim proofs; no existing row is rewritten or backfilled.
-- Replaces existing guards/constraints under the held S5 migration boundary.
-- Owner history auditing still verifies the Merkle root/proofs and source facts;
-- SQL independently enforces the complete per-wallet cumulative recurrence.
SET LOCAL lock_timeout='10s';
ALTER TABLE public.mining_claim_entitlement_headers
 DROP CONSTRAINT IF EXISTS mining_claim_entitlement_headers_sequence_check,
 ADD CONSTRAINT mining_claim_entitlement_headers_sequence_check CHECK(sequence BETWEEN 1 AND 18446744073709551615),
 DROP CONSTRAINT IF EXISTS mining_claim_entitlement_headers_leaf_count_check,
 ADD CONSTRAINT mining_claim_entitlement_headers_leaf_count_check CHECK(leaf_count BETWEEN 1 AND 10000);
ALTER TABLE public.mining_claim_entitlement_leaves
 DROP CONSTRAINT IF EXISTS mining_claim_entitlement_leaves_leaf_index_check,
 ADD CONSTRAINT mining_claim_entitlement_leaves_leaf_index_check CHECK(leaf_index BETWEEN 0 AND 9999);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_entitlement_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE m public.mining_publication_manifests%ROWTYPE; s public.mining_publication_settlements%ROWTYPE;
 h public.mining_claim_entitlement_headers%ROWTYPE; previous_h public.mining_claim_entitlement_headers%ROWTYPE;
 previous_s public.mining_publication_settlements%ROWTYPE; plan jsonb; reference jsonb; expected jsonb;
 i integer; v text; n numeric:=0; sequence_value numeric:=0; encoded text:='';
 alphabet text:='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
BEGIN
 IF TG_RELID NOT IN ('public.mining_claim_entitlement_headers'::regclass,'public.mining_claim_entitlement_leaves'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||(CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_immutable' END)) OR TG_WHEN<>'BEFORE'
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_TRIGGER_IDENTITY'; END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_IMMUTABLE'; END IF;
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_READ_COMMITTED_REQUIRED'; END IF;
 PERFORM 1 FROM public.mining_ingot_epochs WHERE id=NEW.epoch_id FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
 IF TG_TABLE_NAME='mining_claim_entitlement_headers' THEN
  IF EXISTS(SELECT 1 FROM jsonb_each(to_jsonb(NEW)-'epoch_id') kv WHERE kv.value<>'null'::jsonb) THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_DERIVED_FIELDS'; END IF;
  SELECT * INTO STRICT m FROM public.mining_publication_manifests WHERE epoch_id=NEW.epoch_id;
  SELECT * INTO STRICT s FROM public.mining_publication_settlements WHERE epoch_id=NEW.epoch_id;
  IF octet_length(m.manifest_json)>4194304 THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
  plan:=m.manifest_json::jsonb;
  FOREACH v IN ARRAY ARRAY['sequence','day','total','playerNet'] LOOP
   IF jsonb_typeof(m.publication->v) IS DISTINCT FROM 'string'
    OR (m.publication->>v ~ '^[1-9][0-9]{0,19}$') IS DISTINCT FROM true THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
   IF (m.publication->>v)::numeric>18446744073709551615 THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
  END LOOP;
  IF jsonb_typeof(m.publication->'leafCount') IS DISTINCT FROM 'number'
   OR (m.publication->>'leafCount' ~ '^[1-9][0-9]{0,4}$') IS DISTINCT FROM true
   OR jsonb_typeof(s.receipt->'slot') IS DISTINCT FROM 'number'
   OR (s.receipt->>'slot' ~ '^(0|[1-9][0-9]{0,15})$') IS DISTINCT FROM true THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
  IF (m.publication->>'leafCount')::integer>10000 OR (s.receipt->>'slot')::numeric>9007199254740991 THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
  NEW.genesis_hash:=s.receipt->>'genesisHash';NEW.program_id:=m.publication->>'programId';NEW.config_address:=s.receipt->>'config';
  NEW.keep_mint:=m.publication->>'keepMint';NEW.reserve_owner:=m.publication->>'reserveOwner';NEW.sequence:=(m.publication->>'sequence')::numeric;
  NEW.day:=(m.publication->>'day')::numeric;NEW.root:=m.publication->>'root';NEW.source_hash:=m.source_hash;NEW.total_cumulative:=(m.publication->>'total')::numeric;
  NEW.leaf_count:=(m.publication->>'leafCount')::integer;NEW.publication_signature:=s.signature;NEW.publication_slot:=(s.receipt->>'slot')::bigint;NEW.projected_at:=clock_timestamp();
  IF s.receipt->>'sourceHash' IS DISTINCT FROM NEW.source_hash OR s.receipt->>'root' IS DISTINCT FROM NEW.root
   OR s.receipt->>'totalCumulative' IS DISTINCT FROM NEW.total_cumulative::text OR s.receipt->>'sequence' IS DISTINCT FROM NEW.sequence::text
   OR s.receipt->>'day' IS DISTINCT FROM NEW.day::text OR s.receipt->>'programId' IS DISTINCT FROM NEW.program_id
   OR s.receipt->>'mint' IS DISTINCT FROM NEW.keep_mint OR s.receipt->>'signature' IS DISTINCT FROM NEW.publication_signature
   OR s.receipt->>'originalMessageSha256' IS DISTINCT FROM m.intent_sha256 OR s.message_sha256 IS DISTINCT FROM m.intent_sha256
   OR plan#>>'{input,epochId}' IS DISTINCT FROM NEW.epoch_id::text OR plan->>'projection' IS DISTINCT FROM 'READY'
   OR plan#>>'{funding,source,genesisHash}' IS DISTINCT FROM NEW.genesis_hash
   OR plan#>>'{funding,source,programId}' IS DISTINCT FROM NEW.program_id
   OR plan#>>'{funding,config,address}' IS DISTINCT FROM NEW.config_address
   OR plan#>>'{funding,config,keepMint}' IS DISTINCT FROM NEW.keep_mint
   OR plan#>>'{funding,config,emissionReserveOwner}' IS DISTINCT FROM NEW.reserve_owner
   OR s.receipt->>'reviewedProgramDataSha256' IS DISTINCT FROM plan#>>'{funding,source,reviewedProgramDataSha256}'
   OR s.receipt->>'reviewedDeploymentSlot' IS DISTINCT FROM plan#>>'{funding,source,reviewedDeploymentSlot}'
   THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
  IF NEW.sequence=1 THEN
   IF plan->'version' IS DISTINCT FROM '1'::jsonb OR plan->>'scope' IS DISTINCT FROM 'initial-free-virgin-config-keep-only'
    OR plan->'previousPublication' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
  ELSE
   IF plan->'version' IS DISTINCT FROM '2'::jsonb OR plan->>'scope' IS DISTINCT FROM 'initial-free-cumulative-keep-only'
    OR jsonb_typeof(plan->'previousPublication') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_PREDECESSOR'; END IF;
   SELECT * INTO previous_h FROM public.mining_claim_entitlement_headers WHERE genesis_hash=NEW.genesis_hash
    AND program_id=NEW.program_id AND config_address=NEW.config_address AND sequence=NEW.sequence-1;
   IF NOT FOUND THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_PREDECESSOR'; END IF;
   SELECT * INTO STRICT previous_s FROM public.mining_publication_settlements WHERE epoch_id=previous_h.epoch_id;
   reference:=plan->'previousPublication';
   expected:=jsonb_build_object('epochId',previous_h.epoch_id::text,'sequence',previous_h.sequence::text,'day',previous_h.day::text,
    'root',previous_h.root,'total',previous_h.total_cumulative::text,'leafCount',previous_h.leaf_count,'sourceHash',previous_h.source_hash,
    'signature',previous_h.publication_signature,'publicationSlot',previous_h.publication_slot,
    'messageSha256',previous_s.message_sha256,'wireSha256',previous_s.wire_sha256);
   IF reference IS DISTINCT FROM expected OR previous_h.keep_mint IS DISTINCT FROM NEW.keep_mint
    OR previous_h.reserve_owner IS DISTINCT FROM NEW.reserve_owner OR NEW.day<=previous_h.day
    OR NEW.publication_slot<previous_h.publication_slot OR previous_h.publication_signature IS DISTINCT FROM previous_s.signature
    OR s.receipt->>'reviewedProgramDataSha256' IS DISTINCT FROM previous_s.receipt->>'reviewedProgramDataSha256'
    OR s.receipt->>'reviewedDeploymentSlot' IS DISTINCT FROM previous_s.receipt->>'reviewedDeploymentSlot'
    OR NEW.total_cumulative<>previous_h.total_cumulative+(m.publication->>'playerNet')::numeric
    THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_PREDECESSOR'; END IF;
  END IF;
 ELSE
  -- Do not parse a multi-megabyte source manifest for each of 10,000 leaves.
  -- The single deferred header event proves recurrence and completeness below.
  SELECT * INTO STRICT h FROM public.mining_claim_entitlement_headers WHERE epoch_id=NEW.epoch_id;
  IF NEW.leaf_index IS NULL OR NEW.leaf_index<0 OR NEW.leaf_index>=h.leaf_count
   OR NEW.wallet IS NULL OR length(NEW.wallet) NOT BETWEEN 32 AND 44
   OR NEW.leaf_bytes IS NULL OR octet_length(NEW.leaf_bytes)<>65
   OR NEW.proof_bytes IS NULL OR octet_length(NEW.proof_bytes) NOT BETWEEN 4 AND 660
   OR (octet_length(NEW.proof_bytes)-4)%41<>0 THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_LEAF'; END IF;
  IF get_byte(NEW.leaf_bytes,0)<>2 OR get_byte(NEW.proof_bytes,0)<>(octet_length(NEW.proof_bytes)-4)/41
   OR substring(NEW.proof_bytes FROM 2 FOR 3)<>decode('000000','hex') THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_LEAF'; END IF;
  FOR i IN 0..7 LOOP sequence_value:=sequence_value+get_byte(NEW.leaf_bytes,57+i)*power(256::numeric,i); END LOOP;
  IF sequence_value<>h.sequence THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_LEAF'; END IF;
  -- Fixed32-byte Base58 encoding; div avoids rounded large numeric quotients.
  FOR i IN 1..32 LOOP n:=n*256+get_byte(NEW.leaf_bytes,i); END LOOP;
  WHILE n>0 LOOP encoded:=substr(alphabet,mod(n,58)::integer+1,1)||encoded;n:=div(n,58); END LOOP;
  FOR i IN 1..32 LOOP EXIT WHEN get_byte(NEW.leaf_bytes,i)<>0;encoded:='1'||encoded; END LOOP;
  IF NEW.wallet IS DISTINCT FROM encoded THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_LEAF'; END IF;
  FOR i IN 0..get_byte(NEW.proof_bytes,0)-1 LOOP
   IF get_byte(NEW.proof_bytes,44+i*41) NOT IN (0,1) THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_LEAF'; END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_entitlement_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE h public.mining_claim_entitlement_headers%ROWTYPE; previous_h public.mining_claim_entitlement_headers%ROWTYPE;
 m public.mining_publication_manifests%ROWTYPE; plan jsonb; award jsonb; previous_epoch uuid;
 wrong boolean; actual_count bigint; actual_total numeric; award_total numeric:=0;
BEGIN
 IF TG_RELID<>'public.mining_claim_entitlement_headers'::regclass OR TG_NAME<>'mining_claim_entitlement_headers_complete'
  OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_TRIGGER_IDENTITY'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_READ_COMMITTED_REQUIRED'; END IF;
 SELECT * INTO STRICT h FROM public.mining_claim_entitlement_headers WHERE epoch_id=NEW.epoch_id;
 SELECT * INTO STRICT m FROM public.mining_publication_manifests WHERE epoch_id=NEW.epoch_id;
 IF octet_length(m.manifest_json)>4194304 THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
 plan:=m.manifest_json::jsonb;
 IF jsonb_typeof(plan->'awards') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
 IF jsonb_array_length(plan->'awards') NOT BETWEEN 1 AND 32 THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
 FOR award IN SELECT value FROM jsonb_array_elements(plan->'awards') LOOP
  IF jsonb_typeof(award) IS DISTINCT FROM 'object' OR jsonb_typeof(award->'wallet') IS DISTINCT FROM 'string'
   OR (award->>'wallet' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') IS DISTINCT FROM true
   OR jsonb_typeof(award->'net') IS DISTINCT FROM 'string'
   OR (award->>'net' ~ '^(0|[1-9][0-9]{0,19})$') IS DISTINCT FROM true THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
  IF (award->>'net')::numeric>18446744073709551615 THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
  award_total:=award_total+(award->>'net')::numeric;
 END LOOP;
 IF (SELECT count(DISTINCT a->>'wallet') FROM jsonb_array_elements(plan->'awards') a)<>jsonb_array_length(plan->'awards')
  OR award_total<>(m.publication->>'playerNet')::numeric THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
 IF h.sequence>1 THEN
  SELECT * INTO previous_h FROM public.mining_claim_entitlement_headers WHERE genesis_hash=h.genesis_hash
   AND program_id=h.program_id AND config_address=h.config_address AND sequence=h.sequence-1;
  IF NOT FOUND THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_PREDECESSOR'; END IF;
  previous_epoch:=previous_h.epoch_id;
  IF previous_epoch::text IS DISTINCT FROM plan#>>'{previousPublication,epochId}'
   OR (SELECT count(*) FROM public.mining_claim_entitlement_leaves WHERE epoch_id=previous_epoch)<>previous_h.leaf_count
   THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_PREDECESSOR'; END IF;
 END IF;
 -- All rows are bounded by unique indices < their immutable header's count.
 -- Parse each fixed leaf once. Byte ordering matches the canonical chain tree.
 WITH current_rows AS MATERIALIZED (
  SELECT l.wallet,l.leaf_index,row_number() OVER(ORDER BY substring(l.leaf_bytes FROM 2 FOR 32))-1 canonical_index,
   d.keep,d.renown,d.days
  FROM public.mining_claim_entitlement_leaves l CROSS JOIN LATERAL (
   SELECT sum(get_byte(l.leaf_bytes,33+i)*power(256::numeric,i)) keep,
    sum(get_byte(l.leaf_bytes,41+i)*power(256::numeric,i)) renown,
    sum(get_byte(l.leaf_bytes,49+i)*power(256::numeric,i)) days FROM generate_series(0,7) i
  ) d WHERE l.epoch_id=h.epoch_id
 ), previous_rows AS MATERIALIZED (
  SELECT l.wallet,d.keep,d.renown,d.days FROM public.mining_claim_entitlement_leaves l CROSS JOIN LATERAL (
   SELECT sum(get_byte(l.leaf_bytes,33+i)*power(256::numeric,i)) keep,
    sum(get_byte(l.leaf_bytes,41+i)*power(256::numeric,i)) renown,
    sum(get_byte(l.leaf_bytes,49+i)*power(256::numeric,i)) days FROM generate_series(0,7) i
  ) d WHERE l.epoch_id=previous_epoch
 ), awards AS MATERIALIZED (
  SELECT a->>'wallet' wallet,(a->>'net')::numeric net FROM jsonb_array_elements(plan->'awards') a
 ), expected_rows AS MATERIALIZED (
  SELECT coalesce(p.wallet,a.wallet) wallet,coalesce(p.keep,0)+coalesce(a.net,0) keep,
   coalesce(p.renown,0) renown,coalesce(p.days,0) days
  FROM previous_rows p FULL JOIN awards a USING(wallet) WHERE p.wallet IS NOT NULL OR a.net>0
 )
 SELECT coalesce(bool_or(c.wallet IS NULL OR e.wallet IS NULL OR c.leaf_index<>c.canonical_index
  OR c.keep<>e.keep OR c.renown<>e.renown OR c.days<>e.days OR e.keep>18446744073709551615),true),
  count(*),coalesce(sum(c.keep),0) INTO wrong,actual_count,actual_total
 FROM current_rows c FULL JOIN expected_rows e USING(wallet);
 IF wrong OR actual_count<>h.leaf_count OR actual_total<>h.total_cumulative
  OR h.total_cumulative<>coalesce(previous_h.total_cumulative,0)+award_total THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_INCOMPLETE'; END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
-- One deferred full-set check per new header, never one per leaf. A committed
-- complete header occupies every allowed unique index, so no later INSERT can
-- append a leaf. Existing UPDATE/DELETE/TRUNCATE prohibitions remain absolute.
DO $migration$
DECLARE n text;
BEGIN
 FOREACH n IN ARRAY ARRAY['mining_claim_entitlement_headers','mining_claim_entitlement_leaves'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I',n||'_immutable',n);
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I',n||'_no_truncate',n);
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I',n||'_complete',n);
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_entitlement_guard()',n||'_immutable',n);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_entitlement_guard()',n||'_no_truncate',n);
 END LOOP;
 CREATE CONSTRAINT TRIGGER mining_claim_entitlement_headers_complete AFTER INSERT ON public.mining_claim_entitlement_headers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_entitlement_complete();
END $migration$;
REVOKE ALL ON public.mining_claim_entitlement_headers,public.mining_claim_entitlement_leaves FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_mining_entitlement_guard(),public.shardkeep_mining_entitlement_complete() FROM PUBLIC;

--> statement-breakpoint
-- Only the header sequence lookup changes from0173; its complete immutable
-- artifact/header comparison and unrelated failed-wire fences remain intact.
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
