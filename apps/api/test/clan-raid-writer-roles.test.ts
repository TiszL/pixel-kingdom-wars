/** K232 restricted real LOGIN + real provisioning; only two same-transaction
 * capabilities cross the owner boundary. Private journals remain unavailable. */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client';
import { createRaid, submitOrders } from '../src/game/raids';
import { createClanCharterRaidChest, resolveOriginalClanRaidChest } from '../src/game/clanCharterRaidChest';
import { ADMIN_DATABASE_URL } from './db-url';
import { releaseMigratedTemplates } from './migratedTemplate';
import { raidChestFixture, raidChestKey, type RaidChestFixture } from './fixtures/clanCharterRaidChest';
let f: RaidChestFixture;
beforeEach(async () => { vi.stubEnv('MULTI_BASE_ENABLED', 'false'); vi.stubEnv('PHASE_E_CHARTER_ENABLED', 'false'); f = raidChestFixture(); await f.setup(); }, 120_000);
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await f?.close(); }, 120_000);
const migration = readFileSync(fileURLToPath(new URL('../drizzle/0255_clan_raid_writer_capabilities.sql', import.meta.url)), 'utf8');
const script = fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh', import.meta.url));
const functions = ['shardkeep_clan_charter_raid_chest_resolve(uuid,text)', 'shardkeep_clan_charter_raid_chest_assert_posting(uuid,uuid)'];
const orders = () => ({ idempotencyKey: raidChestKey(), deploys: [
  { troop: 'turrider' as const, tx: 6, ty: 14, tMs: 0 }, { troop: 'turrider' as const, tx: 23, ty: 14, tMs: 0 },
  { troop: 'turrider' as const, tx: 14, ty: 6, tMs: 0 }, { troop: 'turrider' as const, tx: 14, ty: 23, tMs: 0 }] });

it('preserves bounded writer capability and private history across real role provisioning and latest migration replay', async () => {
  const suffix = raidChestKey().replaceAll('-', ''), apiName = 'cw_api_' + suffix, workerName = 'cw_worker_' + suffix, strangerName = 'cw_other_' + suffix;
  const apiPassword = randomBytes(32).toString('hex'), workerPassword = randomBytes(32).toString('hex'), strangerPassword = randomBytes(32).toString('hex');
  const [database] = await f.sql`select current_database() name`, ownerUrl = new URL(ADMIN_DATABASE_URL); ownerUrl.pathname = '/' + database!.name;
  const login = (name: string, password: string) => { const url = new URL(ownerUrl); url.username = name; url.password = password; return createDb(url.toString(), { max: 1 }); };
  const provision = () => execFileSync('sh', [script], { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024, env: {
    PATH: process.env.PATH, PGHOST: ownerUrl.hostname, PGPORT: ownerUrl.port, PGDATABASE: database!.name,
    PGUSER: decodeURIComponent(ownerUrl.username), PGPASSWORD: decodeURIComponent(ownerUrl.password),
    POSTGRES_USER: decodeURIComponent(ownerUrl.username), POSTGRES_PASSWORD: decodeURIComponent(ownerUrl.password),
    DB_ROLE_MODE: 'isolated', SOLANA_CLUSTER: 'devnet', API_DB_USER: apiName, API_DB_PASSWORD: apiPassword,
    WORKER_DB_USER: workerName, WORKER_DB_PASSWORD: workerPassword } });
  const signatures = () => f.sql`select p.proname,p.prosrc,p.proowner::regrole::text owner,p.prosecdef,p.proconfig
    from pg_proc p where p.oid in ('public.shardkeep_clan_charter_raid_chest_resolve(uuid,text)'::regprocedure,
    'public.shardkeep_clan_charter_raid_chest_assert_posting(uuid,uuid)'::regprocedure) order by p.proname`;
  let api: ReturnType<typeof createDb> | undefined, worker: ReturnType<typeof createDb> | undefined, stranger: ReturnType<typeof createDb> | undefined;
  try {
    const original = await signatures(); expect(original).toHaveLength(2);
    for (const fn of original) { expect(fn.prosecdef).toBe(true); expect(fn.proconfig).toContain('search_path=pg_catalog, public, pg_temp'); }
    provision(); api = login(apiName, apiPassword); worker = login(workerName, workerPassword);
    await f.sql.unsafe(`create role ${strangerName} login password '${strangerPassword}' nosuperuser nocreatedb nocreaterole noinherit`);
    await f.sql.unsafe(`grant usage on schema public to ${strangerName}`); stranger = login(strangerName, strangerPassword);
    async function boundary() {
      for (const [name, conn] of [[apiName, api!], [workerName, worker!]] as const) {
        expect(await conn.sql`select current_user u,session_user s`).toEqual([{ u: name, s: name }]);
        for (const fn of functions) expect(await conn.sql`select has_function_privilege(current_user,${'public.' + fn},'EXECUTE') allowed`).toEqual([{ allowed: true }]);
        for (const table of ['clan_charter_event_source', 'clan_charter_raid_events', 'clan_charter_raid_tithe_rules', 'clan_charter_loot_posts', 'clan_charter_raid_terminals']) {
          await expect(conn.sql.unsafe(`select * from public.${table}`)).rejects.toMatchObject({ code: '42501' });
          await expect(conn.sql.unsafe(`delete from public.${table}`)).rejects.toMatchObject({ code: '42501' });
          await expect(conn.sql.unsafe(`insert into public.${table} default values`)).rejects.toMatchObject({ code: '42501' });
        }
        await expect(conn.sql`select public.shardkeep_clan_charter_raid_chest_rule_read()`).rejects.toMatchObject({ code: '42501' });
        await expect(conn.sql`select public.shardkeep_clan_charter_raid_chest_rule_initialize(1,10000)`).rejects.toMatchObject({ code: '42501' });
        await expect(conn.sql`select public.shardkeep_clan_charter_raid_chest_read(${raidChestKey()}::uuid)`).rejects.toMatchObject({ code: '42501' });
        await expect(conn.sql`create table public.k232_shadow(id integer)`).rejects.toMatchObject({ code: '42501' });
      }
      for (const fn of functions) expect(await stranger!.sql`select has_function_privilege(current_user,${'public.' + fn},'EXECUTE') allowed`).toEqual([{ allowed: false }]);
      await expect(stranger!.sql`select public.shardkeep_clan_charter_raid_chest_resolve(${raidChestKey()}::uuid,'unknown')`).rejects.toMatchObject({ code: '42501' });
      expect(await signatures()).toEqual(original);
    }
    await boundary();
    // Restricted gameplay works genuinely unenrolled, then after owner-only
    // prospective enrollment. The exact same source functions run in each case.
    for (const enrolled of [false, true]) {
      const a = await f.attacker('turrider'), c = await f.clan(a.wallet), d = await f.defender();
      if (enrolled) await f.initialize();
      const raid = await createRaid(api.db, a.wallet, { defenderWallet: d.wallet, idempotencyKey: raidChestKey() });
      const actor = enrolled ? worker : api;
      await expect(actor.sql`create temp table clan_charter_raid_events(raid_id uuid)`).rejects.toMatchObject({ code: '42501' });
      const route = await actor.db.transaction(tx => resolveOriginalClanRaidChest(tx, raid.id, a.wallet, 100n));
      expect(route).toMatchObject({ history: enrolled ? 'captured' : 'unenrolled', clanId: c.id });
      const result = await submitOrders(actor.db, a.wallet, raid.id, orders()); expect(result.result.lootShards).toBeGreaterThan(0);
      expect(await f.entries(raid.id)).toHaveLength(3);
      expect(await f.service().read(raid.id)).toMatchObject({ status: enrolled ? 'reconciled' : 'unenrolled' });
    }
    const facts = await f.sql`select to_jsonb(e) value from clan_charter_raid_events e order by raid_id`;
    // Old SQL replay can restore INVOKER. Applying the latest frontier restores
    // only these attributes/ACLs without altering source bodies or facts.
    await f.sql`alter function public.shardkeep_clan_charter_raid_chest_resolve(uuid,text) security invoker`;
    await f.sql`alter function public.shardkeep_clan_charter_raid_chest_assert_posting(uuid,uuid) security invoker`;
    for (let i = 0; i < 2; i++) {
      await f.db.transaction(async tx => { for (const part of migration.split('--> statement-breakpoint')) await tx.execute(sql.raw(part)); });
      provision(); await boundary();
      expect(await f.sql`select to_jsonb(e) value from clan_charter_raid_events e order by raid_id`).toEqual(facts);
    }
  } finally {
    await api?.sql.end(); await worker?.sql.end(); await stranger?.sql.end();
    // A migrated template holds GRANTs to the groups; release it before dropping them.
    await releaseMigratedTemplates();
    for (const name of [apiName, workerName, strangerName, 'shardkeep_api_runtime', 'shardkeep_worker_runtime']) {
      if ((await f.sql`select 1 from pg_roles where rolname=${name}`).length) await f.sql.unsafe(`drop owned by ${name};drop role ${name}`);
    }
  }
}, 180_000);
