/** Fresh-database fixtures clone one migrated TEMPLATE database instead of replaying the
 * whole migration chain for every case.
 *
 * 2026-10-10 (release/r3-t-fresh-db-template): CI run 38069074990 had 72 red API files;
 * about 393 of its 415 failed tests were 30 s timeouts, almost all in fixtures that
 * CREATE DATABASE and then replay all 302 migrations before the case body runs. Locally
 * (night Mac) that replay alone takes 12.5 s per case; CREATE DATABASE ... TEMPLATE of the
 * migrated 36 MB database takes 0.19 s. A template clone is a block-for-block copy of the
 * template's files, so every table, seal row, function body, trigger, ACL and the
 * drizzle journal are exactly what the replay produced. The fixture keeps its own
 * runMigrations call: on a clone it re-checks every applied journal row against this
 * build's migration hashes (about 0.6 s) and applies nothing.
 *
 * Exactness. The migration chain reads cluster state in exactly one place: whether the
 * shared runtime groups shardkeep_api_runtime / shardkeep_worker_runtime exist (the
 * conditional GRANTs in 0136, 0172-0190, 0255-0260, 0297, ...), and their OIDs are what
 * those GRANTs store. So a template is keyed by this build's migration journal, the
 * migrating user, and those two roles' OIDs (or absence). A case only ever clones the
 * template that was migrated under the cluster state it would have migrated under itself;
 * on any other state a matching template is built first (one replay per state per run).
 *
 * Where the replay is paid. The global setup copies the shared test database right after
 * its own replay (0.2 s), so a run starts with the template for its initial state. A
 * per-file hook (migrated-template-setup.ts, hook budget 60 s) builds the template for a
 * state an earlier file changed, so that replay never lands inside a case's 30 s budget.
 * Only a state change inside a file (a case creates the groups, a later case of the same
 * file asks for a fresh database) still pays one replay inside that case, as every case
 * did before.
 *
 * A template migrated while the groups exist holds GRANTs to them, so DROP ROLE of a group
 * fails while it exists, exactly as it would for any other database holding them. A test
 * that drops the shared groups therefore calls releaseMigratedTemplates() first, which
 * drops exactly the templates holding such GRANTs. The global setup drops all of this
 * run's templates before the first file and after the last one.
 *
 * Outside Vitest (the native fixture servers import some of these fixtures) nothing
 * would drop a template, so there a fixture creates a plain database and replays.
 *
 * Journal prefixes (K-night-R3a, CI run of 83d2f27dc). Some cases build a database migrated
 * only to a prefix of the chain by spying runMigrations once with a truncated
 * migrationsFolder before the fixture's own replay. A clone already holds every journal
 * row, so that prefix replay refuses it ("applied migration history mismatch"). While
 * runMigrations is a spy or mock, the fixture therefore gets the plain empty database it
 * replayed into before templates existed, and that prefix is exactly what the case tests. */
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { ADMIN_DATABASE_URL, testDbName } from './db-url';

// The per-file hook imports this module from vitest setupFiles, and a module a setup file
// imports is cached before the test file's vi.mock calls run. So nothing here may import
// a module a test mocks (src/db/client and src/db/migrate are mocked by some files, and
// node:crypto by one): the replay's modules load only when a template is built, and
// hashing uses Web Crypto.

type Sql = ReturnType<typeof postgres>;

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));
const RUNTIME_GROUPS = ['shardkeep_api_runtime', 'shardkeep_worker_runtime'] as const;

async function sha256(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

let journalDigest: Promise<string> | undefined;
/** Identity of this build's migration chain: every migration's timestamp and SQL hash. */
function migrationJournalDigest(): Promise<string> {
  journalDigest ??= sha256(JSON.stringify(
    readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER }).map(m => [m.folderMillis, m.hash])));
  return journalDigest;
}

function templatePrefix(): string {
  return `${testDbName()}_tpl_`;
}

function adminSession(): Sql {
  return postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
}

/** Every cluster input the migration chain reads, plus this build's chain. */
async function migrationInputs(admin: Sql): Promise<string> {
  const [who] = await admin<{ user: string }[]>`select current_user as user`;
  const roles = await admin<{ rolname: string; oid: string }[]>`
    select rolname, oid::text as oid from pg_catalog.pg_roles where rolname in ${admin([...RUNTIME_GROUPS])}`;
  const groups = Object.fromEntries(RUNTIME_GROUPS.map(name => [name, roles.find(r => r.rolname === name)?.oid ?? null]));
  return JSON.stringify({ journal: await migrationJournalDigest(), user: who!.user, groups });
}

async function currentTemplate(admin: Sql): Promise<{ inputs: string; name: string }> {
  const inputs = await migrationInputs(admin);
  return { inputs, name: templatePrefix() + (await sha256(inputs)).slice(0, 16) };
}

async function isComplete(admin: Sql, name: string, inputs: string): Promise<boolean> {
  return (await admin<{ inputs: string | null }[]>`
    select pg_catalog.shobj_description(oid, 'pg_database') as inputs
    from pg_catalog.pg_database where datname = ${name}`)[0]?.inputs === inputs;
}

/** Name of a complete template migrated under exactly these inputs; built if missing, by
 * replaying the chain or, given `source`, by copying a database that was just replayed
 * under these same inputs and has no session open. */
async function templateFor(admin: Sql, source?: string): Promise<string | undefined> {
  const { inputs, name } = await currentTemplate(admin);
  const complete = () => isComplete(admin, name, inputs);
  if (await complete()) return name;
  // Session lock on this one admin connection: concurrent builders of the same template wait.
  await admin`select pg_advisory_lock(hashtextextended(${name}, 0))`;
  try {
    if (await complete()) return name;
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    if (source) {
      await admin.unsafe(`create database ${name} template ${source}`);
    } else {
      await admin.unsafe(`create database ${name}`);
      const [{ createDb }, { runMigrations }] = await Promise.all([import('../src/db/client'), import('../src/db/migrate')]);
      const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${name}`;
      const conn = createDb(url.toString(), { max: 1 });
      try { await runMigrations(conn.db); } finally { await conn.sql.end(); }
    }
    // Another lane on a shared local cluster may have created or dropped a runtime group
    // while this replay ran; then the template matches no single state. Discard it.
    if (await migrationInputs(admin) !== inputs) {
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      return undefined;
    }
    // Nothing may connect to a template: a session on it would block every clone.
    await admin.unsafe(`alter database ${name} allow_connections false`);
    // Written last: only a fully migrated template carries its inputs.
    await admin.unsafe(`comment on database ${name} is '${inputs.replaceAll("'", "''")}'`);
    return name;
  } finally {
    await admin`select pg_advisory_unlock(hashtextextended(${name}, 0))`;
  }
}

/** True when the template for the current cluster state is already complete. */
export async function migratedTemplateReady(): Promise<boolean> {
  const session = adminSession();
  try { const { inputs, name } = await currentTemplate(session); return await isComplete(session, name, inputs); }
  finally { await session.end(); }
}

/** Make sure the template for the current cluster state exists (see the header). Global
 * setup passes the shared test database it has just replayed and closed. */
export async function prepareMigratedTemplate(source?: string): Promise<void> {
  if (!process.env.VITEST) return;
  const session = adminSession();
  try { await templateFor(session, source); } finally { await session.end(); }
}

/** True when the runMigrations the caller is about to run is this build's real replay, not
 * a spy or mock (a journal prefix; see the header). Imported at call time, so it sees the
 * test file's vi.spyOn / vi.mock. */
async function callerReplaysFullChain(): Promise<boolean> {
  const [{ vi }, { runMigrations }] = await Promise.all([import('vitest'), import('../src/db/migrate')]);
  return !vi.isMockFunction(runMigrations);
}

/** CREATE DATABASE `name`, cloned from the migrated template for the current cluster state.
 * The caller still runs runMigrations on it (a verified no-op on a clone; the full replay
 * when no template is used). */
export async function createMigratedDatabase(admin: Sql, name: string): Promise<void> {
  if (!/^[a-z0-9_]{1,63}$/.test(name)) throw Error('fixture database name must be a plain identifier');
  let template: string | undefined;
  if (process.env.VITEST && await callerReplaysFullChain()) {
    const session = adminSession();
    try { template = await templateFor(session); } finally { await session.end(); }
  }
  await admin.unsafe(template ? `create database ${name} template ${template}` : `create database ${name}`);
}

/** Drop this run's templates that hold GRANTs to a shared runtime group. Call before
 * DROP ROLE of such a group; the next fresh-database fixture rebuilds what it needs. A
 * template migrated with no group holds none and stays. */
export async function releaseMigratedTemplates(): Promise<void> {
  await dropTemplates(`and exists (select 1 from pg_catalog.pg_shdepend s where s.dbid = d.oid
    and s.refclassid = 'pg_catalog.pg_authid'::regclass and s.refobjid in (select oid from pg_catalog.pg_roles
      where rolname in ('shardkeep_api_runtime', 'shardkeep_worker_runtime')))`);
}

/** Drop every template of this run (global setup, before the first and after the last file). */
export async function dropMigratedTemplates(): Promise<void> {
  await dropTemplates('');
}

async function dropTemplates(condition: string): Promise<void> {
  const admin = adminSession();
  try {
    const rows = await admin.unsafe<{ datname: string }[]>(`select d.datname from pg_catalog.pg_database d
      where starts_with(d.datname, $1) ${condition}`, [templatePrefix()]);
    for (const { datname } of rows) await admin.unsafe(`drop database if exists ${datname} with (force)`);
  } finally {
    await admin.end();
  }
}
