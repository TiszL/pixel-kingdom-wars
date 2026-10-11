-- Phase E: prospective, immutable battle evidence only. No money, score,
-- allocation, backfill, runtime registration or production activation.
CREATE TABLE IF NOT EXISTS mining_activity_evidence (
 day date NOT NULL,
 policy_version text NOT NULL CHECK (policy_version = 'battle-evidence-v1'),
 coverage_started_at timestamptz NOT NULL,
 sealed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 evidence_hash text NOT NULL CHECK (length(evidence_hash) = 64 AND evidence_hash ~ '^[0-9a-f]{64}$'),
 evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
 result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
 PRIMARY KEY(day, policy_version),
 CONSTRAINT mining_activity_coverage_ck CHECK (coverage_started_at <= day::timestamp AT TIME ZONE 'UTC'),
 CONSTRAINT mining_activity_closed_day_ck CHECK (sealed_at >= (day + 1)::timestamp AT TIME ZONE 'UTC'),
 CONSTRAINT mining_activity_scope_ck CHECK ((
   result->'allocationReady' = 'false'::jsonb
   AND result->>'day' = to_char(day, 'YYYY-MM-DD')
   AND result->>'policyVersion' = policy_version
   AND jsonb_typeof(result->'wallets') = 'array'
 ) IS TRUE)
);
REVOKE ALL ON TABLE mining_activity_evidence FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_activity_evidence_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog,public,pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'MINING_ACTIVITY_EVIDENCE_IMMUTABLE' USING ERRCODE = '23514';
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_mining_activity_evidence_immutable() FROM PUBLIC;
DROP TRIGGER IF EXISTS mining_activity_evidence_immutable ON mining_activity_evidence;
CREATE TRIGGER mining_activity_evidence_immutable BEFORE UPDATE OR DELETE ON mining_activity_evidence
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_activity_evidence_immutable();
DROP TRIGGER IF EXISTS mining_activity_evidence_no_truncate ON mining_activity_evidence;
CREATE TRIGGER mining_activity_evidence_no_truncate BEFORE TRUNCATE ON mining_activity_evidence
FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_activity_evidence_immutable();
