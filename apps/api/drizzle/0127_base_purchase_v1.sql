-- New rows only: old web/in-flight payloads keep their historical compatibility.
CREATE UNIQUE INDEX deposits_base_purchase_key_uq ON deposits
(player_wallet, (payload->'basePurchaseV1'->'request'->>'idempotencyKey'))
WHERE payload ? 'basePurchaseV1';
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_base_purchase_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE q jsonb; r jsonb;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM deposits WHERE payload ? 'basePurchaseV1') THEN
      RAISE EXCEPTION 'versioned base purchases are retained' USING ERRCODE='23514';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.payload ? 'basePurchaseV1' THEN RAISE EXCEPTION 'versioned base purchases are retained' USING ERRCODE='23514'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NOT coalesce(OLD.payload ? 'basePurchaseV1', false) THEN
      IF NEW.payload ? 'basePurchaseV1' THEN RAISE EXCEPTION 'legacy purchases cannot be upgraded to v1' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END IF;
    IF ROW(NEW.id,NEW.player_wallet,NEW.kind,NEW.reference,NEW.created_at,NEW.payload) IS DISTINCT FROM
       ROW(OLD.id,OLD.player_wallet,OLD.kind,OLD.reference,OLD.created_at,OLD.payload)
       OR (OLD.status <> 'pending' AND NEW IS DISTINCT FROM OLD)
       OR (OLD.payment_signature IS NOT NULL AND NEW.payment_signature IS DISTINCT FROM OLD.payment_signature)
       OR NEW.ledger_txn_id IS DISTINCT FROM OLD.ledger_txn_id THEN
      RAISE EXCEPTION 'versioned purchase quote and terminal evidence are immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NOT coalesce(NEW.payload ? 'basePurchaseV1', false) THEN RETURN NEW; END IF;
  q := NEW.payload->'basePurchaseV1'; r := q->'request';
  IF (jsonb_typeof(q)='object' AND q->>'version'='1' AND q->>'depositId'=NEW.id::text
    AND q->>'wallet'=NEW.player_wallet AND r->>'kind'=NEW.kind::text
    AND r->>'idempotencyKey' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND r->>'baseId'=NEW.payload->>'baseId' AND (r->>'baseId')::uuid IS NOT NULL
    AND q->>'reference'=NEW.reference AND (q->>'createdAt')::timestamptz=NEW.created_at
    AND q->>'amountLamports'=NEW.payload->>'amountLamports' AND q->>'amountLamports' ~ '^[1-9][0-9]{0,15}$'
    AND (q->>'amountLamports')::numeric <= 9007199254740991
    AND q->'baseEpoch'->>'landPaidAt'=NEW.payload->>'landPaidAt'
    AND q->'baseEpoch'->'deedAssetId'=NEW.payload->'deedAssetId'
    AND (q->>'createdAt')::timestamptz < (q->>'payableUntil')::timestamptz
    AND (q->>'payableUntil')::timestamptz < (q->>'retryAt')::timestamptz
    AND q->'rail'->>'cluster' IN ('devnet','mainnet-beta')
    AND q->'rail'->>'systemProgram'='11111111111111111111111111111111'
    AND q->'rail'->>'coreProgram' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND q->'rail'->>'configPda' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND q->'rail'->>'treasuryLiquidity' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND q->'rail'->>'treasuryDev' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND q->'rail'->>'treasuryOps' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND CASE NEW.kind
      WHEN 'builder' THEN r->'expectedBuilders'=NEW.payload->'expectedBuilders'
        AND q->'rail'->>'mode'='buy_sink' AND q->'rail'->>'sinkKind'='8'
        AND q->'rail'->'destination'='null'::jsonb AND q->'quotedCostShards'='null'::jsonb
      WHEN 'expansion' THEN r->'expectedExpansions'=NEW.payload->'expectedExpansions'
        AND q->'rail'->>'mode'='sol_transfer' AND q->'rail'->>'destination'=q->'rail'->>'treasuryLiquidity'
        AND q->'quotedCostShards'='null'::jsonb
      WHEN 'mine' THEN r->>'buildingId'=NEW.payload->>'buildingId' AND (r->>'buildingId')::uuid IS NOT NULL
        AND r->>'buildingType' IN ('mine','goldforge') AND (r->>'fromLevel')::integer >= 1
        AND (r->>'toLevel')::integer = (r->>'fromLevel')::integer+1
        AND r->>'maxCostShards' ~ '^[1-9][0-9]{0,18}$' AND (r->>'maxCostShards')::numeric <= 9223372036854775807
        AND q->>'quotedCostShards' ~ '^[1-9][0-9]{0,18}$'
        AND (q->>'quotedCostShards')::numeric <= (r->>'maxCostShards')::numeric
        AND q->'rail'->>'mode'='sol_transfer' AND q->'rail'->>'destination'=q->'rail'->>'treasuryLiquidity'
      ELSE false END) IS NOT TRUE THEN
    RAISE EXCEPTION 'invalid versioned purchase quote' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND NEW.payment_signature IS DISTINCT FROM OLD.payment_signature
    AND current_setting('shardkeep.base_purchase_v1',true) IS DISTINCT FROM NEW.id::text THEN
    RAISE EXCEPTION 'v1-aware confirmed verifier is required' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NEW.status <> 'pending' THEN RAISE EXCEPTION 'v1 must begin pending' USING ERRCODE='23514'; END IF;
  IF NEW.status='pending' AND ROW(NEW.tx_signature,NEW.amount,NEW.mint,NEW.finalized_at,NEW.ledger_txn_id) IS DISTINCT FROM ROW(NULL::text,NULL::bigint,NULL::text,NULL::timestamptz,NULL::uuid) THEN
    RAISE EXCEPTION 'pending v1 cannot contain terminal evidence' USING ERRCODE='23514';
  END IF;
  IF NEW.status='expired' AND (NEW.payment_signature IS NOT NULL OR NEW.tx_signature IS NOT NULL OR NEW.amount IS NOT NULL OR NEW.finalized_at IS NOT NULL) THEN
    RAISE EXCEPTION 'known paid v1 cannot expire' USING ERRCODE='23514';
  END IF;
  IF NEW.status IN ('credited','failed') AND (NEW.tx_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$' AND NEW.amount>0 AND NEW.finalized_at IS NOT NULL
    AND (NEW.payment_signature IS NULL OR NEW.payment_signature=NEW.tx_signature)) IS NOT TRUE THEN
    RAISE EXCEPTION 'terminal v1 requires original payment evidence' USING ERRCODE='23514';
  END IF;
  IF NEW.status='credited' AND (NEW.amount::text=q->>'amountLamports'
    AND (NEW.payment_signature IS NULL OR NEW.payment_signature=NEW.tx_signature) AND NEW.mint='So11111111111111111111111111111111111111112') IS NOT TRUE THEN
    RAISE EXCEPTION 'credited v1 amount or currency differs' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER deposits_base_purchase_guard BEFORE INSERT OR UPDATE OR DELETE ON deposits
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_base_purchase_guard();
--> statement-breakpoint
CREATE TRIGGER deposits_base_purchase_retention BEFORE TRUNCATE ON deposits
FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_base_purchase_guard();
--> statement-breakpoint
-- Rolling old API/worker code cannot finalize v1 rows. The new verifier/credit
-- path marks only its own deposit after frozen-rail validation. The deferred
-- ledger proof also makes an ignored native level/SHARDS guard non-committable.
CREATE FUNCTION public.shardkeep_base_purchase_terminal() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE d deposits%ROWTYPE; q jsonb; r jsonb; l ledger_transactions%ROWTYPE; n integer; debit bigint; burn bigint;
BEGIN
  IF NOT coalesce(NEW.payload ? 'basePurchaseV1', false) OR NEW.status='pending' THEN RETURN NULL; END IF;
  IF TG_OP='UPDATE' AND OLD.status <> 'pending' THEN RETURN NULL; END IF;
  SELECT * INTO d FROM deposits WHERE id=NEW.id;
  IF current_setting('shardkeep.base_purchase_v1',true) IS DISTINCT FROM d.id::text THEN
    RAISE EXCEPTION 'v1-aware payment reconciliation is required' USING ERRCODE='23514';
  END IF;
  IF d.status <> 'credited' OR d.kind <> 'mine' THEN RETURN NULL; END IF;
  q:=d.payload->'basePurchaseV1'; r:=q->'request';
  SELECT * INTO l FROM ledger_transactions WHERE idempotency_key='mine-up:'||d.id::text;
  IF NOT FOUND OR (l.type='build.upgrade_'||(r->>'buildingType') AND l.metadata->>'wallet'=d.player_wallet
    AND l.metadata->>'baseId'=r->>'baseId' AND l.metadata->>'buildingId'=r->>'buildingId'
    AND l.metadata->'to'=r->'toLevel') IS NOT TRUE THEN
    RAISE EXCEPTION 'v1 upgrade ledger scope is missing or different' USING ERRCODE='23514';
  END IF;
  SELECT count(*),
    max(e.delta) FILTER (WHERE a.kind='base_shards' AND a.base_id::text=r->>'baseId' AND a.owner_wallet IS NULL AND a.currency='SHARDS' AND e.delta<0),
    max(e.delta) FILTER (WHERE a.kind='shard_burn' AND a.base_id IS NULL AND a.owner_wallet IS NULL AND a.currency='SHARDS' AND e.delta>0)
    INTO n,debit,burn FROM ledger_entries e JOIN accounts a ON a.id=e.account_id WHERE e.txn_id=l.id;
  IF (n=2 AND debit+burn=0 AND burn>0 AND burn<=(r->>'maxCostShards')::bigint) IS NOT TRUE THEN
    RAISE EXCEPTION 'v1 upgrade funding differs from original consent' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER deposits_base_purchase_terminal AFTER INSERT OR UPDATE ON deposits
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_base_purchase_terminal();
