/** Real isolated installation/dispatch transactions; synthetic Core/finality
 * fixture inputs. This certifies response provenance, not live chain or art. */
import { PublicKey } from '@solana/web3.js';
import { matchAdvancedExpeditionEnvelope } from '@shardkeep/shared/advancedExpeditionApi';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/client';
import { players, sessions } from '../src/db/schema';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import * as prefetch from '../src/game/operatingExpeditionTermReader';
import { dispatchAdvancedExpedition, dispatchAdvancedExpeditionCommitted } from '../src/game/advancedExpeditionDispatch';
import { createAdvancedExpeditionWorkflow } from '../src/game/advancedExpeditionWorkflow';
import { createVehicleInstallations } from '../src/game/vehicleInstallations';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';
import { vehicleBurnDatabase } from './fixtures/vehicleBurn';
import { vehicleServiceExpeditions } from './fixtures/vehicleService';
import { TEST_CONFIG } from './helpers';

const conn = resourceClaimsDatabase(), db = conn.db;
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const key = new PublicKey('11111111111111111111111111111111');
const provider = { policy: { genesisHash: key, programId: key, config: key, round: 1n, mint: key, prizeOwner: key, prizeAta: key,
  stateProvenance: 'fresh-reviewed-deployment' as const,
  deployment: { programDataAddress: key.toBase58(), programDataSha256: 'ab'.repeat(32), upgradeAuthority: null } },
  connect: () => { throw new Error('Synthetic fixture must not contact RPC'); } };
beforeAll(() => conn.setup(), 180_000);
afterAll(() => conn.close());
beforeEach(() => {
  for (const flag of ['MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'PHASE_E_VEHICLES_ENABLED']) vi.stubEnv(flag, 'true');
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs();
});
async function fixture() {
  const f = await vehicleBurnDatabase('survey_balloon', 1, {}, { connection: conn, completedAt: new Date(Date.now() - 7 * 86_400_000) });
  f.finalizeBurn();
  await createVehicleInstallations(db, { verifyBurn: f.reader.verify }).recover(f.actor, f.reservation.id);
  return { ...f, trips: await vehicleServiceExpeditions(f) };
}
function barrier() {
  let release!: () => void;
  return { gate: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
function outcome<T>(pending: Promise<T>) {
  return pending.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
}

it('normal HTTP certifies exactly one concurrent new dispatch and never marks recovery or a legacy three-method provider', async () => {
  const f = await fixture(), command = f.trips.command(), { id: idempotencyKey, ...body } = command;
  const request = { idempotencyKey, ...body }, both = barrier();
  let arrived = 0;
  vi.spyOn(prefetch, 'prefetchOperatingExpeditionTermReader').mockImplementation(async () => {
    const reader = await f.trips.reader();
    if (++arrived === 2) both.release();
    await both.gate; return reader;
  });
  const workflow = createAdvancedExpeditionWorkflow(db, { term: provider });
  const app = await buildApp(TEST_CONFIG, db, { advancedExpeditionWorkflowProvider: workflow }); apps.push(app);
  const [session] = await db.insert(sessions).values({ wallet: f.actor, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1_000) }).returning();
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, f.actor, session!.id) };
  const post = () => app.inject({ method: 'POST', url: '/advanced-expeditions', cookies, payload: request });
  const replies = await Promise.all([post(), post()]);
  expect(arrived).toBe(2); expect(replies.map(reply => reply.statusCode).sort()).toEqual([200, 201]);
  expect(replies.filter(reply => reply.headers['x-pkw-journey-created'] === '1')).toHaveLength(1);
  for (const reply of replies) {
    expect(reply.headers['x-pkw-journey-created']).toBe(reply.statusCode === 201 ? '1' : undefined);
    const original = matchAdvancedExpeditionEnvelope(reply.json(), f.actor, request);
    expect(original.receipt).toEqual(replies[0]!.json().receipt);
    expect(Object.keys(original).sort()).toEqual(['idempotencyKey', 'receipt', 'return', 'serverNow', 'status', 'wallet']);
  }
  const replay = await post(); expect(replay.statusCode).toBe(200); expect(replay.headers['x-pkw-journey-created']).toBeUndefined();
  const legacy = await buildApp(TEST_CONFIG, db, { advancedExpeditionWorkflowProvider: {
    dispatch: workflow.dispatch, read: workflow.read, collect: workflow.collect,
  } }); apps.push(legacy);
  const old = await legacy.inject({ method: 'POST', url: '/advanced-expeditions', cookies, payload: request });
  expect(old.statusCode).toBe(200); expect(old.headers['x-pkw-journey-created']).toBeUndefined();
  expect(old.json()).toEqual(replay.json());
  expect(await conn.sql`select id from advanced_expeditions where id=${idempotencyKey}`).toHaveLength(1);
});

it('reports false after a real player-lock wait and keeps the accepted-row dispatcher compatible', async () => {
  const f = await fixture(), command = f.trips.command(), gate = barrier();
  const firstReader = await f.trips.reader(), secondReader = await f.trips.reader();
  let holderPid: number | undefined, once = true;
  const first = outcome(dispatchAdvancedExpeditionCommitted(db, f.actor, command, {
    ...f.trips.authority, assertAuthority: async (tx, wallet, baseId) => {
      await f.trips.authority.assertAuthority(tx, wallet, baseId);
      if (once) { once = false; holderPid = Number((await tx.execute(sql`select pg_backend_pid() pid`))[0]!.pid); await gate.gate; }
    },
  }, { reader: firstReader, clock: f.trips.clock }));
  let second: typeof first | undefined;
  try {
    await expect.poll(() => holderPid).toBeDefined();
    second = outcome(dispatchAdvancedExpeditionCommitted(db, f.actor, command, f.trips.authority, { reader: secondReader, clock: f.trips.clock }));
    await expect.poll(async () => (await conn.sql<{ waiting: boolean }[]>`select exists(select 1 from pg_stat_activity
      where ${holderPid!}=any(pg_blocking_pids(pid)) and query like '%players%') waiting`)[0]!.waiting).toBe(true);
    gate.release(); const a = await first, b = await second;
    expect(a.ok).toBe(true); expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) throw Error('Expected both dispatch results');
    expect(a.value.created).toBe(true); expect(b.value).toEqual({ created: false, expedition: a.value.expedition });
    vi.stubEnv('PHASE_E_VEHICLES_ENABLED', 'false');
    expect(await dispatchAdvancedExpedition(db, f.actor, command, f.trips.authority)).toEqual(a.value.expedition);
    expect((await dispatchAdvancedExpeditionCommitted(db, f.actor, command, f.trips.authority)).created).toBe(false);
  } finally { gate.release(); await first; if (second) await second; }
});

it('rejects owning-transaction failure after insertion without leaking freshness or consuming the original key or provisions', async () => {
  const f = await fixture(), command = f.trips.command(), transaction = db.transaction.bind(db);
  const before = await conn.sql`select resource_id,available,reserved from resource_stocks where base_id=${f.baseId} order by resource_id`;
  const reader = await f.trips.reader();
  const fail = vi.spyOn(db, 'transaction').mockImplementationOnce(async (run, options) => transaction(async tx => {
    expect(await run(tx)).toMatchObject({ created: true, expedition: { id: command.id } });
    throw Error('Synthetic owning transaction failure');
  }, options));
  await expect(dispatchAdvancedExpeditionCommitted(db, f.actor, command, f.trips.authority, { reader, clock: f.trips.clock }))
    .rejects.toThrow('Synthetic owning transaction failure');
  fail.mockRestore();
  expect(await conn.sql`select id from advanced_expeditions where id=${command.id}`).toEqual([]);
  expect(await conn.sql`select * from advanced_expedition_inflight where base_id=${f.baseId}`).toEqual([]);
  expect(await conn.sql`select resource_id,available,reserved from resource_stocks where base_id=${f.baseId} order by resource_id`).toEqual(before);
  expect((await dispatchAdvancedExpeditionCommitted(db, f.actor, command, f.trips.authority, { reader: await f.trips.reader(), clock: f.trips.clock })).created).toBe(true);
});

it('never permits an outer transaction handle to claim committed provenance', async () => {
  const f = await fixture(), command = f.trips.command();
  await db.transaction(async tx => {
    await tx.select().from(players).where(eq(players.wallet, f.actor)).for('update');
    await expect(dispatchAdvancedExpeditionCommitted(tx as unknown as Db, f.actor, command, f.trips.authority)).rejects.toThrow('top-level DB');
    await expect(dispatchAdvancedExpedition(tx as unknown as Db, f.actor, command, f.trips.authority)).rejects.toThrow('top-level DB');
  });
  expect(await conn.sql`select id from advanced_expeditions where id=${command.id}`).toEqual([]);
});
