#!/usr/bin/env sh
# Provision non-owner runtime credentials and the withdrawal settlement fence.
# Safe to rerun after every migration. Never prints passwords.
set -eu

die() { printf 'db-roles: %s\n' "$*" >&2; exit 1; }

mode="${DB_ROLE_MODE:-legacy}"
cluster="${SOLANA_CLUSTER:-devnet}"

case "$mode" in
  legacy)
    case "$cluster" in
      mainnet|mainnet-beta) die 'mainnet requires DB_ROLE_MODE=isolated' ;;
    esac
    printf 'db-roles: legacy devnet mode; owner credential remains in use\n'
    exit 0
    ;;
  isolated) ;;
  *) die 'DB_ROLE_MODE must be legacy or isolated' ;;
esac

[ -n "${POSTGRES_USER:-}" ] || die 'POSTGRES_USER is required in isolated mode'
[ -n "${POSTGRES_PASSWORD:-}" ] || die 'POSTGRES_PASSWORD is required in isolated mode'
[ -n "${API_DB_USER:-}" ] || die 'API_DB_USER is required in isolated mode'
[ -n "${API_DB_PASSWORD:-}" ] || die 'API_DB_PASSWORD is required in isolated mode'
[ -n "${WORKER_DB_USER:-}" ] || die 'WORKER_DB_USER is required in isolated mode'
[ -n "${WORKER_DB_PASSWORD:-}" ] || die 'WORKER_DB_PASSWORD is required in isolated mode'
case "$API_DB_USER" in *[!A-Za-z0-9_]*) die 'API_DB_USER must contain only letters, digits and underscore' ;; esac
case "$WORKER_DB_USER" in *[!A-Za-z0-9_]*) die 'WORKER_DB_USER must contain only letters, digits and underscore' ;; esac
[ "${#API_DB_USER}" -le 48 ] || die 'API_DB_USER is too long'
[ "${#WORKER_DB_USER}" -le 48 ] || die 'WORKER_DB_USER is too long'
[ "$API_DB_USER" != "$POSTGRES_USER" ] || die 'API_DB_USER must not be the schema owner'
[ "$WORKER_DB_USER" != "$POSTGRES_USER" ] || die 'WORKER_DB_USER must not be the schema owner'
[ "$API_DB_USER" != "$WORKER_DB_USER" ] || die 'API_DB_USER and WORKER_DB_USER must differ'
[ "$API_DB_USER" != 'shardkeep_api_runtime' ] || die 'API_DB_USER uses a reserved group role name'
[ "$API_DB_USER" != 'shardkeep_worker_runtime' ] || die 'API_DB_USER uses a reserved group role name'
[ "$WORKER_DB_USER" != 'shardkeep_api_runtime' ] || die 'WORKER_DB_USER uses a reserved group role name'
[ "$WORKER_DB_USER" != 'shardkeep_worker_runtime' ] || die 'WORKER_DB_USER uses a reserved group role name'
[ "$API_DB_PASSWORD" != "$POSTGRES_PASSWORD" ] || die 'API password must differ from the schema owner password'
[ "$WORKER_DB_PASSWORD" != "$POSTGRES_PASSWORD" ] || die 'worker password must differ from the schema owner password'
[ "$API_DB_PASSWORD" != "$WORKER_DB_PASSWORD" ] || die 'API and worker passwords must differ'
[ "${#API_DB_PASSWORD}" -eq 64 ] || die 'API_DB_PASSWORD must be 64 hexadecimal characters'
[ "${#WORKER_DB_PASSWORD}" -eq 64 ] || die 'WORKER_DB_PASSWORD must be 64 hexadecimal characters'
case "$API_DB_PASSWORD" in *[!0-9A-Fa-f]*) die 'API_DB_PASSWORD must be 64 hexadecimal characters' ;; esac
case "$WORKER_DB_PASSWORD" in *[!0-9A-Fa-f]*) die 'WORKER_DB_PASSWORD must be 64 hexadecimal characters' ;; esac

psql -X -v ON_ERROR_STOP=1 \
  -v api_login="$API_DB_USER" -v api_password="$API_DB_PASSWORD" \
  -v worker_login="$WORKER_DB_USER" -v worker_password="$WORKER_DB_PASSWORD" <<'SQL'
BEGIN;

SELECT 'CREATE ROLE shardkeep_api_runtime NOLOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shardkeep_api_runtime')\gexec
SELECT 'CREATE ROLE shardkeep_worker_runtime NOLOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shardkeep_worker_runtime')\gexec
ALTER ROLE shardkeep_api_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE shardkeep_worker_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT', :'api_login')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'api_login')\gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT', :'worker_login')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'worker_login')\gexec
SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT PASSWORD %L', :'api_login', :'api_password')\gexec
SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT PASSWORD %L', :'worker_login', :'worker_password')\gexec

CREATE TEMP TABLE shardkeep_runtime_login_audit(role_name text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO shardkeep_runtime_login_audit VALUES
  (:'api_login'), (:'worker_login'), ('shardkeep_api_runtime'), ('shardkeep_worker_runtime');
DO $ownership_audit$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba
    JOIN shardkeep_runtime_login_audit a ON a.role_name = r.rolname
    UNION ALL
    SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
    JOIN shardkeep_runtime_login_audit a ON a.role_name = r.rolname
    UNION ALL
    SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
    JOIN shardkeep_runtime_login_audit a ON a.role_name = r.rolname
    UNION ALL
    SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
    JOIN shardkeep_runtime_login_audit a ON a.role_name = r.rolname
  ) THEN
    RAISE EXCEPTION 'configured API/worker login owns a database, schema, relation, or function; use fresh runtime role names';
  END IF;
END;
$ownership_audit$;
-- Neither group may inherit a stale parent role, nor retain unknown members.
SELECT format('REVOKE %I FROM %I', parent.rolname, child.rolname)
FROM pg_auth_members m JOIN pg_roles parent ON parent.oid = m.roleid
JOIN pg_roles child ON child.oid = m.member
WHERE child.rolname IN ('shardkeep_api_runtime', 'shardkeep_worker_runtime')\gexec
SELECT format('REVOKE shardkeep_api_runtime FROM %I', child.rolname)
FROM pg_auth_members m JOIN pg_roles parent ON parent.oid = m.roleid
JOIN pg_roles child ON child.oid = m.member
WHERE parent.rolname = 'shardkeep_api_runtime' AND child.rolname <> :'api_login'\gexec
SELECT format('REVOKE shardkeep_worker_runtime FROM %I', child.rolname)
FROM pg_auth_members m JOIN pg_roles parent ON parent.oid = m.roleid
JOIN pg_roles child ON child.oid = m.member
WHERE parent.rolname = 'shardkeep_worker_runtime' AND child.rolname <> :'worker_login'\gexec
-- A reused login must not retain an old owner/high-privilege membership.
SELECT format('REVOKE %I FROM %I', parent.rolname, :'api_login')
FROM pg_auth_members m
JOIN pg_roles parent ON parent.oid = m.roleid
JOIN pg_roles child ON child.oid = m.member
WHERE child.rolname = :'api_login' AND parent.rolname <> 'shardkeep_api_runtime'\gexec
SELECT format('REVOKE %I FROM %I', parent.rolname, :'worker_login')
FROM pg_auth_members m
JOIN pg_roles parent ON parent.oid = m.roleid
JOIN pg_roles child ON child.oid = m.member
WHERE child.rolname = :'worker_login' AND parent.rolname <> 'shardkeep_worker_runtime'\gexec
SELECT format('GRANT shardkeep_api_runtime TO %I', :'api_login')\gexec
SELECT format('GRANT shardkeep_worker_runtime TO %I', :'worker_login')\gexec

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE :"DBNAME" TO shardkeep_api_runtime, shardkeep_worker_runtime;
GRANT USAGE ON SCHEMA public TO shardkeep_api_runtime, shardkeep_worker_runtime;

-- Remove stale direct grants if an operator reuses an existing dedicated role.
SELECT format('REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I', schemaname, tablename, :'api_login')
FROM pg_tables WHERE schemaname = 'public'\gexec
SELECT format('REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I', schemaname, tablename, :'worker_login')
FROM pg_tables WHERE schemaname = 'public'\gexec
SELECT format('REVOKE ALL PRIVILEGES ON SEQUENCE %I.%I FROM %I', sequence_schema, sequence_name, :'api_login')
FROM information_schema.sequences WHERE sequence_schema = 'public'\gexec
SELECT format('REVOKE ALL PRIVILEGES ON SEQUENCE %I.%I FROM %I', sequence_schema, sequence_name, :'worker_login')
FROM information_schema.sequences WHERE sequence_schema = 'public'\gexec
SELECT format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I', p.oid::regprocedure, :'api_login')
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'\gexec
SELECT format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I', p.oid::regprocedure, :'worker_login')
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'\gexec
SELECT format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I', :'api_login')\gexec
SELECT format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I', :'worker_login')\gexec
SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I', current_database(), :'api_login')\gexec
SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I', current_database(), :'worker_login')\gexec

-- This is a dedicated application database. PUBLIC receives TEMP by default,
-- which would let a compromised runtime login build shadow relations in
-- pg_temp. Privileged functions also pin pg_temp last, but remove the unused
-- capability at the database boundary as defense in depth.
REVOKE TEMPORARY ON DATABASE :"DBNAME" FROM PUBLIC;

-- Normalize reused group roles too. Attribute/membership cleanup above is not
-- enough: stale direct object grants survive role reuse unless removed here.
SELECT format('REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM shardkeep_api_runtime, shardkeep_worker_runtime', schemaname, tablename)
FROM pg_tables WHERE schemaname = 'public'\gexec
SELECT format('REVOKE ALL PRIVILEGES ON SEQUENCE %I.%I FROM shardkeep_api_runtime, shardkeep_worker_runtime', sequence_schema, sequence_name)
FROM information_schema.sequences WHERE sequence_schema = 'public'\gexec
SELECT format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM shardkeep_api_runtime, shardkeep_worker_runtime', p.oid::regprocedure)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'\gexec
REVOKE ALL PRIVILEGES ON SCHEMA public FROM shardkeep_api_runtime, shardkeep_worker_runtime;
REVOKE ALL PRIVILEGES ON DATABASE :"DBNAME" FROM shardkeep_api_runtime, shardkeep_worker_runtime;

-- The API serves the game and therefore needs ordinary game-table DML. The
-- signed artifact/state machine is worker-only. A trigger below narrows the
-- shared withdrawals table to API-owned request/cancel/refund transitions.
-- Phase E mining journals belong to closed source/verifier services. New
-- mining_* tables default private; only the migration-defined projections and
-- append-only player intents below are admitted to the ordinary API role.
-- Fragment/equipment/payment source journals share the0254 immutable mining
-- source seal. Keep their original owner-only ACLs too; never rebaseline a seal
-- to bless the generic grant loop. Their closed services own access.
-- Vehicle and advanced expedition journals are likewise private, including
-- retained signed burn wires. Existing bounded availability probes remain public.
-- Table REVOKE alone does not erase stale column privileges. Normalize both,
-- including PUBLIC, before restoring this finite capability list.
SELECT format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC', tablename)
FROM pg_tables WHERE schemaname = 'public' AND (
  left(tablename, 13) = 'clan_charter_' OR left(tablename, 8) = 'charter_' OR left(tablename, 7) = 'mining_' OR left(tablename, 16) = 'divine_fragment_' OR left(tablename, 13) = 'divine_trial_'
  OR left(tablename, 15) = 'keep_equipment_' OR left(tablename, 8) = 'vehicle_' OR left(tablename, 9) = 'advanced_' OR left(tablename, 19) = 'ordinary_equipment_' OR left(tablename, 15) = 'bound_cosmetic_' OR left(tablename, 18) = 'seeker_realm_sale_' OR tablename IN (
    'crystal_fragment_stocks', 'seeker_fragment_claims', 'payment_signature_claims', 'raid_starter_presentations', 'raid_starter_presentation_contract', 'raid_advanced_presentations', 'raid_advanced_presentation_contract', 'service_activity_contract', 'current_advanced_presentation_contract', 'advanced_identity_current_contract', 'retirement_coverage_contract'
  )
)\gexec
WITH columns AS (
  SELECT c.relname, string_agg(format('%I', a.attname), ', ' ORDER BY a.attnum) names
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND (
    left(c.relname, 13) = 'clan_charter_' OR left(c.relname, 8) = 'charter_' OR left(c.relname, 7) = 'mining_' OR left(c.relname, 16) = 'divine_fragment_' OR left(c.relname, 13) = 'divine_trial_'
    OR left(c.relname, 15) = 'keep_equipment_' OR left(c.relname, 8) = 'vehicle_' OR left(c.relname, 9) = 'advanced_' OR left(c.relname, 19) = 'ordinary_equipment_' OR left(c.relname, 15) = 'bound_cosmetic_' OR left(c.relname, 18) = 'seeker_realm_sale_' OR c.relname IN (
      'crystal_fragment_stocks', 'seeker_fragment_claims', 'payment_signature_claims', 'raid_starter_presentations', 'raid_starter_presentation_contract', 'raid_advanced_presentations', 'raid_advanced_presentation_contract', 'service_activity_contract', 'current_advanced_presentation_contract', 'advanced_identity_current_contract', 'retirement_coverage_contract'
    )
  ) GROUP BY c.relname
)
SELECT format('REVOKE SELECT (%s), INSERT (%s), UPDATE (%s), REFERENCES (%s) ON TABLE public.%I FROM PUBLIC, shardkeep_api_runtime, shardkeep_worker_runtime, %I, %I',
  names, names, names, names, relname, :'api_login', :'worker_login') FROM columns\gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO shardkeep_api_runtime', schemaname, tablename)
FROM pg_tables
WHERE schemaname = 'public' AND left(tablename, 13) <> 'clan_charter_' AND left(tablename, 8) <> 'charter_' AND left(tablename, 7) <> 'mining_'
  AND left(tablename, 16) <> 'divine_fragment_' AND left(tablename, 13) <> 'divine_trial_' AND left(tablename, 15) <> 'keep_equipment_' AND left(tablename, 8) <> 'vehicle_' AND left(tablename, 9) <> 'advanced_' AND left(tablename, 19) <> 'ordinary_equipment_' AND left(tablename, 15) <> 'bound_cosmetic_' AND left(tablename, 18) <> 'seeker_realm_sale_' AND tablename NOT IN (
  'crystal_fragment_stocks', 'seeker_fragment_claims', 'payment_signature_claims', 'raid_starter_presentations', 'raid_starter_presentation_contract', 'raid_advanced_presentations', 'raid_advanced_presentation_contract', 'service_activity_contract', 'current_advanced_presentation_contract', 'advanced_identity_current_contract', 'retirement_coverage_contract',
  'economy_chain_identity', 'withdrawal_attempts', 'withdrawal_authorizations',
  'withdrawal_payout_reservations', 'release_history', 'release_fragment_claims'
)\gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO shardkeep_worker_runtime', schemaname, tablename)
FROM pg_tables WHERE schemaname = 'public' AND left(tablename, 13) <> 'clan_charter_' AND left(tablename, 8) <> 'charter_' AND left(tablename, 7) <> 'mining_'
  AND left(tablename, 16) <> 'divine_fragment_' AND left(tablename, 13) <> 'divine_trial_' AND left(tablename, 15) <> 'keep_equipment_' AND left(tablename, 8) <> 'vehicle_' AND left(tablename, 9) <> 'advanced_' AND left(tablename, 19) <> 'ordinary_equipment_' AND left(tablename, 15) <> 'bound_cosmetic_' AND left(tablename, 18) <> 'seeker_realm_sale_' AND tablename NOT IN (
  'crystal_fragment_stocks', 'seeker_fragment_claims', 'payment_signature_claims', 'raid_starter_presentations', 'raid_starter_presentation_contract', 'raid_advanced_presentations', 'raid_advanced_presentation_contract', 'service_activity_contract', 'current_advanced_presentation_contract', 'advanced_identity_current_contract', 'retirement_coverage_contract',
  'economy_chain_identity', 'withdrawal_authorizations', 'withdrawal_payout_reservations',
  'release_history', 'release_fragment_claims'
)\gexec
SELECT format('GRANT USAGE, SELECT ON SEQUENCE %I.%I TO shardkeep_api_runtime, shardkeep_worker_runtime', sequence_schema, sequence_name)
FROM information_schema.sequences WHERE sequence_schema = 'public' AND left(sequence_name, 13) <> 'clan_charter_' AND left(sequence_name, 8) <> 'charter_' AND left(sequence_name, 7) <> 'mining_'
  AND left(sequence_name, 16) <> 'divine_fragment_' AND left(sequence_name, 13) <> 'divine_trial_' AND left(sequence_name, 15) <> 'keep_equipment_' AND left(sequence_name, 8) <> 'vehicle_' AND left(sequence_name, 9) <> 'advanced_' AND left(sequence_name, 19) <> 'ordinary_equipment_' AND left(sequence_name, 15) <> 'bound_cosmetic_' AND left(sequence_name, 18) <> 'seeker_realm_sale_'\gexec
SELECT format('REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM PUBLIC', sequence_name)
FROM information_schema.sequences WHERE sequence_schema = 'public' AND (left(sequence_name, 13) = 'clan_charter_' OR left(sequence_name, 8) = 'charter_' OR left(sequence_name, 7) = 'mining_'
  OR left(sequence_name, 16) = 'divine_fragment_' OR left(sequence_name, 13) = 'divine_trial_' OR left(sequence_name, 15) = 'keep_equipment_' OR left(sequence_name, 8) = 'vehicle_' OR left(sequence_name, 9) = 'advanced_' OR left(sequence_name, 19) = 'ordinary_equipment_' OR left(sequence_name, 15) = 'bound_cosmetic_' OR left(sequence_name, 18) = 'seeker_realm_sale_')\gexec
-- Deployment provisions both before and after migrations. Until the additive
-- successor exists, keep the helper owner-only. An invalid successor refuses.
DO $crafting_runtime_before$
DECLARE accepted boolean;
BEGIN
  IF to_regprocedure('public.shardkeep_crafting_runtime_sources_valid()') IS NOT NULL THEN
    EXECUTE 'SELECT public.shardkeep_crafting_runtime_sources_valid()' INTO accepted;
    IF accepted IS DISTINCT FROM true THEN RAISE EXCEPTION 'CRAFTING_RUNTIME_SOURCE'; END IF;
  END IF;
END;
$crafting_runtime_before$;
SELECT 'GRANT EXECUTE ON FUNCTION public.shardkeep_assert_ordinary_crafting_shards(uuid) TO shardkeep_api_runtime, shardkeep_worker_runtime'
WHERE to_regprocedure('public.shardkeep_assert_ordinary_crafting_shards(uuid)') IS NOT NULL
  AND to_regprocedure('public.shardkeep_crafting_runtime_sources_valid()') IS NOT NULL\gexec
-- Bound cosmetics expose public appearance only; custody/preferences stay private.
SELECT 'GRANT EXECUTE ON FUNCTION public.shardkeep_bound_cosmetic_base_visual(uuid,text) TO shardkeep_api_runtime, shardkeep_worker_runtime'
WHERE to_regprocedure('public.shardkeep_bound_cosmetic_base_visual(uuid,text)') IS NOT NULL\gexec
SELECT 'GRANT EXECUTE ON FUNCTION public.shardkeep_bound_cosmetic_raid_visual(uuid) TO shardkeep_api_runtime, shardkeep_worker_runtime'
WHERE to_regprocedure('public.shardkeep_bound_cosmetic_raid_visual(uuid)') IS NOT NULL\gexec
-- Current API journey callbacks read immutable, redacted original Wake captures.
-- No worker caller or custody/preference writer is admitted by these readers.
SELECT 'GRANT EXECUTE ON FUNCTION public.shardkeep_bound_cosmetic_starter_wake(uuid) TO shardkeep_api_runtime'
WHERE to_regprocedure('public.shardkeep_bound_cosmetic_starter_wake(uuid)') IS NOT NULL\gexec
SELECT 'GRANT EXECUTE ON FUNCTION public.shardkeep_bound_cosmetic_advanced_wake(uuid) TO shardkeep_api_runtime'
WHERE to_regprocedure('public.shardkeep_bound_cosmetic_advanced_wake(uuid)') IS NOT NULL\gexec
-- Frozen starter presentation exposes only the immutable minimal appearance.
SELECT 'GRANT EXECUTE ON FUNCTION public.shardkeep_raid_starter_presentation(uuid) TO shardkeep_api_runtime, shardkeep_worker_runtime'
WHERE to_regprocedure('public.shardkeep_raid_starter_presentation(uuid)') IS NOT NULL\gexec
-- Advanced candidate locks and frozen read expose only redacted appearance facts.
SELECT 'GRANT EXECUTE ON FUNCTION public.shardkeep_raid_advanced_candidate(uuid,jsonb,timestamptz) TO shardkeep_api_runtime, shardkeep_worker_runtime'
WHERE to_regprocedure('public.shardkeep_raid_advanced_candidate(uuid,jsonb,timestamptz)') IS NOT NULL\gexec
SELECT 'GRANT EXECUTE ON FUNCTION public.shardkeep_raid_advanced_presentation(uuid) TO shardkeep_api_runtime, shardkeep_worker_runtime'
WHERE to_regprocedure('public.shardkeep_raid_advanced_presentation(uuid)') IS NOT NULL\gexec
-- Current service animation reads only redacted original Workshop obligations.
SELECT 'GRANT EXECUTE ON FUNCTION public.shardkeep_service_activity(text,uuid,jsonb,timestamptz) TO shardkeep_api_runtime, shardkeep_worker_runtime'
WHERE to_regprocedure('public.shardkeep_service_activity(text,uuid,jsonb,timestamptz)') IS NOT NULL\gexec
-- Current advanced berth facts retain original installation authority.
SELECT 'GRANT EXECUTE ON FUNCTION public.shardkeep_current_advanced_presentation(text,uuid,jsonb,timestamptz) TO shardkeep_api_runtime, shardkeep_worker_runtime'
WHERE to_regprocedure('public.shardkeep_current_advanced_presentation(text,uuid,jsonb,timestamptz)') IS NOT NULL\gexec
-- 0292/0293: current installed reservation identities from the same locked appearance read (additive namespace).
SELECT 'GRANT EXECUTE ON FUNCTION public.shardkeep_advanced_identity_current(text,uuid,jsonb,timestamptz) TO shardkeep_api_runtime, shardkeep_worker_runtime'
WHERE to_regprocedure('public.shardkeep_advanced_identity_current(text,uuid,jsonb,timestamptz)') IS NOT NULL\gexec
-- 0172/0175/0176/0188/0189 and0182–0184/0194: exact public claim/sale capabilities.
SELECT format('GRANT SELECT ON TABLE public.%I TO shardkeep_api_runtime', tablename)
FROM pg_tables WHERE schemaname = 'public' AND tablename IN (
  'mining_claim_entitlement_headers', 'mining_claim_entitlement_leaves',
  'mining_claim_receipts', 'mining_claim_failures',
  'mining_tax_claim_receipts', 'mining_tax_claim_failures',
  'seeker_realm_sale_receipts', 'seeker_realm_sale_failures'
)\gexec
-- 0173/0174/0186/0187/0190: validated player intents, never verifier authority.
SELECT format('GRANT SELECT, INSERT ON TABLE public.%I TO shardkeep_api_runtime', tablename)
FROM pg_tables WHERE schemaname = 'public' AND tablename IN (
  'mining_claim_preparations', 'mining_claim_signed_wires',
  'mining_tax_claim_preparations', 'mining_tax_claim_signed_wires',
  'mining_tax_claim_continuations',
  'seeker_realm_sale_preparations', 'seeker_realm_sale_signed_wires'
)\gexec
SELECT 'GRANT EXECUTE ON FUNCTION public.shardkeep_mining_tax_continuation_lock(uuid) TO shardkeep_api_runtime'
WHERE to_regprocedure('public.shardkeep_mining_tax_continuation_lock(uuid)') IS NOT NULL\gexec
-- 0255: same-transaction original-clan resolution/post validation only.
-- No raw source journal, rule initialization or verifier capability is granted.
SELECT 'GRANT EXECUTE ON FUNCTION public.shardkeep_clan_charter_raid_chest_resolve(uuid,text) TO shardkeep_api_runtime, shardkeep_worker_runtime'
WHERE to_regprocedure('public.shardkeep_clan_charter_raid_chest_resolve(uuid,text)') IS NOT NULL
  AND (SELECT prosecdef FROM pg_proc WHERE oid=to_regprocedure('public.shardkeep_clan_charter_raid_chest_resolve(uuid,text)'))\gexec
SELECT 'GRANT EXECUTE ON FUNCTION public.shardkeep_clan_charter_raid_chest_assert_posting(uuid,uuid) TO shardkeep_api_runtime, shardkeep_worker_runtime'
WHERE to_regprocedure('public.shardkeep_clan_charter_raid_chest_assert_posting(uuid,uuid)') IS NOT NULL
  AND (SELECT prosecdef FROM pg_proc WHERE oid=to_regprocedure('public.shardkeep_clan_charter_raid_chest_assert_posting(uuid,uuid)'))\gexec
--0256: count-only settlement of immutable accepted sources in the caller transaction.
--0260: prospective locked army-shortage witness only; no historical repair.
SELECT 'GRANT EXECUTE ON FUNCTION public.shardkeep_charter_army_disposition_begin(uuid,text,uuid,jsonb) TO shardkeep_api_runtime, shardkeep_worker_runtime'
WHERE to_regprocedure('public.shardkeep_charter_army_disposition_begin(uuid,text,uuid,jsonb)') IS NOT NULL
  AND (SELECT prosecdef FROM pg_proc WHERE oid=to_regprocedure('public.shardkeep_charter_army_disposition_begin(uuid,text,uuid,jsonb)'))\gexec
SELECT 'GRANT EXECUTE ON FUNCTION public.shardkeep_settle_advanced_returns(uuid,timestamptz) TO shardkeep_api_runtime, shardkeep_worker_runtime'
WHERE to_regprocedure('public.shardkeep_settle_advanced_returns(uuid,timestamptz)') IS NOT NULL
  AND (SELECT prosecdef FROM pg_proc WHERE oid=to_regprocedure('public.shardkeep_settle_advanced_returns(uuid,timestamptz)'))\gexec
SELECT 'GRANT EXECUTE ON FUNCTION public.shardkeep_settle_due_equipment(uuid,timestamptz) TO shardkeep_api_runtime, shardkeep_worker_runtime'
WHERE to_regprocedure('public.shardkeep_settle_due_equipment(uuid,timestamptz)') IS NOT NULL
  AND (SELECT prosecdef FROM pg_proc WHERE oid=to_regprocedure('public.shardkeep_settle_due_equipment(uuid,timestamptz)'))\gexec
SELECT 'GRANT EXECUTE ON FUNCTION public.shardkeep_equipment_idle(uuid) TO shardkeep_api_runtime, shardkeep_worker_runtime'
WHERE to_regprocedure('public.shardkeep_equipment_idle(uuid)') IS NOT NULL
  AND (SELECT prosecdef FROM pg_proc WHERE oid=to_regprocedure('public.shardkeep_equipment_idle(uuid)'))\gexec
SELECT 'GRANT EXECUTE ON FUNCTION public.shardkeep_finish_starter_equipment(uuid) TO shardkeep_api_runtime, shardkeep_worker_runtime'
WHERE to_regprocedure('public.shardkeep_finish_starter_equipment(uuid)') IS NOT NULL
  AND (SELECT prosecdef FROM pg_proc WHERE oid=to_regprocedure('public.shardkeep_finish_starter_equipment(uuid)'))\gexec
SELECT 'GRANT EXECUTE ON FUNCTION public.shardkeep_starter_equipment_evidence(uuid) TO shardkeep_api_runtime, shardkeep_worker_runtime'
WHERE to_regprocedure('public.shardkeep_starter_equipment_evidence(uuid)') IS NOT NULL
  AND (SELECT prosecdef FROM pg_proc WHERE oid=to_regprocedure('public.shardkeep_starter_equipment_evidence(uuid)'))\gexec
GRANT CONNECT ON DATABASE :"DBNAME" TO shardkeep_api_runtime, shardkeep_worker_runtime;
GRANT USAGE ON SCHEMA public TO shardkeep_api_runtime, shardkeep_worker_runtime;
SELECT 'REVOKE ALL PRIVILEGES ON TABLE public.withdrawal_attempts FROM PUBLIC, shardkeep_api_runtime'
WHERE to_regclass('public.withdrawal_attempts') IS NOT NULL\gexec
SELECT 'REVOKE ALL PRIVILEGES ON TABLE public.economy_chain_identity FROM PUBLIC, shardkeep_api_runtime, shardkeep_worker_runtime'
WHERE to_regclass('public.economy_chain_identity') IS NOT NULL\gexec
SELECT 'GRANT SELECT, INSERT ON public.economy_chain_identity TO shardkeep_api_runtime, shardkeep_worker_runtime'
WHERE to_regclass('public.economy_chain_identity') IS NOT NULL\gexec
SELECT 'REVOKE ALL PRIVILEGES ON TABLE public.withdrawal_authorizations FROM PUBLIC, shardkeep_api_runtime'
WHERE to_regclass('public.withdrawal_authorizations') IS NOT NULL\gexec
SELECT 'GRANT INSERT (withdrawal_id, challenge_token, wallet_signature, cluster, keep_mint) ON public.withdrawal_authorizations TO shardkeep_api_runtime'
WHERE to_regclass('public.withdrawal_authorizations') IS NOT NULL\gexec
SELECT 'GRANT SELECT, UPDATE (validated_digest, validated_at) ON public.withdrawal_authorizations TO shardkeep_worker_runtime'
WHERE to_regclass('public.withdrawal_authorizations') IS NOT NULL\gexec
SELECT 'REVOKE ALL PRIVILEGES ON TABLE public.withdrawal_payout_reservations FROM PUBLIC, shardkeep_api_runtime'
WHERE to_regclass('public.withdrawal_payout_reservations') IS NOT NULL\gexec
SELECT 'GRANT SELECT ON public.withdrawal_payout_reservations TO shardkeep_worker_runtime'
WHERE to_regclass('public.withdrawal_payout_reservations') IS NOT NULL\gexec
-- Public release history (M47 §5, migration 0500): the release CLI in the API
-- container appends rows after a verified deploy and the public routes read
-- them. History is never rewritten: no UPDATE/DELETE/TRUNCATE for any runtime.
SELECT 'GRANT SELECT, INSERT ON public.release_history, public.release_fragment_claims TO shardkeep_api_runtime'
WHERE to_regclass('public.release_history') IS NOT NULL AND to_regclass('public.release_fragment_claims') IS NOT NULL\gexec
SELECT 'GRANT SELECT ON public.release_history, public.release_fragment_claims TO shardkeep_worker_runtime'
WHERE to_regclass('public.release_history') IS NOT NULL AND to_regclass('public.release_fragment_claims') IS NOT NULL\gexec
SELECT 'REVOKE ALL ON FUNCTION public.shardkeep_reserve_withdrawal_allowance(uuid,text,bigint,bigint) FROM PUBLIC, shardkeep_api_runtime'
WHERE to_regprocedure('public.shardkeep_reserve_withdrawal_allowance(uuid,text,bigint,bigint)') IS NOT NULL\gexec
SELECT 'REVOKE ALL ON FUNCTION public.shardkeep_finalize_withdrawal_allowance(uuid) FROM PUBLIC, shardkeep_api_runtime'
WHERE to_regprocedure('public.shardkeep_finalize_withdrawal_allowance(uuid)') IS NOT NULL\gexec
SELECT 'REVOKE ALL ON FUNCTION public.shardkeep_release_withdrawal_allowance(uuid) FROM PUBLIC, shardkeep_api_runtime'
WHERE to_regprocedure('public.shardkeep_release_withdrawal_allowance(uuid)') IS NOT NULL\gexec
SELECT 'GRANT EXECUTE ON FUNCTION public.shardkeep_reserve_withdrawal_allowance(uuid,text,bigint,bigint) TO shardkeep_worker_runtime'
WHERE to_regprocedure('public.shardkeep_reserve_withdrawal_allowance(uuid,text,bigint,bigint)') IS NOT NULL\gexec
SELECT 'GRANT EXECUTE ON FUNCTION public.shardkeep_finalize_withdrawal_allowance(uuid) TO shardkeep_worker_runtime'
WHERE to_regprocedure('public.shardkeep_finalize_withdrawal_allowance(uuid)') IS NOT NULL\gexec
SELECT 'GRANT EXECUTE ON FUNCTION public.shardkeep_release_withdrawal_allowance(uuid) TO shardkeep_worker_runtime'
WHERE to_regprocedure('public.shardkeep_release_withdrawal_allowance(uuid)') IS NOT NULL\gexec

CREATE OR REPLACE FUNCTION public.shardkeep_guard_withdrawal_api_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $guard$
DECLARE recovery_refund_link_ok boolean;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'shardkeep_api_runtime', 'member') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'API role cannot delete withdrawals' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- The API may omit created_at but can never choose/backdate it.
    NEW.created_at := pg_catalog.statement_timestamp();
    IF NEW.status::text <> 'unbonding'
       OR NEW.request_ledger_txn_id IS NULL
       OR NEW.tx_signature IS NOT NULL OR NEW.mint IS NOT NULL
       OR NEW.payout_ledger_txn_id IS NOT NULL OR NEW.refund_ledger_txn_id IS NOT NULL
       OR NEW.last_error IS NOT NULL OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'API role may only insert an unsettled withdrawal request' USING ERRCODE = '42501';
    END IF;
    IF NEW.unbonds_at < NEW.created_at - interval '10 seconds' THEN
      RAISE EXCEPTION 'API role cannot backdate withdrawal maturity' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- Economic intent and worker-owned settlement evidence are immutable to API.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.player_wallet IS DISTINCT FROM OLD.player_wallet
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.fee_burned IS DISTINCT FROM OLD.fee_burned
     OR NEW.destination IS DISTINCT FROM OLD.destination
     OR NEW.unbonds_at IS DISTINCT FROM OLD.unbonds_at
     OR NEW.tx_signature IS DISTINCT FROM OLD.tx_signature
     OR NEW.mint IS DISTINCT FROM OLD.mint
     OR NEW.request_ledger_txn_id IS DISTINCT FROM OLD.request_ledger_txn_id
     OR NEW.payout_ledger_txn_id IS DISTINCT FROM OLD.payout_ledger_txn_id
     OR NEW.last_error IS DISTINCT FROM OLD.last_error
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'API role cannot mutate withdrawal intent or worker settlement evidence' USING ERRCODE = '42501';
  END IF;

  -- User-facing API owns only cancellation and a positively-proven refund.
  IF OLD.status::text = 'unbonding' AND NEW.status::text = 'cancelled'
     AND NEW.completed_at IS NOT NULL
     AND NEW.refund_ledger_txn_id IS NOT DISTINCT FROM OLD.refund_ledger_txn_id THEN
    RETURN NEW;
  END IF;
  IF OLD.status::text = 'failed' AND NEW.status::text = 'refunded'
     AND NEW.completed_at IS NOT NULL
     AND NEW.refund_ledger_txn_id IS NOT DISTINCT FROM OLD.refund_ledger_txn_id THEN
    RETURN NEW;
  END IF;
  IF OLD.status::text = 'refunded' AND NEW.status::text = 'refunded'
     AND NEW.completed_at IS NOT DISTINCT FROM OLD.completed_at
     AND OLD.refund_ledger_txn_id IS NULL AND NEW.refund_ledger_txn_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.status::text = 'cancelled' AND NEW.status::text = 'cancelled'
     AND NEW.completed_at IS NOT DISTINCT FROM OLD.completed_at
     AND OLD.refund_ledger_txn_id IS NULL AND NEW.refund_ledger_txn_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.ledger_transactions t
      JOIN public.totp_recoveries r
        ON r.id::text = t.metadata->>'recoveryId'
      WHERE t.id = NEW.refund_ledger_txn_id
        AND t.type = 'withdrawal.cancel'
        AND t.idempotency_key = 'withdrawal:' || OLD.id::text || ':cancel'
        AND t.metadata->>'wallet' = OLD.player_wallet
        AND t.metadata->>'withdrawalId' = OLD.id::text
        AND t.metadata->>'reason' = 'totp_recovery'
        AND r.player_wallet = OLD.player_wallet AND r.status::text = 'holding'
        AND (SELECT pg_catalog.count(*) FROM public.ledger_entries e WHERE e.txn_id = t.id) = 2
        AND (SELECT coalesce(pg_catalog.sum(e.delta), 0)
          FROM public.ledger_entries e JOIN public.accounts a ON a.id = e.account_id
          WHERE e.txn_id = t.id AND a.kind::text = 'withdrawal_escrow'
            AND a.owner_wallet IS NULL AND a.base_id IS NULL) = -OLD.amount
        AND (SELECT coalesce(pg_catalog.sum(e.delta), 0)
          FROM public.ledger_entries e JOIN public.accounts a ON a.id = e.account_id
          WHERE e.txn_id = t.id AND a.kind::text = 'player_keep'
            AND a.owner_wallet = OLD.player_wallet AND a.base_id IS NULL) = OLD.amount
    ) INTO recovery_refund_link_ok;
    IF recovery_refund_link_ok THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'API recovery refund link lacks exact ledger evidence' USING ERRCODE = '42501';
  END IF;

  RAISE EXCEPTION 'API role cannot perform this withdrawal state transition' USING ERRCODE = '42501';
END;
$guard$;
REVOKE ALL ON FUNCTION public.shardkeep_guard_withdrawal_api_write() FROM PUBLIC;
DO $install$
BEGIN
  IF to_regclass('public.withdrawals') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS withdrawal_api_write_guard ON public.withdrawals';
    EXECUTE 'CREATE TRIGGER withdrawal_api_write_guard
      BEFORE INSERT OR UPDATE OR DELETE ON public.withdrawals
      FOR EACH ROW EXECUTE FUNCTION public.shardkeep_guard_withdrawal_api_write()';
  END IF;
END;
$install$;

-- Verify the finite restoration and the unchanged predecessor graph inside
-- this same transaction. A failure rolls back every provisioning change.
DO $crafting_runtime_after$
DECLARE accepted boolean;
BEGIN
  IF to_regprocedure('public.shardkeep_crafting_runtime_sources_valid()') IS NOT NULL THEN
    EXECUTE 'SELECT public.shardkeep_crafting_runtime_sources_valid()
      AND public.shardkeep_bound_cosmetic_return_sources_valid()
      AND public.shardkeep_bound_cosmetic_visual_sources_valid()
      AND public.shardkeep_raid_starter_sources_valid()
      AND public.shardkeep_raid_advanced_sources_valid()
      AND public.shardkeep_service_activity_sources_valid()
      AND public.shardkeep_current_advanced_sources_valid()
      AND public.shardkeep_advanced_identity_sources_valid()' INTO accepted;
    IF accepted IS DISTINCT FROM true
      OR NOT has_function_privilege('shardkeep_api_runtime','public.shardkeep_assert_ordinary_crafting_shards(uuid)','EXECUTE')
      OR NOT has_function_privilege('shardkeep_worker_runtime','public.shardkeep_assert_ordinary_crafting_shards(uuid)','EXECUTE')
    THEN RAISE EXCEPTION 'CRAFTING_RUNTIME_SOURCE'; END IF;
    EXECUTE 'SELECT public.shardkeep_divine_fragment_source()';
  END IF;
END;
$crafting_runtime_after$;

COMMIT;
SQL

printf 'db-roles: isolated API/worker privileges and withdrawal fence verified\n'
