-- Accepted five families: non-NFT starter only in this DARK registry. No
-- placement, NFT activation, dispatch, earnings, tier or use allowance.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fleet_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_id uuid NOT NULL REFERENCES bases(id) ON DELETE RESTRICT,
  berth_id uuid NOT NULL REFERENCES buildings(id) ON DELETE RESTRICT,
  family text NOT NULL,
  installed_wallet text NOT NULL REFERENCES players(wallet),
  completed_build_job_id uuid NOT NULL REFERENCES builder_jobs(id) ON DELETE RESTRICT,
  berth_completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fleet_installations_base_family_uq UNIQUE (base_id, family),
  CONSTRAINT fleet_installations_berth_uq UNIQUE (berth_id),
  CONSTRAINT fleet_installations_family_ck CHECK (family = 'starter')
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_starter_fleet_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE b public.bases%ROWTYPE; berth public.buildings%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'fleet installation identity is immutable' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO b FROM public.bases WHERE id = NEW.base_id FOR UPDATE;
  IF NOT FOUND OR b.owner_wallet <> NEW.installed_wallet OR b.status <> 'active'
    OR NOT EXISTS (SELECT 1 FROM public.base_slots WHERE base_id = b.id AND wallet = b.owner_wallet AND active)
  THEN RAISE EXCEPTION 'starter installation requires current active base custody' USING ERRCODE = '23514'; END IF;
  SELECT * INTO berth FROM public.buildings WHERE id = NEW.berth_id FOR UPDATE;
  IF NOT FOUND OR berth.base_id IS DISTINCT FROM NEW.base_id OR berth.type <> 'berth' OR berth.level < 1
    OR NOT EXISTS (SELECT 1 FROM public.builder_jobs WHERE id = NEW.completed_build_job_id
      AND base_id = NEW.base_id AND building_id = NEW.berth_id AND kind = 'build'
      AND completed_at = NEW.berth_completed_at AND cancelled_at IS NULL)
    OR EXISTS (SELECT 1 FROM public.builder_jobs WHERE building_id = NEW.berth_id AND kind = 'build' AND completed_at IS NULL)
  THEN RAISE EXCEPTION 'starter installation requires original completed berth' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.shardkeep_starter_fleet_guard() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.fleet_installations'::regclass AND tgname = 'starter_fleet_guard') THEN
    CREATE TRIGGER starter_fleet_guard BEFORE INSERT OR UPDATE OR DELETE ON fleet_installations
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_starter_fleet_guard();
  END IF;
END;
$migration$;
