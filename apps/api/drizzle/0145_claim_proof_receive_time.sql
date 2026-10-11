-- HELD for explicit owner approval: replaces the existing main deed-claim
-- guard function used by the retained base-claim triggers. No data backfill.
-- Preserve true RPC receive time; claim receipt time is post-lock admission.
-- The server pins its existing BASE_OWNERSHIP.mutationFreshnessMs constant as a
-- connection setting. Missing/malformed policy fails closed, never grants a
-- timeless proof. This is writer consistency, not authority against a SQL admin.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_base_claim_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r jsonb; b bases%ROWTYPE; audit base_transfers%ROWTYPE; proof deed_ownership_observations%ROWTYPE; active_now boolean;
BEGIN
  IF TG_OP='TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM base_claim_commands) THEN
      RAISE EXCEPTION 'deed claim decisions are retained' USING ERRCODE='23514';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP IN ('UPDATE','DELETE') THEN
    RAISE EXCEPTION 'deed claim decisions are immutable' USING ERRCODE='23514';
  END IF;
  -- Cancellation and acceptance use the same wallet serialization even for a
  -- future caller which forgets the application lock. The PK excludes both.
  PERFORM 1 FROM players WHERE wallet=NEW.actor_wallet FOR UPDATE;
  IF NEW.receipt IS NULL THEN
    IF NEW.transfer_id IS NOT NULL THEN
      RAISE EXCEPTION 'cancelled deed claim cannot contain a transfer' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  r := NEW.receipt;
  IF (jsonb_typeof(r)='object' AND r->>'version'='1'
    AND r->>'actor'=NEW.actor_wallet AND r->>'idempotencyKey'=NEW.request_key::text
    AND r->'request'->>'idempotencyKey'=NEW.request_key::text
    AND (r->'request'->>'baseId')::uuid IS NOT NULL
    AND r->'request'->>'deedAssetId' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND r->'ownership'->>'owner'=NEW.actor_wallet
    AND r->'ownership'->>'collection' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND r->'ownership'->>'slot' ~ '^(0|[1-9][0-9]{0,15})$'
    AND (r->'ownership'->>'slot')::numeric <= 9007199254740991
    AND (r->>'createdAt')::timestamptz=NEW.created_at
    AND jsonb_typeof(r->'active')='boolean'
    AND r->>'outcome' IN ('claimed','already_owned')) IS NOT TRUE THEN
    RAISE EXCEPTION 'invalid deed claim identity or ownership evidence' USING ERRCODE='23514';
  END IF;
  SELECT * INTO b FROM bases WHERE id=(r->'request'->>'baseId')::uuid FOR UPDATE;
  IF NOT FOUND OR b.owner_wallet IS DISTINCT FROM NEW.actor_wallet
    OR b.deed_asset_id IS DISTINCT FROM r->'request'->>'deedAssetId' THEN
    RAISE EXCEPTION 'deed claim receipt requires the exact accepted base' USING ERRCODE='23514';
  END IF;
  active_now := b.status='active' AND EXISTS (SELECT 1 FROM base_slots
    WHERE base_id=b.id AND wallet=NEW.actor_wallet AND active);
  IF (r->>'active')::boolean IS DISTINCT FROM active_now THEN
    RAISE EXCEPTION 'deed claim activation differs from accepted state' USING ERRCODE='23514';
  END IF;
  SELECT * INTO proof FROM deed_ownership_observations WHERE base_id=b.id
    ORDER BY checked_at DESC LIMIT 1;
  IF NOT FOUND OR (proof.asset_id=b.deed_asset_id AND proof.owner=NEW.actor_wallet
    AND proof.status='owned' AND proof.slot=(r->'ownership'->>'slot')::bigint
    AND isfinite(proof.checked_at) AND isfinite(NEW.created_at)
    AND proof.checked_at <= NEW.created_at
    AND extract(epoch FROM (NEW.created_at - proof.checked_at)) * 1000
      <= current_setting('shardkeep.deed_mutation_freshness_ms', true)::bigint) IS NOT TRUE THEN
    RAISE EXCEPTION 'deed claim requires its committed finalized observation' USING ERRCODE='23514';
  END IF;
  IF r->>'outcome'='already_owned' THEN
    IF NEW.transfer_id IS NOT NULL OR r->'transferId' IS DISTINCT FROM 'null'::jsonb
      OR r->'fromWallet' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'already-owned deed cannot invent a transfer' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO audit FROM base_transfers WHERE id=NEW.transfer_id FOR SHARE;
    IF NOT FOUND OR (r->>'transferId'=NEW.transfer_id::text
      AND r->>'fromWallet'=audit.from_wallet AND audit.from_wallet<>NEW.actor_wallet
      AND audit.to_wallet=NEW.actor_wallet AND audit.deed_asset_id=b.deed_asset_id) IS NOT TRUE THEN
      RAISE EXCEPTION 'deed claim requires its original canonical transfer audit' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
