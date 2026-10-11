-- New prospective wallet XP only. No balances, grants, allocation or backfill.
CREATE TABLE IF NOT EXISTS mining_wallet_experience_days (
 day date NOT NULL, policy_version integer NOT NULL,
 source_policy text NOT NULL CHECK (source_policy='battle-evidence-v1'), source_hash text NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'),
 source_coverage_started_at timestamptz NOT NULL, sealed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 result_hash text NOT NULL CHECK(result_hash ~ '^[0-9a-f]{64}$'), result jsonb NOT NULL,
 PRIMARY KEY(day,policy_version),
 FOREIGN KEY(day,source_policy) REFERENCES mining_activity_evidence(day,policy_version),
 CHECK(isfinite(sealed_at) AND sealed_at >= (day+1)::timestamp AT TIME ZONE 'UTC'),
 CHECK((result->>'day'=to_char(day,'YYYY-MM-DD') AND result->>'policyVersion'=policy_version::text
  AND result->'allocationReady'='false'::jsonb AND result->'publicationAuthorized'='false'::jsonb
  AND jsonb_typeof(result->'wallets')='array' AND jsonb_typeof(result->'awards')='array') IS TRUE)
);
CREATE TABLE IF NOT EXISTS mining_wallet_experience_awards (
 raid_id uuid PRIMARY KEY, day date NOT NULL, policy_version integer NOT NULL,
 wallet text NOT NULL, base_id uuid NOT NULL, first_accepted_at timestamptz NOT NULL,
 points integer NOT NULL CHECK(points>0), source_hash text NOT NULL,
 FOREIGN KEY(day,policy_version) REFERENCES mining_wallet_experience_days(day,policy_version),
 CHECK(first_accepted_at >= day::timestamp AT TIME ZONE 'UTC' AND first_accepted_at < (day+1)::timestamp AT TIME ZONE 'UTC')
);
CREATE INDEX IF NOT EXISTS mining_wallet_experience_wallet_idx ON mining_wallet_experience_awards(wallet,day);
REVOKE ALL ON mining_wallet_experience_days,mining_wallet_experience_awards FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_wallet_xp_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE src mining_activity_evidence%ROWTYPE; seal mining_wallet_experience_days%ROWTYPE; r jsonb; first_at timestamptz;
BEGIN
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN
  RAISE EXCEPTION 'MINING_WALLET_XP_OWNER_REQUIRED' USING ERRCODE='42501';
 END IF;
 SELECT * INTO src FROM mining_activity_evidence WHERE day=NEW.day AND policy_version='battle-evidence-v1';
 IF NOT FOUND OR src.evidence_hash IS DISTINCT FROM NEW.source_hash THEN RAISE EXCEPTION 'MINING_WALLET_XP_SOURCE'; END IF;
 IF TG_TABLE_NAME='mining_wallet_experience_days' THEN
  IF NEW.source_coverage_started_at IS DISTINCT FROM src.coverage_started_at OR NEW.sealed_at<src.sealed_at THEN RAISE EXCEPTION 'MINING_WALLET_XP_SOURCE'; END IF;
 ELSE
  SELECT * INTO seal FROM mining_wallet_experience_days WHERE day=NEW.day AND policy_version=NEW.policy_version;
  IF NOT FOUND OR seal.source_hash IS DISTINCT FROM NEW.source_hash OR NOT EXISTS (
   SELECT 1 FROM jsonb_array_elements(seal.result->'awards') a WHERE a=jsonb_build_object('raidId',NEW.raid_id,'wallet',NEW.wallet,
    'baseId',NEW.base_id,'firstAcceptedAt',to_char(NEW.first_accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'points',NEW.points)
  ) THEN RAISE EXCEPTION 'MINING_WALLET_XP_SOURCE'; END IF;
  SELECT e INTO r FROM jsonb_array_elements(src.evidence->'raids') e WHERE e->'raid'->>'id'=NEW.raid_id::text;
  SELECT min((e->>'occurredAt')::timestamptz) INTO first_at FROM jsonb_array_elements(r->'events') e WHERE e->>'sourceKey'='battle_fought';
  IF r IS NULL OR r->'raid'->>'wallet' IS DISTINCT FROM NEW.wallet OR r->'raid'->>'baseId' IS DISTINCT FROM NEW.base_id::text
   OR r->'raid'->'opponent' IS DISTINCT FROM 'null'::jsonb OR r->'raid'->'campaignStage' IS NULL OR r->'raid'->'campaignStage'='null'::jsonb
   OR r->'raid'->>'status' IS DISTINCT FROM 'resolved' OR r->'raid'->'retreated' IS DISTINCT FROM 'false'::jsonb
   OR first_at IS DISTINCT FROM NEW.first_accepted_at OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(src.result->'wallets') w WHERE w->>'wallet'=NEW.wallet AND w->'playedRaidIds' ? NEW.raid_id::text
   ) THEN RAISE EXCEPTION 'MINING_WALLET_XP_SOURCE'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_mining_wallet_xp_insert() FROM PUBLIC;
DROP TRIGGER IF EXISTS mining_wallet_xp_insert ON mining_wallet_experience_days;
CREATE TRIGGER mining_wallet_xp_insert BEFORE INSERT ON mining_wallet_experience_days FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_wallet_xp_insert();
DROP TRIGGER IF EXISTS mining_wallet_xp_insert ON mining_wallet_experience_awards;
CREATE TRIGGER mining_wallet_xp_insert BEFORE INSERT ON mining_wallet_experience_awards FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_wallet_xp_insert();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_wallet_xp_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE expected jsonb; actual jsonb;
BEGIN
 SELECT coalesce(jsonb_agg(a ORDER BY a->>'raidId'),'[]') INTO expected FROM mining_wallet_experience_days d,
  LATERAL jsonb_array_elements(d.result->'awards') a WHERE d.day=NEW.day AND d.policy_version=NEW.policy_version;
 SELECT coalesce(jsonb_agg(jsonb_build_object('raidId',raid_id,'wallet',wallet,'baseId',base_id,
  'firstAcceptedAt',to_char(first_accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'points',points) ORDER BY raid_id),'[]')
  INTO actual FROM mining_wallet_experience_awards WHERE day=NEW.day AND policy_version=NEW.policy_version;
 IF expected IS DISTINCT FROM actual THEN RAISE EXCEPTION 'MINING_WALLET_XP_INCOMPLETE'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_mining_wallet_xp_complete() FROM PUBLIC;
DROP TRIGGER IF EXISTS mining_wallet_xp_complete ON mining_wallet_experience_days;
CREATE CONSTRAINT TRIGGER mining_wallet_xp_complete AFTER INSERT ON mining_wallet_experience_days DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_wallet_xp_complete();
DROP TRIGGER IF EXISTS mining_wallet_xp_complete ON mining_wallet_experience_awards;
CREATE CONSTRAINT TRIGGER mining_wallet_xp_complete AFTER INSERT ON mining_wallet_experience_awards DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_wallet_xp_complete();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_wallet_xp_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN RAISE EXCEPTION 'MINING_WALLET_XP_IMMUTABLE'; END $$;
REVOKE ALL ON FUNCTION public.shardkeep_mining_wallet_xp_immutable() FROM PUBLIC;
DROP TRIGGER IF EXISTS mining_wallet_xp_immutable ON mining_wallet_experience_days;
CREATE TRIGGER mining_wallet_xp_immutable BEFORE UPDATE OR DELETE ON mining_wallet_experience_days FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_wallet_xp_immutable();
DROP TRIGGER IF EXISTS mining_wallet_xp_no_truncate ON mining_wallet_experience_days;
CREATE TRIGGER mining_wallet_xp_no_truncate BEFORE TRUNCATE ON mining_wallet_experience_days FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_wallet_xp_immutable();
DROP TRIGGER IF EXISTS mining_wallet_xp_immutable ON mining_wallet_experience_awards;
CREATE TRIGGER mining_wallet_xp_immutable BEFORE UPDATE OR DELETE ON mining_wallet_experience_awards FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_wallet_xp_immutable();
DROP TRIGGER IF EXISTS mining_wallet_xp_no_truncate ON mining_wallet_experience_awards;
CREATE TRIGGER mining_wallet_xp_no_truncate BEFORE TRUNCATE ON mining_wallet_experience_awards FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_wallet_xp_immutable();
