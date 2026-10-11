-- Prospective shadow input observations only. No allocation, contribution
-- consumption, EXP/Renown award, funding or runtime registration.
CREATE TABLE IF NOT EXISTS mining_free_wallet_shadows (
 wallet text NOT NULL,
 day date NOT NULL,
 policy_version text NOT NULL CHECK (policy_version = 'free-shadow-v1'),
 observed_at timestamptz NOT NULL,
 evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
 evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
 result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
 PRIMARY KEY(wallet, day, policy_version),
 CONSTRAINT mining_free_shadow_closed_day_ck CHECK (isfinite(observed_at) AND observed_at >= (day + 1)::timestamp AT TIME ZONE 'UTC'),
 CONSTRAINT mining_free_shadow_scope_ck CHECK ((
   result->>'wallet' = wallet AND result->>'day' = to_char(day, 'YYYY-MM-DD')
   AND result->>'policyVersion' = policy_version
   AND result->'allocationReady' = 'false'::jsonb
   AND result->'publicationAuthorized' = 'false'::jsonb
 ) IS TRUE)
);
REVOKE ALL ON TABLE mining_free_wallet_shadows FROM PUBLIC;
--> statement-breakpoint
-- A hash proves replay consistency, not authority. A broadly granted runtime
-- role must not manufacture an observation that bypasses the source collector.
CREATE OR REPLACE FUNCTION public.shardkeep_mining_free_shadow_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog,public,pg_temp AS $$
BEGIN
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN
  RAISE EXCEPTION 'MINING_FREE_SHADOW_OWNER_REQUIRED' USING ERRCODE = '42501';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_mining_free_shadow_insert_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS mining_free_shadow_insert_guard ON mining_free_wallet_shadows;
CREATE TRIGGER mining_free_shadow_insert_guard BEFORE INSERT ON mining_free_wallet_shadows
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_free_shadow_insert_guard();
--> statement-breakpoint
-- The consumer also trusts the existing battle journal. Protect that producer
-- boundary prospectively without rewriting its migration or accepted facts.
CREATE OR REPLACE FUNCTION public.shardkeep_mining_activity_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog,public,pg_temp AS $$
BEGIN
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN
  RAISE EXCEPTION 'MINING_ACTIVITY_OWNER_REQUIRED' USING ERRCODE = '42501';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_mining_activity_insert_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS mining_activity_insert_guard ON mining_activity_evidence;
CREATE TRIGGER mining_activity_insert_guard BEFORE INSERT ON mining_activity_evidence
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_activity_insert_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_free_shadow_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog,public,pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'MINING_FREE_SHADOW_IMMUTABLE' USING ERRCODE = '23514';
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_mining_free_shadow_immutable() FROM PUBLIC;
DROP TRIGGER IF EXISTS mining_free_shadow_immutable ON mining_free_wallet_shadows;
CREATE TRIGGER mining_free_shadow_immutable BEFORE UPDATE OR DELETE ON mining_free_wallet_shadows
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_free_shadow_immutable();
DROP TRIGGER IF EXISTS mining_free_shadow_no_truncate ON mining_free_wallet_shadows;
CREATE TRIGGER mining_free_shadow_no_truncate BEFORE TRUNCATE ON mining_free_wallet_shadows
FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_free_shadow_immutable();
