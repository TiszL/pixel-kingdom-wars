-- M47 §5 (D-189): the public release history behind pixelkingdomwars.com/changelog.
-- One row per deployed git sha. The only writer is the release-notes CLI
-- (apps/api/src/releases/cli.ts) that infra/deploy.sh runs after a publicly
-- verified release; no HTTP route writes here. A curated fragment is claimed by
-- the first recorded release that carries it, so every note is published once.
-- History is append-only: UPDATE, DELETE and TRUNCATE are refused on both tables.
-- File number and journal timestamp 1790276000000 are reserved by M47 §5, strictly
-- between main's 0170 (1790272400000) and the Phase E branch's first entry.
-- Entry shape is checked here as well as in zod, so psql cannot store a row the
-- public routes could not serve.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_release_entries_valid(entries jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE entry jsonb;
BEGIN
 IF jsonb_typeof(entries) IS DISTINCT FROM 'array'
   OR jsonb_array_length(entries) < 1 OR jsonb_array_length(entries) > 40 THEN
  RETURN false;
 END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(entries) LOOP
  IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(entry)) <> 5
    OR jsonb_typeof(entry->'id') IS DISTINCT FROM 'string'
    OR jsonb_typeof(entry->'category') IS DISTINCT FROM 'string'
    OR jsonb_typeof(entry->'platforms') IS DISTINCT FROM 'string'
    OR jsonb_typeof(entry->'title') IS DISTINCT FROM 'string'
    OR jsonb_typeof(entry->'body') IS DISTINCT FROM 'string'
    OR NOT ((entry->>'id') ~ '^([0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*|android-[1-9][0-9]{0,5}|maintenance-[0-9a-f]{8})$')
    OR length(entry->>'id') > 96
    OR (entry->>'category') NOT IN ('new','improved','fixed','balance','android','world')
    OR (entry->>'platforms') NOT IN ('all','web','android')
    OR length(entry->>'title') NOT BETWEEN 1 AND 80
    OR length(entry->>'body') NOT BETWEEN 1 AND 600
    OR (entry->>'title') ~ '[<>]' OR (entry->>'body') ~ '[<>]' THEN
   RETURN false;
  END IF;
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_release_entries_valid(jsonb) FROM PUBLIC;
CREATE TABLE IF NOT EXISTS release_history (
 git_sha text PRIMARY KEY,
 version text NOT NULL,
 sim_version integer NOT NULL,
 built_at timestamptz,
 deployed_at timestamptz NOT NULL DEFAULT now(),
 kind text NOT NULL,
 entries jsonb NOT NULL,
 fragment_ids text[] NOT NULL DEFAULT '{}',
 recorded_by text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT release_history_git_sha_ck CHECK (git_sha ~ '^[0-9a-f]{40}$'),
 CONSTRAINT release_history_version_ck CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
 CONSTRAINT release_history_sim_version_ck CHECK (sim_version > 0 AND sim_version <= 100000),
 CONSTRAINT release_history_kind_ck CHECK (kind IN ('deploy','backfill')),
 CONSTRAINT release_history_entries_ck CHECK (public.shardkeep_release_entries_valid(entries)),
 CONSTRAINT release_history_fragment_ids_ck CHECK (cardinality(fragment_ids) <= 40),
 CONSTRAINT release_history_recorded_by_ck CHECK (length(recorded_by) BETWEEN 1 AND 200)
);
CREATE INDEX IF NOT EXISTS release_history_deployed_at_idx ON release_history (deployed_at DESC, git_sha);
CREATE TABLE IF NOT EXISTS release_fragment_claims (
 fragment_id text PRIMARY KEY,
 git_sha text NOT NULL REFERENCES release_history (git_sha),
 claimed_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT release_fragment_claims_id_ck CHECK (length(fragment_id) <= 96
   AND fragment_id ~ '^([0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*|android-[1-9][0-9]{0,5})$')
);
CREATE INDEX IF NOT EXISTS release_fragment_claims_git_sha_idx ON release_fragment_claims (git_sha);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_release_history_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'Release history is append-only' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_release_history_immutable() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.release_history'::regclass AND tgname = 'release_history_append_only') THEN
    CREATE TRIGGER release_history_append_only BEFORE UPDATE OR DELETE ON release_history
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_release_history_immutable();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.release_history'::regclass AND tgname = 'release_history_no_truncate') THEN
    CREATE TRIGGER release_history_no_truncate BEFORE TRUNCATE ON release_history
FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_release_history_immutable();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.release_fragment_claims'::regclass AND tgname = 'release_fragment_claims_append_only') THEN
    CREATE TRIGGER release_fragment_claims_append_only BEFORE UPDATE OR DELETE ON release_fragment_claims
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_release_history_immutable();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.release_fragment_claims'::regclass AND tgname = 'release_fragment_claims_no_truncate') THEN
    CREATE TRIGGER release_fragment_claims_no_truncate BEFORE TRUNCATE ON release_fragment_claims
FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_release_history_immutable();
  END IF;
END;
$migration$;
