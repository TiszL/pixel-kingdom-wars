-- D-153.17: explicit free Crownlands home, without backfill/dispatch/issuance.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS expedition_free_homes (
  base_id uuid PRIMARY KEY REFERENCES bases(id) ON DELETE RESTRICT,
  id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  assigned_wallet text NOT NULL REFERENCES players(wallet),
  realm_id text NOT NULL,
  policy_version integer NOT NULL,
  provenance text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expedition_free_homes_policy_ck CHECK (
    policy_version = 1 AND realm_id = 'crownlands' AND provenance = 'authenticated_free_home_v1')
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_expedition_free_home_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE b public.bases%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'original free home assignment is immutable' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO b FROM public.bases WHERE id = NEW.base_id FOR UPDATE;
  IF NOT FOUND OR b.owner_wallet <> NEW.assigned_wallet OR b.status <> 'active'
    OR b.land_paid_at IS NOT NULL OR b.deed_asset_id IS NOT NULL
    OR b.deed_mint_asset_id IS NOT NULL OR b.deed_minting_at IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM public.base_slots WHERE base_id = NEW.base_id AND wallet = NEW.assigned_wallet AND active)
    OR EXISTS (SELECT 1 FROM public.fantasy_land_claims WHERE base_id = NEW.base_id AND state IN ('held','assigned'))
    OR EXISTS (SELECT 1 FROM public.fantasy_retirement_exclusions WHERE base_id = NEW.base_id)
  THEN RAISE EXCEPTION 'free home requires current active free base custody' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.shardkeep_expedition_free_home_guard() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.expedition_free_homes'::regclass AND tgname = 'expedition_free_home_guard') THEN
    CREATE TRIGGER expedition_free_home_guard BEFORE INSERT OR UPDATE OR DELETE ON expedition_free_homes
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_expedition_free_home_guard();
  END IF;
END;
$migration$;
