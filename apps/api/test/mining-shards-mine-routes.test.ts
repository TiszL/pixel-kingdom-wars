/** Mounted HTTP and durable SQL with real finalized-reader semantics over
 * fixture account/transaction bytes. No live RPC or source authority is mocked. */
import { randomUUID } from 'node:crypto';
import { Keypair, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMiningTermFixture } from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { bases, baseSlots, buildings, mineAccrualStates, sessions } from '../src/db/schema';
import * as termReader from '../src/game/expeditionTermReader';
import * as sources from '../src/mining/shardsTaxMineSources';
import { connectTestDb, createTestPlayer, TEST_CONFIG } from './helpers';

const conn = connectTestDb(), db = conn.db, now = new Date('2035-01-01T01:00:00.000Z');
const servers: FastifyInstance[] = [];
let bank: Awaited<ReturnType<typeof createMiningTermFixture>>;
const connect = vi.fn((signal: AbortSignal) => bank.connect(signal));
const deedReader = vi.fn(async () => { throw Error('Fixture deed reader is unavailable'); });
beforeAll(async () => {
  bank = await createMiningTermFixture({ day: '2035-01-01', genesisHash: Keypair.generate().publicKey, programId: Keypair.generate().publicKey });
  bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(+now / 1000), 32);
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_MINING_ENABLED', 'true');
  connect.mockClear(); deedReader.mockClear();
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map(app => app.close()));
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
});
afterAll(() => conn.sql.end());
async function open(provider = true) {
  const previous = process.env['MULTI_BASE_ENABLED']; process.env['MULTI_BASE_ENABLED'] = 'false';
  try {
    const app = await buildApp(TEST_CONFIG, db, {
      ...(provider ? { starterExpeditionProvider: { policy: bank.policy, connect } } : {}),
      market: { finalizedDeedReader: deedReader, deedCollection: Keypair.generate().publicKey.toBase58() },
    });
    servers.push(app); await app.ready(); return app;
  } finally {
    if (previous === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = previous;
  }
}
async function cookie(wallet: string) {
  const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(+now + SESSION_TTL_SEC * 1000) }).returning();
  return { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
}
async function fixture() {
  const player = await createTestPlayer(db);
  const [base] = await db.insert(bases).values({ ownerWallet: player.wallet, status: 'active', keepLevel: 1 }).returning();
  await db.insert(baseSlots).values({ wallet: player.wallet, slot: 1, baseId: base!.id });
  const [mine] = await db.insert(buildings).values({ playerWallet: player.wallet, baseId: base!.id, type: 'mine', level: 1, tx: 1, ty: 1 }).returning();
  await db.insert(mineAccrualStates).values({ mineBuildingId: mine!.id, lastAccrualAt: now, accruedShards: 0n });
  return { wallet: player.wallet, base: base!, mine: mine!, request: { idempotencyKey: randomUUID(), baseId: base!.id }, cookies: await cookie(player.wallet) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const post = (app: FastifyInstance, f: Fixture, payload: object = f.request) => app.inject({ method: 'POST', url: '/mining/shards/sources', cookies: f.cookies, payload });
const get = (app: FastifyInstance, f: Fixture, key: string = f.request.idempotencyKey) => app.inject({ url: `/mining/shards/sources/by-key/${key}`, cookies: f.cookies });
const rows = (f: Fixture) => conn.sql`select id from shards_mine_admissions where id=${f.request.idempotencyKey}`;

describe.sequential('authenticated physical Mine source admission', () => {
  it('authenticates before flags and strictly excludes client term, quantity and actor authority', async () => {
    const f = await fixture(), app = await open(); vi.stubEnv('PHASE_E_MINING_ENABLED', 'false');
    for (const request of [{ method: 'POST' as const, url: '/mining/shards/sources', payload: f.request }, { url: `/mining/shards/sources/by-key/${f.request.idempotencyKey}` }]) {
      const response = await app.inject(request); expect(response.statusCode).toBe(401); expect(response.headers['cache-control']).toBe('private, no-store');
    }
    for (const extra of [{ wallet: f.wallet }, { term: {} }, { gross: '1000' }, { admittedAt: now.toISOString() }]) expect((await post(app, f, { ...f.request, ...extra })).statusCode).toBe(400);
    expect((await app.inject({ url: `/mining/shards/sources/by-key/${f.request.idempotencyKey}?wallet=${f.wallet}`, cookies: f.cookies })).statusCode).toBe(400);
    expect((await get(app, f, 'bad')).statusCode).toBe(400);
    expect((await post(app, f)).statusCode).toBe(503); expect(connect).not.toHaveBeenCalled(); expect(deedReader).not.toHaveBeenCalled(); expect(await rows(f)).toHaveLength(0);
  });
  it('admits a genuine zero-winner term without minting and recovers immutable history after pause, restart and custody change', async () => {
    const f = await fixture(), app = await open();
    const response = await post(app, f); expect(response.statusCode, response.body).toBe(201);
    const accepted = response.json(); expect(accepted).toMatchObject({ wallet: f.wallet, source: { ...f.request, wallet: f.wallet, mineIds: [f.mine.id], admittedAt: now.toISOString() } });
    expect(accepted.source.termHash).toMatch(/^[0-9a-f]{64}$/); expect(connect).toHaveBeenCalledOnce();
    expect(await conn.sql`select wallet from shards_tax_assessments where wallet=${f.wallet}`).toHaveLength(0);
    await app.close(); servers.splice(servers.indexOf(app), 1); const restarted = await open(false); vi.stubEnv('PHASE_E_MINING_ENABLED', 'false');
    const buyer = await createTestPlayer(db); await db.delete(baseSlots).where(eq(baseSlots.baseId, f.base.id));
    await db.update(bases).set({ ownerWallet: buyer.wallet, status: 'inactive' }).where(eq(bases.id, f.base.id));
    const reads = connect.mock.calls.length;
    const replay = await post(restarted, f); expect(replay.statusCode, replay.body).toBe(200); expect(replay.json()).toEqual(accepted);
    const history = await get(restarted, f); expect(history.statusCode, history.body).toBe(200); expect(history.json()).toEqual(accepted); expect(history.headers['cache-control']).toBe('private, no-store');
    expect(connect).toHaveBeenCalledTimes(reads); expect(deedReader).not.toHaveBeenCalled(); expect(await rows(f)).toHaveLength(1);
    expect((await post(restarted, f, { ...f.request, baseId: randomUUID() })).statusCode).toBe(409);
  });
  it('does not disclose another wallet source through history or replay', async () => {
    const f = await fixture(), app = await open(); expect((await post(app, f)).statusCode).toBe(201);
    const other = await createTestPlayer(db), foreign = { ...f, wallet: other.wallet, cookies: await cookie(other.wallet) };
    const hidden = await get(app, foreign), missing = await get(app, foreign, randomUUID());
    expect(hidden.statusCode).toBe(200); expect(hidden.json()).toEqual(missing.json()); expect(hidden.json()).toEqual({ wallet: other.wallet, source: null });
    expect((await post(app, foreign)).statusCode).toBe(404); expect(await rows(f)).toHaveLength(1);
  });
  it('refuses missing providers and missing current base authority without creating a source', async () => {
    const f = await fixture(), missing = await open(false); expect((await post(missing, f)).statusCode).toBe(503);
    const app = await open(); await db.update(bases).set({ deedAssetId: Keypair.generate().publicKey.toBase58() }).where(eq(bases.id, f.base.id));
    expect((await post(app, f)).statusCode).toBe(503); expect(deedReader).toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled(); expect(await rows(f)).toHaveLength(0);
  });
  it('prefetches genuine term evidence before locks and rechecks ownership after that await', async () => {
    const f = await fixture(), app = await open(), prefetch = termReader.prefetchExpeditionTermReader;
    const transaction = db.transaction.bind(db); let locked = false;
    vi.spyOn(db, 'transaction').mockImplementation(async (...args) => {
      const [callback, config] = args; return transaction(async tx => { locked = true; try { return await callback(tx); } finally { locked = false; } }, config);
    });
    vi.spyOn(termReader, 'prefetchExpeditionTermReader').mockImplementation(async (...args) => {
      expect(locked).toBe(false); const reader = await prefetch(...args);
      await db.update(bases).set({ status: 'inactive' }).where(eq(bases.id, f.base.id)); return reader;
    });
    const response = await post(app, f); expect(response.statusCode, response.body).toBe(404); expect(connect).toHaveBeenCalledOnce(); expect(await rows(f)).toHaveLength(0);
  });
  it('rechecks pause after finalized prefetch before any durable admission', async () => {
    const f = await fixture(), app = await open(), prefetch = termReader.prefetchExpeditionTermReader;
    vi.spyOn(termReader, 'prefetchExpeditionTermReader').mockImplementation(async (...args) => { const reader = await prefetch(...args); vi.stubEnv('PHASE_E_MINING_ENABLED', 'false'); return reader; });
    expect((await post(app, f)).statusCode).toBe(503); expect(connect).toHaveBeenCalledOnce(); expect(await rows(f)).toHaveLength(0);
  });
  it('reports failed history storage as unavailable rather than fabricated absence', async () => {
    const f = await fixture(), app = await open(false); vi.spyOn(sources, 'readPhysicalMineTaxSource').mockRejectedValue(Error('storage unavailable'));
    const response = await get(app, f); expect(response.statusCode).toBe(503); expect(response.json().error.code).toBe('SHARDS_SOURCE_UNAVAILABLE'); expect(response.headers['cache-control']).toBe('private, no-store'); expect(response.json().source).toBeUndefined();
  });
});
