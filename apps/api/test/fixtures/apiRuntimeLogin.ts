/** A fresh non-owner API LOGIN provisioned by the actual
 * infra/db/provision-runtime-roles.sh, exactly as production runs it, for the
 * gameplay tests that serve an ordinary route through a non-owner connection.
 *
 * Why (2026-10-10, CI cluster E): those tests hand-granted "every public table
 * except vehicle_*" directly to their LOGIN. The private-source seals
 * (0279-0298) only tolerate privileges held by the two runtime GROUPS: a direct
 * grant on a private bound_cosmetic_* / ordinary_equipment_* table, or on a
 * fingerprinted crafting table, reads as tampering and the guarded calls fail
 * closed (500 / ADVANCED_COLLECTION_HELD); and the ordinary base read now needs
 * EXECUTE on SECURITY DEFINER functions such as shardkeep_settle_due_equipment
 * that only the provisioner grants (to the API group). The provisioner is the one
 * source of the API capability, so the fixture uses it rather than a copy.
 *
 * The provisioner rewrites cluster-global group membership, so this takes the
 * shared runtime-role guard (cluster lock + idle check) first and always drops
 * both LOGINs, with their membership edges, in close(). */
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { ADMIN_DATABASE_URL } from '../db-url';
import { assertRuntimeRoleProvisioningSafe } from './runtimeRoleProvisioningGuard';

const PROVISIONER = fileURLToPath(new URL('../../../../infra/db/provision-runtime-roles.sh', import.meta.url));

/** `owner` is the schema owner's connection to the disposable fixture database. */
export async function provisionApiRuntimeLogin(owner: ReturnType<typeof postgres>, prefix: string) {
  const [database] = await owner<{ name: string }[]>`select current_database() name`;
  const suffix = randomBytes(8).toString('hex'), login = `${prefix}_${suffix}`, worker = `${prefix}_worker_${suffix}`;
  const password = randomBytes(32).toString('hex');
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  const created = new Map<string, number>();
  const close = async () => {
    const failures: unknown[] = [];
    for (const [name, oid] of created) {
      try {
        const [current] = await admin<{ oid: number }[]>`select oid::int from pg_roles where rolname=${name}`;
        if (!current) continue;
        if (Number(current.oid) !== oid) throw Error('Refusing cleanup of a replaced fixture role: ' + name);
        // Test-local grants (if any) live in the fixture database; the role itself is cluster-wide.
        await owner.unsafe(`drop owned by ${name}`); await admin.unsafe(`drop role ${name}`);
      } catch (error) { failures.push(error); }
    }
    await admin.end();
    if (failures.length) throw new AggregateError(failures, 'Runtime LOGIN fixture cleanup failed');
  };
  try {
    await assertRuntimeRoleProvisioningSafe(admin, login, worker);
    const url = new URL(ADMIN_DATABASE_URL); url.pathname = '/' + database!.name;
    try {
      execFileSync('sh', [PROVISIONER], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024, env: { PATH: process.env.PATH,
        PGHOST: url.hostname, PGPORT: url.port, PGDATABASE: database!.name,
        PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
        POSTGRES_USER: decodeURIComponent(url.username), POSTGRES_PASSWORD: decodeURIComponent(url.password) || 'owned-loopback-trust-fixture',
        DB_ROLE_MODE: 'isolated', SOLANA_CLUSTER: 'devnet', API_DB_USER: login, API_DB_PASSWORD: password,
        WORKER_DB_USER: worker, WORKER_DB_PASSWORD: randomBytes(32).toString('hex') } });
    } finally {
      // Both names were absent at the guard; whatever exists now is this fixture's.
      for (const row of await admin<{ rolname: string; oid: number }[]>`select rolname,oid::int from pg_roles where rolname in (${login},${worker})`) created.set(row.rolname, Number(row.oid));
    }
    url.username = login; url.password = password;
    return { login, url: url.toString(), close };
  } catch (error) {
    await close();
    throw error;
  }
}
