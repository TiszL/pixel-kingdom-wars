import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import { RAID_ENERGY } from '@shardkeep/shared';
import { BasePurchaseStatusSchema, type BasePurchaseNetwork, type BasePurchaseQuote } from '@shardkeep/shared/basePurchases';
import { PublicKey } from '@solana/web3.js';
import { eq, sql } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { SESSION_COOKIE, issueSessionJwt } from '../src/auth/session';
import { baseProfiles, baseRaidLocks, bases, baseSlots, deposits, raids as raidRows, sessions } from '../src/db/schema';
import * as raids from '../src/game/raids';
import { cancelUnquotedBasePurchase, freezeBasePurchaseQuote, getBasePurchase, quoteBasePurchase,
  matchesBasePurchaseBuilderTransaction, originalBasePurchase } from '../src/money/basePurchases';
import { createDepositIntent, creditDeposit, type DepositPayload, type VerifiedPayment } from '../src/money/deposits';
import { verifyDepositNow } from '../src/money/depositWatcher';
import { connectTestDb, createTestPlayer, randomWallet, TEST_CONFIG } from './helpers';

const conn = connectTestDb(); const db = conn.db;
const now = new Date('2034-08-01T00:00:00.000Z');
const previousBase = process.env['BASE_PURCHASE_V1_ENABLED']; const previousEnergy = process.env['ENERGY_PURCHASE_V1_ENABLED'];
const network: BasePurchaseNetwork = { cluster: 'devnet', coreProgram: randomWallet(), configPda: randomWallet(),
  treasuryLiquidity: randomWallet(), treasuryDev: randomWallet(), treasuryOps: randomWallet(), systemProgram: '11111111111111111111111111111111' };
beforeEach(() => { process.env['BASE_PURCHASE_V1_ENABLED'] = 'true'; process.env['ENERGY_PURCHASE_V1_ENABLED'] = 'true'; });
afterEach(() => {
  vi.restoreAllMocks();
  if (previousBase === undefined) delete process.env['BASE_PURCHASE_V1_ENABLED']; else process.env['BASE_PURCHASE_V1_ENABLED'] = previousBase;
  if (previousEnergy === undefined) delete process.env['ENERGY_PURCHASE_V1_ENABLED']; else process.env['ENERGY_PURCHASE_V1_ENABLED'] = previousEnergy;
});
afterAll(async () => { await conn.sql.end(); });
const signature = () => bs58.encode(randomBytes(64));
async function fixture(kind: 'energy' | 'energy_pack' = 'energy') {
  const { wallet } = await createTestPlayer(db);
  const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active', landPaidAt: now }).returning();
  const baseId = base!.id; await db.insert(baseSlots).values({ wallet, baseId, slot: 1 });
  const request = { kind, baseId, idempotencyKey: randomUUID() };
  return { wallet, baseId, request, quote: () => quoteBasePurchase(db, wallet, request, network, now) };
}
function payment(q: BasePurchaseQuote): VerifiedPayment {
  return { txSignature: signature(), wallet: q.wallet, kind: q.request.kind, lamports: BigInt(q.amountLamports), finalized: true, basePurchaseV1: q };
}
async function purchased(baseId: string) {
  return (await db.select().from(baseProfiles).where(eq(baseProfiles.baseId, baseId)))[0]?.purchasedEnergy ?? 0;
}
async function row(id: string) { return (await db.select().from(deposits).where(eq(deposits.id, id)))[0]!; }

describe.sequential('original paid energy and receipt recovery', () => {
  for (const kind of ['energy', 'energy_pack'] as const) it(`${kind} grants once to the original base after transfer, with history available while dark`, async () => {
    const f = await fixture(kind); const values = await Promise.all([f.quote(), f.quote(), f.quote()]);
    const q = values[0]!.purchase!.quote; values.forEach(v => expect(v.purchase!.quote).toEqual(q));
    expect(q.energyQuantity).toBe(kind === 'energy' ? 1 : RAID_ENERGY.packSize);
    expect(q.amountLamports).toBe(String(kind === 'energy' ? RAID_ENERGY.solLamportsPerEnergy : RAID_ENERGY.packLamports));
    expect(q.rail).toMatchObject({ mode: 'buy_sink', sinkKind: kind === 'energy' ? 3 : 7 });
    await expect(quoteBasePurchase(db, f.wallet, { ...f.request, baseId: randomUUID() }, network, now))
      .rejects.toMatchObject({ code: 'BASE_PURCHASE_MISMATCH' });
    const buyer = await createTestPlayer(db);
    await db.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, f.baseId));
    await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    await db.insert(baseSlots).values({ wallet: buyer.wallet, baseId: f.baseId, slot: 1 });
    const pay = payment(q); expect((await creditDeposit(db, q.depositId, pay, now)).credited).toBe(true);
    expect((await creditDeposit(db, q.depositId, pay, now)).credited).toBe(false);
    expect(await purchased(f.baseId)).toBe(q.energyQuantity);
    process.env['BASE_PURCHASE_V1_ENABLED'] = 'false'; process.env['ENERGY_PURCHASE_V1_ENABLED'] = 'false';
    const accepted = await getBasePurchase(db, f.wallet, f.request.idempotencyKey, now, kind);
    expect(BasePurchaseStatusSchema.parse(accepted)).toMatchObject({ enabled: false, purchase: { quote: q, status: 'credited',
      receipt: { energy: { quantity: q.energyQuantity }, amountLamports: q.amountLamports, shards: null } } });
    expect(await quoteBasePurchase(db, f.wallet, f.request, undefined, now, async () => { throw new Error('historical authority'); })).toEqual(accepted);
    expect((await getBasePurchase(db, buyer.wallet, f.request.idempotencyKey)).purchase).toBeNull();
  });
  it('grants a historical frozen SKU without consulting today’s price/quantity or a daily cap', async () => {
    const f = await fixture('energy_pack'); const id = randomUUID(); const reference = randomWallet();
    // Simulate a valid quote from a previous catalogue: parsing/grant must not reinterpret its terms.
    const qty = RAID_ENERGY.packSize + 1; const amount = RAID_ENERGY.packLamports + 1;
    const payload = freezeBasePurchaseQuote({ request: f.request, network }, id, reference, f.wallet,
      { baseId: f.baseId, landPaidAt: now.toISOString(), deedAssetId: null, amountLamports: amount, energyQuantity: qty }, now);
    await db.insert(deposits).values({ id, playerWallet: f.wallet, kind: 'energy_pack', reference, createdAt: now, payload });
    const q = originalBasePurchase(await row(id))!; await creditDeposit(db, id, payment(q), now);
    expect(await purchased(f.baseId)).toBe(qty);
    const another = await quoteBasePurchase(db, f.wallet, { ...f.request, idempotencyKey: randomUUID() }, network, now);
    await creditDeposit(db, another.purchase!.quote.depositId, payment(another.purchase!.quote), now);
    expect(await purchased(f.baseId)).toBe(qty + RAID_ENERGY.packSize);
  });
  it('retains legacy minimum-price behavior without silently making legacy evidence v1', async () => {
    const f = await fixture(); const intent = await createDepositIntent(db, f.wallet, 'energy', { baseId: f.baseId }, now);
    expect((await row(intent.id)).payload).not.toHaveProperty('basePurchaseV1');
    await creditDeposit(db, intent.id, { txSignature: signature(), wallet: f.wallet, kind: 'energy',
      lamports: BigInt(RAID_ENERGY.solLamportsPerEnergy) + 1n, finalized: true }, now);
    expect(await purchased(f.baseId)).toBe(1);
  });
  it('rejects amount/quantity/epoch changes and rolls back every grant when a pack fails midway', async () => {
    const f = await fixture('energy_pack'); const q = (await f.quote()).purchase!.quote; const pay = payment(q);
    for (const delta of [-1n, 1n]) await expect(creditDeposit(db, q.depositId, { ...pay, lamports: pay.lamports + delta }, now)).rejects.toBeDefined();
    expect((await row(q.depositId)).status).toBe('pending'); expect(await purchased(f.baseId)).toBe(0);
    await expect(creditDeposit(db, q.depositId, { ...pay, basePurchaseV1: { ...q, energyQuantity: q.energyQuantity! + 1 } }, now)).rejects.toBeDefined();
    await db.update(bases).set({ landPaidAt: new Date(now.getTime() + 1) }).where(eq(bases.id, f.baseId));
    await expect(creditDeposit(db, q.depositId, pay, now)).rejects.toBeDefined();
    await db.update(bases).set({ landPaidAt: now }).where(eq(bases.id, f.baseId));
    const original = raids.grantPurchasedEnergy; let calls = 0;
    vi.spyOn(raids, 'grantPurchasedEnergy').mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error('synthetic interrupted pack'); return original(...args);
    });
    await expect(creditDeposit(db, q.depositId, pay, now)).rejects.toThrow('synthetic interrupted pack');
    expect(await purchased(f.baseId)).toBe(0); expect((await row(q.depositId)).status).toBe('pending');
    vi.restoreAllMocks(); await creditDeposit(db, q.depositId, pay, now); expect(await purchased(f.baseId)).toBe(q.energyQuantity);
  });
  it('database retains immutable quantity and terminal evidence, and cancellation fences a delayed quote', async () => {
    const f = await fixture(); const q = (await f.quote()).purchase!.quote; const existing = await row(q.depositId);
    const payload = existing.payload as DepositPayload;
    await expect(db.update(deposits).set({ payload: { ...payload, energyQuantity: 2 } }).where(eq(deposits.id, q.depositId))).rejects.toBeDefined();
    await expect(db.execute(sql`update deposits set payment_signature=${signature()} where id=${q.depositId}`)).rejects.toBeDefined();
    await creditDeposit(db, q.depositId, payment(q), now);
    await expect(db.delete(deposits).where(eq(deposits.id, q.depositId))).rejects.toBeDefined();
    const cancelled = await fixture(); await cancelUnquotedBasePurchase(db, cancelled.wallet, cancelled.request.idempotencyKey);
    await expect(cancelled.quote()).rejects.toMatchObject({ code: 'BASE_PURCHASE_CANCELLED' });
  });
  it('the SQL quote guard rejects mismatched, missing, fractional or out-of-range quantity and wrong ABI', async () => {
    const f = await fixture('energy_pack');
    for (const change of [
      (p: DepositPayload) => ({ ...p, energyQuantity: p.energyQuantity! + 1 }),
      (p: DepositPayload) => ({ ...p, basePurchaseV1: { ...p.basePurchaseV1!, energyQuantity: undefined } }),
      ...[0, -1, 1.5, 2_147_483_648].map(quantity => (p: DepositPayload) => ({ ...p, energyQuantity: quantity,
        basePurchaseV1: { ...p.basePurchaseV1!, energyQuantity: quantity } })),
      (p: DepositPayload) => ({ ...p, basePurchaseV1: { ...p.basePurchaseV1!, rail: { ...p.basePurchaseV1!.rail, sinkKind: 3 } } }),
    ]) {
      const id = randomUUID(); const reference = randomWallet();
      const payload = freezeBasePurchaseQuote({ request: { ...f.request, idempotencyKey: randomUUID() }, network }, id, reference, f.wallet,
        { baseId: f.baseId, landPaidAt: now.toISOString(), deedAssetId: null, amountLamports: RAID_ENERGY.packLamports, energyQuantity: RAID_ENERGY.packSize }, now);
      await expect(db.insert(deposits).values({ id, playerWallet: f.wallet, kind: 'energy_pack', reference, createdAt: now,
        payload: change(payload) })).rejects.toBeDefined();
    }
    expect(await db.select().from(deposits).where(eq(deposits.playerWallet, f.wallet))).toHaveLength(0);
  });
  it('keeps the exact paid energy pending during a raid, even after the quote window, then recovers once', async () => {
    const f = await fixture('energy_pack'); const q = (await f.quote()).purchase!.quote; const pay = payment(q);
    const attacker = await createTestPlayer(db);
    const [raid] = await db.insert(raidRows).values({ attackerWallet: attacker.wallet, defenderWallet: f.wallet,
      defenderBaseId: f.baseId, seed: 1n, snapshot: {}, armySnapshot: {}, ordersDeadlineAt: new Date(now.getTime() + 60_000) }).returning();
    await db.insert(baseRaidLocks).values({ baseId: f.baseId, raidId: raid!.id, state: 'live', expiresAt: new Date(now.getTime() + 60_000) });
    const afterTtl = new Date(Date.parse(q.retryAt) + 1);
    await expect(verifyDepositNow(db, async () => pay, f.wallet, q.depositId, afterTtl)).resolves.toEqual({ action: 'none' });
    expect(await row(q.depositId)).toMatchObject({ status: 'pending', txSignature: null }); expect(await purchased(f.baseId)).toBe(0);
    await db.delete(baseRaidLocks).where(eq(baseRaidLocks.raidId, raid!.id));
    await expect(verifyDepositNow(db, async () => pay, f.wallet, q.depositId, afterTtl)).resolves.toEqual({ action: 'credited' });
    await expect(verifyDepositNow(db, async () => pay, f.wallet, q.depositId, afterTtl)).resolves.toEqual({ action: 'none' });
    expect(await purchased(f.baseId)).toBe(q.energyQuantity);
  });
  it('requires the exact original ABI, payer, reference and amount', async () => {
    for (const kind of ['energy', 'energy_pack'] as const) {
      const f = await fixture(kind); const q = (await f.quote()).purchase!.quote;
      const data = Buffer.alloc(17); createHash('sha256').update('global:buy_sink').digest().copy(data, 0, 0, 8);
      data[8] = q.rail.sinkKind!; data.writeBigUInt64LE(BigInt(q.amountLamports), 9);
      const keys = [q.wallet, q.rail.configPda, q.rail.treasuryLiquidity, q.rail.treasuryDev, q.rail.treasuryOps, q.reference, q.rail.systemProgram, q.rail.coreProgram].map(k => new PublicKey(k));
      const tx = { transaction: { message: { staticAccountKeys: keys, compiledInstructions: [{ programIdIndex: 7, accountKeyIndexes: [1, 0, 2, 3, 4, 5, 6], data }] } } };
      expect(matchesBasePurchaseBuilderTransaction(tx, q)).toBe(true);
      data[8] = kind === 'energy' ? 7 : 3; expect(matchesBasePurchaseBuilderTransaction(tx, q)).toBe(false); data[8] = q.rail.sinkKind!;
      data.writeBigUInt64LE(BigInt(q.amountLamports) + 1n, 9); expect(matchesBasePurchaseBuilderTransaction(tx, q)).toBe(false); data.writeBigUInt64LE(BigInt(q.amountLamports), 9);
      keys[5] = new PublicKey(randomWallet()); expect(matchesBasePurchaseBuilderTransaction(tx, q)).toBe(false); keys[5] = new PublicKey(q.reference);
      keys[0] = new PublicKey(randomWallet()); expect(matchesBasePurchaseBuilderTransaction(tx, q)).toBe(false);
    }
  });
  it('old servers cannot attest energy support, and the new capability is authenticated, read-only and independently dark', async () => {
    const f = await fixture(); const old = Fastify(); old.get('/base/purchases/v1/:key', async () => ({ enabled: true, purchase: null }));
    const url = `/base/purchases/v1/energy/${f.request.idempotencyKey}?kind=energy`;
    expect((await old.inject({ method: 'GET', url })).statusCode).toBe(404); await old.close();
    process.env['ENERGY_PURCHASE_V1_ENABLED'] = 'false'; await expect(f.quote()).rejects.toMatchObject({ code: 'BASE_PURCHASE_DISABLED' });
    const app = await buildApp(TEST_CONFIG, db);
    try {
      const [session] = await db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + 3600_000) }).returning();
      const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id) };
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      const got = await app.inject({ method: 'GET', url, cookies });
      expect(got.json()).toMatchObject({ enabled: false, purchase: null }); expect(got.headers['cache-control']).toBe('private, no-store');
      for (const query of ['', '?kind=shield', '?kind=energy&enabled=true', '?kind=energy&kind=energy_pack']) {
        expect((await app.inject({ method: 'GET', url: url.split('?')[0]! + query, cookies })).statusCode).toBe(400);
      }
      expect(await db.select().from(deposits).where(eq(deposits.playerWallet, f.wallet))).toHaveLength(0);
    } finally { await app.close(); }
  });
});
