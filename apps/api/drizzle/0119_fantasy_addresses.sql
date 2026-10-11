-- Dual-address staging: every existing Earth address and frozen quote stays
-- byte-for-byte unchanged. Native fantasy land has no invented Earth fields.
ALTER TABLE plots
  ADD COLUMN address_kind text NOT NULL DEFAULT 'legacy-earth',
  ADD COLUMN fantasy_world_id text,
  ADD COLUMN fantasy_tile_id integer,
  ALTER COLUMN valley_id DROP NOT NULL,
  ALTER COLUMN x DROP NOT NULL,
  ALTER COLUMN y DROP NOT NULL,
  ALTER COLUMN earth_cell DROP NOT NULL,
  ALTER COLUMN country_a3 DROP NOT NULL;
ALTER TABLE plots ADD CONSTRAINT plots_address_shape_ck CHECK (
  (address_kind='legacy-earth' AND valley_id IS NOT NULL AND x IS NOT NULL AND y IS NOT NULL
    AND earth_cell IS NOT NULL AND country_a3 IS NOT NULL AND fantasy_world_id IS NULL AND fantasy_tile_id IS NULL)
  OR (address_kind='fantasy' AND base_id IS NOT NULL AND fantasy_world_id IS NOT NULL AND fantasy_tile_id IS NOT NULL
    AND valley_id IS NULL AND x IS NULL AND y IS NULL AND earth_cell IS NULL AND country_a3 IS NULL)
);
ALTER TABLE plots ADD CONSTRAINT plots_fantasy_tile_fk FOREIGN KEY(fantasy_world_id,fantasy_tile_id) REFERENCES fantasy_world_tiles(world_id,tile_id);
CREATE UNIQUE INDEX plots_fantasy_tile_uq ON plots(fantasy_world_id,fantasy_tile_id) WHERE address_kind='fantasy';
--> statement-breakpoint
ALTER TABLE plot_reservations
  ADD COLUMN address_kind text NOT NULL DEFAULT 'legacy-earth',
  ADD COLUMN fantasy_world_id text,
  ADD COLUMN fantasy_tile_id integer,
  ALTER COLUMN earth_cell DROP NOT NULL,
  ALTER COLUMN site_id DROP NOT NULL,
  ALTER COLUMN x DROP NOT NULL,
  ALTER COLUMN y DROP NOT NULL,
  ALTER COLUMN country_a3 DROP NOT NULL;
ALTER TABLE plot_reservations ADD CONSTRAINT plot_reservations_address_shape_ck CHECK (
  (address_kind='legacy-earth' AND earth_cell IS NOT NULL AND site_id IS NOT NULL AND x IS NOT NULL AND y IS NOT NULL
    AND country_a3 IS NOT NULL AND fantasy_world_id IS NULL AND fantasy_tile_id IS NULL)
  OR (address_kind='fantasy' AND fantasy_world_id IS NOT NULL AND fantasy_tile_id IS NOT NULL
    AND earth_cell IS NULL AND site_id IS NULL AND x IS NULL AND y IS NULL AND country_a3 IS NULL)
);
ALTER TABLE plot_reservations ADD CONSTRAINT plot_reservations_fantasy_tile_fk FOREIGN KEY(fantasy_world_id,fantasy_tile_id) REFERENCES fantasy_world_tiles(world_id,tile_id);
CREATE UNIQUE INDEX plot_reservations_live_fantasy_tile_uq ON plot_reservations(fantasy_world_id,fantasy_tile_id) WHERE state IN ('reserved','paid','converted');
--> statement-breakpoint
CREATE FUNCTION fantasy_address_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE claim fantasy_land_claims%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.address_kind IS DISTINCT FROM OLD.address_kind OR
      (OLD.address_kind='fantasy' AND ROW(NEW.fantasy_world_id,NEW.fantasy_tile_id,NEW.base_id)
        IS DISTINCT FROM ROW(OLD.fantasy_world_id,OLD.fantasy_tile_id,OLD.base_id)) THEN
      RAISE EXCEPTION 'land address cannot be rebound' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.address_kind <> 'fantasy' THEN RETURN NEW; END IF;
  SELECT * INTO claim FROM fantasy_land_claims WHERE world_id=NEW.fantasy_world_id
    AND tile_id=NEW.fantasy_tile_id AND base_id=NEW.base_id AND state IN ('held','assigned');
  IF claim.id IS NULL OR (TG_TABLE_NAME='plots' AND claim.state <> 'assigned') THEN
    RAISE EXCEPTION 'native land requires its matching persistent base claim' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='plot_reservations' THEN
    IF claim.deposit_id IS DISTINCT FROM NEW.deposit_id THEN
      RAISE EXCEPTION 'native reservation deposit/base identity differs from claim' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plots_address_binding BEFORE INSERT OR UPDATE ON plots FOR EACH ROW EXECUTE FUNCTION fantasy_address_binding_guard();
CREATE TRIGGER plot_reservations_address_binding BEFORE INSERT OR UPDATE ON plot_reservations FOR EACH ROW EXECUTE FUNCTION fantasy_address_binding_guard();
