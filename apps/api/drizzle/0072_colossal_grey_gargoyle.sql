ALTER TABLE "bases" ADD COLUMN "deed_mint_asset_id" text;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "deed_mint_asset_id" text;--> statement-breakpoint

-- Every base mint owns one exact Core address before broadcast. This trigger
-- also fences a mixed-version deploy: an old pod only writes deed_minting_at,
-- so its conditional UPDATE must fail instead of returning a row and letting
-- the old random-signer broadcaster run. The transaction-local claim marker is
-- set only by the fixed-address code shipped with this migration; requiring the
-- address alone would still let an old pod steal a released fixed-id retry.
CREATE FUNCTION "shardkeep_guard_base_deed_mint_reservation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  identity_changed boolean := TG_OP = 'INSERT';
  claim_changed boolean := TG_OP = 'INSERT';
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.deed_mint_asset_id LIKE 'legacy-unknown:%'
       AND NEW.deed_mint_asset_id IS DISTINCT FROM OLD.deed_mint_asset_id
       AND current_setting('shardkeep.allow_legacy_deed_reconcile', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'legacy ambiguous deed reservation for base % is quarantined', NEW.id
        USING ERRCODE = '23514';
    END IF;
    identity_changed := NEW.deed_asset_id IS DISTINCT FROM OLD.deed_asset_id
      OR NEW.deed_mint_asset_id IS DISTINCT FROM OLD.deed_mint_asset_id;
    claim_changed := NEW.deed_minting_at IS DISTINCT FROM OLD.deed_minting_at;
  END IF;

  IF NEW.deed_asset_id IS NOT NULL AND NEW.deed_mint_asset_id IS NULL THEN
    NEW.deed_mint_asset_id := NEW.deed_asset_id;
  END IF;
  IF claim_changed AND NEW.deed_minting_at IS NOT NULL THEN
    IF NEW.deed_mint_asset_id IS NULL
       OR NEW.deed_mint_asset_id LIKE 'legacy-unknown:%' THEN
      RAISE EXCEPTION 'deed mint claim for base % requires an exact asset reservation', NEW.id
        USING ERRCODE = '23514';
    END IF;
    IF current_setting('shardkeep.fixed_deed_mint_claim', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'legacy timestamp-only deed mint writer is fenced for base %', NEW.id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- The two columns form one namespace. Separate ordinary UNIQUE indexes do
  -- not stop base A reserving X while base B records X as attached, so serialize
  -- every identity change and reject a cross-column duplicate in the database.
  IF identity_changed THEN
    IF NEW.deed_asset_id IS NOT NULL OR NEW.deed_mint_asset_id IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtext('shardkeep:deed-asset-registry'));
    END IF;
    IF NEW.deed_asset_id IS NOT NULL
       AND NEW.deed_mint_asset_id IS DISTINCT FROM NEW.deed_asset_id THEN
      RAISE EXCEPTION 'base % attached deed % differs from reserved deed %',
        NEW.id, NEW.deed_asset_id, NEW.deed_mint_asset_id
        USING ERRCODE = '23514';
    END IF;
    IF NEW.deed_asset_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM bases b
      WHERE b.id <> NEW.id AND b.deed_mint_asset_id = NEW.deed_asset_id
    ) THEN
      RAISE EXCEPTION 'deed % is reserved by another base', NEW.deed_asset_id
        USING ERRCODE = '23514';
    END IF;
    IF NEW.deed_mint_asset_id IS NOT NULL
       AND NEW.deed_mint_asset_id NOT LIKE 'legacy-unknown:%'
       AND EXISTS (
         SELECT 1 FROM bases b
         WHERE b.id <> NEW.id AND b.deed_asset_id = NEW.deed_mint_asset_id
       ) THEN
      RAISE EXCEPTION 'reserved deed % is attached to another base', NEW.deed_mint_asset_id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "bases_deed_mint_reservation_guard"
BEFORE INSERT OR UPDATE ON "bases"
FOR EACH ROW EXECUTE FUNCTION "shardkeep_guard_base_deed_mint_reservation"();--> statement-breakpoint

-- Deployed pre-0072 code claims on players, not bases. Reject its acquisition
-- and refresh UPDATEs so RETURNING yields no broadcaster permission. Clearing a
-- prior timestamp remains legal; the durable historical quarantine below is
-- never cleared by that old catch path.
CREATE FUNCTION "shardkeep_guard_player_deed_mint_reservation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  claim_changed boolean := TG_OP = 'INSERT';
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.deed_mint_asset_id LIKE 'legacy-unknown:%'
       AND (NEW.deed_mint_asset_id IS DISTINCT FROM OLD.deed_mint_asset_id
         OR NEW.deed_asset_id IS DISTINCT FROM OLD.deed_asset_id)
       AND current_setting('shardkeep.allow_legacy_deed_reconcile', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'legacy ambiguous deed reservation for wallet % is quarantined', NEW.wallet
        USING ERRCODE = '23514';
    END IF;
    IF OLD.deed_mint_asset_id NOT LIKE 'legacy-unknown:%'
       AND NEW.deed_asset_id IS DISTINCT FROM OLD.deed_asset_id THEN
      NEW.deed_mint_asset_id := NEW.deed_asset_id;
    END IF;
    claim_changed := NEW.deed_minting_at IS DISTINCT FROM OLD.deed_minting_at;
  END IF;

  IF NEW.deed_asset_id IS NOT NULL AND NEW.deed_mint_asset_id IS NULL THEN
    NEW.deed_mint_asset_id := NEW.deed_asset_id;
  END IF;
  IF claim_changed AND NEW.deed_minting_at IS NOT NULL THEN
    IF NEW.deed_mint_asset_id IS NULL
       OR NEW.deed_mint_asset_id LIKE 'legacy-unknown:%' THEN
      RAISE EXCEPTION 'deed mint claim for wallet % requires an exact asset reservation', NEW.wallet
        USING ERRCODE = '23514';
    END IF;
    IF current_setting('shardkeep.fixed_deed_mint_claim', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'legacy timestamp-only deed mint writer is fenced for wallet %', NEW.wallet
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "players_deed_mint_reservation_guard"
BEFORE INSERT OR UPDATE ON "players"
FOR EACH ROW EXECUTE FUNCTION "shardkeep_guard_player_deed_mint_reservation"();--> statement-breakpoint

-- Existing attached deeds become their own completed reservation. A completed
-- identity never needs a live lease left by an interrupted old process.
UPDATE "players"
SET "deed_mint_asset_id" = "deed_asset_id", "deed_minting_at" = NULL
WHERE "deed_asset_id" IS NOT NULL;--> statement-breakpoint
UPDATE "bases"
SET "deed_mint_asset_id" = "deed_asset_id", "deed_minting_at" = NULL
WHERE "deed_asset_id" IS NOT NULL;--> statement-breakpoint

-- Historical cutover quarantine. A pre-0072 random-signer send may have landed
-- and then thrown before its catch cleared deed_minting_at. Therefore a NULL
-- timestamp is not proof that no asset exists: every preexisting paid/deedless
-- base must fail closed, not silently receive a new deterministic deed. The
-- sentinel is an explicit manual-reconciliation state protected by the trigger
-- above; the time lease can be cleared because no automated retry may cross it.
UPDATE "bases"
SET "deed_mint_asset_id" = 'legacy-unknown:' || "id"::text,
    "deed_minting_at" = NULL
WHERE "deed_asset_id" IS NULL
  AND "deed_mint_asset_id" IS NULL
  AND ("land_paid_at" IS NOT NULL OR "deed_minting_at" IS NOT NULL);--> statement-breakpoint

-- 0064 normally materialized every paid wallet into bases, but preserve the
-- same fail-closed state on the compatibility row. Do not quarantine a seller
-- with durable transfer evidence or a wallet whose stable base already records
-- an attached deed. A merely deedless base is not counter-evidence: the old
-- player-level minter could have landed an unrecorded random-signer asset for it.
UPDATE "players" p
SET "deed_mint_asset_id" = 'legacy-unknown:wallet:' || p."wallet",
    "deed_minting_at" = NULL
WHERE p."deed_asset_id" IS NULL
  AND p."deed_mint_asset_id" IS NULL
  AND (p."entry_paid_at" IS NOT NULL OR p."deed_minting_at" IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM "bases" b
    WHERE b."owner_wallet" = p."wallet" AND b."deed_asset_id" IS NOT NULL
  )
  AND NOT EXISTS (SELECT 1 FROM "base_transfers" t WHERE t."from_wallet" = p."wallet");--> statement-breakpoint

CREATE UNIQUE INDEX "bases_deed_mint_asset_uq" ON "bases" USING btree ("deed_mint_asset_id") WHERE deed_mint_asset_id IS NOT NULL;
