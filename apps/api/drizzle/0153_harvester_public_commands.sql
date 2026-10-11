-- D153.33 public consent is atomic with its newly admitted immutable source.
-- No historical source can be relabeled as a public confirmation.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
ALTER TABLE harvester_sources ADD COLUMN IF NOT EXISTS public_admission boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS harvester_source_commands (
 id uuid PRIMARY KEY, actor_wallet text NOT NULL REFERENCES players(wallet),
 base_id uuid NOT NULL REFERENCES bases(id) ON DELETE RESTRICT,
 harvester_id uuid NOT NULL, expected_source_id uuid, policy_version integer NOT NULL,
 CONSTRAINT harvester_public_command_policy_ck CHECK (policy_version > 0),
 CONSTRAINT harvester_public_command_expected_ck CHECK (expected_source_id IS NULL OR expected_source_id <> id),
 CONSTRAINT harvester_public_command_source_fk FOREIGN KEY(id) REFERENCES harvester_sources(id)
  DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_harvester_public_command_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'Harvester public command is immutable' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_harvester_public_command_immutable() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_source_commands'::regclass AND tgname = 'harvester_public_command_immutable') THEN
    CREATE TRIGGER harvester_public_command_immutable BEFORE UPDATE OR DELETE ON harvester_source_commands
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_harvester_public_command_immutable();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_source_commands'::regclass AND tgname = 'harvester_public_command_no_truncate') THEN
    CREATE TRIGGER harvester_public_command_no_truncate BEFORE TRUNCATE ON harvester_source_commands
FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_harvester_public_command_immutable();
  END IF;
END;
$migration$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_harvester_public_admission_marker() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 -- Always overwrite caller input. A concurrent internal insertion cannot see
 -- another transaction's pending public command and therefore remains false.
 NEW.public_admission := EXISTS(SELECT 1 FROM public.harvester_source_commands c
  WHERE c.id=NEW.id AND c.actor_wallet=NEW.actor_wallet AND c.base_id=NEW.base_id
   AND c.harvester_id=NEW.harvester_id AND c.policy_version=NEW.policy_version);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_harvester_public_admission_marker() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_sources'::regclass AND tgname = 'harvester_public_admission_marker') THEN
    CREATE TRIGGER harvester_public_admission_marker BEFORE INSERT ON harvester_sources
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_harvester_public_admission_marker();
  END IF;
END;
$migration$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_harvester_public_command_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='harvester_sources' THEN
  IF NOT NEW.public_admission THEN RETURN NULL; END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.harvester_source_commands c
  JOIN public.harvester_sources s ON s.id=c.id
  WHERE c.id=NEW.id AND s.public_admission AND s.actor_wallet=c.actor_wallet
   AND s.base_id=c.base_id AND s.harvester_id=c.harvester_id AND s.policy_version=c.policy_version)
 THEN RAISE EXCEPTION 'Harvester public command lacks its atomic original source' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_harvester_public_command_binding() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_source_commands'::regclass AND tgname = 'harvester_public_command_binding') THEN
    CREATE CONSTRAINT TRIGGER harvester_public_command_binding AFTER INSERT ON harvester_source_commands
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_harvester_public_command_binding();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.harvester_sources'::regclass AND tgname = 'harvester_public_source_binding') THEN
    CREATE CONSTRAINT TRIGGER harvester_public_source_binding AFTER INSERT ON harvester_sources
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_harvester_public_command_binding();
  END IF;
END;
$migration$;
