import { trainBatch } from './training-consent';
/** An unknown purchase is not a rejection. Closing its key must exclude a late
 * debit even when acceptance and explicit abandonment race across connections. */
import { randomUUID } from 'node:crypto';
import { BuildingType, TROOPS, type TrainingComposition } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, LOGIN_COOKIE, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { armyTrainingBatches, armyTrainingBatchClosures, bases, baseSlots, baseTrainingQueue, buildings, sessions, trainingQueue } from '../src/db/schema';
import { getArmyState, quoteTraining } from '../src/game/army';
import { ensureStartingBase } from '../src/game/base';
import { getBaseShardBalance, rewardBaseShards } from '../src/game/baseEconomy';
import { transferStableBase } from '../src/game/baseOwnership';
import { rewardShards } from '../src/game/spend';
import type { StableBaseMutationContext } from '../src/game/stableBasePrerequisites';
import { closeTrainingBatch, getTrainingReceipt, TrainingCloseBodySchema, TrainingRecoverySchema } from '../src/game/trainingRecovery';
import * as recovery from '../src/game/trainingRecovery';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, randomWallet, TEST_CONFIG } from './helpers';

const conn = connectTestDb(); const db = conn.db;
const originalMode = process.env['MULTI_BASE_ENABLED'];
const at = new Date('2026-09-06T12:00:00Z');
const key = () => randomUUID();
const composition: TrainingComposition = [{ troop: 'highlander', count: 2 }];
const cost = String(TROOPS.highlander.costKeep * 2);
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => {
  if (originalMode === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = originalMode;
  await conn.sql.end();
});

async function fixture(stable: boolean) {
  const { wallet } = await createTestPlayer(db);
  let context: StableBaseMutationContext | undefined;
  let asset: string | undefined;
  if (stable) {
    // Stable transfers project the deed into the buyer's legacy identity.
    // Keep its representation canonical for shared-DB metadata sweeps.
    asset = randomWallet();
    const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active', keepLevel: 8, deedAssetId: asset, landPaidAt: at }).returning();
    await db.insert(baseSlots).values({ wallet, slot: 1, baseId: base!.id });
    context = { baseId: base!.id, assertAuthority: async () => {} };
    await rewardBaseShards(db, base!.id, 100_000n, 'test.recovery', key());
  } else {
    await ensureStartingBase(db, wallet);
    await rewardShards(db, wallet, 100_000n, 'test.recovery', key());
  }
  await db.insert(buildings).values([
    { playerWallet: wallet, baseId: context?.baseId, type: BuildingType.Barracks, level: 3, tx: 8, ty: 8 },
    { playerWallet: wallet, baseId: context?.baseId, type: BuildingType.Camp, level: 3, tx: 18, ty: 8 },
  ]);
  const balance = async () => context ? getBaseShardBalance(db, context.baseId) : (await getOrCreatePlayerAccount(db, wallet, 'player_shards')).balance;
  const queue = async () => context
    ? db.select().from(baseTrainingQueue).where(eq(baseTrainingQueue.baseId, context.baseId))
    : db.select().from(trainingQueue).where(eq(trainingQueue.playerWallet, wallet));
  return { wallet, context, asset, balance, queue };
}

for (const stable of [false, true]) describe.sequential(`training recovery (${stable ? 'stable' : 'legacy'})`, () => {
  beforeEach(() => { process.env['MULTI_BASE_ENABLED'] = String(stable); });

  it('recovers an immutable accepted receipt after a lost reply and later army changes, never cancelling the purchase', async () => {
    const f = await fixture(stable); const id = key();
    const accepted = await trainBatch(db, f.wallet, composition, cost, id, at, f.context);
    const before = await f.balance();
    await getArmyState(db, f.wallet, new Date(at.getTime() + 86_400_000), f.context?.baseId);
    const receipt = await getTrainingReceipt(db, f.wallet, id);
    expect(receipt).toMatchObject({ version: 1, status: 'accepted', idempotencyKey: id, baseId: f.context?.baseId ?? null,
      request: { composition, confirmedCostShards: cost }, result: { ...accepted, replayed: true } });
    expect(TrainingRecoverySchema.parse(receipt)).toEqual(receipt);
    expect(await closeTrainingBatch(db, f.wallet, id)).toEqual(receipt);
    expect(await f.balance()).toBe(before);
    expect(await f.queue()).toHaveLength(2);
    expect(await db.select().from(armyTrainingBatchClosures).where(eq(armyTrainingBatchClosures.playerWallet, f.wallet))).toHaveLength(0);
  });

  it('keeps a quote rejection unknown until explicit permanent close, then rejects even changed legacy bodies', async () => {
    const f = await fixture(stable); const id = key(); const before = await f.balance();
    await expect(trainBatch(db, f.wallet, composition, '0', id, at, f.context)).rejects.toMatchObject({ code: 'TRAINING_QUOTE_CHANGED' });
    expect(await getTrainingReceipt(db, f.wallet, id)).toEqual({ version: 1, status: 'unknown', idempotencyKey: id });
    const closed = await closeTrainingBatch(db, f.wallet, id);
    expect(closed.status).toBe('closed');
    expect(await closeTrainingBatch(db, f.wallet, id)).toEqual(closed);
    expect(await getTrainingReceipt(db, f.wallet, id)).toEqual(closed);
    await expect(trainBatch(db, f.wallet, composition, cost, id, at, f.context)).rejects.toMatchObject({ code: 'TRAINING_BATCH_CLOSED' });
    expect(await f.balance()).toBe(before); expect(await f.queue()).toEqual([]);
    expect(await db.select().from(armyTrainingBatches).where(eq(armyTrainingBatches.playerWallet, f.wallet))).toEqual([]);
  });

  it('rolls back an old binary purchase whose receipt arrives after closure, including all unit debits', async () => {
    const f = await fixture(stable); const id = key(); const before = await f.balance();
    await closeTrainingBatch(db, f.wallet, id);
    // Reproduce the pre-migration application writer by removing ONLY the new
    // app check. The real queue/ledger/receipt transaction still runs unchanged.
    const oldBinary = vi.spyOn(recovery, 'assertTrainingBatchOpen').mockResolvedValueOnce(undefined);
    try {
      await expect(trainBatch(db, f.wallet, composition, cost, id, at, f.context))
        .rejects.toMatchObject({ cause: { code: '23514', constraint_name: 'training_batch_key_closed' } });
    } finally { oldBinary.mockRestore(); }
    expect(await f.balance()).toBe(before); expect(await f.queue()).toEqual([]);
    expect(await db.select().from(armyTrainingBatches).where(eq(armyTrainingBatches.playerWallet, f.wallet))).toEqual([]);
    expect((await getTrainingReceipt(db, f.wallet, id)).status).toBe('closed');
  });

  it('returns unknown before an in-flight acceptance commits, then returns that acceptance when close loses the wallet lock', async () => {
    const f = await fixture(stable); const id = key(); const before = await f.balance();
    const consent = (await quoteTraining(db, f.wallet, composition, at, f.context)).consent;
    const ready = latch(); const release = latch();
    const transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, 'transaction');
    // Legacy training first reconciles completed quest markers in its own
    // transaction. The fixture has no due rows; hold the purchase transaction.
    if (!stable) spy.mockImplementationOnce(transaction);
    spy.mockImplementationOnce((work, config) => transaction(async (tx) => {
      const result = await work(tx); ready.resolve(); await release.promise; return result;
    }, config));
    const accepting = trainBatch(db, f.wallet, composition, cost, id, at, f.context, consent);
    try {
      await ready.promise; spy.mockRestore();
      expect((await getTrainingReceipt(db, f.wallet, id)).status).toBe('unknown');
      const closing = closeTrainingBatch(db, f.wallet, id);
      release.resolve();
      const accepted = await accepting;
      expect(await closing).toMatchObject({ status: 'accepted', result: { ...accepted, replayed: true } });
      expect(await f.balance()).toBe(before - BigInt(cost)); expect(await f.queue()).toHaveLength(2);
    } finally { release.resolve(); spy.mockRestore(); await accepting; }
  });

  it('prevents a delayed first POST from debiting after explicit close wins the wallet lock', async () => {
    const f = await fixture(stable); const id = key(); const before = await f.balance();
    const ready = latch(); const release = latch();
    const transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, 'transaction').mockImplementationOnce((work, config) => transaction(async (tx) => {
      const result = await work(tx); ready.resolve(); await release.promise; return result;
    }, config));
    const closing = closeTrainingBatch(db, f.wallet, id);
    try {
      await ready.promise; spy.mockRestore();
      const late = trainBatch(db, f.wallet, composition, cost, id, at, f.context);
      const rejected = expect(late).rejects.toMatchObject({ code: 'TRAINING_BATCH_CLOSED' });
      release.resolve(); await closing; await rejected;
      expect(await f.balance()).toBe(before); expect(await f.queue()).toEqual([]);
    } finally { release.resolve(); spy.mockRestore(); await closing; }
  });
});

describe.sequential('private historical receipt authority', () => {
  beforeEach(() => { process.env['MULTI_BASE_ENABLED'] = 'true'; });
  it('lets the original buyer recover after deed sale without granting the seller or buyer new army authority', async () => {
    const seller = await fixture(true); const buyer = await createTestPlayer(db); const id = key();
    await trainBatch(db, seller.wallet, composition, cost, id, at, seller.context);
    const receipt = await getTrainingReceipt(db, seller.wallet, id);
    await transferStableBase(db, seller.context!.baseId, seller.wallet, buyer.wallet, seller.asset!);
    expect(await getTrainingReceipt(db, seller.wallet, id)).toEqual(receipt);
    expect(await closeTrainingBatch(db, seller.wallet, id)).toEqual(receipt);
    // The database also rejects a closure writer that bypasses the new service.
    await expect(db.insert(armyTrainingBatchClosures).values({ playerWallet: seller.wallet, idempotencyKey: id }))
      .rejects.toMatchObject({ cause: { code: '23514', constraint_name: 'training_batch_key_accepted' } });
    expect((await getTrainingReceipt(db, buyer.wallet, id)).status).toBe('unknown');
    await closeTrainingBatch(db, buyer.wallet, id);
    expect(await getTrainingReceipt(db, seller.wallet, id)).toEqual(receipt);
    await expect(trainBatch(db, seller.wallet, composition, cost, id, at, seller.context)).rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    const absent = key(); await closeTrainingBatch(db, seller.wallet, absent);
    expect((await getTrainingReceipt(db, seller.wallet, absent)).status).toBe('closed');
  });

  it('requires explicit confirmation and a live full session, even though current land is not required', async () => {
    // Authentication and the landless receipt routes are independent of multi-
    // base startup's production observer-capacity admission check.
    process.env['MULTI_BASE_ENABLED'] = 'false';
    const owner = await createTestPlayer(db);
    const [session] = await db.insert(sessions).values({ wallet: owner.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
    const cookie = await issueSessionJwt(TEST_CONFIG, owner.wallet, session!.id);
    const app = await buildApp(TEST_CONFIG, db); const id = 'receipt/key with spaces';
    const url = `/army/training/receipt?idempotencyKey=${encodeURIComponent(id)}`;
    const cookies = { [SESSION_COOKIE]: cookie };
    try {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      const unknown = await app.inject({ method: 'GET', url, cookies });
      expect(unknown.statusCode).toBe(200); expect(unknown.json().status).toBe('unknown'); expect(unknown.headers['cache-control']).toBe('no-store');
      for (const confirmed of [undefined, false, 'true']) {
        expect((await app.inject({ method: 'POST', url: '/army/training/close', cookies, payload: { idempotencyKey: id, confirmed } })).statusCode).toBe(400);
      }
      expect((await getTrainingReceipt(db, owner.wallet, id)).status).toBe('unknown');
      const close = await app.inject({ method: 'POST', url: '/army/training/close', cookies, payload: { idempotencyKey: id, confirmed: true } });
      expect(close.statusCode).toBe(200); expect(close.json().status).toBe('closed'); expect(close.headers['cache-control']).toBe('no-store');
      expect((await app.inject({ method: 'GET', url, cookies: { ...cookies, [LOGIN_COOKIE]: 'pending' } })).statusCode).toBe(403);
      await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, session!.id));
      expect((await app.inject({ method: 'GET', url, cookies })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/army/training/close', cookies, payload: { idempotencyKey: key(), confirmed: true } })).statusCode).toBe(401);
    } finally { await app.close(); }
    expect(TrainingCloseBodySchema.safeParse({ idempotencyKey: id, confirmed: true, wallet: owner.wallet }).success).toBe(false);
  });
});
