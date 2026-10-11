-- D153.20. This validates immutable allocation/proof shape, not arbitrary SQL
-- authorization or correspondence of projection writes to those receipts.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
ALTER TABLE resource_stock_operations ADD COLUMN IF NOT EXISTS effective_quantity bigint;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.resource_stock_operations'::regclass AND conname = 'resource_stock_effective_ck') THEN
    ALTER TABLE resource_stock_operations ADD CONSTRAINT resource_stock_effective_ck CHECK
  (effective_quantity IS NULL OR (kind = 'release' AND effective_quantity >= 0 AND effective_quantity <= quantity));
  END IF;
END;
$migration$;
-- 0139 now creates the final zero-capable check. An experimental database
-- carrying the old nonzero check needs separate operator review, not a rewrite.
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.resource_stock_entries'::regclass
      AND conname = 'resource_stock_entries_delta_ck'
      AND position('delta <> 0' in pg_catalog.pg_get_constraintdef(oid)) > 0) THEN
    RAISE EXCEPTION 'experimental raw entry nonzero constraint requires operator review';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.resource_stock_entries'::regclass AND conname = 'resource_stock_entries_delta_ck') THEN
    ALTER TABLE resource_stock_entries ADD CONSTRAINT resource_stock_entries_delta_ck CHECK (delta >= -9223372036854775807);
  END IF;
END;
$migration$;
CREATE TABLE IF NOT EXISTS raw_raid_snapshots (
  raid_id uuid PRIMARY KEY REFERENCES raids(id),
  attacker_base_id uuid NOT NULL REFERENCES bases(id), defender_base_id uuid NOT NULL REFERENCES bases(id),
  keep_id uuid, frozen_divisor integer NOT NULL, theft_version integer NOT NULL, frozen_at timestamptz NOT NULL,
  CONSTRAINT raw_raid_snapshot_ck CHECK (attacker_base_id <> defender_base_id AND frozen_divisor > 0 AND theft_version > 0)
);
CREATE TABLE IF NOT EXISTS raw_raid_resources (
  raid_id uuid NOT NULL REFERENCES raw_raid_snapshots(raid_id), resource_id text NOT NULL,
  available bigint NOT NULL, reserved bigint NOT NULL, maximum bigint NOT NULL, from_available bigint NOT NULL,
  PRIMARY KEY (raid_id, resource_id),
  CONSTRAINT raw_raid_resource_id_ck CHECK (resource_id IN ('frost_quartz','heartwood_logs','sunstone_rubble','crown_iron_ore','rough_prism','storm_ore','thorn_fibre','ember_nodules')),
  CONSTRAINT raw_raid_resource_amount_ck CHECK (available >= 0 AND reserved >= 0 AND available::numeric + reserved::numeric <= 9223372036854775807 AND maximum >= 0 AND from_available >= 0 AND from_available <= maximum)
);
CREATE TABLE IF NOT EXISTS raw_raid_allocations (
  raid_id uuid NOT NULL, resource_id text NOT NULL, reservation_id uuid NOT NULL REFERENCES resource_stock_operations(id),
  quantity bigint NOT NULL, PRIMARY KEY (raid_id, resource_id, reservation_id),
  CONSTRAINT raw_raid_allocation_resource_fk FOREIGN KEY (raid_id, resource_id) REFERENCES raw_raid_resources(raid_id, resource_id),
  CONSTRAINT raw_raid_allocation_quantity_ck CHECK (quantity > 0)
);
CREATE TABLE IF NOT EXISTS raw_raid_terminals (
  raid_id uuid PRIMARY KEY REFERENCES raw_raid_snapshots(raid_id), outcome text NOT NULL, reason text NOT NULL, settled_at timestamptz NOT NULL,
  CONSTRAINT raw_raid_terminal_ck CHECK (outcome IN ('transferred','released') AND length(reason) BETWEEN 1 AND 128)
);
CREATE TABLE IF NOT EXISTS raw_raid_entries (
  raid_id uuid NOT NULL REFERENCES raw_raid_terminals(raid_id), resource_id text NOT NULL, bucket text NOT NULL, delta bigint NOT NULL,
  PRIMARY KEY (raid_id, resource_id, bucket),
  CONSTRAINT raw_raid_entry_resource_fk FOREIGN KEY (raid_id, resource_id) REFERENCES raw_raid_resources(raid_id, resource_id),
  CONSTRAINT raw_raid_entry_ck CHECK (bucket IN ('defender_available','defender_reserved','attacker_available') AND delta >= -9223372036854775807)
);
CREATE TABLE IF NOT EXISTS raw_raid_reservation_debits (
  raid_id uuid NOT NULL REFERENCES raw_raid_terminals(raid_id), resource_id text NOT NULL, reservation_id uuid NOT NULL,
  quantity bigint NOT NULL, bucket text NOT NULL, release_operation_id uuid REFERENCES resource_stock_operations(id),
  PRIMARY KEY (raid_id, resource_id, reservation_id),
  CONSTRAINT raw_raid_debit_allocation_fk FOREIGN KEY (raid_id, resource_id, reservation_id) REFERENCES raw_raid_allocations(raid_id, resource_id, reservation_id),
  CONSTRAINT raw_raid_debit_ck CHECK (quantity > 0 AND ((bucket = 'reserved' AND release_operation_id IS NULL) OR (bucket = 'available' AND release_operation_id IS NOT NULL)))
);
CREATE INDEX IF NOT EXISTS raw_raid_debit_reservation_idx ON raw_raid_reservation_debits(reservation_id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_raw_raid_insert_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE parent public.resource_stock_operations%ROWTYPE; released public.resource_stock_operations%ROWTYPE; lost numeric; header public.raw_raid_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO STRICT header FROM public.raw_raid_snapshots WHERE raid_id = NEW.raid_id;
  IF TG_TABLE_NAME IN ('raw_raid_resources','raw_raid_allocations') AND EXISTS
    (SELECT 1 FROM public.raw_raid_terminals WHERE raid_id = NEW.raid_id)
  THEN RAISE EXCEPTION 'raw allocation is already terminal' USING ERRCODE = '23514'; END IF;
  IF TG_TABLE_NAME IN ('raw_raid_allocations','raw_raid_reservation_debits') THEN
    SELECT * INTO STRICT parent FROM public.resource_stock_operations WHERE id = NEW.reservation_id;
    IF parent.kind <> 'reserve' OR parent.base_id <> header.defender_base_id OR parent.resource_id <> NEW.resource_id
    THEN RAISE EXCEPTION 'raw allocation parent differs' USING ERRCODE = '23514'; END IF;
    SELECT coalesce(sum(quantity::numeric),0) INTO lost FROM public.raw_raid_reservation_debits WHERE reservation_id = parent.id AND bucket = 'reserved';
    IF TG_TABLE_NAME = 'raw_raid_allocations' THEN
      IF EXISTS (SELECT 1 FROM public.resource_stock_operations WHERE reservation_id = parent.id) OR NEW.quantity > parent.quantity::numeric - lost
      THEN RAISE EXCEPTION 'raw allocation exceeds open residual' USING ERRCODE = '23514'; END IF;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM public.raw_raid_terminals WHERE raid_id = NEW.raid_id AND outcome = 'transferred')
        OR NOT EXISTS (SELECT 1 FROM public.raw_raid_allocations WHERE raid_id = NEW.raid_id AND resource_id = NEW.resource_id AND reservation_id = parent.id AND quantity = NEW.quantity)
      THEN RAISE EXCEPTION 'raw debit lacks original transfer allocation' USING ERRCODE = '23514'; END IF;
      IF NEW.bucket = 'reserved' THEN
        IF EXISTS (SELECT 1 FROM public.resource_stock_operations WHERE reservation_id = parent.id) OR NEW.quantity > parent.quantity::numeric - lost
        THEN RAISE EXCEPTION 'raw reserved debit exceeds open residual' USING ERRCODE = '23514'; END IF;
      ELSE
        SELECT * INTO STRICT released FROM public.resource_stock_operations WHERE id = NEW.release_operation_id;
        IF released.kind <> 'release' OR released.reservation_id <> parent.id OR
          ROW(released.base_id,released.resource_id,released.quantity) IS DISTINCT FROM ROW(parent.base_id,parent.resource_id,parent.quantity)
          OR NEW.quantity::numeric + (SELECT coalesce(sum(quantity::numeric),0) FROM public.raw_raid_reservation_debits WHERE release_operation_id = released.id) > coalesce(released.effective_quantity,released.quantity)
        THEN RAISE EXCEPTION 'raw available debit lacks original release' USING ERRCODE = '23514'; END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.shardkeep_raw_raid_insert_guard() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.raw_raid_resources'::regclass AND tgname = 'raw_resource_insert') THEN
    CREATE TRIGGER raw_resource_insert BEFORE INSERT ON raw_raid_resources FOR EACH ROW EXECUTE FUNCTION public.shardkeep_raw_raid_insert_guard();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.raw_raid_allocations'::regclass AND tgname = 'raw_allocation_insert') THEN
    CREATE TRIGGER raw_allocation_insert BEFORE INSERT ON raw_raid_allocations FOR EACH ROW EXECUTE FUNCTION public.shardkeep_raw_raid_insert_guard();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.raw_raid_reservation_debits'::regclass AND tgname = 'raw_debit_insert') THEN
    CREATE TRIGGER raw_debit_insert BEFORE INSERT ON raw_raid_reservation_debits FOR EACH ROW EXECUTE FUNCTION public.shardkeep_raw_raid_insert_guard();
  END IF;
END;
$migration$;
--> statement-breakpoint
-- A terminal release can never later acquire a RESERVED loss. Later theft of
-- its released units explicitly uses the AVAILABLE lineage, preserving history.
CREATE OR REPLACE FUNCTION public.shardkeep_resource_stock_proof()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE operation_key uuid; op public.resource_stock_operations%ROWTYPE; parent public.resource_stock_operations%ROWTYPE; amount bigint; lost numeric; debit_bucket text; credit_bucket text;
BEGIN
  IF TG_TABLE_NAME = 'resource_stock_operations' THEN operation_key := NEW.id; ELSE operation_key := NEW.operation_id; END IF;
  SELECT * INTO STRICT op FROM public.resource_stock_operations WHERE id = operation_key;
  amount := coalesce(op.effective_quantity,op.quantity);
  debit_bucket := CASE WHEN op.kind = 'reserve' THEN 'available' ELSE 'reserved' END;
  credit_bucket := CASE op.kind WHEN 'reserve' THEN 'reserved' WHEN 'release' THEN 'available' ELSE 'consumed' END;
  IF amount = 0 AND (op.kind <> 'release' OR op.effective_quantity IS DISTINCT FROM 0::bigint)
    OR (SELECT count(*) FROM public.resource_stock_entries WHERE operation_id = operation_key) <> 2
    OR NOT EXISTS (SELECT 1 FROM public.resource_stock_entries WHERE operation_id = operation_key AND bucket = debit_bucket AND delta = -amount)
    OR NOT EXISTS (SELECT 1 FROM public.resource_stock_entries WHERE operation_id = operation_key AND bucket = credit_bucket AND delta = amount)
  THEN RAISE EXCEPTION 'raw stock proof must have exact balanced entries' USING ERRCODE = '23514'; END IF;
  IF op.reservation_id IS NOT NULL THEN
    SELECT * INTO STRICT parent FROM public.resource_stock_operations WHERE id = op.reservation_id;
    SELECT coalesce(sum(quantity::numeric),0) INTO lost FROM public.raw_raid_reservation_debits WHERE reservation_id = parent.id AND bucket = 'reserved';
    IF parent.kind <> 'reserve' OR ROW(parent.base_id,parent.resource_id,parent.quantity) IS DISTINCT FROM ROW(op.base_id,op.resource_id,op.quantity)
      OR amount <> parent.quantity::numeric - lost OR (op.kind = 'consume' AND lost <> 0)
    THEN RAISE EXCEPTION 'raw stock terminal must match original residual' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_raw_raid_proof()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE h public.raw_raid_snapshots%ROWTYPE; r public.raw_raid_resources%ROWTYPE; terminal public.raw_raid_terminals%ROWTYPE; av numeric; rs numeric;
BEGIN
  SELECT * INTO STRICT h FROM public.raw_raid_snapshots WHERE raid_id = NEW.raid_id;
  IF (SELECT count(*) FROM public.raw_raid_resources WHERE raid_id = h.raid_id) <> 8
  THEN RAISE EXCEPTION 'raw raid requires all original resources' USING ERRCODE = '23514'; END IF;
  SELECT * INTO terminal FROM public.raw_raid_terminals WHERE raid_id = h.raid_id;
  IF terminal.raid_id IS NOT NULL AND (terminal.settled_at < h.frozen_at OR (terminal.outcome = 'transferred' AND h.keep_id IS NULL))
  THEN RAISE EXCEPTION 'raw raid terminal lacks eligible original keep/time' USING ERRCODE = '23514'; END IF;
  FOR r IN SELECT * FROM public.raw_raid_resources WHERE raid_id = h.raid_id LOOP
    IF r.maximum::numeric <> trunc((r.available::numeric + r.reserved::numeric) / h.frozen_divisor)
      OR r.from_available <> least(r.available,r.maximum)
      OR (SELECT coalesce(sum(quantity::numeric),0) FROM public.raw_raid_allocations WHERE raid_id = h.raid_id AND resource_id = r.resource_id) <> r.maximum::numeric-r.from_available
    THEN RAISE EXCEPTION 'raw raid allocation is not original available-first maximum' USING ERRCODE = '23514'; END IF;
    IF terminal.outcome = 'transferred' THEN
      IF (SELECT count(*) FROM public.raw_raid_allocations WHERE raid_id = h.raid_id AND resource_id = r.resource_id)
        <> (SELECT count(*) FROM public.raw_raid_reservation_debits WHERE raid_id = h.raid_id AND resource_id = r.resource_id)
      THEN RAISE EXCEPTION 'raw raid transfer missing allocation debit' USING ERRCODE = '23514'; END IF;
      SELECT coalesce(sum(quantity::numeric) FILTER (WHERE bucket = 'available'),0),coalesce(sum(quantity::numeric) FILTER (WHERE bucket = 'reserved'),0)
        INTO av,rs FROM public.raw_raid_reservation_debits WHERE raid_id = h.raid_id AND resource_id = r.resource_id;
      IF (SELECT count(*) FROM public.raw_raid_entries WHERE raid_id = h.raid_id AND resource_id = r.resource_id) <> 3
        OR NOT EXISTS (SELECT 1 FROM public.raw_raid_entries WHERE raid_id=h.raid_id AND resource_id=r.resource_id AND bucket='defender_available' AND delta::numeric=-(r.from_available::numeric+av))
        OR NOT EXISTS (SELECT 1 FROM public.raw_raid_entries WHERE raid_id=h.raid_id AND resource_id=r.resource_id AND bucket='defender_reserved' AND delta::numeric=-rs)
        OR NOT EXISTS (SELECT 1 FROM public.raw_raid_entries WHERE raid_id=h.raid_id AND resource_id=r.resource_id AND bucket='attacker_available' AND delta=r.maximum)
        OR av+rs+r.from_available <> r.maximum
      THEN RAISE EXCEPTION 'raw raid transfer requires exact balanced proof' USING ERRCODE = '23514'; END IF;
    END IF;
  END LOOP;
  IF terminal.outcome IS DISTINCT FROM 'transferred' AND
    (EXISTS (SELECT 1 FROM public.raw_raid_entries WHERE raid_id=h.raid_id) OR EXISTS (SELECT 1 FROM public.raw_raid_reservation_debits WHERE raid_id=h.raid_id))
  THEN RAISE EXCEPTION 'untransferred raw raid cannot have entries or debits' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.shardkeep_raw_raid_proof() FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['raw_raid_snapshots','raw_raid_resources','raw_raid_allocations','raw_raid_terminals','raw_raid_entries','raw_raid_reservation_debits'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid = pg_catalog.to_regclass('public.' || t) AND tgname = t || '_immutable') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_resource_stock_immutable()',t||'_immutable',t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid = pg_catalog.to_regclass('public.' || t) AND tgname = t || '_no_truncate') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_resource_stock_immutable()',t||'_no_truncate',t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid = pg_catalog.to_regclass('public.' || t) AND tgname = t || '_proof') THEN
      EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_raw_raid_proof()',t||'_proof',t);
    END IF;
  END LOOP;
END;
$$;
