-- DARK E2 raw-stock bookkeeping only. No source credit, grants or routes.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS resource_stocks (
  base_id uuid NOT NULL REFERENCES bases(id) ON DELETE RESTRICT,
  resource_id text NOT NULL,
  available bigint NOT NULL DEFAULT 0,
  reserved bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (base_id, resource_id),
  CONSTRAINT resource_stocks_id_ck CHECK (resource_id IN ('frost_quartz','heartwood_logs','sunstone_rubble','crown_iron_ore','rough_prism','storm_ore','thorn_fibre','ember_nodules')),
  CONSTRAINT resource_stocks_quantity_ck CHECK (available >= 0 AND reserved >= 0 AND available::numeric + reserved::numeric <= 9223372036854775807)
);
CREATE TABLE IF NOT EXISTS resource_stock_operations (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  base_id uuid NOT NULL,
  resource_id text NOT NULL,
  quantity bigint NOT NULL,
  custody_wallet text NOT NULL,
  reservation_id uuid REFERENCES resource_stock_operations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resource_stock_operations_id_ck CHECK (resource_id IN ('frost_quartz','heartwood_logs','sunstone_rubble','crown_iron_ore','rough_prism','storm_ore','thorn_fibre','ember_nodules')),
  CONSTRAINT resource_stock_operations_quantity_ck CHECK (quantity > 0),
  CONSTRAINT resource_stock_operations_kind_ck CHECK (
    (kind = 'reserve' AND reservation_id IS NULL) OR
    (kind IN ('release','consume') AND reservation_id IS NOT NULL AND reservation_id <> id))
);
CREATE UNIQUE INDEX IF NOT EXISTS resource_stock_terminal_uq ON resource_stock_operations (reservation_id) WHERE reservation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS resource_stock_base_idx ON resource_stock_operations (base_id, created_at);
CREATE TABLE IF NOT EXISTS resource_stock_entries (
  operation_id uuid NOT NULL REFERENCES resource_stock_operations(id),
  bucket text NOT NULL,
  delta bigint NOT NULL,
  PRIMARY KEY (operation_id, bucket),
  CONSTRAINT resource_stock_entries_bucket_ck CHECK (bucket IN ('available','reserved','consumed')),
  -- D153.20: a fully stolen reservation releases zero, proved by 0144.
  CONSTRAINT resource_stock_entries_delta_ck CHECK (delta >= -9223372036854775807)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_resource_stock_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'raw stock operation evidence is immutable' USING ERRCODE = '23514';
END;
$$;
REVOKE ALL ON FUNCTION public.shardkeep_resource_stock_immutable() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.resource_stock_operations'::regclass AND tgname = 'resource_stock_operation_immutable') THEN
    CREATE TRIGGER resource_stock_operation_immutable BEFORE UPDATE OR DELETE ON resource_stock_operations
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_resource_stock_immutable();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.resource_stock_entries'::regclass AND tgname = 'resource_stock_entry_immutable') THEN
    CREATE TRIGGER resource_stock_entry_immutable BEFORE UPDATE OR DELETE ON resource_stock_entries
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_resource_stock_immutable();
  END IF;
END;
$migration$;
--> statement-breakpoint
-- Both INSERT sites trigger the check: an empty operation or extra later entry
-- cannot become accepted evidence. Shape is exact, not merely zero-sum.
-- Keep any later same-block refinement when this file is replayed.
DO $migration$
BEGIN
  IF pg_catalog.to_regprocedure('public.shardkeep_resource_stock_proof()') IS NULL THEN
    CREATE FUNCTION public.shardkeep_resource_stock_proof()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  operation_key uuid;
  op public.resource_stock_operations%ROWTYPE;
  parent public.resource_stock_operations%ROWTYPE;
  debit_bucket text;
  credit_bucket text;
BEGIN
  IF TG_TABLE_NAME = 'resource_stock_operations' THEN operation_key := NEW.id;
  ELSE operation_key := NEW.operation_id; END IF;
  SELECT * INTO STRICT op FROM public.resource_stock_operations WHERE id = operation_key;
  debit_bucket := CASE WHEN op.kind = 'reserve' THEN 'available' ELSE 'reserved' END;
  credit_bucket := CASE op.kind WHEN 'reserve' THEN 'reserved' WHEN 'release' THEN 'available' ELSE 'consumed' END;
  IF (SELECT count(*) FROM public.resource_stock_entries WHERE operation_id = operation_key) <> 2
    OR NOT EXISTS (SELECT 1 FROM public.resource_stock_entries WHERE operation_id = operation_key AND bucket = debit_bucket AND delta = -op.quantity)
    OR NOT EXISTS (SELECT 1 FROM public.resource_stock_entries WHERE operation_id = operation_key AND bucket = credit_bucket AND delta = op.quantity)
  THEN RAISE EXCEPTION 'raw stock proof must have exact balanced entries' USING ERRCODE = '23514'; END IF;
  IF op.reservation_id IS NOT NULL THEN
    SELECT * INTO STRICT parent FROM public.resource_stock_operations WHERE id = op.reservation_id;
    IF parent.kind <> 'reserve' OR ROW(parent.base_id, parent.resource_id, parent.quantity)
      IS DISTINCT FROM ROW(op.base_id, op.resource_id, op.quantity)
    THEN RAISE EXCEPTION 'raw stock terminal must match original reservation' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NULL;
END;
$$;
  END IF;
END;
$migration$;
REVOKE ALL ON FUNCTION public.shardkeep_resource_stock_proof() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.resource_stock_operations'::regclass AND tgname = 'resource_stock_operation_proof') THEN
    CREATE CONSTRAINT TRIGGER resource_stock_operation_proof AFTER INSERT ON resource_stock_operations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_resource_stock_proof();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.resource_stock_entries'::regclass AND tgname = 'resource_stock_entry_proof') THEN
    CREATE CONSTRAINT TRIGGER resource_stock_entry_proof AFTER INSERT ON resource_stock_entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_resource_stock_proof();
  END IF;
END;
$migration$;
