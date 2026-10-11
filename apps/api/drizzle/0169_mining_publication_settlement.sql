-- Internal verified terminal custody. No route, signer or activation. The additive
-- replacement of the admitted-stock guard remains in the separately held S5 scope.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS mining_publication_manifests (
 epoch_id uuid PRIMARY KEY REFERENCES mining_publication_attempts(epoch_id),
 manifest_json text NOT NULL CHECK(octet_length(manifest_json) BETWEEN 1 AND 4194304),
 source_hash text NOT NULL CHECK(source_hash~'^[0-9a-f]{64}$'),
 publication jsonb NOT NULL CHECK(jsonb_typeof(publication)='object'),
 intent_sha256 text NOT NULL CHECK(intent_sha256~'^[0-9a-f]{64}$'),
 prepared_at timestamptz NOT NULL CHECK(isfinite(prepared_at))
);
CREATE TABLE IF NOT EXISTS mining_publication_settlements (
 epoch_id uuid PRIMARY KEY REFERENCES mining_publication_manifests(epoch_id),
 signature text NOT NULL UNIQUE CHECK(length(signature) BETWEEN 64 AND 88),
 signed_transaction bytea NOT NULL CHECK(octet_length(signed_transaction) BETWEEN 1 AND 1232),
 message_sha256 text NOT NULL CHECK(message_sha256~'^[0-9a-f]{64}$'),
 wire_sha256 text NOT NULL CHECK(wire_sha256~'^[0-9a-f]{64}$'),
 receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=65536),
 finalized_at timestamptz NOT NULL CHECK(isfinite(finalized_at))
);
CREATE TABLE IF NOT EXISTS mining_ingot_dispositions (
 reservation_id uuid PRIMARY KEY REFERENCES mining_ingot_reservations(id),
 epoch_id uuid NOT NULL REFERENCES mining_publication_settlements(epoch_id),
 consumed_qty integer NOT NULL CHECK(consumed_qty>=0),returned_qty integer NOT NULL CHECK(returned_qty>=0)
);
CREATE INDEX IF NOT EXISTS mining_ingot_dispositions_epoch ON mining_ingot_dispositions(epoch_id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_settlement_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.mining_publication_attempts%ROWTYPE; m public.mining_publication_manifests%ROWTYPE;
 r public.mining_ingot_reservations%ROWTYPE; plan jsonb; planned jsonb; k text;
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
  IF plan->>'scope' IS DISTINCT FROM 'initial-free-virgin-config-keep-only' OR plan->>'projection' IS DISTINCT FROM 'READY'
   OR plan#>>'{input,epochId}' IS DISTINCT FROM NEW.epoch_id::text OR jsonb_typeof(plan->'reservations') IS DISTINCT FROM 'array'
   OR jsonb_array_length(plan->'reservations')<>a.reservation_count THEN RAISE EXCEPTION 'MINING_SETTLEMENT_MANIFEST'; END IF;
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_settlement_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b uuid;
BEGIN
 IF TG_RELID NOT IN ('public.mining_publication_settlements'::regclass,'public.mining_ingot_dispositions'::regclass)
 OR TG_NAME<>TG_TABLE_NAME||'_complete' OR TG_OP<>'INSERT' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'MINING_SETTLEMENT_TRIGGER_IDENTITY'; END IF;
 IF EXISTS(SELECT 1 FROM public.mining_ingot_reservations r WHERE r.epoch_id=NEW.epoch_id AND NOT EXISTS(SELECT 1 FROM public.mining_ingot_dispositions d WHERE d.reservation_id=r.id AND d.epoch_id=r.epoch_id))
 THEN RAISE EXCEPTION 'MINING_SETTLEMENT_INCOMPLETE'; END IF;
 FOR b IN SELECT DISTINCT base_id FROM public.mining_ingot_reservations WHERE epoch_id=NEW.epoch_id LOOP PERFORM public.shardkeep_assert_mining_ingot_stock(b); END LOOP;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_assert_mining_ingot_stock(target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE minted bigint; held bigint; reserved bigint; consumed bigint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.mining_ingot_admissions WHERE base_id=target) THEN RETURN; END IF;
 -- Receipt identity and BOTH exact ledger legs are required; acquired_via is
 -- merely a label. No uncollected or malformed job supplies earned inventory.
 IF EXISTS(SELECT 1 FROM public.workshop_jobs j WHERE j.base_id=target AND j.collected_at IS NOT NULL AND (
  j.collected_by_wallet IS NULL OR j.collect_idempotency_key IS NULL OR j.collected_at<j.ready_at OR
  NOT EXISTS(SELECT 1 FROM public.ledger_transactions t WHERE t.id=j.debit_ledger_txn_id AND t.type='workshop.refine'
   AND t.idempotency_key='workshop:'||j.base_id::text||':'||j.started_by_wallet||':'||j.start_idempotency_key
   AND t.metadata=jsonb_build_object('baseId',j.base_id,'wallet',j.started_by_wallet,'ingots',j.ingots,'shards',j.shards_charged::text,'recipeVersion',j.recipe_version,'workshopLevel',j.workshop_level_at_start)) OR
  (SELECT count(*) FROM public.ledger_entries e WHERE e.txn_id=j.debit_ledger_txn_id)<>2 OR
  NOT EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id WHERE e.txn_id=j.debit_ledger_txn_id
   AND a.kind='base_shards' AND a.currency='SHARDS' AND a.base_id=target AND a.owner_wallet IS NULL AND e.delta=-j.shards_charged) OR
  NOT EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id WHERE e.txn_id=j.debit_ledger_txn_id
   AND a.kind='shard_burn' AND a.currency='SHARDS' AND a.base_id IS NULL AND a.owner_wallet IS NULL AND e.delta=j.shards_charged)
 )) THEN RAISE EXCEPTION 'MINING_INGOT_SOURCE_INVALID' USING ERRCODE='23514'; END IF;
 SELECT coalesce(sum(ingots),0) INTO minted FROM public.workshop_jobs WHERE base_id=target AND collected_at IS NOT NULL;
 SELECT coalesce(sum(qty),0) INTO held FROM public.base_items WHERE base_id=target AND item_id='forge_ingot';
 SELECT coalesce(sum(r.qty),0) INTO reserved FROM public.mining_ingot_reservations r
  WHERE r.base_id=target AND NOT EXISTS(SELECT 1 FROM public.mining_ingot_releases x WHERE x.reservation_id=r.id)
  AND NOT EXISTS(SELECT 1 FROM public.mining_ingot_dispositions d WHERE d.reservation_id=r.id);
 SELECT coalesce(sum(d.consumed_qty),0) INTO consumed FROM public.mining_ingot_dispositions d JOIN public.mining_ingot_reservations r ON r.id=d.reservation_id WHERE r.base_id=target;
 IF held+reserved+consumed<>minted THEN RAISE EXCEPTION 'MINING_INGOT_CONSERVATION' USING ERRCODE='23514'; END IF;
END $$;
--> statement-breakpoint
DO $migration$
DECLARE n text;
BEGIN
 FOREACH n IN ARRAY ARRAY['mining_publication_manifests','mining_publication_settlements','mining_ingot_dispositions'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||n)::regclass AND tgname=n||'_immutable') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_settlement_guard()',n||'_immutable',n);
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_settlement_guard()',n||'_no_truncate',n);
  END IF;
 END LOOP;
 FOREACH n IN ARRAY ARRAY['mining_publication_settlements','mining_ingot_dispositions'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||n)::regclass AND tgname=n||'_complete') THEN
   EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_settlement_complete()',n||'_complete',n);
  END IF;
 END LOOP;
END $migration$;
REVOKE ALL ON mining_publication_manifests,mining_publication_settlements,mining_ingot_dispositions FROM PUBLIC;
