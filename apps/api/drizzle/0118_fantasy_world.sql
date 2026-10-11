-- D-128: geography is durable deed identity. This foundation creates no claims,
-- changes no Earth plots, and publishes no NFT metadata.
CREATE TABLE fantasy_world_catalog (
  world_id text PRIMARY KEY,
  catalog_hash text NOT NULL CHECK (catalog_hash ~ '^[a-f0-9]{64}$'),
  tile_count integer NOT NULL CHECK (tile_count > 0),
  installed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE fantasy_world_tiles (
  world_id text NOT NULL REFERENCES fantasy_world_catalog(world_id),
  tile_id integer NOT NULL CHECK (tile_id >= 0),
  realm_id text NOT NULL,
  allocation text NOT NULL CHECK (allocation IN ('ordinary', 'genesis', 'seeker')),
  PRIMARY KEY (world_id, tile_id)
);
--> statement-breakpoint
CREATE TABLE fantasy_retirement_exclusions (
  base_id uuid PRIMARY KEY REFERENCES bases(id),
  mint_id text,
  receipt_id uuid NOT NULL REFERENCES ledger_transactions(id),
  abandon_receipt_id uuid NOT NULL REFERENCES base_abandons(id),
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE fantasy_migration_batches (
  manifest_hash text PRIMARY KEY CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  world_id text NOT NULL REFERENCES fantasy_world_catalog(world_id),
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE fantasy_land_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  tile_id integer NOT NULL,
  base_id uuid NOT NULL REFERENCES bases(id),
  state text NOT NULL CHECK (state IN ('held', 'assigned', 'released')),
  source text NOT NULL CHECK (source IN ('migration-active', 'migration-inactive', 'purchase')),
  expected_mint text,
  deposit_id uuid REFERENCES deposits(id),
  manifest_hash text REFERENCES fantasy_migration_batches(manifest_hash),
  created_at timestamptz NOT NULL DEFAULT now(),
  assigned_at timestamptz,
  released_at timestamptz,
  FOREIGN KEY (world_id, tile_id) REFERENCES fantasy_world_tiles(world_id, tile_id),
  CONSTRAINT fantasy_claim_source_ck CHECK (
    (source = 'purchase' AND deposit_id IS NOT NULL AND manifest_hash IS NULL)
    OR (source IN ('migration-active','migration-inactive') AND expected_mint IS NOT NULL
      AND deposit_id IS NULL AND manifest_hash IS NOT NULL)
  ),
  CONSTRAINT fantasy_claim_time_ck CHECK (
    (state='held' AND assigned_at IS NULL AND released_at IS NULL)
    OR (state='assigned' AND assigned_at IS NOT NULL AND released_at IS NULL)
    OR (state='released' AND released_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX fantasy_claim_live_tile_uq ON fantasy_land_claims(world_id,tile_id) WHERE state IN ('held','assigned');
CREATE UNIQUE INDEX fantasy_claim_live_base_uq ON fantasy_land_claims(base_id) WHERE state IN ('held','assigned');
CREATE UNIQUE INDEX fantasy_claim_live_deposit_uq ON fantasy_land_claims(deposit_id) WHERE state IN ('held','assigned');
--> statement-breakpoint
CREATE FUNCTION fantasy_immutable_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'fantasy identity evidence is immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER fantasy_catalog_immutable BEFORE UPDATE OR DELETE ON fantasy_world_catalog FOR EACH ROW EXECUTE FUNCTION fantasy_immutable_identity();
CREATE TRIGGER fantasy_tiles_immutable BEFORE UPDATE OR DELETE ON fantasy_world_tiles FOR EACH ROW EXECUTE FUNCTION fantasy_immutable_identity();
CREATE TRIGGER fantasy_exclusions_immutable BEFORE UPDATE OR DELETE ON fantasy_retirement_exclusions FOR EACH ROW EXECUTE FUNCTION fantasy_immutable_identity();
CREATE TRIGGER fantasy_batches_immutable BEFORE UPDATE OR DELETE ON fantasy_migration_batches FOR EACH ROW EXECUTE FUNCTION fantasy_immutable_identity();
--> statement-breakpoint
CREATE FUNCTION fantasy_claim_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_mint text; tile_allocation text; deposit_base text; payment_state text; stored_payment_signature text; credited_signature text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fantasy claims retain recovery history' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.world_id,NEW.tile_id,NEW.base_id,NEW.source,NEW.expected_mint,NEW.deposit_id,NEW.manifest_hash,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.world_id,OLD.tile_id,OLD.base_id,OLD.source,OLD.expected_mint,OLD.deposit_id,OLD.manifest_hash,OLD.created_at)
      OR OLD.state='released' OR (OLD.state='assigned' AND (NEW.state <> 'assigned'
        OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at)) THEN
      RAISE EXCEPTION 'fantasy claim cannot be rebound or reassigned' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT deed_asset_id INTO current_mint FROM bases WHERE id=NEW.base_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fantasy claim base missing' USING ERRCODE='23503'; END IF;
  IF NEW.expected_mint IS NOT NULL AND NEW.expected_mint IS DISTINCT FROM current_mint THEN
    RAISE EXCEPTION 'fantasy claim mint identity changed' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM fantasy_retirement_exclusions WHERE base_id=NEW.base_id
      OR (mint_id IS NOT NULL AND mint_id=current_mint)) THEN
    RAISE EXCEPTION 'retired deed cannot claim fantasy land' USING ERRCODE='23514';
  END IF;
  SELECT allocation INTO tile_allocation FROM fantasy_world_tiles WHERE world_id=NEW.world_id AND tile_id=NEW.tile_id;
  IF tile_allocation IS DISTINCT FROM 'ordinary' THEN
    RAISE EXCEPTION 'reserved or non-deeded fantasy terrain is not claimable' USING ERRCODE='23514';
  END IF;
  IF NEW.deposit_id IS NOT NULL THEN
    SELECT payload->>'baseId',status,payment_signature,tx_signature INTO deposit_base,payment_state,stored_payment_signature,credited_signature
      FROM deposits WHERE id=NEW.deposit_id;
    IF deposit_base IS DISTINCT FROM NEW.base_id::text THEN
      RAISE EXCEPTION 'fantasy claim deposit belongs to another base' USING ERRCODE='23514';
    END IF;
    IF NEW.state='assigned' AND payment_state IS DISTINCT FROM 'credited' THEN
      RAISE EXCEPTION 'fantasy purchase assignment requires credited payment' USING ERRCODE='23514';
    END IF;
    IF NEW.state='released' AND (payment_state IS DISTINCT FROM 'expired' OR stored_payment_signature IS NOT NULL OR credited_signature IS NOT NULL) THEN
      RAISE EXCEPTION 'fantasy purchase release requires proven unpaid expiry' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.state='released' THEN
    RAISE EXCEPTION 'migration holds require explicit reconciliation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fantasy_claim_identity BEFORE INSERT OR UPDATE OR DELETE ON fantasy_land_claims FOR EACH ROW EXECUTE FUNCTION fantasy_claim_identity_guard();
--> statement-breakpoint
CREATE FUNCTION fantasy_exclusion_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b bases%ROWTYPE; receipt ledger_transactions%ROWTYPE; abandon base_abandons%ROWTYPE;
BEGIN
  SELECT * INTO b FROM bases WHERE id=NEW.base_id FOR UPDATE;
  SELECT * INTO receipt FROM ledger_transactions WHERE id=NEW.receipt_id;
  SELECT * INTO abandon FROM base_abandons WHERE id=NEW.abandon_receipt_id;
  IF b.id IS NULL OR b.deed_asset_id IS DISTINCT FROM NEW.mint_id
    OR receipt.type NOT IN ('retire.scripted-deed','purge.synthetic')
    OR receipt.metadata->>'wallet' IS DISTINCT FROM b.owner_wallet
    OR abandon.player_wallet IS DISTINCT FROM b.owner_wallet
    OR receipt.created_at IS DISTINCT FROM abandon.created_at
    OR b.created_at > receipt.created_at
    OR EXISTS (SELECT 1 FROM base_transfers WHERE created_at >= receipt.created_at
      AND (from_wallet=b.owner_wallet OR to_wallet=b.owner_wallet))
    OR EXISTS (SELECT 1 FROM fantasy_land_claims WHERE base_id=NEW.base_id AND state IN ('held','assigned')) THEN
    RAISE EXCEPTION 'fantasy retirement requires exact positive historical receipts' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fantasy_exclusion_identity BEFORE INSERT ON fantasy_retirement_exclusions FOR EACH ROW EXECUTE FUNCTION fantasy_exclusion_identity_guard();
