import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client';
import { createRaid, submitOrders } from '../src/game/raids';
import { consumeArmy } from '../src/game/army';
import { charterSalesRaidFixture, setupCharterSaleRaidActor } from './fixtures/charterSalesRaid';
import { charterSalesWorkflowFixture, salesPath } from './fixtures/charterSalesWorkflow';
import { postgresLeaf } from './fixtures/charterPermitInventory';
import { ADMIN_DATABASE_URL } from './db-url';
import { releaseMigratedTemplates } from './migratedTemplate';

const orders = () => ({ deploys: [{ troop: 'highlander' as const, tx: 6, ty: 14, tMs: 0 }], idempotencyKey: randomUUID() });

it('supports the exact runtime capability after real provisioning while private data, extra grants and arbitrary proof writes remain refused', async () => {
 const c = await charterSalesRaidFixture(), suffix = randomUUID().replaceAll('-', ''), name = 'cad_' + suffix, worker = 'cdw_' + suffix;
 const password = randomBytes(32).toString('hex'), workerPassword = randomBytes(32).toString('hex'), [db] = await c.sql`select current_database() name`, url = new URL(ADMIN_DATABASE_URL); url.pathname = '/' + db!.name;
 let runtime: ReturnType<typeof createDb> | undefined;
 try {
  const provision = () => execFileSync('sh', [fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh', import.meta.url))], {
   encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: { PATH: process.env.PATH, PGHOST: url.hostname, PGPORT: url.port, PGDATABASE: db!.name,
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), POSTGRES_USER: decodeURIComponent(url.username), POSTGRES_PASSWORD: decodeURIComponent(url.password),
    DB_ROLE_MODE: 'isolated', SOLANA_CLUSTER: 'devnet', API_DB_USER: name, API_DB_PASSWORD: password, WORKER_DB_USER: worker, WORKER_DB_PASSWORD: workerPassword } });
  provision(); provision(); const login = new URL(url); login.username = name; login.password = password; runtime = createDb(login.toString(), { max: 1 });
  const held = await c.raid(), raid = await c.raid(); await consumeArmy(c.db, c.birth.actor.wallet, { highlander: 1 });
  for (const table of ['charter_army_dispositions', 'charter_army_disposition_contract']) {
   await expect(runtime.sql.unsafe(`select * from ${table}`)).rejects.toMatchObject({ code: '42501' });
   await expect(runtime.sql.unsafe(`insert into ${table} default values`)).rejects.toMatchObject({ code: '42501' });
  }
  await expect(runtime.sql`select public.shardkeep_charter_army_disposition_proof(${raid.value.id}::uuid)`).rejects.toMatchObject({ code: '42501' });
  await c.sql.unsafe(`grant select on charter_army_dispositions to ${name}`);
  const refused = await submitOrders(runtime.db, c.birth.actor.wallet, held.value.id, orders()).then(() => null, error => error);
  expect(postgresLeaf(refused)).toEqual({ code: '42501', message: 'CHARTER_ARMY_PRIVATE_GRANTS' });
  expect(await c.sql`select status from raids where id=${held.value.id}`).toEqual([{ status: 'pending_orders' }]);
  expect(await c.sql`select * from charter_army_dispositions`).toHaveLength(0);
  await c.sql.unsafe(`revoke select on charter_army_dispositions from ${name}`);
  // Refusal retains its real simulation lease. Use the second real admission
  // for success; do not alter the held raid or fabricate lease expiry.
  await expect(submitOrders(runtime.db, c.birth.actor.wallet, raid.value.id, orders())).rejects.toMatchObject({ code: 'RAID_ARMY_CHANGED' });
  expect(await c.sql`select raid_id from charter_army_dispositions`).toEqual([{ raid_id: raid.value.id }]);
  expect((await c.sql`select shardkeep_charter_sale_ante_proof(${raid.value.id}::uuid,true) value`)[0]!.value.classification).toBe('army-changed-retained');
 } finally {
  await runtime?.sql.end();
  // A migrated template holds GRANTs to the groups; release it before dropping them.
  await releaseMigratedTemplates();
  // Dispose even when DROP ROLE fails: a fixture database left behind keeps GRANTs to the
  // groups, so every later file that drops them fails too (K-night-R3b).
  try {
   for (const role of [name, worker, 'shardkeep_api_runtime', 'shardkeep_worker_runtime']) {
    if ((await c.sql`select 1 from pg_roles where rolname=${role}`).length) await c.sql.unsafe(`drop owned by ${role};drop role ${role}`);
   }
  } finally { await c.dispose(); vi.unstubAllEnvs(); }
 }
}, 120000);

it('completes members-first payment, both genuine wallet signatures and original sale recovery after a witnessed army-change terminal', async () => {
 const c = await charterSalesWorkflowFixture();
 try {
  await setupCharterSaleRaidActor(c, c.source.wallet); vi.stubEnv('MULTI_BASE_ENABLED', 'false');
  const defender = await c.actor(); vi.stubEnv('MULTI_BASE_ENABLED', 'false');
  const raid = await createRaid(c.db, c.source.wallet, { defenderWallet: defender.wallet, idempotencyKey: randomUUID() });
  await consumeArmy(c.db, c.source.wallet, { highlander: 1 });
  await expect(submitOrders(c.db, c.source.wallet, raid.id, orders())).rejects.toMatchObject({ code: 'RAID_ARMY_CHANGED' });
  vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_CHARTER_ENABLED', 'true');
  const app = await c.open(), p = await c.prepared(app), id = p.state.id;
  const wire = c.signed(p.state), retained = await c.post(app, `${salesPath}/${id}/signed`, wire.body, c.buyerAuth.cookies); expect(retained.statusCode, retained.body).toBe(200);
  await c.finalize(id); const terminal = await c.post(app, `${salesPath}/${id}/recover`); expect(terminal.statusCode, terminal.body).toBe(200); expect(terminal.json().status).toBe('completed');
  expect(await c.sql`select leader_wallet from clans where id=${c.birth.consent.clanId}`).toEqual([{ leader_wallet: c.buyer.wallet }]);
  expect(await c.sql`select * from clan_charter_member_payments`).toHaveLength(1);
  const [attempt] = await c.sql`select source from charter_sale_attempts where sale_id=${id}`;
  expect(attempt!.source.clearance.raids[0].classification).toBe('army-changed-retained');
  const before = await c.salesSnapshot(); c.setOnline(false); vi.stubEnv('PHASE_E_CHARTER_ENABLED', 'false');
  const offline = await c.open({ options: { newSaleDomain: null, chain: null, issuer: null, finalizedDeedReader: null, deedCollection: null } });
  const replay = await c.post(offline, `${salesPath}/${id}/recover`); expect(replay.statusCode, replay.body).toBe(200); expect(replay.json()).toEqual(terminal.json()); expect(await c.salesSnapshot()).toBe(before);
 } finally { await c.dispose(); vi.unstubAllEnvs(); }
}, 120000);
