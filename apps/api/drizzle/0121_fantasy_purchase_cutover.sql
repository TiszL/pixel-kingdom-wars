-- D-128: deployment may pause new sales, but it must never reopen Earth supply
-- after the first native reservation. Previously issued intents still settle.
CREATE TABLE fantasy_purchase_cutover (
  world_id text PRIMARY KEY REFERENCES fantasy_world_catalog(world_id),
  activated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fantasy_purchase_cutover_immutable BEFORE UPDATE OR DELETE ON fantasy_purchase_cutover
  FOR EACH ROW EXECUTE FUNCTION fantasy_immutable_identity();
--> statement-breakpoint
CREATE FUNCTION fantasy_purchase_cutover_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Serializes old and new binaries with native allocation. This runs only for
  -- INSERT: existing Earth reservations are deliberately recoverable forever.
  PERFORM pg_advisory_xact_lock(hashtext('shardkeep:fantasy-location'));
  IF NEW.address_kind='legacy-earth' AND EXISTS (SELECT 1 FROM fantasy_purchase_cutover) THEN
    RAISE EXCEPTION 'Earth purchase allocation is permanently closed' USING ERRCODE='23514';
  END IF;
  IF NEW.address_kind='fantasy' AND NOT EXISTS (
    SELECT 1 FROM fantasy_purchase_cutover WHERE world_id=NEW.fantasy_world_id
  ) THEN
    RAISE EXCEPTION 'native purchase cutover is not active' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plot_reservations_fantasy_cutover BEFORE INSERT ON plot_reservations
  FOR EACH ROW EXECUTE FUNCTION fantasy_purchase_cutover_guard();
