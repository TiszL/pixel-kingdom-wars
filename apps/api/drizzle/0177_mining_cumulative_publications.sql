-- Cumulative free-only manifests retain a settled predecessor. Existing SQL,
-- rows and immutable custody dispositions are unchanged. This replacement of
-- the existing guard remains held under S5 pending separate owner approval.
SET LOCAL lock_timeout='10s';
CREATE OR REPLACE FUNCTION public.shardkeep_mining_settlement_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.mining_publication_attempts%ROWTYPE; m public.mining_publication_manifests%ROWTYPE;
 r public.mining_ingot_reservations%ROWTYPE; plan jsonb; planned jsonb; k text;
 previous_m public.mining_publication_manifests%ROWTYPE;
 previous_s public.mining_publication_settlements%ROWTYPE; reference jsonb;
BEGIN
 IF TG_RELID NOT IN ('public.mining_publication_manifests'::regclass,'public.mining_publication_settlements'::regclass,'public.mining_ingot_dispositions'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||(CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_immutable' END)) OR TG_WHEN<>'BEFORE'
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN
 RAISE EXCEPTION 'MINING_SETTLEMENT_TRIGGER_IDENTITY'; END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_SETTLEMENT_IMMUTABLE'; END IF;
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN
 RAISE EXCEPTION 'MINING_SETTLEMENT_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_SETTLEMENT_READ_COMMITTED_REQUIRED'; END IF;
 PERFORM 1 FROM public.mining_ingot_epochs WHERE id=NEW.epoch_id FOR UPDATE NOWAIT;
 SELECT * INTO STRICT a FROM public.mining_publication_attempts WHERE epoch_id=NEW.epoch_id;
 IF EXISTS(SELECT 1 FROM public.mining_ingot_aborts WHERE epoch_id=NEW.epoch_id) THEN RAISE EXCEPTION 'MINING_SETTLEMENT_ABORTED'; END IF;
 IF TG_TABLE_NAME='mining_publication_manifests' THEN
  IF NEW.source_hash IS NOT NULL OR NEW.intent_sha256 IS NOT NULL OR NEW.prepared_at IS NOT NULL THEN RAISE EXCEPTION 'MINING_SETTLEMENT_DERIVED_FIELDS'; END IF;
  plan:=NEW.manifest_json::jsonb;
  IF ((plan->>'scope'='initial-free-virgin-config-keep-only' AND plan->>'version'='1')
    OR (plan->>'scope'='initial-free-cumulative-keep-only' AND plan->>'version'='2')) IS DISTINCT FROM true
   OR plan->>'projection' IS DISTINCT FROM 'READY'
   OR plan#>>'{input,epochId}' IS DISTINCT FROM NEW.epoch_id::text OR jsonb_typeof(plan->'reservations') IS DISTINCT FROM 'array'
   OR jsonb_array_length(plan->'reservations')<>a.reservation_count THEN RAISE EXCEPTION 'MINING_SETTLEMENT_MANIFEST'; END IF;
  IF plan->>'version'='2' THEN
   reference:=plan->'previousPublication';
   IF jsonb_typeof(reference) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'MINING_SETTLEMENT_PREDECESSOR'; END IF;
   SELECT * INTO STRICT previous_m FROM public.mining_publication_manifests WHERE epoch_id=(reference->>'epochId')::uuid;
   SELECT * INTO STRICT previous_s FROM public.mining_publication_settlements WHERE epoch_id=previous_m.epoch_id;
   IF reference->>'sourceHash' IS DISTINCT FROM previous_m.source_hash
    OR reference->>'signature' IS DISTINCT FROM previous_s.signature
    OR reference->>'messageSha256' IS DISTINCT FROM previous_s.message_sha256
    OR reference->>'wireSha256' IS DISTINCT FROM previous_s.wire_sha256
    OR reference->>'publicationSlot' IS DISTINCT FROM previous_s.receipt->>'slot'
    OR ((NEW.publication->>'sequence')::numeric=(previous_m.publication->>'sequence')::numeric+1) IS DISTINCT FROM true
    OR ((NEW.publication->>'day')::numeric>(previous_m.publication->>'day')::numeric) IS DISTINCT FROM true
    OR ((NEW.publication->>'total')::numeric=(previous_m.publication->>'total')::numeric+(NEW.publication->>'playerNet')::numeric) IS DISTINCT FROM true
    OR plan#>>'{funding,source,genesisHash}' IS DISTINCT FROM previous_m.manifest_json::jsonb#>>'{funding,source,genesisHash}'
    OR plan#>>'{funding,config,address}' IS DISTINCT FROM previous_m.manifest_json::jsonb#>>'{funding,config,address}'
    THEN RAISE EXCEPTION 'MINING_SETTLEMENT_PREDECESSOR'; END IF;
   FOREACH k IN ARRAY ARRAY['sequence','day','root','total','leafCount'] LOOP
    IF reference->>k IS DISTINCT FROM previous_m.publication->>k THEN RAISE EXCEPTION 'MINING_SETTLEMENT_PREDECESSOR'; END IF;
   END LOOP;
   FOREACH k IN ARRAY ARRAY['programId','keepMint','reserveOwner'] LOOP
    IF NEW.publication->>k IS DISTINCT FROM previous_m.publication->>k THEN RAISE EXCEPTION 'MINING_SETTLEMENT_PREDECESSOR'; END IF;
   END LOOP;
  END IF;
  IF (SELECT count(DISTINCT v->>'reservationId') FROM jsonb_array_elements(plan->'reservations') v)<>a.reservation_count THEN RAISE EXCEPTION 'MINING_SETTLEMENT_MANIFEST'; END IF;
  FOR planned IN SELECT value FROM jsonb_array_elements(plan->'reservations') LOOP
   SELECT * INTO STRICT r FROM public.mining_ingot_reservations WHERE id=(planned->>'reservationId')::uuid AND epoch_id=NEW.epoch_id;
   IF planned->>'baseId' IS DISTINCT FROM r.base_id::text OR planned->>'actorWallet' IS DISTINCT FROM r.actor_wallet
    OR (planned->>'reserved')::integer IS DISTINCT FROM r.qty OR (planned->>'proposedConsumed')::integer<0 OR (planned->>'proposedReturned')::integer<0
    OR (planned->>'proposedConsumed')::bigint+(planned->>'proposedReturned')::bigint IS DISTINCT FROM r.qty::bigint THEN RAISE EXCEPTION 'MINING_SETTLEMENT_MANIFEST'; END IF;
  END LOOP;
  NEW.source_hash:=encode(sha256(convert_to(NEW.manifest_json,'UTF8')),'hex');NEW.intent_sha256:=a.intent_sha256;NEW.prepared_at:=clock_timestamp();
 ELSIF TG_TABLE_NAME='mining_publication_settlements' THEN
  SELECT * INTO STRICT m FROM public.mining_publication_manifests WHERE epoch_id=NEW.epoch_id;
  IF NEW.message_sha256 IS NOT NULL OR NEW.wire_sha256 IS NOT NULL OR NEW.finalized_at IS NOT NULL THEN RAISE EXCEPTION 'MINING_SETTLEMENT_DERIVED_FIELDS'; END IF;
  NEW.message_sha256:=a.intent_sha256;NEW.wire_sha256:=encode(sha256(NEW.signed_transaction),'hex');NEW.finalized_at:=clock_timestamp();
  IF NEW.receipt->>'signature' IS DISTINCT FROM NEW.signature OR NEW.receipt->>'originalMessageSha256' IS DISTINCT FROM a.intent_sha256
   OR NEW.receipt->>'signedTransactionSha256' IS DISTINCT FROM NEW.wire_sha256 OR NEW.receipt->>'sourceHash' IS DISTINCT FROM m.source_hash
   OR NEW.receipt->>'currentClaimsAuthorized' IS DISTINCT FROM 'false' OR NEW.receipt->>'scoreFairnessVerified' IS DISTINCT FROM 'false'
   OR NEW.receipt->>'trust' IS DISTINCT FROM 'trusted-finalized-rpc-reviewed-program'
   OR NEW.receipt->>'totalCumulative' IS DISTINCT FROM m.publication->>'total'
   OR ((NEW.receipt->>'slot')::bigint >= (m.publication->>'blockhashContextSlot')::bigint) IS DISTINCT FROM true THEN RAISE EXCEPTION 'MINING_SETTLEMENT_RECEIPT'; END IF;
  FOREACH k IN ARRAY ARRAY['programId','day','sequence','root','budgetGross','freeGross','deedGross','playerNet','recycle','tax','taxCommitment','taxVersion','splitStart','splitEnd'] LOOP
   IF NEW.receipt->>k IS DISTINCT FROM m.publication->>k THEN RAISE EXCEPTION 'MINING_SETTLEMENT_RECEIPT'; END IF;
  END LOOP;
 ELSE
  SELECT * INTO STRICT r FROM public.mining_ingot_reservations WHERE id=NEW.reservation_id AND epoch_id=NEW.epoch_id;
  SELECT * INTO STRICT m FROM public.mining_publication_manifests WHERE epoch_id=NEW.epoch_id;
  SELECT value INTO STRICT planned FROM jsonb_array_elements(m.manifest_json::jsonb->'reservations') WHERE value->>'reservationId'=NEW.reservation_id::text;
  IF NEW.consumed_qty::bigint+NEW.returned_qty::bigint<>r.qty OR NEW.consumed_qty IS DISTINCT FROM (planned->>'proposedConsumed')::integer
   OR NEW.returned_qty IS DISTINCT FROM (planned->>'proposedReturned')::integer
   OR EXISTS(SELECT 1 FROM public.mining_ingot_releases WHERE reservation_id=r.id) THEN RAISE EXCEPTION 'MINING_SETTLEMENT_DISPOSITION'; END IF;
 END IF;
 RETURN NEW;
END $$;
