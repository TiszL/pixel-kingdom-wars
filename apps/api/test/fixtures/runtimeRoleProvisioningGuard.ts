/** Refusal boundary for root-serialized local role fixtures. The unchanged
 * provisioner alters shared cluster roles (it REVOKEs every other member of the
 * two groups), so a disposable database alone is not isolation.
 *
 * 2026-10-10 (CI cluster E):
 * - An ABSENT group role is idle: the provisioner creates it NOLOGIN and
 *   standard. Requiring both groups to pre-exist refused every guarded fixture on
 *   a fresh CI Postgres (shard 13: no earlier provisioner had run) and after
 *   mining-runtime-provisioning dropped the groups (shard 15).
 * - The check first takes a cluster-wide advisory lock on the caller's admin
 *   session (advisory locks are per-database, so it is keyed in the shared admin
 *   database), held until that session ends, so guarded fixtures in concurrent
 *   local lanes never interleave. A live edge from an unguarded provisioner is
 *   waited out for a bounded time, then refused: it is never revoked. */
import type postgres from 'postgres';
import { ADMIN_DATABASE_URL } from '../db-url';

const LOCK_KEY = 'shardkeep.runtime-role-fixture';
// Bounded so a caller inside a default 30 s test still fails by refusal, not timeout.
const WAIT_MS = 20_000;

export async function assertRuntimeRoleProvisioningSafe(
  sql: ReturnType<typeof postgres>, apiLogin: string, workerLogin: string,
): Promise<void> {
  const groups = ['shardkeep_api_runtime', 'shardkeep_worker_runtime'];
  if (apiLogin === workerLogin || [apiLogin, workerLogin].some(name => !/^[A-Za-z0-9_]{1,48}$/.test(name) || groups.includes(name))) {
    throw Error('Expected two distinct fresh fixture LOGIN names');
  }
  // Advisory locks are scoped to one database: only the shared admin database
  // makes this lock exclude fixtures whose disposable databases differ.
  const [where] = await sql<{ name: string }[]>`select current_database() name`;
  if (where?.name !== new URL(ADMIN_DATABASE_URL).pathname.slice(1)) throw Error('Runtime-role fixture lock must be taken in the admin database');
  // performance.now(): callers may fake Date (vi.useFakeTimers({toFake:['Date']})).
  const deadline = performance.now() + WAIT_MS, pause = () => new Promise(resolve => setTimeout(resolve, 500));
  for (;;) {
    const [held] = await sql<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtext(${LOCK_KEY})) locked`;
    if (held?.locked) break;
    if (performance.now() > deadline) throw Error('Another runtime-role fixture holds the cluster provisioning lock; refusing provisioning');
    await pause();
  }
  for (;;) {
    const roles = await sql<{ rolname: string; unsafe: boolean }[]>`select rolname,
      (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls) unsafe
      from pg_roles where rolname in ('shardkeep_api_runtime','shardkeep_worker_runtime')`;
    const edges = await sql`select 1 from pg_auth_members m
      join pg_roles parent on parent.oid=m.roleid join pg_roles child on child.oid=m.member
      where parent.rolname in ('shardkeep_api_runtime','shardkeep_worker_runtime')
         or child.rolname in ('shardkeep_api_runtime','shardkeep_worker_runtime') limit 1`;
    const names = await sql`select 1 from pg_roles where rolname in (${apiLogin},${workerLogin}) limit 1`;
    if (!roles.some(role => role.unsafe) && !edges.length && !names.length) return;
    if (roles.some(role => role.unsafe) || names.length || performance.now() > deadline) {
      throw Error('Shared runtime roles are not idle, standard, and unowned by other fixtures; refusing provisioning');
    }
    await pause();
  }
}
