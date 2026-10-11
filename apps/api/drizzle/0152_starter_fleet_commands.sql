-- D153.30: explicit free installation consent. No backfill of internal installs.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS starter_fleet_commands (
 id uuid PRIMARY KEY, actor_wallet text NOT NULL REFERENCES players(wallet),
 base_id uuid NOT NULL REFERENCES bases(id) ON DELETE RESTRICT,
 berth_id uuid NOT NULL REFERENCES buildings(id) ON DELETE RESTRICT,
 installation_id uuid NOT NULL REFERENCES fleet_installations(id) ON DELETE RESTRICT,
 completed_build_job_id uuid NOT NULL REFERENCES builder_jobs(id) ON DELETE RESTRICT,
 berth_completed_at timestamptz NOT NULL, installed_at timestamptz NOT NULL,
 accepted_at timestamptz NOT NULL,
 CONSTRAINT starter_fleet_command_time_ck CHECK (accepted_at >= installed_at AND installed_at >= berth_completed_at)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_starter_fleet_command_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE home public.bases%ROWTYPE;
BEGIN
 IF TG_OP <> 'INSERT' THEN
  RAISE EXCEPTION 'starter installation command is immutable' USING ERRCODE='23514';
 END IF;
 SELECT * INTO home FROM public.bases WHERE id=NEW.base_id FOR UPDATE;
 IF NOT FOUND OR home.owner_wallet<>NEW.actor_wallet OR home.status<>'active'
  OR NOT EXISTS (SELECT 1 FROM public.base_slots WHERE base_id=home.id AND wallet=NEW.actor_wallet AND active)
  OR NOT EXISTS (SELECT 1 FROM public.fleet_installations WHERE id=NEW.installation_id
   AND base_id=NEW.base_id AND berth_id=NEW.berth_id AND family='starter'
   AND completed_build_job_id=NEW.completed_build_job_id AND berth_completed_at=NEW.berth_completed_at AND created_at=NEW.installed_at)
  OR NOT EXISTS (SELECT 1 FROM public.builder_jobs WHERE id=NEW.completed_build_job_id
   AND base_id=NEW.base_id AND building_id=NEW.berth_id AND kind='build'
   AND completed_at=NEW.berth_completed_at AND cancelled_at IS NULL)
 THEN RAISE EXCEPTION 'starter command requires current custody and original installation links' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.shardkeep_starter_fleet_command_guard() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.starter_fleet_commands'::regclass AND tgname = 'starter_fleet_command_guard') THEN
    CREATE TRIGGER starter_fleet_command_guard BEFORE INSERT OR UPDATE OR DELETE ON starter_fleet_commands
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_starter_fleet_command_guard();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.starter_fleet_commands'::regclass AND tgname = 'starter_fleet_command_no_truncate') THEN
    CREATE TRIGGER starter_fleet_command_no_truncate BEFORE TRUNCATE ON starter_fleet_commands
FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_starter_fleet_command_guard();
  END IF;
END;
$migration$;
