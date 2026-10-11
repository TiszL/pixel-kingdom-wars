/** K240: execute the operator script against disposable PostgreSQL, not a fake
 * psql transcript. Both migration orders and repeated provisioning must retain
 * the private source/verifier boundary, including stale column/membership grants. */
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { ADMIN_DATABASE_URL } from './db-url';

const script = fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh', import.meta.url));
const reads = ['mining_claim_entitlement_headers', 'mining_claim_entitlement_leaves',
  'mining_claim_receipts', 'mining_claim_failures', 'mining_tax_claim_receipts', 'mining_tax_claim_failures'];
const intents = ['mining_claim_preparations', 'mining_claim_signed_wires',
  'mining_tax_claim_preparations', 'mining_tax_claim_signed_wires', 'mining_tax_claim_continuations'];

it.each(['roles-first', 'migrations-first'] as const)('%s preserves only original public claim rights across actual reprovisioning', async order => {
  const suffix = randomUUID().replaceAll('-', ''), name = `mining_roles_${suffix}_test`;
  const apiRole = `mr_api_${suffix}`, workerRole = `mr_worker_${suffix}`, leakedRole = `mr_leak_${suffix}`;
  const ownerUrl = new URL(ADMIN_DATABASE_URL); ownerUrl.pathname = `/${name}`;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(ownerUrl.hostname)) throw Error('Owned local fixture required');
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  const password = { api: randomBytes(32).toString('hex'), worker: randomBytes(32).toString('hex') };
  let owner: ReturnType<typeof createDb> | undefined, api: ReturnType<typeof createDb> | undefined, worker: ReturnType<typeof createDb> | undefined;
  const provision = () => execFileSync('sh', [script], { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: process.env.PATH, PGHOST: ownerUrl.hostname, PGPORT: ownerUrl.port,
      PGDATABASE: name, PGUSER: decodeURIComponent(ownerUrl.username), PGPASSWORD: decodeURIComponent(ownerUrl.password),
      POSTGRES_USER: decodeURIComponent(ownerUrl.username), POSTGRES_PASSWORD: decodeURIComponent(ownerUrl.password),
      DB_ROLE_MODE: 'isolated', SOLANA_CLUSTER: 'devnet', API_DB_USER: apiRole, API_DB_PASSWORD: password.api,
      WORKER_DB_USER: workerRole, WORKER_DB_PASSWORD: password.worker } });
  try {
    await admin.unsafe(`create database ${name}`); owner = createDb(ownerUrl.toString(), { max: 1 });
    if (order === 'roles-first') provision();
    await runMigrations(owner.db);
    const [savedContract] = await owner.sql`select record from divine_fragment_resource_publication_contract where singleton`;
    expect(savedContract).toBeDefined();
    provision();
    const login = (role: string, secret: string) => { const url = new URL(ownerUrl); url.username = role; url.password = secret; return createDb(url.toString(), { max: 1 }); };
    api = login(apiRole, password.api); worker = login(workerRole, password.worker);
    const tables = await owner.sql<{ tablename: string }[]>`select tablename from pg_tables where schemaname='public' and left(tablename,7)='mining_' order by tablename`;
    expect(tables.length).toBeGreaterThan(reads.length + intents.length);
    const vehicleTables = await owner.sql<{ tablename: string }[]>`select tablename from pg_tables where schemaname='public'
      and (left(tablename,8)='vehicle_' or left(tablename,9)='advanced_') order by tablename`;
    // 2026-10-10 (CI 37503885235): this pinned 16 (the 0214-era custody tables, 8495c1a6f); 0256..0293 added
    // 16 more (return seal, identity contract, craft materials, issuance, request delivery). The rule is the
    // provisioner's own prefix clause: EVERY vehicle_/advanced_ table is private to both runtimes. Derive the
    // set from that clause, keep the original custody tables in it, and check each table below.
    const provisioner = readFileSync(script, 'utf8');
    expect(provisioner).toContain("OR left(tablename, 8) = 'vehicle_' OR left(tablename, 9) = 'advanced_' OR");
    expect(vehicleTables.map(({ tablename }) => tablename)).toEqual(expect.arrayContaining([
      'advanced_expedition_entries', 'advanced_expedition_inflight', 'advanced_expedition_returns', 'advanced_expedition_supplies',
      'advanced_expeditions', 'advanced_vehicle_installations', 'vehicle_activation_reservations', 'vehicle_burn_consumptions',
      'vehicle_burn_preparations', 'vehicle_burn_signed_wires', 'vehicle_mint_registry', 'vehicle_service_applications',
      'vehicle_service_burn_preparations', 'vehicle_service_consumptions', 'vehicle_service_intents', 'vehicle_service_signed_wires']));
    const sourceSeals = () => owner!.sql`select p.proname, p.prosrc, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and left(p.proname,17)='shardkeep_mining_' order by p.oid`;
    const originalSeals = await sourceSeals();
    expect(originalSeals.length).toBeGreaterThan(0);
    async function assertBoundary() {
      for (const [role, conn] of [[apiRole, api!], [workerRole, worker!]] as const) {
        for (const { tablename } of tables) {
          const isApi = role === apiRole, select = isApi && [...reads, ...intents].includes(tablename), insert = isApi && intents.includes(tablename);
          const [actual] = await conn.sql`select has_table_privilege(current_user,${'public.' + tablename},'SELECT') can_read,
            has_table_privilege(current_user,${'public.' + tablename},'INSERT') can_insert,
            has_table_privilege(current_user,${'public.' + tablename},'UPDATE') can_update,
            has_table_privilege(current_user,${'public.' + tablename},'DELETE') can_delete,
            has_any_column_privilege(current_user,${'public.' + tablename},'UPDATE') can_update_column`;
          expect(actual, `${role}:${tablename}`).toEqual({ can_read: select, can_insert: insert, can_update: false, can_delete: false, can_update_column: false });
          if (select) expect(await conn.sql.unsafe(`select * from public.${tablename} limit 1`)).toBeDefined();
          else await expect(conn.sql.unsafe(`select * from public.${tablename} limit 1`)).rejects.toMatchObject({ code: '42501' });
        }
        for (const table of ['mining_publication_attempts', 'mining_publication_manifests', 'mining_contribution_receipts', 'divine_fragment_mining_contract', 'divine_fragment_resource_publication_contract']) {
          await expect(conn.sql.unsafe(`select * from public.${table}`)).rejects.toMatchObject({ code: '42501' });
          await expect(conn.sql.unsafe(`delete from public.${table}`)).rejects.toMatchObject({ code: '42501' });
        }
        for (const table of ['mining_claim_receipts', 'mining_claim_failures', 'mining_tax_claim_receipts', 'mining_tax_claim_failures']) {
          await expect(conn.sql.unsafe(`insert into public.${table} default values`)).rejects.toMatchObject({ code: '42501' });
        }
        for (const { tablename } of vehicleTables) {
          const [access] = await conn.sql`select has_table_privilege(current_user,${'public.' + tablename},'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') table_access,
            has_any_column_privilege(current_user,${'public.' + tablename},'SELECT,INSERT,UPDATE,REFERENCES') column_access`;
          expect(access, `${role}:${tablename}`).toEqual({ table_access: false, column_access: false });
          await expect(conn.sql.unsafe(`select * from public.${tablename}`)).rejects.toMatchObject({ code: '42501' });
        }
        const [probe] = await conn.sql`select has_function_privilege(current_user,'public.shardkeep_has_advanced_resource_sources(uuid,text)','EXECUTE') allowed`;
        expect(probe!.allowed).toBe(true);
        const [equipment] = await conn.sql`select has_function_privilege(current_user,'public.shardkeep_has_equipment_resource_sources_v2(uuid,text)','EXECUTE') allowed`;
        expect(equipment!.allowed).toBe(true);
        for (const table of ['seeker_realm_sale_preparations', 'seeker_realm_sale_signed_wires', 'seeker_realm_sale_receipts', 'seeker_realm_sale_failures']) {
          const isApi = role === apiRole, intent = table.endsWith('_preparations') || table.endsWith('_signed_wires');
          const [access] = await conn.sql`select has_table_privilege(current_user,${'public.' + table},'SELECT') can_read,
            has_table_privilege(current_user,${'public.' + table},'INSERT') can_insert,
            has_table_privilege(current_user,${'public.' + table},'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') can_mutate,
            has_any_column_privilege(current_user,${'public.' + table},'UPDATE,REFERENCES') can_mutate_column,
            has_any_column_privilege(current_user,${'public.' + table},'INSERT') can_insert_column`;
          expect(access, `${role}:${table}`).toEqual({ can_read: isApi, can_insert: isApi && intent, can_mutate: false, can_mutate_column: false, can_insert_column: isApi && intent });
          if (isApi) expect(await conn.sql.unsafe(`select * from public.${table}`)).toEqual([]);
          else await expect(conn.sql.unsafe(`select * from public.${table}`)).rejects.toMatchObject({ code: '42501' });
          if (!isApi || !intent) await expect(conn.sql.unsafe(`insert into public.${table} default values`)).rejects.toMatchObject({ code: '42501' });
        }
        const [continuation] = await conn.sql`select has_function_privilege(current_user,'public.shardkeep_mining_tax_continuation_lock(uuid)','EXECUTE') allowed`;
        expect(continuation!.allowed).toBe(role === apiRole);
      }
      expect(await sourceSeals()).toEqual(originalSeals);
      // 2026-10-10 (CI 37503885235): 0254's record was the newest contract when this was pinned (8495c1a6f);
      // 0258..0279 successors extended and reformatted the live projection, so whole-record equality with 0254 is
      // gone by design. Provisioning must still leave the saved 0254 record untouched, keep the live table
      // projection equal to the newest table seal (0279 bound cosmetics) and pass the newest whole-system check.
      const [contract] = await owner!.sql`select r.record,(b.record->'tables')=(shardkeep_divine_fragment_contract()->'tables') intact
        from divine_fragment_resource_publication_contract r cross join divine_fragment_bound_cosmetics_contract b where r.singleton and b.singleton`;
      expect(contract!.intact).toBe(true); expect(contract!.record).toEqual(savedContract!.record);
      await owner!.sql`select shardkeep_divine_fragment_source()`;
    }
    await assertBoundary();
    // Reused logins/groups can inherit leaks as well as retain direct grants.
    await owner.sql.unsafe(`create role ${leakedRole} nologin; grant select on mining_publication_signed_wires to ${leakedRole}; grant ${leakedRole} to shardkeep_api_runtime`);
    await owner.sql.unsafe(`grant select on mining_publication_signing_reservations to ${apiRole}; grant select (id) on mining_contribution_receipts to public, ${workerRole}; grant insert (claim_id) on mining_claim_receipts to ${apiRole}`);
    await expect(api.sql`select * from mining_publication_signed_wires`).resolves.toEqual([]);
    await expect(worker.sql`select id from mining_contribution_receipts`).resolves.toEqual([]);
    await owner.sql.unsafe(`grant select on vehicle_burn_signed_wires to public; grant select (id) on vehicle_activation_reservations to ${apiRole}, ${workerRole}`);
    await owner.sql.unsafe(`grant select on seeker_realm_sale_signed_wires to public; grant update(wallet) on seeker_realm_sale_signed_wires to ${apiRole}; grant insert(wallet) on seeker_realm_sale_receipts to ${workerRole}`);
    await expect(worker.sql`select * from seeker_realm_sale_signed_wires`).resolves.toEqual([]);
    await expect(api.sql`select * from vehicle_burn_signed_wires`).resolves.toEqual([]);
    await expect(worker.sql`select id from vehicle_activation_reservations`).resolves.toEqual([]);
    provision(); await assertBoundary();
    await expect(worker.sql`select id from vehicle_activation_reservations`).rejects.toMatchObject({ code: '42501' });
    await expect(worker.sql`select id from mining_contribution_receipts`).rejects.toMatchObject({ code: '42501' });
    await runMigrations(owner.db); provision(); await assertBoundary();
    const [member] = await owner.sql`select pg_has_role(${apiRole},${leakedRole},'member') inherited`;
    expect(member!.inherited).toBe(false);
    // An unrelated role retaining a grant on a sealed source is changed
    // authority. Provisioning strips runtime membership, but must not rewrite
    // that unrelated role or rebaseline the immutable seal to declare it safe.
    await owner.sql.unsafe(`grant select on mining_publication_manifests to ${leakedRole}; grant ${leakedRole} to shardkeep_api_runtime`);
    provision();
    await expect(api.sql`select * from mining_publication_manifests`).rejects.toMatchObject({ code: '42501' });
    const [retained] = await owner.sql`select record from divine_fragment_resource_publication_contract where singleton`;
    expect(retained!.record).toEqual(savedContract!.record);
    await expect(owner.sql`select shardkeep_divine_fragment_source()`).rejects.toMatchObject({ code: 'P0001', message: 'DIVINE_FRAGMENT_SOURCE' });
  } finally {
    await api?.sql.end(); await worker?.sql.end(); await owner?.sql.end();
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    // 2026-10-10 (cluster D, K-night-D4/E3): drop only the three roles this case created. The two NOLOGIN groups
    // are cluster-wide and shared: every provisioner run creates or normalizes them. Dropping them here deleted
    // them for every later file in a CI shard, and on a shared local cluster the drop fails while another
    // database holds grants to them, and that finally-block error replaced the case's real failure.
    for (const role of [apiRole, workerRole, leakedRole]) await admin.unsafe(`drop role if exists ${role}`);
    await admin.end();
  }
}, 120_000);
