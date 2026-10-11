-- K232 held same-transaction gameplay capabilities. Preserve the existing
-- owner, bodies and pinned search_path; neither function writes private facts.
SET LOCAL lock_timeout='10s';
ALTER FUNCTION public.shardkeep_clan_charter_raid_chest_resolve(uuid,text) SECURITY DEFINER;
ALTER FUNCTION public.shardkeep_clan_charter_raid_chest_assert_posting(uuid,uuid) SECURITY DEFINER;
REVOKE ALL ON FUNCTION public.shardkeep_clan_charter_raid_chest_resolve(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_clan_charter_raid_chest_assert_posting(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE role_name text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['shardkeep_api_runtime','shardkeep_worker_runtime'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION public.shardkeep_clan_charter_raid_chest_resolve(uuid,text) TO %I',role_name);
   EXECUTE format('GRANT EXECUTE ON FUNCTION public.shardkeep_clan_charter_raid_chest_assert_posting(uuid,uuid) TO %I',role_name);
  END IF;
 END LOOP;
END $$;
