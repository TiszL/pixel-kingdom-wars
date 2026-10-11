import { randomUUID } from 'node:crypto';
import { BUILD_COSTS, BuildingType, GRID, buildCountCapForKeep } from '@shardkeep/shared';
import { WallBatchReceiptSchema, WallBatchStatusSchema, type WallBatchRequest } from '@shardkeep/shared/wallBatch';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, LOGIN_COOKIE, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import type { Db, DbOrTx, DbTx } from '../src/db/client';
import { accounts, baseDailyActivity, baseQuestProgress, bases, baseSlots, builderJobs, buildings, dailyActivity, ledgerEntries, ledgerTransactions, players, questProgress, sessions } from '../src/db/schema';
import { placeWallsBatch, wallBatchLedgerKey, type StableBaseMutationContext } from '../src/game/base';
import { assertFreshLockedBaseAuthority, transferStableBase } from '../src/game/baseOwnership';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { rewardShards } from '../src/game/spend';
import { executeWallBatchCommand, getWallBatchCommand } from '../src/game/wallBatch';
import { bootstrapSystemAccounts, getOrCreateBaseAccount, getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import { connectTestDb, createTestPlayer, randomWallet, TEST_CONFIG } from './helpers';

const conn = connectTestDb(); const db = conn.db;
const flags = ['MULTI_BASE_ENABLED', 'FREE_ONBOARDING', 'WALL_BATCH_V1_ENABLED'] as const;
const old = Object.fromEntries(flags.map(flag => [flag, process.env[flag]]));
beforeEach(() => { process.env['MULTI_BASE_ENABLED'] = 'false'; process.env['FREE_ONBOARDING'] = 'true'; process.env['WALL_BATCH_V1_ENABLED'] = 'true'; });
afterEach(() => { for (const flag of flags) { if (old[flag] === undefined) delete process.env[flag]; else process.env[flag] = old[flag]; } });
afterAll(async () => { await conn.sql.end(); });
const now = new Date('2034-06-01T00:00:00.000Z');
const unitCost = BigInt(BUILD_COSTS.wall.costShards);
async function fixture(stable = true, funding = unitCost * 100n) {
  const { wallet } = await createTestPlayer(db);
  let baseId: string | undefined;
  if (stable) {
    const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active', landPaidAt: now }).returning();
    baseId = base!.id; await db.insert(baseSlots).values({ wallet, baseId, slot: 1 });
    await rewardBaseShards(db, baseId, funding, 'test.wall.fund', randomUUID());
  } else await rewardShards(db, wallet, funding, 'test.wall.fund', randomUUID());
  const context: StableBaseMutationContext | undefined = baseId ? { baseId, assertAuthority: async (tx, actor, target) => { await assertFreshLockedBaseAuthority(tx, actor, target); } } : undefined;
  const request: WallBatchRequest = { idempotencyKey: randomUUID(), baseId: baseId ?? null,
    tiles: [{ tx: 8, ty: 9 }, { tx: 9, ty: 9 }], maxCostShards: String(unitCost * 2n) };
  const payer = baseId ? await getOrCreateBaseAccount(db, baseId, 'base_shards') : await getOrCreatePlayerAccount(db, wallet, 'player_shards');
  return { wallet, baseId, context, request, payer, submit: (r = request) => executeWallBatchCommand(db, wallet, r, now, context) };
}
async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    balance: (await db.select().from(accounts).where(eq(accounts.id, f.payer.id)))[0]!.balance,
    buildings: await db.select().from(buildings).where(eq(buildings.playerWallet, f.wallet)),
    jobs: await db.select().from(builderJobs).where(eq(builderJobs.playerWallet, f.wallet)),
    quests: f.baseId ? await db.select().from(baseQuestProgress).where(eq(baseQuestProgress.baseId, f.baseId))
      : await db.select().from(questProgress).where(eq(questProgress.playerWallet, f.wallet)),
    activity: f.baseId ? await db.select().from(baseDailyActivity).where(eq(baseDailyActivity.baseId, f.baseId))
      : await db.select().from(dailyActivity).where(eq(dailyActivity.playerWallet, f.wallet)),
  };
}
async function cookies(wallet: string) {
  const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  return { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
}
/** Faults stay inside real nested transactions; failures must undo the ledger,
 * lazy completions and every placement-side effect, not just omit the receipt. */
function faultDb(mode: 'insert' | 'proof' | 'readonly'): Db {
  function wrap<T extends DbOrTx>(target: T): T {
    return new Proxy(target, { get(t, key) {
      if (key === 'transaction') return (run: (tx: DbTx) => Promise<unknown>) => (t as Db).transaction(tx => run(wrap(tx)));
      if (mode === 'readonly' && ['insert', 'update', 'delete'].includes(String(key))) return () => { throw new Error('historical reader attempted mutation'); };
      if (mode === 'insert' && key === 'insert') return (table: typeof buildings) => { if (table === buildings) throw new Error('wall insert outage'); return t.insert(table); };
      if (mode === 'proof' && key === 'select') return (fields?: object) => {
        if (fields && 'delta' in fields) return { from: () => ({ innerJoin: () => ({ where: async () => [] }) }) };
        return fields ? t.select(fields as Parameters<T['select']>[0]) : t.select();
      };
      const value = Reflect.get(t, key); return typeof value === 'function' ? value.bind(t) : value;
    } });
  }
  return wrap(db);
}

describe.sequential('atomic original wall batch command', () => {
  for (const setting of [undefined, 'garbage', 'TRUE', 'false', 'true']) it(`fresh placement requires exact opt-in (${String(setting)}); history is independent`, async () => {
    const f = await fixture(false); const receipt = await f.submit(); const fresh = await fixture(false);
    if (setting === undefined) delete process.env['WALL_BATCH_V1_ENABLED']; else process.env['WALL_BATCH_V1_ENABLED'] = setting;
    const app = await buildApp(TEST_CONFIG, db); const auth = await cookies(f.wallet);
    try {
      const read = await app.inject({ method: 'GET', url: `/base/walls/batch/v1/${f.request.idempotencyKey}`, cookies: auth });
      expect(read.statusCode).toBe(200); expect(WallBatchStatusSchema.parse(read.json())).toMatchObject({ enabled: setting === 'true', receipt });
      const replay = await app.inject({ method: 'POST', url: '/base/walls/batch/v1', cookies: auth, payload: f.request });
      expect(replay.statusCode).toBe(200); expect(replay.json()).toEqual(receipt);
      const before = await snapshot(fresh);
      expect(await getWallBatchCommand(db, fresh.wallet, fresh.request.idempotencyKey)).toMatchObject({ enabled: setting === 'true', receipt: null });
      const response = await app.inject({ method: 'POST', url: '/base/walls/batch/v1', cookies: await cookies(fresh.wallet), payload: fresh.request });
      if (setting === 'true') expect(response.statusCode).toBe(201);
      else { expect(response.statusCode).toBe(503); expect(response.json().error.code).toBe('WALL_BATCH_DISABLED'); expect(await snapshot(fresh)).toEqual(before); }
      for (const r of [read, replay, response]) expect(r.headers['cache-control']).toBe('private, no-store');
    } finally { await app.close(); }
  });
  for (const mode of ['legacy', 'stable-flag-off', 'stable-flag-on']) it(`${mode}: concurrent same-consent requests create exactly one complete stroke and actual two-leg receipt`, async () => {
    const f = await fixture(mode !== 'legacy'); process.env['MULTI_BASE_ENABLED'] = String(mode === 'stable-flag-on');
    const before = await snapshot(f);
    const results = await Promise.all(Array.from({ length: 4 }, () => f.submit()));
    const receipt = WallBatchReceiptSchema.parse(results[0]); results.forEach(r => expect(r).toEqual(receipt));
    expect(receipt.request).toEqual(f.request); expect(receipt.funding.amount).toBe(String(unitCost * 2n));
    const after = await snapshot(f); expect(after.balance).toBe(before.balance - unitCost * 2n); expect(after.jobs).toHaveLength(0);
    expect(after.buildings.map(b => ({ tx: b.tx, ty: b.ty }))).toEqual(f.request.tiles);
    const [txn] = await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.id, receipt.receiptId));
    expect(txn!.idempotencyKey).toBe(wallBatchLedgerKey(f.wallet, f.request.idempotencyKey)); expect(receipt.acceptedAt).toBe(txn!.createdAt.toISOString());
    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.txnId, receipt.receiptId));
    expect(entries.map(e => e.delta).sort()).toEqual([-unitCost * 2n, unitCost * 2n].sort());
    expect(entries.find(e => e.delta < 0n)!.accountId).toBe(f.payer.id);
  });
  it('a generous ceiling still burns only the current server cost', async () => {
    const f = await fixture(); const r = await f.submit({ ...f.request, maxCostShards: String(unitCost * 3n) });
    expect(r.funding.amount).toBe(String(unitCost * 2n)); expect(r.request.maxCostShards).toBe(String(unitCost * 3n));
  });
  it('an original key never accepts a changed scope, tile order, tile set or ceiling even while paused', async () => {
    const f = await fixture(); await f.submit(); const before = await snapshot(f); process.env['WALL_BATCH_V1_ENABLED'] = 'false';
    for (const request of [{ ...f.request, baseId: null }, { ...f.request, baseId: randomUUID() },
      { ...f.request, tiles: [...f.request.tiles].reverse() }, { ...f.request, tiles: [{ tx: 10, ty: 9 }] },
      { ...f.request, maxCostShards: String(unitCost * 3n) }]) {
      await expect(f.submit(request)).rejects.toMatchObject({ code: 'WALL_BATCH_MISMATCH' });
    }
    expect(await snapshot(f)).toEqual(before);
  });
  it('a geometry conflict, over-cap stroke or lower ceiling is all-or-nothing', async () => {
    for (const kind of ['geometry', 'cap', 'ceiling']) {
      const f = await fixture();
      let request = f.request;
      if (kind === 'geometry') await db.insert(buildings).values({ playerWallet: f.wallet, baseId: f.baseId!, type: 'wall', tx: 9, ty: 9 });
      if (kind === 'cap') {
        const cap = buildCountCapForKeep(BuildingType.Wall, 1)!;
        await db.insert(buildings).values(Array.from({ length: cap - 1 }, (_, i) => ({ playerWallet: f.wallet, baseId: f.baseId!, type: BuildingType.Wall,
          tx: (GRID.plotTiles - GRID.claimTiles) / 2 + i % GRID.claimTiles, ty: 12 + Math.floor(i / GRID.claimTiles) })));
      }
      if (kind === 'ceiling') request = { ...request, maxCostShards: String(unitCost) };
      const before = await snapshot(f); await expect(f.submit(request)).rejects.toThrow(); expect(await snapshot(f)).toEqual(before);
      expect((await getWallBatchCommand(db, f.wallet, request.idempotencyKey)).receipt).toBeNull();
    }
  });
  it('insufficient funding cannot place an affordable prefix', async () => {
    const f = await fixture(true, unitCost); const before = await snapshot(f);
    await expect(f.submit()).rejects.toThrow(); expect(await snapshot(f)).toEqual(before);
  });
  for (const mode of ['insert', 'proof'] as const) it(`${mode} failure rolls back debit, walls, lazy jobs and quest/activity effects`, async () => {
    const f = await fixture();
    const [b] = await db.insert(buildings).values({ playerWallet: f.wallet, baseId: f.baseId!, type: 'keep', tx: 15, ty: 15 }).returning();
    await db.insert(builderJobs).values({ playerWallet: f.wallet, baseId: f.baseId!, buildingId: b!.id, kind: 'build', startedAt: new Date('2020-01-01T00:00:00.000Z'), finishesAt: new Date('2020-01-02T00:00:00.000Z') });
    const before = await snapshot(f);
    await expect(executeWallBatchCommand(faultDb(mode), f.wallet, f.request, now, f.context)).rejects.toThrow();
    expect(await snapshot(f)).toEqual(before); expect((await getWallBatchCommand(db, f.wallet, f.request.idempotencyKey)).receipt).toBeNull();
  });
  it('never auto-selects current base or substitutes wallet funding for an explicit base', async () => {
    const f = await fixture(); const before = await snapshot(f); process.env['MULTI_BASE_ENABLED'] = 'true';
    await expect(f.submit({ ...f.request, baseId: null })).rejects.toMatchObject({ code: 'BASE_ID_REQUIRED' });
    await expect(executeWallBatchCommand(db, f.wallet, f.request, now)).rejects.toMatchObject({ code: 'WALL_BATCH_CONTEXT_MISMATCH' });
    await expect(executeWallBatchCommand(db, f.wallet, f.request, now, { baseId: randomUUID(), assertAuthority: async () => {} })).rejects.toMatchObject({ code: 'WALL_BATCH_CONTEXT_MISMATCH' });
    expect(await snapshot(f)).toEqual(before);
  });
  it('checks frozen deed authority inside the locked write transaction', async () => {
    const f = await fixture(); const before = await snapshot(f);
    await expect(executeWallBatchCommand(db, f.wallet, f.request, now, { baseId: f.baseId!, assertAuthority: async () => { throw new Error('deed evidence expired while waiting'); } })).rejects.toThrow(/expired/);
    expect(await snapshot(f)).toEqual(before);
  });
  it('retains old actor proof after real transfer and wall movement/deletion with no buyer access', async () => {
    const f = await fixture(); const receipt = await f.submit(); const buyer = await createTestPlayer(db); const asset = randomWallet();
    await db.update(bases).set({ deedAssetId: asset }).where(eq(bases.id, f.baseId!));
    await transferStableBase(db, f.baseId!, f.wallet, buyer.wallet, asset);
    await db.delete(buildings).where(eq(buildings.baseId, f.baseId!));
    process.env['WALL_BATCH_V1_ENABLED'] = 'false'; process.env['MULTI_BASE_ENABLED'] = 'true';
    expect((await getWallBatchCommand(faultDb('readonly'), f.wallet, f.request.idempotencyKey)).receipt).toEqual(receipt);
    expect(await executeWallBatchCommand(db, f.wallet, f.request)).toEqual(receipt);
    expect((await getWallBatchCommand(db, buyer.wallet, f.request.idempotencyKey)).receipt).toBeNull();
  });
  it('GET serializes with the actual writer and sees complete acceptance after commit', async () => {
    const f = await fixture(); let entered!: () => void; let release!: () => void;
    const inside = new Promise<void>(r => { entered = r; }); const finish = new Promise<void>(r => { release = r; });
    const pending = executeWallBatchCommand(db, f.wallet, f.request, now, { baseId: f.baseId!, assertAuthority: async (tx, actor, base) => {
      await f.context!.assertAuthority(tx, actor, base); entered(); await finish;
    } });
    let read: ReturnType<typeof getWallBatchCommand> | undefined;
    try {
      await inside; read = getWallBatchCommand(db, f.wallet, f.request.idempotencyKey);
      await expect.poll(async () => Number((await conn.sql`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%players%wallet%'`)[0]!.n)).toBeGreaterThan(0);
    } finally { release(); }
    const receipt = await pending; expect((await read!)!.receipt).toEqual(receipt);
  });
  it('legacy output/dedup and free-form build namespace remain unchanged and never backfill proof', async () => {
    const f = await fixture(false); process.env['WALL_BATCH_V1_ENABLED'] = 'false';
    const legacyKey = wallBatchLedgerKey(f.wallet, f.request.idempotencyKey);
    const legacy = await placeWallsBatch(db, f.wallet, [f.request.tiles[0]!, f.request.tiles[0]!], legacyKey, now);
    expect(Object.keys(legacy)).toEqual(['buildings', 'cost']); expect(legacy.buildings).toHaveLength(1); expect(legacy.cost).toBe(String(unitCost));
    expect((await getWallBatchCommand(db, f.wallet, f.request.idempotencyKey)).receipt).toBeNull();
    process.env['WALL_BATCH_V1_ENABLED'] = 'true';
    const receipt = await f.submit({ ...f.request, tiles: [{ tx: 10, ty: 9 }] }); expect(receipt.funding.amount).toBe(String(unitCost));
    const transactions = await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, `build:${f.wallet}:${legacyKey}`));
    expect(transactions).toHaveLength(1); expect(transactions[0]!.metadata).toMatchObject({ type: 'wall', count: 1 });
  });
  it('legacy and v1 overlap races accept one complete geometry owner', async () => {
    const f = await fixture();
    const outcomes = await Promise.allSettled([f.submit(), placeWallsBatch(db, f.wallet, f.request.tiles, f.request.idempotencyKey, now, f.baseId, f.context)]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await snapshot(f)).buildings).toHaveLength(f.request.tiles.length);
    expect((await getWallBatchCommand(db, f.wallet, f.request.idempotencyKey)).receipt !== null).toBe(outcomes[0]!.status === 'fulfilled');
  });
  for (const corruption of ['legacy-metadata', 'actor', 'key', 'scope', 'type', 'currency', 'source', 'sink', 'extra-legs', 'above-ceiling'] as const) {
    it(`occupied ${corruption} proof blocks GET/replay and never makes a second debit`, async () => {
      const f = await fixture(false); const sys = await bootstrapSystemAccounts(db);
      let metadata: Record<string, unknown> = { wallet: f.wallet, wallBatchV1: { actor: f.wallet, request: f.request } };
      if (corruption === 'legacy-metadata') metadata = { wallet: f.wallet, type: 'wall', count: 2 };
      if (corruption === 'actor') metadata = { wallet: f.wallet, wallBatchV1: { actor: randomWallet(), request: f.request } };
      if (corruption === 'key') metadata = { wallet: f.wallet, wallBatchV1: { actor: f.wallet, request: { ...f.request, idempotencyKey: randomUUID() } } };
      if (corruption === 'scope') metadata = { baseId: randomUUID(), wallBatchV1: { actor: f.wallet, request: f.request } };
      const amount = corruption === 'above-ceiling' ? BigInt(f.request.maxCostShards) + 1n : unitCost;
      let entries = [{ account: f.payer.id, delta: -amount }, { account: sys.shard_burn, delta: amount }];
      if (corruption === 'currency') entries = [{ account: sys.keep_genesis, delta: -amount }, { account: sys.burn, delta: amount }];
      if (corruption === 'source') entries[0] = { account: sys.shard_genesis, delta: -amount };
      if (corruption === 'sink') entries[1] = { account: sys.shard_genesis, delta: amount };
      if (corruption === 'extra-legs') entries = [{ account: f.payer.id, delta: -amount }, { account: sys.shard_burn, delta: amount - 1n }, { account: sys.shard_genesis, delta: 1n }];
      await postTransaction(db, { type: corruption === 'type' ? 'test.not.wall' : 'build.place', idempotencyKey: wallBatchLedgerKey(f.wallet, f.request.idempotencyKey), metadata, entries });
      process.env['WALL_BATCH_V1_ENABLED'] = 'false';
      const before = await snapshot(f);
      await expect(getWallBatchCommand(db, f.wallet, f.request.idempotencyKey)).rejects.toMatchObject({ code: 'WALL_BATCH_EVIDENCE_UNAVAILABLE' });
      await expect(f.submit()).rejects.toMatchObject({ code: 'WALL_BATCH_EVIDENCE_UNAVAILABLE' }); expect(await snapshot(f)).toEqual(before);
    });
  }
  it('HTTP history/auth/validation/land failures are private and never bootstrap current state', async () => {
    const f = await fixture(false); const receipt = await f.submit(); const auth = await cookies(f.wallet);
    process.env['FREE_ONBOARDING'] = 'false'; const app = await buildApp(TEST_CONFIG, db); const before = await snapshot(f);
    try {
      const url = `/base/walls/batch/v1/${f.request.idempotencyKey}`;
      expect((await app.inject({ method: 'POST', url: '/base/walls/batch/v1', cookies: auth, payload: f.request })).json()).toEqual(receipt);
      const read = await app.inject({ method: 'GET', url, cookies: auth }); expect(read.json().receipt).toEqual(receipt);
      const stranger = await createTestPlayer(db);
      const foreign = await app.inject({ method: 'GET', url, cookies: await cookies(stranger.wallet) });
      expect(foreign.statusCode).toBe(200); expect(foreign.json().receipt).toBeNull();
      expect(foreign.json().wallet).toBe(stranger.wallet); expect(foreign.headers['cache-control']).toBe('private, no-store');
      const missing = await app.inject({ method: 'GET', url: `/base/walls/batch/v1/${randomUUID()}`, cookies: auth }); expect(missing.json().receipt).toBeNull();
      const fresh = await app.inject({ method: 'POST', url: '/base/walls/batch/v1', cookies: auth, payload: { ...f.request, idempotencyKey: randomUUID() } });
      expect(fresh.statusCode).toBe(402);
      const failures = [fresh, await app.inject({ method: 'GET', url }), await app.inject({ method: 'GET', url, cookies: { ...auth, [LOGIN_COOKIE]: 'pending' } }),
        await app.inject({ method: 'GET', url: '/base/walls/batch/v1/invalid', cookies: auth }),
        await app.inject({ method: 'POST', url: '/base/walls/batch/v1', cookies: auth, payload: { ...f.request, amount: '1' } })];
      failures.forEach(r => { expect(r.statusCode).toBeGreaterThanOrEqual(400); expect(r.headers['cache-control']).toBe('private, no-store'); });
      for (const r of [read, missing]) expect(r.headers['cache-control']).toBe('private, no-store');
      expect(await snapshot(f)).toEqual(before);
    } finally { await app.close(); }
  });
  it('HTTP respects explicit base with rollout off and refuses foreign/stale authority', async () => {
    const f = await fixture(); const app = await buildApp(TEST_CONFIG, db); const auth = await cookies(f.wallet);
    try {
      const unknown = await app.inject({ method: 'POST', url: '/base/walls/batch/v1', cookies: auth, payload: { ...f.request, baseId: randomUUID() } }); expect(unknown.statusCode).toBe(404);
      await db.update(bases).set({ deedMintAssetId: randomWallet() }).where(eq(bases.id, f.baseId!)); const before = await snapshot(f);
      expect((await app.inject({ method: 'POST', url: '/base/walls/batch/v1', cookies: auth, payload: f.request })).statusCode).toBe(503); expect(await snapshot(f)).toEqual(before);
      await db.update(bases).set({ deedMintAssetId: null }).where(eq(bases.id, f.baseId!));
      const response = await app.inject({ method: 'POST', url: '/base/walls/batch/v1', cookies: auth, payload: f.request }); expect(response.statusCode).toBe(201);
      expect(response.json().request.baseId).toBe(f.baseId);
    } finally { await app.close(); }
  });
});
