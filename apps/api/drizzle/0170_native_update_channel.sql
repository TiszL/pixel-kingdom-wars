-- M45 §2 (Track N0; D-153.47): the operator-written native update channel.
-- Rows are never deleted; rollback is a forward re-release under a higher code.
-- UPDATE may only promote channel tester->stable, flip store_status
-- pending->published and set mandatory false->true. Game traffic never writes.
-- version_code stops at six digits and notes_url needs a host, matching the
-- wire schema (apkPath regex, z.url()) so psql cannot store an unservable row.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS native_update_channel (
 version_code integer PRIMARY KEY,
 version_name text NOT NULL,
 source_commit text NOT NULL,
 apk_path text NOT NULL,
 sha256 text NOT NULL,
 size_bytes bigint NOT NULL,
 signer_sha256 text NOT NULL,
 published_at timestamptz NOT NULL DEFAULT now(),
 store_status text NOT NULL DEFAULT 'pending',
 channel text NOT NULL,
 mandatory boolean NOT NULL DEFAULT false,
 notes_url text,
 created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT native_update_channel_apk_path_key UNIQUE (apk_path),
 CONSTRAINT native_update_channel_sha256_key UNIQUE (sha256),
 CONSTRAINT native_update_channel_version_code_ck CHECK (version_code > 0 AND version_code <= 999999),
 CONSTRAINT native_update_channel_version_name_ck CHECK (version_name ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
 CONSTRAINT native_update_channel_source_commit_ck CHECK (source_commit ~ '^[0-9a-f]{40}$'),
 CONSTRAINT native_update_channel_sha256_ck CHECK (sha256 ~ '^[0-9a-f]{64}$'),
 CONSTRAINT native_update_channel_signer_ck CHECK (signer_sha256 ~ '^[0-9a-f]{64}$'),
 CONSTRAINT native_update_channel_apk_path_ck CHECK (apk_path = '/native/releases/' || version_code || '-' || sha256 || '.apk'),
 CONSTRAINT native_update_channel_size_ck CHECK (size_bytes > 0 AND size_bytes <= 314572800),
 CONSTRAINT native_update_channel_store_status_ck CHECK (store_status IN ('pending','published')),
 CONSTRAINT native_update_channel_channel_ck CHECK (channel IN ('tester','stable')),
 CONSTRAINT native_update_channel_notes_url_ck CHECK (notes_url IS NULL OR notes_url ~ '^https://[^/?#[:space:]]+([/?#][^[:space:]]*)?$')
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_native_update_channel_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'Native update channel rows are never deleted' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_native_update_channel_immutable() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.shardkeep_native_update_channel_forward_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 -- Every column except the three forward-only switches is compared as a whole
 -- row, so a column added later is immutable without editing this function.
 IF (to_jsonb(NEW) - 'channel' - 'store_status' - 'mandatory')
    IS DISTINCT FROM (to_jsonb(OLD) - 'channel' - 'store_status' - 'mandatory')
  OR NOT (NEW.channel = OLD.channel OR (OLD.channel = 'tester' AND NEW.channel = 'stable'))
  OR NOT (NEW.store_status = OLD.store_status OR (OLD.store_status = 'pending' AND NEW.store_status = 'published'))
  OR NOT (NEW.mandatory = OLD.mandatory OR (NOT OLD.mandatory AND NEW.mandatory)) THEN
  RAISE EXCEPTION 'Native update channel rows only move forward' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_native_update_channel_forward_only() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.native_update_channel'::regclass AND tgname = 'native_update_channel_no_delete') THEN
    CREATE TRIGGER native_update_channel_no_delete BEFORE DELETE ON native_update_channel
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_native_update_channel_immutable();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.native_update_channel'::regclass AND tgname = 'native_update_channel_no_truncate') THEN
    CREATE TRIGGER native_update_channel_no_truncate BEFORE TRUNCATE ON native_update_channel
FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_native_update_channel_immutable();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.native_update_channel'::regclass AND tgname = 'native_update_channel_forward_only') THEN
    CREATE TRIGGER native_update_channel_forward_only BEFORE UPDATE ON native_update_channel
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_native_update_channel_forward_only();
  END IF;
END;
$migration$;
