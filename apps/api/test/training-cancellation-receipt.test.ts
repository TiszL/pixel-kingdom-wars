import { randomUUID } from 'node:crypto';
import { BuildingType } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, LOGIN_COOKIE, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { accounts, bases, baseSlots, baseTrainingQueue, buildings, ledgerEntries, ledgerTransactions, players, sessions, trainingQueue } from '../src/db/schema';
import { cancelTraining } from '../src/game/army';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { transferStableBase } from '../src/game/baseOwnership';
import { rewardShards } from '../src/game/spend';
import {
  getTrainingCancellationReceipt, TrainingCancellationBodySchema, TrainingCancellationPathSchema,
  TrainingCancellationReceiptQuerySchema, TrainingCancellationReceiptSchema, TrainingCancellationResultSchema,
} from '../src/game/trainingCancellationReceipt';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import { connectTestDb, createTestPlayer, randomWallet, TEST_CONFIG } from './helpers';
import { trainTroop } from './training-consent';

const conn = connectTestDb(); const db = conn.db;
const mode = process.env['MULTI_BASE_ENABLED'];
const at = new Date('2026-09-01T00:00:00Z');
beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => {
  if (mode === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = mode;
  await conn.sql.end();
});
async function fixture(stable: boolean) {
  process.env['MULTI_BASE_ENABLED'] = String(stable);
  const { wallet } = await createTestPlayer(db); const asset = randomWallet();
  await db.update(players).set({ keepLevel: 8 }).where(eq(players.wallet, wallet));
  let baseId: string | undefined;
  if (stable) {
    const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active', keepLevel: 8,
      deedAssetId: asset, deedMintAssetId: asset, landPaidAt: at }).returning();
    baseId = base!.id; await db.insert(baseSlots).values({ wallet, slot: 1, baseId });
    await rewardBaseShards(db, baseId, 100_000n, 'test.cancel-receipt', randomUUID());
  } else await rewardShards(db, wallet, 100_000n, 'test.cancel-receipt', randomUUID());
  await db.insert(buildings).values([
    { playerWallet: wallet, baseId, type: BuildingType.Keep, level: 8, tx: 14, ty: 14 },
    { playerWallet: wallet, baseId, type: BuildingType.Barracks, level: 3, tx: 8, ty: 8 },
    { playerWallet: wallet, baseId, type: BuildingType.Camp, level: 3, tx: 18, ty: 8 },
    { playerWallet: wallet, baseId, type: BuildingType.Forge, level: 3, tx: 8, ty: 18 },
  ]);
  const context = baseId ? { baseId, assertAuthority: async () => {} } : undefined;
  const queued = await trainTroop(db, wallet, 'highlander', randomUUID(), at, context);
  const query = { idempotencyKey: randomUUID(), ...(baseId ? { baseId } : {}) };
  const cancel = (actor = wallet) => cancelTraining(db, actor, queued.id, query.idempotencyKey, at, context);
  return { wallet, baseId, asset, context, queued, query, cancel };
}

for (const stable of [false, true]) describe(`historical training cancellation (${stable ? 'deed' : 'legacy'})`, () => {
  it('returns the exact committed result through an enforced read-only consistent snapshot', async () => {
    const f = await fixture(stable); const posted = await f.cancel();
    const pending = await trainTroop(db, f.wallet, 'highlander', randomUUID(), at, f.context);
    const before = {
      accounts: await db.select().from(accounts), txns: await db.select().from(ledgerTransactions),
      entries: await db.select().from(ledgerEntries), players: await db.select().from(players),
      bases: await db.select().from(bases), queue: await db.select().from(stable ? baseTrainingQueue : trainingQueue),
    };
    const transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, 'transaction').mockImplementationOnce((work, config) => {
      expect(config).toEqual({ isolationLevel: 'repeatable read', accessMode: 'read only' });
      return transaction(work, config);
    });
    let receipt;
    try { receipt = await getTrainingCancellationReceipt(db, f.wallet, f.queued.id, f.query); }
    finally { spy.mockRestore(); }
    expect(receipt).toEqual({ version: 1, status: 'accepted', queueId: f.queued.id,
      baseId: f.baseId ?? null, idempotencyKey: f.query.idempotencyKey,
      result: { ...posted, cancelledAt: posted.cancelledAt.toISOString(), replayed: true } });
    expect(TrainingCancellationReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(TrainingCancellationResultSchema.parse(JSON.parse(JSON.stringify(posted)))).toMatchObject({ replayed: false });
    expect(await getTrainingCancellationReceipt(db, f.wallet, f.queued.id.toUpperCase(), f.query)).toEqual(receipt);
    expect(await db.select().from(accounts)).toEqual(before.accounts);
    expect(await db.select().from(ledgerTransactions)).toEqual(before.txns);
    expect(await db.select().from(ledgerEntries)).toEqual(before.entries);
    expect(await db.select().from(players)).toEqual(before.players);
    expect(await db.select().from(bases)).toEqual(before.bases);
    expect(await db.select().from(stable ? baseTrainingQueue : trainingQueue)).toEqual(before.queue);
    expect(before.queue.find((row) => row.id === pending.id)!.completedAt).toBeNull();
  });

  it('does not infer cancellation from a known queue, wrong key, base or another actor', async () => {
    const f = await fixture(stable);
    expect((await getTrainingCancellationReceipt(db, f.wallet, f.queued.id, f.query)).status).toBe('unknown');
    await f.cancel(); const other = await createTestPlayer(db);
    expect((await getTrainingCancellationReceipt(db, other.wallet, f.queued.id, f.query)).status).toBe('unknown');
    expect((await getTrainingCancellationReceipt(db, f.wallet, randomUUID(), f.query)).status).toBe('unknown');
    for (const query of [{ ...f.query, idempotencyKey: randomUUID() }, { ...f.query, baseId: randomUUID() },
      ...(stable ? [{ idempotencyKey: f.query.idempotencyKey }] : [])]) {
      expect((await getTrainingCancellationReceipt(db, f.wallet, f.queued.id, query)).status).toBe('unknown');
    }
  });

  it('rejects substituted refund and debit links instead of trusting a cancelled flag', async () => {
    const f = await fixture(stable); await f.cancel();
    const table = stable ? baseTrainingQueue : trainingQueue;
    const [row] = await db.select().from(table).where(eq(table.id, f.queued.id));
    const [unrelated] = await db.insert(ledgerTransactions).values({ idempotencyKey: randomUUID(), type: 'test.unrelated', metadata: {} }).returning();
    await db.update(table).set({ refundLedgerTxnId: unrelated!.id }).where(eq(table.id, f.queued.id));
    expect((await getTrainingCancellationReceipt(db, f.wallet, f.queued.id, f.query)).status).toBe('unknown');
    await db.update(table).set({ refundLedgerTxnId: row!.refundLedgerTxnId, debitLedgerTxnId: unrelated!.id }).where(eq(table.id, f.queued.id));
    expect((await getTrainingCancellationReceipt(db, f.wallet, f.queued.id, f.query)).status).toBe('unknown');
  });
});

it('keeps the cancellation actor receipt after sale without giving it to the new owner', async () => {
  const f = await fixture(true); await f.cancel(); const buyer = await createTestPlayer(db);
  const original = await getTrainingCancellationReceipt(db, f.wallet, f.queued.id, f.query);
  await transferStableBase(db, f.baseId!, f.wallet, buyer.wallet, f.asset);
  expect(await getTrainingCancellationReceipt(db, f.wallet, f.queued.id, f.query)).toEqual(original);
  expect((await getTrainingCancellationReceipt(db, buyer.wallet, f.queued.id, f.query)).status).toBe('unknown');
});

it('binds inherited troop cancellation to the buyer, not the original purchaser', async () => {
  const f = await fixture(true); const buyer = await createTestPlayer(db);
  await transferStableBase(db, f.baseId!, f.wallet, buyer.wallet, f.asset);
  await f.cancel(buyer.wallet);
  expect((await getTrainingCancellationReceipt(db, buyer.wallet, f.queued.id, f.query)).status).toBe('accepted');
  expect((await getTrainingCancellationReceipt(db, f.wallet, f.queued.id, f.query)).status).toBe('unknown');
});

it('rejects balanced but redirected refunds and false debit metadata', async () => {
  for (const wrongAccount of [true, false]) {
    const f = await fixture(true);
    const [row] = await db.select().from(baseTrainingQueue).where(eq(baseTrainingQueue.id, f.queued.id));
    const sys = await bootstrapSystemAccounts(db);
    const walletAccount = await getOrCreatePlayerAccount(db, f.wallet, 'player_shards');
    const [baseAccount] = await db.select().from(accounts).where(eq(accounts.baseId, f.baseId!));
    // A structurally balanced ledger transaction alone cannot prove a refund
    // to the original debit account or validate substituted receipt metadata.
    const posted = await postTransaction(db, {
      idempotencyKey: `army-train-cancel:${row!.id}`, type: 'army.train.cancel',
      metadata: { wallet: f.wallet, baseId: f.baseId, queueId: row!.id, troop: row!.troop,
        debitLedgerTxnId: wrongAccount ? row!.debitLedgerTxnId : randomUUID() },
      entries: [{ account: sys.shard_burn, delta: -row!.paidShardCost! },
        { account: wrongAccount ? walletAccount.id : baseAccount!.id, delta: row!.paidShardCost! }],
    });
    await db.update(baseTrainingQueue).set({ completedAt: at, cancelledAt: at,
      cancelIdempotencyKey: f.query.idempotencyKey, refundLedgerTxnId: posted.transaction.id }).where(eq(baseTrainingQueue.id, row!.id));
    expect((await getTrainingCancellationReceipt(db, f.wallet, f.queued.id, f.query)).status).toBe('unknown');
  }
});

it('keeps decimal strings exact and preserves the existing POST strip behavior', () => {
  const row = { id: randomUUID(), troop: 'highlander', refundShards: '9007199254740993', cancelledAt: at.toISOString(), replayed: true };
  expect(TrainingCancellationResultSchema.parse(row).refundShards).toBe('9007199254740993');
  expect(TrainingCancellationResultSchema.safeParse({ ...row, refundShards: 10 }).success).toBe(false);
  const body = { idempotencyKey: randomUUID(), baseId: randomUUID() };
  expect(TrainingCancellationBodySchema.parse({ ...body, extra: true })).toEqual(body);
  expect(TrainingCancellationReceiptQuerySchema.safeParse({ ...body, extra: true }).success).toBe(false);
  expect(TrainingCancellationPathSchema.safeParse({ queueId: 'invalid' }).success).toBe(false);
});

it('requires a complete authenticated session, accepts historical reads without land, and never caches them', async () => {
  const f = await fixture(true); await f.cancel(); const buyer = await createTestPlayer(db);
  await transferStableBase(db, f.baseId!, f.wallet, buyer.wallet, f.asset);
  const [session] = await db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  const jwt = await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id);
  // Historical explicit-base reads remain available without enabling the live
  // deed observer against synthetic test deeds. No current land is required.
  process.env['MULTI_BASE_ENABLED'] = 'false';
  const app = await buildApp(TEST_CONFIG, db);
  const url = `/army/train/${f.queued.id}/cancel/receipt?${new URLSearchParams(f.query)}`;
  try {
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url, cookies: { [LOGIN_COOKIE]: jwt } })).statusCode).toBe(403);
    const response = await app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: jwt } });
    expect(response.statusCode).toBe(200); expect(response.json().status).toBe('accepted');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(TrainingCancellationReceiptSchema.parse(response.json())).toEqual(response.json());
    expect((await app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: jwt, [LOGIN_COOKIE]: 'pending' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `${url}&extra=true`, cookies: { [SESSION_COOKIE]: jwt } })).statusCode).toBe(400);
    await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, session!.id));
    expect((await app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: jwt } })).statusCode).toBe(401);
  } finally { await app.close(); }
});
