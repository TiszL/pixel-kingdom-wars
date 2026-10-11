import { randomUUID } from 'node:crypto';
import { BuildingType, MINING, PLOT_GEOMETRY, plotBounds } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, LOGIN_COOKIE, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import type { Db } from '../src/db/client';
import { accounts, bases, baseSlots, builderJobs, buildings, itemUses, ledgerTransactions, sessions } from '../src/db/schema';
import { completeDueJobs, ensureStartingBase, placeBuilding } from '../src/game/base';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { transferStableBase } from '../src/game/baseOwnership';
import { ConstructionReceiptAbsentSchema, ConstructionReceiptQuerySchema, ConstructionReceiptSchema, getConstructionReceipt, readConstructionReceipt } from '../src/game/constructionReceipt';
import { rewardShards } from '../src/game/spend';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep, holdPlayerLock, randomWallet, settlesWithin, TEST_CONFIG } from './helpers';

const conn = connectTestDb(); const db = conn.db;
const mode = process.env['MULTI_BASE_ENABLED'];
const at = new Date('2026-09-07T00:00:00Z');
beforeAll(async () => { process.env['MULTI_BASE_ENABLED'] = 'false'; await bootstrapSystemAccounts(db); });
afterAll(async () => {
  if (mode === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = mode;
  await conn.sql.end();
});
async function fixture(stable: boolean) {
  const { wallet } = await createTestPlayer(db);
  const asset = randomWallet();
  let baseId: string | undefined;
  if (stable) {
    const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active', keepLevel: 8, deedAssetId: asset, landPaidAt: at }).returning();
    baseId = base!.id;
    await db.insert(baseSlots).values({ wallet, slot: 1, baseId });
    await rewardBaseShards(db, baseId, 100_000n, 'test.receipt', randomUUID());
  } else {
    await ensureStartingBase(db, wallet);
    await rewardShards(db, wallet, 100_000n, 'test.receipt', randomUUID());
  }
  await fundTestKeep(db, wallet, 100_000n, 'test.receipt', randomUUID());
  const request = { type: BuildingType.Mine, tx: 11, ty: 8, idempotencyKey: randomUUID(), ...(baseId ? { baseId } : {}) };
  const place = () => placeBuilding(db, wallet, request.type, request.tx, request.ty, request.idempotencyKey, at, baseId);
  return { wallet, baseId, asset, request, place };
}

for (const stable of [false, true]) describe(`ordinary construction acceptance (${stable ? 'stable' : 'legacy'})`, () => {
  it('proves a lost accepted reply without repeating its debit or touching due jobs or moved buildings', async () => {
    const f = await fixture(stable); const building = await f.place();
    await db.update(buildings).set({ tx: 12 }).where(eq(buildings.id, building.id));
    const jobs = await db.select().from(builderJobs).where(eq(builderJobs.buildingId, building.id));
    const ledger = await db.select().from(ledgerTransactions);
    const balances = await db.select().from(accounts);
    const receipt = await getConstructionReceipt(db, f.wallet, f.request);
    expect(receipt).toMatchObject({ version: 1, status: 'accepted', request: f.request, baseId: f.baseId ?? null,
      funding: { currency: 'SHARDS', amount: String(MINING.MINE_BUILD_KEEP[0]) } });
    expect(ConstructionReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(receipt).not.toHaveProperty('building'); expect(receipt).not.toHaveProperty('result');
    expect(await getConstructionReceipt(db, f.wallet, f.request)).toEqual(receipt);
    expect(await db.select().from(builderJobs).where(eq(builderJobs.buildingId, building.id))).toEqual(jobs);
    expect(await db.select().from(ledgerTransactions)).toEqual(ledger);
    expect(await db.select().from(accounts)).toEqual(balances);
    expect((await db.select().from(buildings).where(eq(buildings.id, building.id)))[0]!.tx).toBe(12);
  });
  it('leaves changed bodies, base ambiguity and another wallet unresolved', async () => {
    const f = await fixture(stable); await f.place(); const other = await createTestPlayer(db);
    for (const request of [
      { ...f.request, tx: 12 }, { ...f.request, ty: 9 }, { ...f.request, type: BuildingType.Wall },
      { ...f.request, idempotencyKey: randomUUID() }, { ...f.request, baseId: randomUUID() },
      ...(stable ? [{ ...f.request, baseId: undefined }] : []),
    ]) expect((await getConstructionReceipt(db, f.wallet, request)).status).toBe('unknown');
    expect((await getConstructionReceipt(db, other.wallet, f.request)).status).toBe('unknown');
    if (f.baseId) expect((await getConstructionReceipt(db, f.wallet, { ...f.request, baseId: f.baseId.toUpperCase() })).status).toBe('accepted');
  });
  it('recognizes the actual progressive KEEP debit without rebuilding the current price', async () => {
    const f = await fixture(stable); await f.place();
    await completeDueJobs(db, f.wallet, new Date(at.getTime() + 120_000), f.baseId);
    const second = { ...f.request, tx: 17, ty: 14, idempotencyKey: randomUUID() };
    await placeBuilding(db, f.wallet, second.type, second.tx, second.ty, second.idempotencyKey, new Date(at.getTime() + 120_000), f.baseId);
    expect(await getConstructionReceipt(db, f.wallet, second)).toMatchObject({ status: 'accepted', funding: { currency: 'KEEP', amount: String(MINING.MINE_BUILD_KEEP[1]) } });
  });
});

it('retains seller receipt access after a real stable transfer without giving it to the buyer', async () => {
  const f = await fixture(true); await f.place(); const buyer = await createTestPlayer(db);
  const original = await getConstructionReceipt(db, f.wallet, f.request);
  await transferStableBase(db, f.baseId!, f.wallet, buyer.wallet, f.asset);
  expect(await getConstructionReceipt(db, f.wallet, f.request)).toEqual(original);
  expect((await getConstructionReceipt(db, buyer.wallet, f.request)).status).toBe('unknown');
});

it('recovers an instant single wall but does not report an uncommitted placement as accepted', async () => {
  const f = await fixture(false);
  const wall = { ...f.request, type: BuildingType.Wall };
  const built = await placeBuilding(db, f.wallet, wall.type, wall.tx, wall.ty, wall.idempotencyKey, at);
  expect((await getConstructionReceipt(db, f.wallet, wall)).status).toBe('accepted');
  expect(await db.select().from(builderJobs).where(eq(builderJobs.buildingId, built.id))).toEqual([]);
  const next = await fixture(false);
  const transaction = db.transaction.bind(db);
  const spy = vi.spyOn(db, 'transaction').mockImplementationOnce((work, config) => transaction(async (tx) => {
    await work(tx); throw new Error('test rollback after placement inserts');
  }, config));
  try { await expect(next.place()).rejects.toThrow('test rollback after placement inserts'); }
  finally { spy.mockRestore(); }
  expect((await getConstructionReceipt(db, next.wallet, next.request)).status).toBe('unknown');
  expect((await db.select().from(buildings).where(eq(buildings.playerWallet, next.wallet))).filter((b) => b.type === BuildingType.Mine)).toEqual([]);
});

it('does not mistake a matching ledger key or coordinates for evidence of the intended operation and debit', async () => {
  const f = await fixture(false); const sys = await bootstrapSystemAccounts(db);
  const payer = await getOrCreatePlayerAccount(db, f.wallet, 'player_shards');
  const other = await createTestPlayer(db);
  await rewardShards(db, other.wallet, 1000n, 'test.receipt', randomUUID());
  const otherAccount = await getOrCreatePlayerAccount(db, other.wallet, 'player_shards');
  const metadata = { wallet: f.wallet, type: f.request.type, tx: f.request.tx, ty: f.request.ty };
  for (const variant of [
    { type: 'build.place', metadata: { wallet: f.wallet, type: 'wall', count: 1 }, payer: payer.id },
    { type: 'hero.recruit', metadata, payer: payer.id },
    { type: 'build.mine', metadata, payer: payer.id },
    { type: 'build.place', metadata: { ...metadata, wallet: other.wallet }, payer: payer.id },
    { type: 'build.place', metadata, payer: otherAccount.id },
    { type: 'build.place', metadata: { ...metadata, tx: '11' }, payer: payer.id },
  ]) {
    const request = { ...f.request, idempotencyKey: randomUUID() };
    await postTransaction(db, { idempotencyKey: `build:${f.wallet}:${request.idempotencyKey}`, type: variant.type, metadata: variant.metadata,
      entries: [{ account: variant.payer, delta: -1n }, { account: sys.shard_burn, delta: 1n }] });
    expect((await getConstructionReceipt(db, f.wallet, request)).status).toBe('unknown');
  }
  const missingEntries = { ...f.request, idempotencyKey: randomUUID() };
  await db.insert(ledgerTransactions).values({ idempotencyKey: `build:${f.wallet}:${missingEntries.idempotencyKey}`, type: 'build.place', metadata });
  expect((await getConstructionReceipt(db, f.wallet, missingEntries)).status).toBe('unknown');
});

it('recovers a signed-tile receipt from original ledger proof without expanding or repricing today’s base', async () => {
  const f = await fixture(false);
  const sys = await bootstrapSystemAccounts(db);
  const payer = await getOrCreatePlayerAccount(db, f.wallet, 'player_shards');
  const { min, max } = plotBounds(PLOT_GEOMETRY.currentVersion);
  const request = { ...f.request, type: BuildingType.Wall, tx: min, ty: max - 1 };
  await postTransaction(db, {
    idempotencyKey: `build:${f.wallet}:${request.idempotencyKey}`, type: 'build.place',
    metadata: { wallet: f.wallet, type: request.type, tx: request.tx, ty: request.ty },
    entries: [{ account: payer.id, delta: -1n }, { account: sys.shard_burn, delta: 1n }],
  });
  const before = await db.select().from(accounts);
  const receipt = await getConstructionReceipt(db, f.wallet, request);
  expect(receipt).toMatchObject({ status: 'accepted', request, funding: { currency: 'SHARDS', amount: '1' } });
  expect((await getConstructionReceipt(db, f.wallet, { ...request, tx: min + 1 })).status).toBe('unknown');
  expect(await db.select().from(accounts)).toEqual(before);
  expect(ConstructionReceiptQuerySchema.parse({ ...request, tx: String(min), ty: String(max - 1) })).toEqual(request);
  expect(ConstructionReceiptQuerySchema.safeParse({ ...request, tx: min - 1 }).success).toBe(false);
  expect(ConstructionReceiptQuerySchema.safeParse({ ...request, ty: max }).success).toBe(false);
});

it('requires full live authentication but no current land, and accepts only a bounded original query', async () => {
  const f = await fixture(false); await f.place();
  const [session] = await db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id) };
  const app = await buildApp(TEST_CONFIG, db);
  const url = `/base/buildings/receipt?${new URLSearchParams(Object.entries(f.request).map(([k,v]) => [k,String(v)]))}`;
  try {
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const response = await app.inject({ method: 'GET', url, cookies });
    expect(response.statusCode).toBe(200); expect(response.json().status).toBe('accepted');
    expect(response.headers['cache-control']).toBe('no-store');
    expect((await app.inject({ method: 'GET', url: `${url}&wallet=${f.wallet}`, cookies })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url, cookies: { ...cookies, [LOGIN_COOKIE]: 'pending' } })).statusCode).toBe(403);
    await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, session!.id));
    expect((await app.inject({ method: 'GET', url, cookies })).statusCode).toBe(401);
  } finally { await app.close(); }
  expect(ConstructionReceiptQuerySchema.safeParse({ ...f.request, baseId: null }).success).toBe(false);
  expect(ConstructionReceiptQuerySchema.safeParse({ ...f.request, heroContractOnly: true }).success).toBe(false);
});

// GET /base/buildings/receipt answers `absent` only as proof that no committed
// command claimed `build:<wallet>:<key>`. The native client forgets a saved
// placement on that answer, so a wrong `absent` would hide a real charge and a
// lost `absent` would block BUILD forever.
const claimedRows = (wallet: string, key: string) => db.select().from(ledgerTransactions)
  .where(eq(ledgerTransactions.idempotencyKey, `build:${wallet}:${key}`));

describe('route answer: absent only when no row claims the wallet key', () => {
  for (const stable of [false, true]) {
    it(`a never-claimed key is absent with a server time; once committed it is accepted, never absent (${stable ? 'stable' : 'legacy'})`, async () => {
      const f = await fixture(stable); const before = Date.now();
      const answer = await readConstructionReceipt(db, f.wallet, f.request);
      expect(ConstructionReceiptAbsentSchema.parse(answer)).toEqual({
        version: 1, status: 'absent', idempotencyKey: f.request.idempotencyKey, absentAsOf: expect.any(String) });
      const absentAsOf = Date.parse((answer as { absentAsOf: string }).absentAsOf);
      expect(absentAsOf).toBeGreaterThanOrEqual(before); expect(absentAsOf).toBeLessThanOrEqual(Date.now());
      // Reading never claims the key, so the original request can still commit.
      expect(await claimedRows(f.wallet, f.request.idempotencyKey)).toEqual([]);
      await f.place();
      const accepted = await readConstructionReceipt(db, f.wallet, f.request);
      expect(accepted.status).toBe('accepted');
      expect(accepted).toEqual(await getConstructionReceipt(db, f.wallet, f.request));
    });
    it(`an existing row that does not match the query stays unknown, never absent (${stable ? 'stable' : 'legacy'})`, async () => {
      const f = await fixture(stable); await f.place();
      for (const request of [
        { ...f.request, tx: 12 }, { ...f.request, ty: 9 }, { ...f.request, type: BuildingType.Wall },
        { ...f.request, baseId: randomUUID() }, ...(stable ? [{ ...f.request, baseId: undefined }] : []),
      ]) expect((await readConstructionReceipt(db, f.wallet, request)).status).toBe('unknown');
    });
  }
  it('Keep and altar types stay unknown even for a never-claimed key, as before', async () => {
    const f = await fixture(false);
    for (const type of [BuildingType.Keep, BuildingType.HeroAltar, BuildingType.SiegeStool])
      expect(await readConstructionReceipt(db, f.wallet, { ...f.request, type, idempotencyKey: randomUUID() }))
        .toEqual({ version: 1, status: 'unknown', idempotencyKey: expect.any(String) });
  });
  it('a forged, foreign-shaped or entry-less ledger row under the key stays unknown', async () => {
    const f = await fixture(false); const sys = await bootstrapSystemAccounts(db);
    const payer = await getOrCreatePlayerAccount(db, f.wallet, 'player_shards');
    const metadata = { wallet: f.wallet, type: f.request.type, tx: f.request.tx, ty: f.request.ty };
    for (const type of ['hero.recruit', 'build.mine']) {
      const request = { ...f.request, idempotencyKey: randomUUID() };
      await postTransaction(db, { idempotencyKey: `build:${f.wallet}:${request.idempotencyKey}`, type, metadata,
        entries: [{ account: payer.id, delta: -1n }, { account: sys.shard_burn, delta: 1n }] });
      expect((await readConstructionReceipt(db, f.wallet, request)).status).toBe('unknown');
    }
    const entryless = { ...f.request, idempotencyKey: randomUUID() };
    await db.insert(ledgerTransactions).values({ idempotencyKey: `build:${f.wallet}:${entryless.idempotencyKey}`, type: 'build.place', metadata });
    expect((await readConstructionReceipt(db, f.wallet, entryless)).status).toBe('unknown');
  });
  it('a hero-contract item use (no ledger row, wallet or base scoped) still claims the key for this wallet only', async () => {
    const f = await fixture(false); const other = await createTestPlayer(db);
    const walletScoped = randomUUID(); const baseScoped = randomUUID();
    await db.insert(itemUses).values([
      { playerWallet: f.wallet, itemId: 'hero_contract_test', idempotencyKey: `build:${f.wallet}:${walletScoped}` },
      { playerWallet: f.wallet, itemId: 'hero_contract_test', idempotencyKey: `build:${f.wallet}:${randomUUID()}:${baseScoped}` },
    ]);
    for (const idempotencyKey of [walletScoped, baseScoped])
      expect((await readConstructionReceipt(db, f.wallet, { ...f.request, idempotencyKey })).status).toBe('unknown');
    // The namespace is per wallet: another wallet never claimed these keys.
    expect((await readConstructionReceipt(db, other.wallet, { ...f.request, idempotencyKey: walletScoped })).status).toBe('absent');
  });
  it.each(['commit', 'rollback'] as const)('waits for a placement still holding the wallet lock instead of answering past it (%s)', async (outcome) => {
    const f = await fixture(false);
    const finish = await holdPlayerLock(db, f.wallet, (tx) => placeBuilding(tx as unknown as Db, f.wallet, f.request.type, f.request.tx, f.request.ty, f.request.idempotencyKey, at), outcome);
    const reading = readConstructionReceipt(db, f.wallet, f.request);
    // The uncommitted claim is invisible to other sessions; without the lock wait
    // this read would already have answered `absent` for a charge about to commit.
    let answeredEarly: boolean;
    try { answeredEarly = await settlesWithin(reading, 400); } finally { await finish(); }
    expect(answeredEarly).toBe(false);
    expect((await reading).status).toBe(outcome === 'commit' ? 'accepted' : 'absent');
  });
  it('HTTP answers the exact absent shape, then the accepted receipt, without caching either', async () => {
    const f = await fixture(false);
    const [session] = await db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
    const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id) };
    const app = await buildApp(TEST_CONFIG, db);
    const url = `/base/buildings/receipt?${new URLSearchParams(Object.entries(f.request).map(([k, v]) => [k, String(v)]))}`;
    try {
      const absent = await app.inject({ method: 'GET', url, cookies });
      expect(absent.statusCode, absent.body).toBe(200); expect(absent.headers['cache-control']).toBe('no-store');
      expect(Object.keys(absent.json()).sort()).toEqual(['absentAsOf', 'idempotencyKey', 'status', 'version']);
      expect(ConstructionReceiptAbsentSchema.parse(absent.json())).toMatchObject({ status: 'absent', idempotencyKey: f.request.idempotencyKey });
      await f.place();
      const accepted = await app.inject({ method: 'GET', url, cookies });
      expect(accepted.statusCode).toBe(200); expect(accepted.json().status).toBe('accepted');
      expect(accepted.headers['cache-control']).toBe('no-store');
    } finally { await app.close(); }
  });
});
