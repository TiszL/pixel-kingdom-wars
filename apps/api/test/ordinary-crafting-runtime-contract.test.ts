/** Production-role regression for the additive crafting EXECUTE successor.
 * The test owns its database and uses the real provisioner. No fixture grant
 * substitutes for the production restoration. the content pipeline must supply the admitted
 * disposable database endpoint; this suite has not been executed by its author.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterEach, expect, it, vi } from 'vitest';
import { BUILD_COSTS, BuildingType, PHASE_E_ORDINARY_CRAFTING } from '@shardkeep/shared';
import { ordinaryCraftingRecipe } from '@shardkeep/shared/phaseEOrdinaryCrafting';
import { createDb, type DbTx } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { bases, baseSlots, buildings, builderJobs, resourceStocks } from '../src/db/schema';
import { bootstrapSystemAccounts } from '../src/ledger';
import { assertFreshLockedBaseAuthority } from '../src/game/baseOwnership';
import { startOrdinaryCrafting, settleDueOrdinaryCrafting } from '../src/game/ordinaryCrafting';
import { createTestPlayer } from './helpers';
import { ADMIN_DATABASE_URL } from './db-url';

const migrations = fileURLToPath(new URL('../drizzle/', import.meta.url));
const provisioner = fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh', import.meta.url));
const helper = 'public.shardkeep_assert_ordinary_crafting_shards(uuid)';
const contractTable = 'public.divine_fragment_crafting_runtime_contract';
const predecessorEnd = '0297_phase_e_chain_identity';
const rollback = new Error('crafting contract mutation rolled back');
afterEach(() => vi.unstubAllEnvs());

// Until the content pipeline allocates the ordinal, the reviewed bytes live outside the
// migration journal. After promotion, resolve the allocated file by suffix.
function successorSql() {
  const allocated = readdirSync(migrations).filter(name => /^\d+_ordinary_crafting_runtime\.sql$/.test(name));
  if (allocated.length > 1) throw Error('Ambiguous crafting runtime successor');
  return readFileSync(path.join(migrations, allocated[0] ?? 'pending/ordinary_crafting_runtime.sql'), 'utf8');
}
function predecessorFolder() {
  const journal = JSON.parse(readFileSync(path.join(migrations, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const end = journal.entries.findIndex(entry => entry.tag === predecessorEnd);
  if (end < 0) throw Error('Missing pinned crafting predecessor');
  const folder = mkdtempSync(path.join(tmpdir(), 'crafting-runtime-predecessor-'));
  try {
    mkdirSync(path.join(folder, 'meta'));
    journal.entries = journal.entries.slice(0, end + 1);
    writeFileSync(path.join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries) copyFileSync(path.join(migrations, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
    return folder;
  } catch (error) { rmSync(folder, { recursive: true, force: true }); throw error; }
}
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, migrate = true) {
  const f = await setup();
  try { if (migrate) await f.migrate(); await run(f); } finally { await f.close(); }
}
async function setup() {
  for (const flag of ['MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'ORDINARY_CRAFTING_ENABLED']) vi.stubEnv(flag, 'true');
  const url = new URL(ADMIN_DATABASE_URL), suffix = randomUUID().replaceAll('-', '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Crafting fixture requires local owned database');
  const name = `craft_runtime_${suffix}_test`, apiRole = `craft_api_${suffix}`, workerRole = `craft_worker_${suffix}`;
  url.pathname = `/${name}`;
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} }), owner = createDb(url.toString(), { max: 2 });
  const apiPassword = randomBytes(32).toString('hex'), workerPassword = randomBytes(32).toString('hex');
  const roleUrl = (role: string, password: string) => { const u = new URL(url); u.username = role; u.password = password; return u.toString(); };
  const api = createDb(roleUrl(apiRole, apiPassword), { max: 1 }), worker = createDb(roleUrl(workerRole, workerPassword), { max: 1 });
  let created = false;
  const close = async () => {
    await Promise.all([api.sql.end(), worker.sql.end(), owner.sql.end()]);
    try {
      if (created) await admin.unsafe(`drop database ${name} with (force)`);
      // Only fixture-created login identities are removed. Shared group roles remain.
      for (const role of [apiRole, workerRole]) await admin.unsafe(`drop role if exists ${role}`);
    } finally { await admin.end(); }
  };
  try {
    await admin.unsafe(`create database ${name}`); created = true;
    const folder = predecessorFolder();
    try { await runMigrations(owner.db, { migrationsFolder: folder }); }
    finally { rmSync(folder, { recursive: true, force: true }); }
    await bootstrapSystemAccounts(owner.db);
    const [clock] = await owner.sql`select clock_timestamp() now`;
    const at = new Date(clock!.now);
    const provision = () => spawnSync('sh', [provisioner], { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH, PGHOST: url.hostname, PGPORT: url.port, PGDATABASE: name,
        PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
        POSTGRES_USER: decodeURIComponent(url.username), POSTGRES_PASSWORD: decodeURIComponent(url.password),
        DB_ROLE_MODE: 'isolated', SOLANA_CLUSTER: 'devnet', API_DB_USER: apiRole, API_DB_PASSWORD: apiPassword,
        WORKER_DB_USER: workerRole, WORKER_DB_PASSWORD: workerPassword } });
    const migrate = () => owner.sql.begin(async tx => {
      for (const part of successorSql().split('--> statement-breakpoint')) if (part.trim()) await tx.unsafe(part);
    });
    async function base() {
      const { wallet } = await createTestPlayer(owner.db);
      const [base] = await owner.db.insert(bases).values({ ownerWallet: wallet, status: 'active' }).returning();
      const baseId = base!.id;
      await owner.db.insert(baseSlots).values({ wallet, slot: 1, baseId });
      const [workshop] = await owner.db.insert(buildings).values({ baseId, playerWallet: wallet, type: BuildingType.Workshop, tx: 9, ty: 2 }).returning();
      const completedAt = new Date(+at - 1_000);
      await owner.db.insert(builderJobs).values({ baseId, playerWallet: wallet, buildingId: workshop!.id, kind: 'build',
        startedAt: new Date(+completedAt - BUILD_COSTS[BuildingType.Workshop].buildSec * 1_000), finishesAt: completedAt, completedAt });
      const recipe = ordinaryCraftingRecipe('refine_prismstone_lens', PHASE_E_ORDINARY_CRAFTING.v1.recipeVersion, 1);
      for (const input of recipe.inputs) {
        if (input.kind !== 'raw') throw Error('Restricted crafting regression expects raw recipe inputs');
        await owner.db.insert(resourceStocks).values({ baseId, resourceId: input.itemId, available: BigInt(input.quantity) });
      }
      return { wallet, baseId, recipe, command: { id: randomUUID(), baseId, recipeId: recipe.recipeId, recipeVersion: recipe.recipeVersion, quantity: recipe.quantity },
        authority: { baseId, assertAuthority: async (tx: DbTx, w: string, id: string) => { await assertFreshLockedBaseAuthority(tx, w, id); } } };
    }
    return { owner, api, worker, apiRole, workerRole, at, base, migrate, provision, close };
  } catch (error) { await close(); throw error; }
}
type Fixture = Awaited<ReturnType<typeof setup>>;
type OwnerSql = Fixture['owner']['sql'];
type Tx = postgres.TransactionSql;
async function sourceGraph(sql: OwnerSql | Tx) {
  const [row] = await sql`select
    shardkeep_bound_cosmetic_wake_sources_valid() wake,
    shardkeep_bound_cosmetic_return_sources_valid() returns,
    shardkeep_bound_cosmetic_visual_sources_valid() visual,
    shardkeep_raid_starter_sources_valid() starter,
    shardkeep_raid_advanced_sources_valid() advanced,
    shardkeep_service_activity_sources_valid() service,
    shardkeep_current_advanced_sources_valid() current_advanced,
    shardkeep_advanced_identity_sources_valid() identity`;
  expect(Object.values(row!)).toEqual(Array(8).fill(true));
  await sql`select shardkeep_divine_fragment_source()`;
}
async function originals(sql: OwnerSql) {
  // Every existing record/source hash remains byte-for-byte unchanged; capture
  // all existing seal rows rather than substituting a newly accepted baseline.
  const relations = await sql`select c.relname from pg_class c join pg_attribute a on a.attrelid=c.oid
    where c.relnamespace='public'::regnamespace and c.relkind='r'
    and a.attname in ('record','source_sha256') and a.attnum>0 and not a.attisdropped
    and (right(c.relname,9)='_contract' or right(c.relname,5)='_seal')
    and c.relname<>'divine_fragment_crafting_runtime_contract' order by c.relname`;
  const rows: Record<string, unknown> = {};
  for (const relation of relations) rows[relation.relname] = await sql.unsafe(`select row_to_json(t)::text row from public.${relation.relname} t order by row_to_json(t)::text`);
  return rows;
}
function provision(f: Fixture) { const result = f.provision(); expect(result.status, result.stderr).toBe(0); }

it('preserves owner-only helper rights before the successor and restores runtime rights only after migration', () => fixture(async f => {
  const old = await originals(f.owner.sql), [graph] = await f.owner.sql`select shardkeep_divine_fragment_contract() value`;
  await sourceGraph(f.owner.sql);
  provision(f);
  expect(await f.owner.sql`select a.grantee from pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where p.oid=${helper}::regprocedure and a.grantee<>p.proowner`).toHaveLength(0);
  for (const connection of [f.api, f.worker]) {
    expect((await connection.sql`select has_function_privilege(current_user,${helper},'EXECUTE') allowed`)[0]!.allowed).toBe(false);
  }
  expect(await originals(f.owner.sql)).toEqual(old);
  expect((await f.owner.sql`select shardkeep_divine_fragment_contract() value`)[0]).toEqual(graph);
  await sourceGraph(f.owner.sql);
  await expect(f.owner.sql.begin(async tx => {
    await tx.unsafe(`grant execute on function ${helper} to public`);
    for (const part of successorSql().split('--> statement-breakpoint')) if (part.trim()) await tx.unsafe(part);
  })).rejects.toThrow('DIVINE_FRAGMENT_SOURCE');
  expect((await f.owner.sql`select to_regclass(${contractTable}) name`)[0]!.name).toBeNull();
  expect(await originals(f.owner.sql)).toEqual(old);
  await f.migrate(); provision(f);
  for (const connection of [f.api, f.worker]) {
    expect((await connection.sql`select has_function_privilege(current_user,${helper},'EXECUTE') allowed`)[0]!.allowed).toBe(true);
  }
  expect(await originals(f.owner.sql)).toEqual(old);
  expect((await f.owner.sql`select shardkeep_divine_fragment_contract() value`)[0]).toEqual(graph);
  await sourceGraph(f.owner.sql);
  provision(f);
  expect(await originals(f.owner.sql)).toEqual(old);
  await sourceGraph(f.owner.sql);
  await f.owner.sql.unsafe(`grant execute on function ${helper} to public`);
  try {
    const invalid = f.provision();
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain('CRAFTING_RUNTIME_SOURCE');
  } finally { await f.owner.sql.unsafe(`revoke execute on function ${helper} from public`); }
  expect(await originals(f.owner.sql)).toEqual(old);
  await sourceGraph(f.owner.sql);
  await expect(f.migrate()).rejects.toThrow('CRAFTING_RUNTIME_PREDECESSOR_ACL');
  expect(await originals(f.owner.sql)).toEqual(old);
  await sourceGraph(f.owner.sql);
}, false), 120_000);

it('restores actual restricted API starts and worker completion after both helper permissions are revoked', () => fixture(async f => {
  provision(f);
  const a = await f.base();
  const original = await f.owner.sql`select pg_get_functiondef(${helper}::regprocedure) definition,prosecdef from pg_proc where oid=${helper}::regprocedure`;
  expect(original[0]!.prosecdef).toBe(false);
  await f.owner.sql.unsafe(`revoke execute on function ${helper} from shardkeep_api_runtime,shardkeep_worker_runtime`);
  await sourceGraph(f.owner.sql);
  await expect(startOrdinaryCrafting(f.api.db, a.wallet, a.command, a.authority, { clock: () => f.at })).rejects.toMatchObject({ code: '42501' });
  expect(await f.owner.sql`select id from ordinary_crafting_jobs where id=${a.command.id}`).toHaveLength(0);
  provision(f);
  for (const connection of [f.api, f.worker]) {
    expect((await connection.sql`select has_function_privilege(current_user,${helper},'EXECUTE') allowed`)[0]!.allowed).toBe(true);
  }
  const accepted = await startOrdinaryCrafting(f.api.db, a.wallet, a.command, a.authority, { clock: () => f.at });
  expect(accepted.job.baseId).toBe(a.baseId);
  const completed = await f.worker.db.transaction(tx => settleDueOrdinaryCrafting(tx, a.baseId, accepted.job.readyAt));
  expect(completed).toHaveLength(1);
  expect(completed[0]!.completion!.custodyWallet).toBe(a.wallet);
  expect(await f.owner.sql`select available,pending_output from crafting_stocks where base_id=${a.baseId} and item_id=${a.recipe.output.itemId}`)
    .toEqual([{ available: String(a.recipe.output.quantity), pending_output: '0' }]);
  expect(await f.worker.db.transaction(tx => settleDueOrdinaryCrafting(tx, a.baseId, accepted.job.readyAt))).toHaveLength(0);
  expect(await f.owner.sql`select pg_get_functiondef(${helper}::regprocedure) definition,prosecdef from pg_proc where oid=${helper}::regprocedure`).toEqual(original);
  await sourceGraph(f.owner.sql);
}), 120_000);

it('keeps PUBLIC, trigger functions and the successor record private with exact finite EXECUTE grants', () => fixture(async f => {
  provision(f);
  const acl = await f.owner.sql`select r.rolname,a.privilege_type,a.is_grantable,a.grantor=p.proowner owner_grant
    from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    left join pg_roles r on r.oid=a.grantee where p.oid=${helper}::regprocedure and a.grantee<>p.proowner order by r.rolname`;
  expect(acl).toEqual(['shardkeep_api_runtime','shardkeep_worker_runtime'].map(rolname => ({ rolname, privilege_type: 'EXECUTE', is_grantable: false, owner_grant: true })));
  for (const connection of [f.api, f.worker]) {
    await expect(connection.sql.unsafe(`select * from ${contractTable}`)).rejects.toMatchObject({ code: '42501' });
    for (const signature of ['shardkeep_ordinary_crafting_proof()', 'shardkeep_ordinary_crafting_shards_complete()', 'shardkeep_crafting_runtime_sources_valid()']) {
      expect((await connection.sql`select has_function_privilege(current_user,${'public.' + signature},'EXECUTE') allowed`)[0]!.allowed).toBe(false);
    }
  }
  const outsider = 'craft_out_' + randomUUID().replaceAll('-', '');
  await f.owner.sql.unsafe(`create role ${outsider}`);
  try { expect((await f.owner.sql`select has_function_privilege(${outsider},${helper},'EXECUTE') allowed`)[0]!.allowed).toBe(false); }
  finally { await f.owner.sql.unsafe(`drop role ${outsider}`); }
}), 120_000);

it('rejects broadened grants and source or seal shape drift without normalizing unrelated changes', () => fixture(async f => {
  provision(f);
  const old = await originals(f.owner.sql);
  const attacks = [
    `grant execute on function ${helper} to public`,
    `grant execute on function ${helper} to shardkeep_api_runtime with grant option`,
    `grant execute on function ${helper} to ${f.apiRole}`,
    `alter function ${helper} security definer`,
    `alter function ${helper} set search_path=public,pg_catalog`,
    `create or replace function public.shardkeep_assert_ordinary_crafting_shards(target uuid) returns void language plpgsql set search_path=pg_catalog,public,pg_temp as 'begin return; end'`,
    `alter function public.shardkeep_crafting_runtime_acl_valid() volatile`,
    `alter function public.shardkeep_divine_fragment_contract() set search_path=public,pg_catalog`,
    `grant select(record) on ${contractTable} to public`,
    `alter table ${contractTable} disable trigger crafting_runtime_seal_guard`,
    `alter table ${contractTable} add column unexpected boolean`,
    `alter table ${contractTable} enable row level security`,
    `create rule unexpected as on update to ${contractTable} do instead nothing`,
  ];
  for (const attack of attacks) {
    await expect(f.owner.sql.begin(async tx => {
      await tx.unsafe(attack);
      expect((await tx`select shardkeep_crafting_runtime_sources_valid() valid`)[0]!.valid, attack).toBe(false);
      expect((await tx`select shardkeep_divine_fragment_contract() value`)[0]!.value, attack).toBeNull();
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await originals(f.owner.sql)).toEqual(old);
    await sourceGraph(f.owner.sql);
  }
  // Unrelated old trigger drift must remain visible in the predecessor graph.
  await expect(f.owner.sql.begin(async tx => {
    await tx`alter table ordinary_crafting_jobs disable trigger bound_cosmetic_workshop_guard`;
    expect((await tx`select shardkeep_bound_cosmetic_wake_sources_valid() valid`)[0]!.valid).toBe(false);
    throw rollback;
  })).rejects.toBe(rollback);
  for (const mutation of [
    `insert into ${contractTable}(record) select record from ${contractTable}`,
    `update ${contractTable} set record=record`,
    `delete from ${contractTable}`,
    `truncate ${contractTable}`,
  ]) await expect(f.owner.sql.unsafe(mutation)).rejects.toThrow('CRAFTING_RUNTIME_SEAL_IMMUTABLE');
  expect(await originals(f.owner.sql)).toEqual(old);
  await sourceGraph(f.owner.sql);
}), 120_000);
