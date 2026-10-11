/** A fresh-database fixture's template clone must be what a full migration replay produces:
 * the same catalog by name (relations, columns, ACLs, function bodies, triggers, policies),
 * the same rows wherever two independent replays agree (seal records pin object OIDs and
 * migration-time clocks, so those never agree byte for byte, even replay to replay), and the
 * same accept/refuse decision from every sealed source. If a migration ever starts reading
 * cluster state the template key does not cover, or the clone path drifts from the replay
 * path, this file fails instead of the suites that rely on the clone silently testing a
 * different database (test/migratedTemplate.ts). */
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { ADMIN_DATABASE_URL, testDbName } from './db-url';
import { FRESH_DB_CASE_MS } from './freshDbCaseBudgets';
import { createMigratedDatabase, releaseMigratedTemplates } from './migratedTemplate';

type Sql = ReturnType<typeof postgres>;
const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
const created: string[] = [];
const disposable = () => { const name = `migrated_template_${randomUUID().replaceAll('-', '')}_test`; created.push(name); return name; };
const urlFor = (name: string) => { const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${name}`; return url.toString(); };
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const name of created.splice(0)) await admin.unsafe(`drop database if exists ${name} with (force)`);
});
afterAll(() => admin.end());

/** Everything a migration can leave behind, by name (OIDs differ between databases). */
async function catalog(sql: Sql): Promise<Record<string, string[]>> {
  const user = `n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp%'`;
  const sets: Record<string, string> = {
    namespaces: `select n.nspname||' '||n.nspowner::regrole::text||' '||coalesce(n.nspacl::text,'') v from pg_namespace n where ${user}`,
    relations: `select n.nspname||'.'||c.relname||' '||c.relkind::text||' '||c.relowner::regrole::text||' '||coalesce(c.relacl::text,'')
      ||' '||coalesce(array_to_string(c.reloptions,','),'')||' '||c.relrowsecurity||' '||c.relforcerowsecurity||' '||c.relpersistence::text v
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where ${user}`,
    columns: `select a.attrelid::regclass::text||' '||a.attnum||' '||a.attname||' '||format_type(a.atttypid,a.atttypmod)||' '||a.attnotnull
      ||' '||a.attisdropped||' '||a.attidentity::text||' '||a.attgenerated::text||' '||coalesce(pg_get_expr(d.adbin,d.adrelid),'')||' '||coalesce(a.attacl::text,'') v
      from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
      left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where ${user} and a.attnum>0`,
    functions: `select p.oid::regprocedure::text||' '||p.prokind::text||' '||p.proowner::regrole::text||' '||p.prosecdef||' '||p.provolatile::text||' '||p.proisstrict
      ||' '||p.proleakproof||' '||p.proparallel::text||' '||coalesce(p.proacl::text,'')||' '||coalesce(array_to_string(p.proconfig,','),'')
      ||' '||md5(coalesce(p.prosrc,''))||' '||case when p.prokind in ('f','p') then md5(pg_get_functiondef(p.oid)) else '' end v
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where ${user}`,
    triggers: `select t.tgrelid::regclass::text||' '||t.tgname||' '||t.tgenabled::text||' '||pg_get_triggerdef(t.oid) v from pg_trigger t
      join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where ${user} and not t.tgisinternal`,
    constraints: `select c.conrelid::regclass::text||' '||c.contypid::regtype::text||' '||c.conname||' '||c.convalidated||' '||c.condeferrable||' '||c.condeferred
      ||' '||pg_get_constraintdef(c.oid) v from pg_constraint c join pg_namespace n on n.oid=c.connamespace where ${user}`,
    indexes: `select pg_get_indexdef(i.indexrelid)||' '||i.indisvalid v from pg_index i join pg_class c on c.oid=i.indexrelid
      join pg_namespace n on n.oid=c.relnamespace where ${user}`,
    views: `select c.oid::regclass::text||' '||md5(pg_get_viewdef(c.oid)) v from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where ${user} and c.relkind in ('v','m')`,
    policies: `select schemaname||'.'||tablename||' '||policyname||' '||permissive||' '||array_to_string(roles,',')||' '||cmd
      ||' '||coalesce(qual,'')||' '||coalesce(with_check,'') v from pg_policies`,
    types: `select t.oid::regtype::text||' '||t.typtype::text||' '||t.typowner::regrole::text||' '||coalesce(t.typacl::text,'')
      ||' '||coalesce((select string_agg(e.enumlabel,',' order by e.enumsortorder) from pg_enum e where e.enumtypid=t.oid),'') v
      from pg_type t join pg_namespace n on n.oid=t.typnamespace where ${user}`,
    sequences: `select schemaname||'.'||sequencename||' '||coalesce(last_value::text,'')||' '||increment_by v from pg_sequences`,
    defaultAcls: `select coalesce(d.defaclrole::regrole::text,'')||' '||d.defaclobjtype::text||' '||coalesce(d.defaclacl::text,'') v from pg_default_acl d`,
    eventTriggers: `select evtname||' '||evtevent||' '||evtenabled::text||' '||evtfoid::regproc::text v from pg_event_trigger`,
    extensions: `select extname||' '||extversion v from pg_extension`,
  };
  const out: Record<string, string[]> = {};
  for (const [key, query] of Object.entries(sets)) {
    out[key] = (await sql.unsafe<{ v: string }[]>(query)).map(row => row.v).sort();
  }
  return out;
}

/** Row count and content digest of every table, by name. */
async function rows(sql: Sql): Promise<Map<string, string>> {
  const tables = await sql.unsafe<{ name: string }[]>(`select c.oid::regclass::text as name from pg_class c
    join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','drizzle') and c.relkind in ('r','p') order by 1`);
  const out = new Map<string, string>();
  for (const { name } of tables) {
    const [row] = await sql.unsafe<{ n: number; h: string }[]>(`select count(*)::int as n,
      md5(coalesce(string_agg(x::text, chr(10) order by x::text), '')) as h from (select to_jsonb(t) as x from ${name} t) s`);
    out.set(name, `${row!.n} ${row!.h}`);
  }
  return out;
}

/** Every zero-argument seal proof's decision: its value, or the error it raises. */
async function sealDecisions(sql: Sql): Promise<Record<string, string>> {
  const proofs = await sql<{ fn: string }[]>`select p.oid::regprocedure::text as fn from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.pronargs=0 and p.prokind='f'
      and p.prorettype<>'trigger'::regtype and p.proname ~ '(_valid|_source|_source_check)$' order by 1`;
  const out: Record<string, string> = {};
  for (const { fn } of proofs) {
    try { out[fn] = `ok ${(await sql.unsafe<{ v: string | null }[]>(`select ${fn}::text as v`))[0]!.v}`; }
    catch (error) { out[fn] = `refused ${(error as { code?: string }).code} ${(error as Error).message}`; }
  }
  return out;
}

const sameSet = (key: string, expected: string[], actual: string[]) => {
  // Report only what differs (each entry leads with the object's name).
  const want = new Set(expected), got = new Set(actual);
  expect({ key, onlyReplay: expected.filter(v => !got.has(v)), onlyClone: actual.filter(v => !want.has(v)) })
    .toEqual({ key, onlyReplay: [], onlyClone: [] });
};

// Two full replays, then three catalog/row dumps and every seal proof three times.
// 2026-10-10, alone on the night Mac (load ~6): 12.5 s per replay, 48.5 s for the case. CI
// runners have measured up to 2.3x slower than the same file elsewhere, so ~3x the case.
const EQUIVALENCE_CASE_MS = 150_000;

describe('fresh-database template clone', { timeout: FRESH_DB_CASE_MS }, () => {
  it('is what a full migration replay produces: same catalog, same rows wherever two replays agree, same seal decisions', async () => {
    const first = disposable(), second = disposable(), cloned = disposable();
    for (const name of [first, second]) {
      await admin.unsafe(`create database ${name}`);
      const conn = createDb(urlFor(name), { max: 1 });
      try { await runMigrations(conn.db); } finally { await conn.sql.end(); }
    }
    await createMigratedDatabase(admin, cloned);
    const b = createDb(urlFor(cloned), { max: 1 });
    try {
      // On a clone the fixture's own replay re-checks the journal and applies nothing.
      await runMigrations(b.db);
      const [journal] = await b.sql<{ count: number }[]>`select count(*)::int as count from drizzle.__drizzle_migrations`;
      expect(journal!.count).toBeGreaterThan(300);
    } finally { await b.sql.end(); }
    const [a1, a2, clone] = [first, second, cloned].map(name => postgres(urlFor(name), { max: 1, onnotice: () => {} }));
    try {
      const [c1, c2, cc] = [await catalog(a1!), await catalog(a2!), await catalog(clone!)];
      for (const key of Object.keys(c1)) { sameSet(key, c1[key]!, c2[key]!); sameSet(key, c1[key]!, cc[key]!); }
      expect(c1.functions!.length).toBeGreaterThan(500);
      // Seal records pin object OIDs and migration-time clocks, so two honest replays already
      // differ in some tables. Wherever the two replays agree, the clone must agree too;
      // where they differ, the clone holds the same number of rows and the seals decide below.
      const [r1, r2, rc] = [await rows(a1!), await rows(a2!), await rows(clone!)];
      expect([...rc.keys()]).toEqual([...r1.keys()]);
      expect(r1.size).toBeGreaterThan(400);
      const variant: string[] = [];
      for (const [table, digest] of r1) {
        if (r2.get(table) === digest) expect(`${table} ${rc.get(table)}`).toBe(`${table} ${digest}`);
        else {
          variant.push(table);
          expect(`${table} ${rc.get(table)!.split(' ')[0]}`).toBe(`${table} ${digest.split(' ')[0]}`);
        }
      }
      expect(variant.length).toBeLessThan(r1.size / 10);
      // Same inputs, same decision: every sealed source accepts or refuses exactly as on a replay.
      const [d1, d2, dc] = [await sealDecisions(a1!), await sealDecisions(a2!), await sealDecisions(clone!)];
      expect(d2).toEqual(d1);
      expect(dc).toEqual(d1);
      expect(Object.keys(d1).length).toBeGreaterThan(30);
      expect(d1['shardkeep_divine_fragment_source()']).toBe('ok ');
    } finally { for (const sql of [a1, a2, clone]) await sql!.end(); }
  }, EQUIVALENCE_CASE_MS);

  it('keys the template to the build journal and to the runtime groups it was migrated under, and refuses sessions on it', async () => {
    const name = disposable();
    await createMigratedDatabase(admin, name);
    const groups = await admin<{ rolname: string; oid: string }[]>`
      select rolname, oid::text as oid from pg_roles where rolname in ('shardkeep_api_runtime','shardkeep_worker_runtime')`;
    const templates = await admin<{ datname: string; datallowconn: boolean; inputs: string }[]>`
      select datname, datallowconn, shobj_description(oid,'pg_database') as inputs from pg_database
      where starts_with(datname, ${testDbName() + '_tpl_'})`;
    const current = templates.filter(t => {
      const inputs = JSON.parse(t.inputs) as { groups: Record<string, string | null> };
      return ['shardkeep_api_runtime', 'shardkeep_worker_runtime'].every(group =>
        inputs.groups[group] === (groups.find(g => g.rolname === group)?.oid ?? null));
    });
    expect(current).toHaveLength(1);
    expect(current[0]!.datallowconn).toBe(false);
    expect(JSON.parse(current[0]!.inputs)).toMatchObject({ journal: expect.stringMatching(/^[0-9a-f]{64}$/), user: new URL(ADMIN_DATABASE_URL).username });
    // The clone itself is an ordinary connectable database.
    const [clone] = await admin<{ datallowconn: boolean }[]>`select datallowconn from pg_database where datname=${name}`;
    expect(clone!.datallowconn).toBe(true);
  });

  it('release drops exactly the templates holding runtime-group GRANTs, so none can block DROP ROLE of a group, and the next fixture rebuilds its own', async () => {
    await createMigratedDatabase(admin, disposable());
    const groups = `('shardkeep_api_runtime','shardkeep_worker_runtime')`;
    const holders = async () => (await admin.unsafe<{ datname: string }[]>(`select distinct d.datname from pg_shdepend s
      join pg_database d on d.oid=s.dbid where s.refclassid='pg_authid'::regclass
        and s.refobjid in (select oid from pg_roles where rolname in ${groups}) and starts_with(d.datname, $1)`,
    [testDbName() + '_tpl_'])).map(row => row.datname);
    // A template migrated while a group exists holds its GRANTs, exactly like a replayed
    // database would; with no group there is nothing to hold.
    const exists = (await admin.unsafe(`select 1 from pg_roles where rolname in ${groups}`)).length > 0;
    expect((await holders()).length > 0).toBe(exists);
    await releaseMigratedTemplates();
    expect(await holders()).toEqual([]);
    // What stays was migrated with no group: it holds nothing and stays valid across drops.
    const left = await admin<{ inputs: string }[]>`select shobj_description(oid,'pg_database') as inputs
      from pg_database where starts_with(datname, ${testDbName() + '_tpl_'})`;
    for (const { inputs } of left) expect(JSON.parse(inputs).groups).toEqual({ shardkeep_api_runtime: null, shardkeep_worker_runtime: null });
    const name = disposable();
    await createMigratedDatabase(admin, name);
    const conn = createDb(urlFor(name), { max: 1 });
    try {
      const [journal] = await conn.sql<{ count: number }[]>`select count(*)::int as count from drizzle.__drizzle_migrations`;
      expect(journal!.count).toBeGreaterThan(300);
    } finally { await conn.sql.end(); }
  });

  it('gives a case that spies runMigrations to a journal prefix the empty database the prefix replays into, then clones again', async () => {
    // K-night-R3a: upgrade cases (vehicle-consumption-fence, the charter suites, the advanced
    // presentation sources) build their fixture database migrated only to a prefix of the
    // chain, by spying the fixture's runMigrations once. A clone already holds every journal
    // row, so that prefix replay refused it ("applied migration history mismatch") and the
    // upgrade those cases exist to test never ran.
    const root = fileURLToPath(new URL('../drizzle', import.meta.url)), folder = await mkdtemp(join(tmpdir(), 'template-prefix-'));
    try {
      const journal = JSON.parse(await readFile(join(root, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
      const prefix = journal.entries.slice(0, 3);
      await mkdir(join(folder, 'meta'));
      for (const entry of prefix) await copyFile(join(root, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
      await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: prefix }));
      const migrate = await import('../src/db/migrate'), real = migrate.runMigrations;
      const spy = vi.spyOn(migrate, 'runMigrations').mockImplementationOnce(db => real(db, { migrationsFolder: folder }));
      const name = disposable();
      try {
        await createMigratedDatabase(admin, name);
        const conn = createDb(urlFor(name), { max: 1 });
        try {
          await runMigrations(conn.db);
          const [applied] = await conn.sql<{ count: number }[]>`select count(*)::int as count from drizzle.__drizzle_migrations`;
          expect(applied!.count).toBe(prefix.length);
        } finally { await conn.sql.end(); }
      } finally { spy.mockRestore(); }
      // Spy restored: the next fresh database is a full clone again, not a slow replay.
      const next = disposable();
      await createMigratedDatabase(admin, next);
      const clone = postgres(urlFor(next), { max: 1, onnotice: () => {} });
      try {
        const [applied] = await clone<{ count: number }[]>`select count(*)::int as count from drizzle.__drizzle_migrations`;
        expect(applied!.count).toBeGreaterThan(300);
      } finally { await clone.end(); }
    } finally { await rm(folder, { recursive: true, force: true }); }
  });

  it('outside Vitest creates a plain empty database for the caller to replay into', async () => {
    vi.stubEnv('VITEST', undefined);
    const name = disposable();
    await createMigratedDatabase(admin, name);
    const conn = postgres(urlFor(name), { max: 1, onnotice: () => {} });
    try {
      expect(await conn`select 1 from pg_namespace where nspname='drizzle'`).toHaveLength(0);
    } finally { await conn.end(); }
  });
});
