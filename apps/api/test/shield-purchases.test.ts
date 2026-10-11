import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import { SHIELD, WARZONE } from '@shardkeep/shared';
import { type BasePurchaseNetwork, type BasePurchaseQuote, type BasePurchaseRequest } from '@shardkeep/shared/basePurchases';
import { PublicKey, type Connection } from '@solana/web3.js';
import { eq, sql } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { SESSION_COOKIE, issueSessionJwt } from '../src/auth/session';
import { basePurchaseCancellations, basePurchaseShieldReceipts, bases, baseSlots, deposits, sessions, shields } from '../src/db/schema';
import { getGameConfig, setShieldlessMode } from '../src/game/gameConfig';
import { cancelUnquotedBasePurchase, freezeBasePurchaseQuote, allowBasePurchaseTerminal, getBasePurchase, quoteBasePurchase, matchesBasePurchaseBuilderTransaction,
  matchesBasePurchaseWarzoneTransaction } from '../src/money/basePurchases';
import { createDepositIntent, creditDeposit, submitDepositPayment, type VerifiedPayment } from '../src/money/deposits';
import { makeChainDepositVerifier, makeCombinedDepositCommitVerifier, makeWarzoneShieldVerifier, verifyDepositNow } from '../src/money/depositWatcher';
import { NATIVE_SOL_MINT } from '../src/money/mintDimension';
import { connectTestDb, createTestPlayer, randomWallet, TEST_CONFIG } from './helpers';

const conn = connectTestDb(); const db = conn.db;
const now = new Date('2034-08-01T00:00:00.000Z'); const HOUR = 3_600_000;
const network: BasePurchaseNetwork = { cluster: 'devnet', coreProgram: randomWallet(), configPda: randomWallet(),
  treasuryLiquidity: randomWallet(), treasuryDev: randomWallet(), treasuryOps: randomWallet(), systemProgram: '11111111111111111111111111111111' };
const previousBase = process.env['BASE_PURCHASE_V1_ENABLED']; const previousShield = process.env['SHIELD_PURCHASE_V1_ENABLED'];
let config: Awaited<ReturnType<typeof getGameConfig>>;
beforeEach(async () => {
  process.env['BASE_PURCHASE_V1_ENABLED'] = 'true'; process.env['SHIELD_PURCHASE_V1_ENABLED'] = 'true';
  config = await getGameConfig(db);
  await setShieldlessMode(db, 'purge', { purgeStartAt: new Date(now.getTime() - 1), purgeEndAt: new Date(now.getTime() + HOUR) });
});
afterEach(async () => {
  if (previousBase === undefined) delete process.env['BASE_PURCHASE_V1_ENABLED']; else process.env['BASE_PURCHASE_V1_ENABLED'] = previousBase;
  if (previousShield === undefined) delete process.env['SHIELD_PURCHASE_V1_ENABLED']; else process.env['SHIELD_PURCHASE_V1_ENABLED'] = previousShield;
  await setShieldlessMode(db, config.shieldlessMode, config.purgeStartAt && config.purgeEndAt
    ? { purgeStartAt: config.purgeStartAt, purgeEndAt: config.purgeEndAt } : undefined);
});
afterAll(async () => { await conn.sql.end(); });
const signature = () => bs58.encode(randomBytes(64));
async function fixture(kind: 'shield' | 'warzone_shield' = 'shield') {
  const { wallet } = await createTestPlayer(db);
  const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active', landPaidAt: now }).returning();
  const baseId = base!.id; await db.insert(baseSlots).values({ wallet, baseId, slot: 1 });
  if (kind === 'shield') await db.insert(shields).values({ playerWallet: wallet, baseId, source: 'loss',
    expiresAt: new Date(now.getTime() + SHIELD.extendPurchaseMaxRemainingHours * HOUR) });
  const request: BasePurchaseRequest = { kind, baseId, idempotencyKey: randomUUID() };
  const quote = () => quoteBasePurchase(db, wallet, request, network, now);
  return { wallet, baseId, request, quote };
}
function payment(q: BasePurchaseQuote): VerifiedPayment {
  return { txSignature: signature(), wallet: q.wallet, kind: q.request.kind, lamports: BigInt(q.amountLamports), finalized: true, basePurchaseV1: q };
}
function transaction(q: BasePurchaseQuote) {
  const sink = Buffer.alloc(17); createHash('sha256').update('global:buy_sink').digest().copy(sink, 0, 0, 8);
  sink[8] = q.rail.sinkKind!; sink.writeBigUInt64LE(BigInt(q.rail.mode === 'warzone_split' ? q.rail.splitLamports : q.amountLamports), 9);
  const instructions = [{ programIdIndex: 7, accountKeyIndexes: [1, 0, 2, 3, 4, 5, 6], data: sink }];
  if (q.rail.mode === 'warzone_split') {
    const direct = Buffer.alloc(12); direct.writeUInt32LE(2); direct.writeBigUInt64LE(BigInt(q.rail.directLamports), 4);
    instructions.push({ programIdIndex: 6, accountKeyIndexes: [0, 2, 5], data: direct });
  }
  return { transaction: { message: { staticAccountKeys: [q.wallet, q.rail.configPda, q.rail.treasuryLiquidity,
    q.rail.treasuryDev, q.rail.treasuryOps, q.reference, q.rail.systemProgram, q.rail.coreProgram].map(k => new PublicKey(k)),
    compiledInstructions: instructions } }, meta: { err: null, logMessages: [] } };
}

describe.sequential('native shield original payment and exact retained effect', () => {
  it('an ineligible unquoted request can be durably cancelled while dark and landless without minting a payment', async () => {
    const f = await fixture(); await db.delete(shields).where(eq(shields.baseId, f.baseId));
    await expect(f.quote()).rejects.toMatchObject({ statusCode: 422 });
    await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    process.env['BASE_PURCHASE_V1_ENABLED'] = 'false'; process.env['SHIELD_PURCHASE_V1_ENABLED'] = 'false';
    const cancelled = { version: 1, wallet: f.wallet, idempotencyKey: f.request.idempotencyKey, cancelled: true, purchase: null };
    expect(await cancelUnquotedBasePurchase(db, f.wallet, f.request.idempotencyKey)).toEqual(cancelled);
    expect(await cancelUnquotedBasePurchase(db, f.wallet, f.request.idempotencyKey)).toEqual(cancelled);
    await expect(quoteBasePurchase(db, f.wallet, f.request, undefined, now, async () => { throw new Error('must not resolve current authority'); }))
      .rejects.toMatchObject({ code: 'BASE_PURCHASE_CANCELLED' });
    expect((await getBasePurchase(db, f.wallet, f.request.idempotencyKey)).purchase).toBeNull();
    expect(await db.select().from(deposits).where(eq(deposits.playerWallet, f.wallet))).toHaveLength(0);
  });
  it('cancellation fences a delayed quote that already passed its initial history and flag checks', async () => {
    const f = await fixture(); let prepared!: () => void; let resume!: () => void;
    const entered = new Promise<void>(resolve => { prepared = resolve; }); const held = new Promise<void>(resolve => { resume = resolve; });
    const delayed = quoteBasePurchase(db, f.wallet, f.request, network, now, async baseId => {
      prepared(); await held; return { baseId, assertAuthority: async () => { throw new Error('cancelled key reached creation authority'); } };
    });
    const outcome = delayed.then(value => value, error => error);
    await entered; expect((await cancelUnquotedBasePurchase(db, f.wallet, f.request.idempotencyKey)).cancelled).toBe(true);
    resume(); expect(await outcome).toMatchObject({ code: 'BASE_PURCHASE_CANCELLED' });
    expect((await getBasePurchase(db, f.wallet, f.request.idempotencyKey)).purchase).toBeNull();
  });
  it('cancellation loses to any existing quote and returns its unchanged pending or credited payment', async () => {
    const f = await fixture(); const first = await f.quote(); const q = first.purchase!.quote;
    const pending = await cancelUnquotedBasePurchase(db, f.wallet, f.request.idempotencyKey);
    expect(pending).toEqual({ version: 1, wallet: f.wallet, idempotencyKey: f.request.idempotencyKey, cancelled: false, purchase: first.purchase });
    await creditDeposit(db, q.depositId, payment(q), now);
    expect((await cancelUnquotedBasePurchase(db, f.wallet, f.request.idempotencyKey)).purchase)
      .toEqual((await getBasePurchase(db, f.wallet, f.request.idempotencyKey)).purchase);
    await expect(db.insert(basePurchaseCancellations).values({ wallet: f.wallet, idempotencyKey: f.request.idempotencyKey })).rejects.toBeDefined();
  });
  it('SQL retains cancellation and rejects an old writer inserting a late quote against the closed key', async () => {
    const f = await fixture(); await cancelUnquotedBasePurchase(db, f.wallet, f.request.idempotencyKey);
    const id = randomUUID(); const reference = randomWallet();
    const payload = freezeBasePurchaseQuote({ request: f.request, network }, id, reference, f.wallet,
      { baseId: f.baseId, landPaidAt: now.toISOString(), deedAssetId: null, amountLamports: SHIELD.extendCostSolLamports }, now);
    await expect(db.insert(deposits).values({ id, playerWallet: f.wallet, reference, kind: 'shield', status: 'pending', createdAt: now, payload })).rejects.toBeDefined();
    await expect(db.delete(basePurchaseCancellations).where(eq(basePurchaseCancellations.wallet, f.wallet))).rejects.toBeDefined();
    await expect(db.update(basePurchaseCancellations).set({ createdAt: new Date() }).where(eq(basePurchaseCancellations.wallet, f.wallet))).rejects.toBeDefined();
    await expect(db.execute(sql`truncate base_purchase_cancellations`)).rejects.toBeDefined();
    const other = await fixture(); const sameKey = { ...other.request, idempotencyKey: f.request.idempotencyKey };
    expect((await quoteBasePurchase(db, other.wallet, sameKey, network, now)).purchase!.quote.wallet).toBe(other.wallet);
  });
  it('cancel-unquoted requires authentication and an empty body while allowing landless explicit cancellation', async () => {
    const { wallet } = await createTestPlayer(db); const key = randomUUID(); const app = await buildApp(TEST_CONFIG, db);
    const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + HOUR) }).returning();
    const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
    const url = `/base/purchases/v1/${key}/cancel-unquoted`;
    expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, cookies, payload: { wallet: randomWallet() } })).statusCode).toBe(400);
    const response = await app.inject({ method: 'POST', url, cookies, payload: {} });
    expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toEqual({ version: 1, wallet, idempotencyKey: key, cancelled: true, purchase: null }); await app.close();
  });
  for (const kind of ['shield', 'warzone_shield'] as const) it(`${kind} settles exactly once on the original deed and retains history after sale and shield break`, async () => {
    const f = await fixture(kind); const first = await f.quote(); const q = first.purchase!.quote;
    expect((await Promise.all([f.quote(), f.quote()])).map(s => s.purchase!.quote)).toEqual([q, q]);
    expect(q.quotedCostShards).toBeNull();
    if (kind === 'warzone_shield') expect(q.rail).toMatchObject({ mode: 'warzone_split', sinkKind: 6,
      directLamports: (BigInt(WARZONE.shieldCostSolLamports) * BigInt(WARZONE.shieldLiquidityDirectBps) / 10_000n).toString() });
    else expect(q.rail).toMatchObject({ mode: 'buy_sink', sinkKind: 4 });
    const buyer = await createTestPlayer(db); await db.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, f.baseId));
    await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId)); await db.insert(baseSlots).values({ wallet: buyer.wallet, baseId: f.baseId, slot: 1 });
    // Leaving the Warzone window never discards an already paid quotation.
    await setShieldlessMode(db, 'off'); const pay = payment(q);
    expect((await creditDeposit(db, q.depositId, pay, now)).credited).toBe(true);
    expect((await creditDeposit(db, q.depositId, pay, now)).credited).toBe(false);
    const accepted = await getBasePurchase(db, f.wallet, f.request.idempotencyKey, now);
    expect(accepted.purchase!.receipt!.shield).toEqual({ granted: true, expiresAt: new Date(now.getTime()
      + (kind === 'shield' ? SHIELD.extendPurchaseMaxRemainingHours + SHIELD.extendHours : WARZONE.shieldDurationHours) * HOUR).toISOString() });
    await db.delete(shields).where(eq(shields.baseId, f.baseId));
    process.env['SHIELD_PURCHASE_V1_ENABLED'] = 'false';
    const historical = await quoteBasePurchase(db, f.wallet, f.request, undefined, now, async () => { throw new Error('historical authority'); });
    expect(historical).toEqual({ ...accepted, enabled: false });
    expect((await getBasePurchase(db, buyer.wallet, f.request.idempotencyKey)).purchase).toBeNull();
  });
  for (const reason of ['broken', 'expired', 'extended'] as const) it(`ordinary shield ${reason} before finality records paid no-op without inventing new protection`, async () => {
    const f = await fixture(); const q = (await f.quote()).purchase!.quote;
    const expiry = reason === 'extended' ? new Date(now.getTime() + SHIELD.maxHours * HOUR) : now;
    if (reason === 'broken') await db.delete(shields).where(eq(shields.baseId, f.baseId));
    else await db.update(shields).set({ expiresAt: expiry }).where(eq(shields.baseId, f.baseId));
    await creditDeposit(db, q.depositId, payment(q), now);
    expect((await getBasePurchase(db, f.wallet, f.request.idempotencyKey)).purchase!.receipt!.shield)
      .toEqual({ granted: false, expiresAt: reason === 'extended' ? expiry.toISOString() : null });
    expect(await db.select().from(shields).where(eq(shields.baseId, f.baseId))).toHaveLength(reason === 'broken' ? 0 : 1);
  });
  it('ordinary preflight sees a legal hidden ordinary shield under Warzone protection, but not Warzone alone or above the extension cap', async () => {
    const f = await fixture(); await db.insert(shields).values({ playerWallet: f.wallet, baseId: f.baseId,
      source: 'warzone', expiresAt: new Date(now.getTime() + WARZONE.shieldDurationHours * HOUR) });
    expect((await f.quote()).purchase!.quote.request.kind).toBe('shield');
    const g = await fixture(); await db.update(shields).set({ source: 'warzone' }).where(eq(shields.baseId, g.baseId));
    await expect(g.quote()).rejects.toMatchObject({ statusCode: 422 });
    const h = await fixture(); await db.update(shields).set({ expiresAt: new Date(now.getTime() + SHIELD.extendPurchaseMaxRemainingHours * HOUR + 1) }).where(eq(shields.baseId, h.baseId));
    await expect(h.quote()).rejects.toMatchObject({ statusCode: 422 });
  });
  for (const kind of ['shield', 'warzone_shield'] as const) it(`${kind} replacement keys and deed epochs cannot duplicate or redirect an uncertain payment`, async () => {
    const f = await fixture(kind); const q = (await f.quote()).purchase!.quote;
    await expect(quoteBasePurchase(db, f.wallet, { ...f.request, idempotencyKey: randomUUID() }, network, now))
      .rejects.toMatchObject({ code: 'PAYMENT_TARGET_RESERVED' });
    await db.update(bases).set({ deedAssetId: randomWallet() }).where(eq(bases.id, f.baseId));
    await expect(creditDeposit(db, q.depositId, payment(q), now)).rejects.toMatchObject({ code: 'BASE_PURCHASE_CHANGED' });
    expect((await getBasePurchase(db, f.wallet, f.request.idempotencyKey)).purchase!.status).toBe('pending');
    expect(await db.select().from(basePurchaseShieldReceipts).where(eq(basePurchaseShieldReceipts.depositId, q.depositId))).toHaveLength(0);
  });
  it('an earlier legacy shield payment blocks a new native reference while unrelated deeds remain usable', async () => {
    const f = await fixture(); await createDepositIntent(db, f.wallet, 'shield', { baseId: f.baseId }, now);
    await expect(f.quote()).rejects.toMatchObject({ code: 'PAYMENT_TARGET_RESERVED' });
    expect((await (await fixture()).quote()).purchase).not.toBeNull();
  });
  it('a Warzone shield acquired before credit prevents stacking and preserves paid failure evidence', async () => {
    const f = await fixture('warzone_shield'); const q = (await f.quote()).purchase!.quote;
    await db.insert(shields).values({ playerWallet: f.wallet, baseId: f.baseId, source: 'warzone', expiresAt: new Date(now.getTime() + HOUR) });
    const pay = payment(q); await verifyDepositNow(db, async () => pay, f.wallet, q.depositId, new Date(Date.parse(q.retryAt) + 1));
    expect((await getBasePurchase(db, f.wallet, f.request.idempotencyKey)).purchase).toMatchObject({ status: 'failed', txSignature: pay.txSignature, receipt: null });
    expect(await db.select().from(shields).where(eq(shields.baseId, f.baseId))).toHaveLength(1);
  });
  it('the database makes granted/no-op evidence atomic, immutable and retained independently of live shields', async () => {
    const f = await fixture(); const q = (await f.quote()).purchase!.quote;
    await expect(db.transaction(async tx => {
      await allowBasePurchaseTerminal(tx, q.depositId);
      await tx.update(deposits).set({ status: 'credited', amount: BigInt(q.amountLamports), txSignature: signature(), mint: NATIVE_SOL_MINT, finalizedAt: now }).where(eq(deposits.id, q.depositId));
    })).rejects.toBeDefined();
    await expect(db.insert(basePurchaseShieldReceipts).values({ depositId: q.depositId, granted: true, expiresAt: new Date(now.getTime() + HOUR) })).rejects.toBeDefined();
    await creditDeposit(db, q.depositId, payment(q), now);
    await expect(db.update(basePurchaseShieldReceipts).set({ granted: false }).where(eq(basePurchaseShieldReceipts.depositId, q.depositId))).rejects.toBeDefined();
    await expect(db.delete(basePurchaseShieldReceipts).where(eq(basePurchaseShieldReceipts.depositId, q.depositId))).rejects.toBeDefined();
    await expect(db.execute(sql`truncate base_purchase_shield_receipts`)).rejects.toBeDefined();
  });
  it('shield capability is independently dark, and authenticated GET never grants or creates a deposit', async () => {
    const f = await fixture(); process.env['SHIELD_PURCHASE_V1_ENABLED'] = 'false';
    await expect(f.quote()).rejects.toMatchObject({ code: 'BASE_PURCHASE_DISABLED' });
    const app = await buildApp(TEST_CONFIG, db); const [session] = await db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + HOUR) }).returning();
    const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id) };
    const path = `/base/purchases/v1/shields/${f.request.idempotencyKey}`;
    const url = `${path}?kind=shield`;
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    for (const query of ['', '?kind=builder', '?kind=shield&enabled=true', '?kind=shield&kind=warzone_shield']) {
      expect((await app.inject({ method: 'GET', url: `${path}${query}`, cookies })).statusCode).toBe(400);
    }
    const got = await app.inject({ method: 'GET', url, cookies });
    expect(got.json()).toMatchObject({ enabled: false, purchase: null }); expect(got.headers['cache-control']).toBe('private, no-store');
    expect((await app.inject({ method: 'GET', url: `/base/purchases/v1/${f.request.idempotencyKey}`, cookies })).json().enabled).toBe(true);
    expect(await db.select().from(deposits).where(eq(deposits.playerWallet, f.wallet))).toHaveLength(0); await app.close();
  });
  it('an older single-segment status route cannot falsely enable shield consent on the new capability path', async () => {
    const older = Fastify(); const key = randomUUID(); let oldReads = 0;
    // The pre-shield route ignores an unknown kind query and advertises the
    // independently enabled builder/expansion/mine family. It cannot attest shields.
    older.get('/base/purchases/v1/:key', async () => { oldReads++; return { enabled: true, purchase: null }; });
    expect((await older.inject({ method: 'GET', url: `/base/purchases/v1/${key}?kind=shield` })).json().enabled).toBe(true);
    for (const kind of ['shield', 'warzone_shield']) {
      expect((await older.inject({ method: 'GET', url: `/base/purchases/v1/shields/${key}?kind=${kind}` })).statusCode).toBe(404);
    }
    expect(oldReads).toBe(1); await older.close();
  });
  for (const kind of ['shield', 'warzone_shield'] as const) it(`${kind} dedicated history retains the original receipt while dark and landless`, async () => {
    const f = await fixture(kind); const q = (await f.quote()).purchase!.quote;
    const app = await buildApp(TEST_CONFIG, db);
    const [session] = await db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + HOUR) }).returning();
    const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id) };
    const url = `/base/purchases/v1/shields/${f.request.idempotencyKey}?kind=${kind}`;
    expect((await app.inject({ method: 'GET', url, cookies })).json()).toMatchObject({ enabled: true, purchase: { quote: q, status: 'pending' } });
    const buyer = await createTestPlayer(db);
    await db.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, f.baseId));
    await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    await db.insert(baseSlots).values({ wallet: buyer.wallet, baseId: f.baseId, slot: 1 });
    await creditDeposit(db, q.depositId, payment(q), now);
    await db.delete(shields).where(eq(shields.baseId, f.baseId));
    process.env['BASE_PURCHASE_V1_ENABLED'] = 'false'; process.env['SHIELD_PURCHASE_V1_ENABLED'] = 'false';
    const got = await app.inject({ method: 'GET', url, cookies });
    expect(got.statusCode).toBe(200); expect(got.headers['cache-control']).toBe('private, no-store');
    expect(got.json()).toMatchObject({ version: 1, wallet: f.wallet, idempotencyKey: f.request.idempotencyKey,
      enabled: false, purchase: { quote: q, status: 'credited', receipt: { shield: { granted: true } } } });
    const [other] = await db.insert(sessions).values({ wallet: buyer.wallet, expiresAt: new Date(Date.now() + HOUR) }).returning();
    const buyerCookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, buyer.wallet, other!.id) };
    expect((await app.inject({ method: 'GET', url, cookies: buyerCookies })).json()).toMatchObject({ wallet: buyer.wallet, enabled: false, purchase: null });
    expect(await db.select().from(deposits).where(eq(deposits.playerWallet, f.wallet))).toHaveLength(1); await app.close();
  });
  for (const kind of ['shield', 'warzone_shield'] as const) it(`${kind} exact instructions bind wallet, reference, public rail and both amounts`, async () => {
    const f = await fixture(kind); const q = (await f.quote()).purchase!.quote; const tx = transaction(q); const sig = signature();
    const amount = BigInt(q.rail.mode === 'warzone_split' ? q.rail.splitLamports : q.amountLamports);
    const matches = (value: unknown) => kind === 'shield' ? matchesBasePurchaseBuilderTransaction(value, q) : matchesBasePurchaseWarzoneTransaction(value, q, amount);
    expect(matches(tx)).toBe(true);
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const altered = transaction(q); altered.transaction.message.staticAccountKeys[index] = new PublicKey(randomWallet()); expect(matches(altered)).toBe(false);
    }
    for (const instruction of tx.transaction.message.compiledInstructions.keys()) {
      const altered = transaction(q); altered.transaction.message.compiledInstructions[instruction]!.data[altered.transaction.message.compiledInstructions[instruction]!.data.length - 1]! ^= 1;
      expect(matches(altered)).toBe(false);
    }
    const rpc = { getTransaction: async () => tx, getSignaturesForAddress: async () => [{ signature: sig, err: null, blockTime: now.getTime() / 1000 }] } as unknown as Connection;
    const parse = () => [{ reference: q.reference, wallet: q.wallet, kind: q.rail.sinkKind!, lamports: amount }];
    const intent = { id: q.depositId, playerWallet: f.wallet, kind, reference: q.reference, createdAt: now, expectedLamports: BigInt(q.amountLamports), basePurchaseV1: q, paymentSignature: sig };
    expect(await makeCombinedDepositCommitVerifier(rpc, { liquidity: new PublicKey(network.treasuryLiquidity), basePurchaseNetwork: network }, parse)(intent)).toEqual({ txSignature: sig });
    const verifier = kind === 'shield' ? makeChainDepositVerifier(rpc, parse) : makeWarzoneShieldVerifier(rpc, new PublicKey(network.treasuryLiquidity), parse);
    expect(await verifier(intent)).toMatchObject({ txSignature: sig, lamports: BigInt(q.amountLamports) });
  });
  it('a newer partial Warzone retry cannot hide the older exact finalized payment under the same reference', async () => {
    const f = await fixture('warzone_shield'); const q = (await f.quote()).purchase!.quote;
    if (q.rail.mode !== 'warzone_split') throw new Error('fixture');
    const partialSig = signature(); const exactSig = signature(); const exact = transaction(q); const partial = transaction(q);
    partial.transaction.message.compiledInstructions.pop();
    const rpc = { getTransaction: async (sig: string) => sig === partialSig ? partial : exact,
      getSignaturesForAddress: async () => [partialSig, exactSig].map(sig => ({ signature: sig, err: null, blockTime: now.getTime() / 1000 })) } as unknown as Connection;
    const parse = () => [{ reference: q.reference, wallet: q.wallet, kind: 6, lamports: BigInt(q.rail.mode === 'warzone_split' ? q.rail.splitLamports : '0') }];
    const verifier = makeWarzoneShieldVerifier(rpc, new PublicKey(network.treasuryLiquidity), parse);
    expect(await verifier({ id: q.depositId, playerWallet: q.wallet, kind: 'warzone_shield', reference: q.reference,
      createdAt: now, expectedLamports: BigInt(q.amountLamports), basePurchaseV1: q }))
      .toMatchObject({ txSignature: exactSig, lamports: BigInt(q.amountLamports) });
  });
  for (const missing of ['direct', 'split', 'duplicate'] as const) it(`Warzone ${missing} leg ambiguity remains uncertain after TTL and cannot bind confirmed proof`, async () => {
    const f = await fixture('warzone_shield'); const q = (await f.quote()).purchase!.quote;
    if (q.rail.mode !== 'warzone_split') throw new Error('fixture');
    const tx = transaction(q);
    if (missing === 'direct') tx.transaction.message.compiledInstructions.pop();
    else if (missing === 'split') tx.transaction.message.compiledInstructions.shift();
    else tx.transaction.message.compiledInstructions.push(tx.transaction.message.compiledInstructions[0]!);
    const sig = signature();
    const rpc = { getTransaction: async () => tx, getSignaturesForAddress: async () => [{ signature: sig, err: null, blockTime: now.getTime() / 1000 }] } as unknown as Connection;
    const parse = () => missing === 'split' ? [] : [{ reference: q.reference, wallet: q.wallet, kind: 6, lamports: BigInt(q.rail.mode === 'warzone_split' ? q.rail.splitLamports : '0') }];
    const verifier = makeWarzoneShieldVerifier(rpc, new PublicKey(network.treasuryLiquidity), parse);
    await expect(verifyDepositNow(db, verifier, f.wallet, q.depositId, new Date(Date.parse(q.retryAt) + 1))).rejects.toBeDefined();
    expect((await getBasePurchase(db, f.wallet, f.request.idempotencyKey)).purchase!.status).toBe('pending');
    const commit = makeCombinedDepositCommitVerifier(rpc, { liquidity: new PublicKey(network.treasuryLiquidity), basePurchaseNetwork: network }, parse);
    await expect(submitDepositPayment(db, commit, f.wallet, q.depositId, sig)).rejects.toBeDefined();
  });
});
