import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const PROVISION = path.join(ROOT, 'infra/db/provision-runtime-roles.sh');
const COMPOSE = readFileSync(path.join(ROOT, 'infra/docker-compose.prod.yml'), 'utf8');
const DEPLOY = readFileSync(path.join(ROOT, 'infra/deploy.sh'), 'utf8');

function fakePsql() {
  const root = mkdtempSync(path.join(tmpdir(), 'shardkeep-db-roles-'));
  const psql = path.join(root, 'psql');
  const log = path.join(root, 'sql.log');
  writeFileSync(psql, '#!/bin/sh\ncat > "$FAKE_SQL_LOG"\n', { mode: 0o700 });
  chmodSync(psql, 0o700);
  return { root, log };
}

function run(env: NodeJS.ProcessEnv) {
  return spawnSync('sh', [PROVISION], { cwd: ROOT, env, encoding: 'utf8' });
}

describe('runtime database role isolation', () => {
  it('keeps legacy devnet compatible but fails closed for mainnet', () => {
    const devnet = run({ ...process.env, DB_ROLE_MODE: 'legacy', SOLANA_CLUSTER: 'devnet' });
    expect(devnet.status, devnet.stderr).toBe(0);
    expect(devnet.stdout).toContain('legacy devnet mode');

    const mainnet = run({ ...process.env, DB_ROLE_MODE: 'legacy', SOLANA_CLUSTER: 'mainnet-beta' });
    expect(mainnet.status).not.toBe(0);
    expect(mainnet.stderr).toContain('mainnet requires DB_ROLE_MODE=isolated');
  });

  it('requires distinct, non-owner strong credentials in isolated mode', () => {
    const missing = run({ ...process.env, DB_ROLE_MODE: 'isolated', SOLANA_CLUSTER: 'devnet' });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('POSTGRES_USER is required');

    const same = run({
      ...process.env,
      DB_ROLE_MODE: 'isolated', SOLANA_CLUSTER: 'mainnet-beta',
      POSTGRES_USER: 'owner', POSTGRES_PASSWORD: 'owner-secret',
      API_DB_USER: 'api', API_DB_PASSWORD: 'a'.repeat(64),
      WORKER_DB_USER: 'worker', WORKER_DB_PASSWORD: 'a'.repeat(64),
    });
    expect(same.status).not.toBe(0);
    expect(same.stderr).toContain('API and worker passwords must differ');
  });

  it('removes API access to signed attempts and installs a settlement transition fence', () => {
    const fx = fakePsql();
    const apiPassword = 'a'.repeat(64);
    const workerPassword = 'b'.repeat(64);
    const result = run({
      ...process.env,
      PATH: `${fx.root}:${process.env.PATH ?? ''}`,
      FAKE_SQL_LOG: fx.log,
      DB_ROLE_MODE: 'isolated', SOLANA_CLUSTER: 'mainnet-beta',
      POSTGRES_USER: 'owner', POSTGRES_PASSWORD: 'owner-secret',
      API_DB_USER: 'shardkeep_api', API_DB_PASSWORD: apiPassword,
      WORKER_DB_USER: 'shardkeep_worker', WORKER_DB_PASSWORD: workerPassword,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(apiPassword);
    expect(`${result.stdout}${result.stderr}`).not.toContain(workerPassword);
    const sql = readFileSync(fx.log, 'utf8');
    expect(sql).toContain("'withdrawal_attempts', 'withdrawal_authorizations',");
    expect(sql).toContain("'withdrawal_payout_reservations'");
    expect(sql).toContain('REVOKE ALL PRIVILEGES ON TABLE public.withdrawal_attempts');
    expect(sql).toContain('GRANT INSERT (withdrawal_id, challenge_token, wallet_signature, cluster, keep_mint)');
    expect(sql).toContain('GRANT SELECT, UPDATE (validated_digest, validated_at)');
    expect(sql).toContain('REVOKE ALL PRIVILEGES ON TABLE public.withdrawal_payout_reservations');
    expect(sql).toContain('GRANT SELECT ON public.withdrawal_payout_reservations TO shardkeep_worker_runtime');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.shardkeep_reserve_withdrawal_allowance');
    expect(sql).toContain("to_regprocedure('public.shardkeep_reserve_withdrawal_allowance(uuid,text,bigint,bigint)')");
    expect(sql).toContain('REVOKE ALL PRIVILEGES ON SEQUENCE');
    expect(sql).toContain('REVOKE ALL PRIVILEGES ON FUNCTION %s');
    expect(sql).toContain('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I');
    expect(sql).toContain('REVOKE TEMPORARY ON DATABASE :"DBNAME" FROM PUBLIC');
    expect(sql).toContain('FROM shardkeep_api_runtime, shardkeep_worker_runtime');
    expect(sql).toContain('NEW.created_at := pg_catalog.statement_timestamp()');
    expect(sql).toContain('SET search_path = pg_catalog, public, pg_temp');
    expect(sql).toContain('shardkeep_runtime_login_audit');
    expect(sql).toContain('configured API/worker login owns a database, schema, relation, or function');
    expect(sql).toContain('JOIN pg_roles r ON r.oid = d.datdba');
    expect(sql).toContain('JOIN pg_roles r ON r.oid = n.nspowner');
    expect(sql).toContain('JOIN pg_roles r ON r.oid = c.relowner');
    expect(sql).toContain('JOIN pg_roles r ON r.oid = p.proowner');
    expect(sql).toContain('ALTER ROLE shardkeep_api_runtime NOLOGIN NOSUPERUSER');
    expect(sql).toContain('ALTER ROLE shardkeep_worker_runtime NOLOGIN NOSUPERUSER');
    expect(sql).toContain('ALTER ROLE %I LOGIN NOSUPERUSER');
    expect(sql).toContain("('shardkeep_api_runtime'), ('shardkeep_worker_runtime')");
    expect(sql).toContain("child.rolname IN ('shardkeep_api_runtime', 'shardkeep_worker_runtime')");
    expect(sql).toContain("pg_has_role(SESSION_USER, 'shardkeep_api_runtime', 'member')");
    expect(sql).toContain("OLD.status::text = 'unbonding' AND NEW.status::text = 'cancelled'");
    expect(sql).toContain("OLD.status::text = 'cancelled' AND NEW.status::text = 'cancelled'");
    expect(sql).toContain('API recovery refund link lacks exact ledger evidence');
    expect(sql).toContain("OLD.status::text = 'failed' AND NEW.status::text = 'refunded'");
    expect(sql).toContain('API role cannot mutate withdrawal intent or worker settlement evidence');
  });

  it('keeps the public release history append-only for both runtime roles (M47 §5)', () => {
    // WHY: the changelog is what players were told. The API role appends through
    // the deploy-time CLI and reads for the public routes; the worker only reads;
    // neither may rewrite or delete history, so both are excluded from the blanket
    // DML grant and given explicit narrow grants instead.
    const fx = fakePsql();
    const result = run({
      ...process.env,
      PATH: `${fx.root}:${process.env.PATH ?? ''}`,
      FAKE_SQL_LOG: fx.log,
      DB_ROLE_MODE: 'isolated', SOLANA_CLUSTER: 'mainnet-beta',
      POSTGRES_USER: 'owner', POSTGRES_PASSWORD: 'owner-secret',
      API_DB_USER: 'shardkeep_api', API_DB_PASSWORD: 'c'.repeat(64),
      WORKER_DB_USER: 'shardkeep_worker', WORKER_DB_PASSWORD: 'd'.repeat(64),
    });
    expect(result.status, result.stderr).toBe(0);
    const sql = readFileSync(fx.log, 'utf8');
    const blanket = sql.match(/GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I\.%I TO shardkeep_(api|worker)_runtime'[^\\]*?\)\\gexec/g) ?? [];
    expect(blanket).toHaveLength(2);
    for (const grant of blanket) expect(grant).toContain("'release_history', 'release_fragment_claims'");
    expect(sql).toContain("SELECT 'GRANT SELECT, INSERT ON public.release_history, public.release_fragment_claims TO shardkeep_api_runtime'");
    expect(sql).toContain("SELECT 'GRANT SELECT ON public.release_history, public.release_fragment_claims TO shardkeep_worker_runtime'");
    expect(sql).not.toMatch(/GRANT[^'\n]*(UPDATE|DELETE)[^'\n]*release_(history|fragment_claims)/);
  });


  it('restores only the two runtime roles to the invoker crafting proof helper after normalization', () => {
    // The real restricted-crafting integration case must still execute this
    // helper; omitting its finite restore breaks even recipes without SHARDS.
    const fx = fakePsql();
    const result = run({
      ...process.env,
      PATH: `${fx.root}:${process.env.PATH ?? ''}`,
      FAKE_SQL_LOG: fx.log,
      DB_ROLE_MODE: 'isolated', SOLANA_CLUSTER: 'devnet',
      POSTGRES_USER: 'owner', POSTGRES_PASSWORD: 'owner-secret',
      API_DB_USER: 'shardkeep_api', API_DB_PASSWORD: 'c'.repeat(64),
      WORKER_DB_USER: 'shardkeep_worker', WORKER_DB_PASSWORD: 'd'.repeat(64),
    });
    expect(result.status, result.stderr).toBe(0);
    const sql = readFileSync(fx.log, 'utf8');
    const signature = 'public.shardkeep_assert_ordinary_crafting_shards(uuid)';
    const grant = `SELECT 'GRANT EXECUTE ON FUNCTION ${signature} TO shardkeep_api_runtime, shardkeep_worker_runtime'`;
    const grants = sql.split('\n').filter(line => line.includes('GRANT') && line.includes(signature));
    expect(grants).toEqual([grant]);
    const runtimeRevoke = sql.indexOf('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM shardkeep_api_runtime, shardkeep_worker_runtime');
    expect(runtimeRevoke).toBeGreaterThanOrEqual(0);
    expect(sql.indexOf(grant)).toBeGreaterThan(runtimeRevoke);
    expect(sql).toContain(`WHERE to_regprocedure('${signature}') IS NOT NULL`);
    expect(sql).not.toContain(`ALTER FUNCTION ${signature} SECURITY DEFINER`);
    // This transcript guard is not evidence of sealed-contract compatibility.
    // The migration/provisioning integration gate must independently retain it.
  });

  it('uses restricted runtime URLs while reserving owner credentials for one-shots', () => {
    expect(COMPOSE).toContain('DATABASE_URL: postgres://${API_DB_USER:-${POSTGRES_USER}}:${API_DB_PASSWORD:-${POSTGRES_PASSWORD}}');
    expect(COMPOSE).toContain('DATABASE_URL: postgres://${WORKER_DB_USER:-${POSTGRES_USER}}:${WORKER_DB_PASSWORD:-${POSTGRES_PASSWORD}}');
    expect(COMPOSE).toContain('db-roles: { condition: service_completed_successfully }');
    expect(COMPOSE).toMatch(/migrate:[\s\S]*DATABASE_URL: postgres:\/\/\$\{POSTGRES_USER\}:\$\{POSTGRES_PASSWORD\}/);
    expect(DEPLOY).toContain('--entrypoint sh migrate');
    expect(DEPLOY.match(/provision_runtime_roles/g)?.length).toBeGreaterThanOrEqual(3);
    expect(DEPLOY).not.toContain('--entrypoint sh api \\\n  -c \'cd /app/apps/api && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm db:migrate\'');
  });
});
