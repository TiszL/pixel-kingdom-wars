import { createHash, randomUUID, randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import { CAPS, ECONOMY, UPGRADE_COSTS, upgradeSolLamports } from '@shardkeep/shared';
import { BasePurchaseStatusSchema, type BasePurchaseQuote, type BasePurchaseRequest, type BasePurchaseNetwork } from '@shardkeep/shared/basePurchases';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE } from '../src/auth/session';
import { accounts, bases, baseSlots, buildings, builderJobs, deposits, ledgerTransactions, players, sessions } from '../src/db/schema';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { assertFreshLockedBaseAuthority } from '../src/game/baseOwnership';
import { getBasePurchase, quoteBasePurchase, allowBasePurchaseTerminal, matchesBasePurchaseBuilderTransaction } from '../src/money/basePurchases';
import { createDepositIntent, creditDeposit, submitDepositPayment, type VerifiedPayment } from '../src/money/deposits';
import { makeChainDepositVerifier, makeCombinedDepositCommitVerifier, makeCombinedDepositVerifier, verifyDepositNow } from '../src/money/depositWatcher';
import { NATIVE_SOL_MINT } from '../src/money/mintDimension';
import { PublicKey, type Connection } from '@solana/web3.js';
import { connectTestDb, createTestPlayer, randomWallet, TEST_CONFIG } from './helpers';
const conn = connectTestDb(); const db = conn.db;
const previous = process.env['BASE_PURCHASE_V1_ENABLED'];
beforeEach(() => { process.env['BASE_PURCHASE_V1_ENABLED'] = 'true'; });
afterEach(() => { if (previous === undefined) delete process.env['BASE_PURCHASE_V1_ENABLED']; else process.env['BASE_PURCHASE_V1_ENABLED'] = previous; });
afterAll(async () => { await conn.sql.end(); });
const now = new Date('2034-08-01T00:00:00.000Z');
const network: BasePurchaseNetwork = { cluster: 'devnet', coreProgram: randomWallet(), configPda: randomWallet(),
  treasuryLiquidity: randomWallet(), treasuryDev: randomWallet(), treasuryOps: randomWallet(), systemProgram: '11111111111111111111111111111111' };
const signature = () => bs58.encode(randomBytes(64));
async function fixture(kind: 'builder' | 'expansion' | 'mine' | 'goldforge' = 'builder') {
  const { wallet } = await createTestPlayer(db);
  const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active', landPaidAt: now, keepLevel: 20, builders: 1 }).returning();
  const baseId = base!.id; await db.insert(baseSlots).values({ wallet, baseId, slot: 1 });
  let request: BasePurchaseRequest;
  if (kind === 'mine' || kind === 'goldforge') {
    const level = kind === 'mine' ? 4 : 1;
    const [building] = await db.insert(buildings).values({ playerWallet: wallet, baseId, type: kind, level, tx: 10, ty: 10 }).returning();
    const cost = UPGRADE_COSTS[kind][level - 1]!;
    await rewardBaseShards(db, baseId, BigInt(cost) * 100n, 'test.basepurchase.fund', randomUUID());
    request = { kind: 'mine', idempotencyKey: randomUUID(), baseId, buildingId: building!.id, buildingType: kind,
      fromLevel: level, toLevel: level + 1, maxCostShards: String(cost) };
  } else request = kind === 'builder' ? { kind, idempotencyKey: randomUUID(), baseId, expectedBuilders: 1 }
    : { kind, idempotencyKey: randomUUID(), baseId, expectedExpansions: 0 };
  const prepare = async (id: string) => ({ baseId: id, assertAuthority: async (tx: Parameters<typeof assertFreshLockedBaseAuthority>[0], actor: string, target: string) => { await assertFreshLockedBaseAuthority(tx, actor, target); } });
  const quote = (r = request) => quoteBasePurchase(db, wallet, r, network, now, prepare);
  return { wallet, baseId, request, quote };
}
function payment(status: Awaited<ReturnType<typeof getBasePurchase>>): VerifiedPayment {
  const quote = status.purchase!.quote;
  return { txSignature: signature(), wallet: quote.wallet, kind: quote.request.kind, lamports: BigInt(quote.amountLamports), finalized: true, basePurchaseV1: quote };
}
async function auth(wallet: string) {
  const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + 3600_000) }).returning();
  return { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
}
async function getRow(id: string) { return (await db.select().from(deposits).where(eq(deposits.id, id)))[0]!; }

function builderTransaction(q: BasePurchaseQuote, amount = BigInt(q.amountLamports)) {
  const data = Buffer.alloc(17);
  createHash('sha256').update('global:buy_sink').digest().copy(data, 0, 0, 8);
  data[8] = 8; data.writeBigUInt64LE(amount, 9);
  return { transaction: { message: {
    staticAccountKeys: [q.wallet, q.rail.configPda, q.rail.treasuryLiquidity, q.rail.treasuryDev,
      q.rail.treasuryOps, q.reference, q.rail.systemProgram, q.rail.coreProgram].map(k => new PublicKey(k)),
    compiledInstructions: [{ programIdIndex: 7, accountKeyIndexes: [1, 0, 2, 3, 4, 5, 6], data }],
  } }, meta: { err: null, logMessages: [] } };
}

describe.sequential('original paid base quote and immutable acceptance', () => {
  for (const kind of ['builder', 'expansion', 'mine', 'goldforge'] as const) it(`${kind} freezes full consent before wallet and proves original accepted grant after sale`, async () => {
    const f = await fixture(kind); const status = await f.quote(); const q = status.purchase!.quote;
    expect(BasePurchaseStatusSchema.parse(status)).toEqual(status);
    expect(q.request).toEqual(f.request); expect(q.baseEpoch).toEqual({ landPaidAt: now.toISOString(), deedAssetId: null });
    expect(q.createdAt).toBe(now.toISOString());
    expect(Date.parse(q.payableUntil) - Date.parse(q.createdAt)).toBe((ECONOMY.depositPendingTtlMin - ECONOMY.depositReuseMinRemainingMin) * 60_000);
    const buyer = await createTestPlayer(db);
    await db.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, f.baseId));
    await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    await db.insert(baseSlots).values({ wallet: buyer.wallet, baseId: f.baseId, slot: 1 });
    const pay = payment(status); await creditDeposit(db, q.depositId, pay, now);
    expect((await creditDeposit(db, q.depositId, pay, now)).credited).toBe(false);
    const grantedBase = (await db.select().from(bases).where(eq(bases.id, f.baseId)))[0]!;
    if (kind === 'builder') expect(grantedBase.builders).toBe(2);
    else if (kind === 'expansion') expect(grantedBase.expansions).toBe(1);
    else expect(await db.select().from(builderJobs).where(eq(builderJobs.baseId, f.baseId))).toHaveLength(1);
    process.env['BASE_PURCHASE_V1_ENABLED'] = 'false';
    const accepted = await getBasePurchase(db, f.wallet, f.request.idempotencyKey, now);
    expect(accepted).toMatchObject({ enabled: false, purchase: { quote: q, status: 'credited', receipt: { depositId: q.depositId, txSignature: pay.txSignature, amountLamports: q.amountLamports } } });
    expect(await quoteBasePurchase(db, f.wallet, f.request, undefined, now, async () => { throw new Error('historical RPC'); })).toEqual(accepted);
    if (f.request.kind === 'mine') expect(accepted.purchase!.receipt!.shards).toMatchObject({ currency: 'SHARDS', amount: f.request.maxCostShards });
    else expect(accepted.purchase!.receipt!.shards).toBeNull();
    expect((await getBasePurchase(db, buyer.wallet, f.request.idempotencyKey)).purchase).toBeNull();
  });
  it('the fresh authenticated route uses the configured original rail and never quotes a mismatched cluster', async () => {
    const f = await fixture(); const cookie = await auth(f.wallet);
    const deps = { basePurchaseNetwork: network, mineBuild: { liquidityWallet: network.treasuryLiquidity },
      depositVerifier: async () => null, depositPaymentCommitVerifier: async () => null };
    const app = await buildApp(TEST_CONFIG, db, deps);
    try {
      const response = await app.inject({ method: 'POST', url: '/base/purchases/v1/quote', cookies: cookie, payload: f.request });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().purchase.quote).toMatchObject({ wallet: f.wallet, request: f.request, rail: network });
      expect(response.headers['cache-control']).toBe('private, no-store');
    } finally { await app.close(); }
    const other = await fixture();
    const mismatch = await buildApp(TEST_CONFIG, db, { ...deps, basePurchaseNetwork: { ...network, cluster: 'mainnet-beta' } });
    try {
      const response = await mismatch.inject({ method: 'POST', url: '/base/purchases/v1/quote', cookies: await auth(other.wallet), payload: other.request });
      expect(response.statusCode).toBe(503); expect(response.json().error.code).toBe('BASE_PURCHASE_RAIL_UNAVAILABLE');
      expect((await getBasePurchase(db, other.wallet, other.request.idempotencyKey)).purchase).toBeNull();
    } finally { await mismatch.close(); }
  });
  for (const flag of [undefined, 'false', 'TRUE', 'junk']) it(`fresh quote needs exact true (${flag}); history and auth-only unknown never need land or rail`, async () => {
    const f = await fixture(); const known = await f.quote();
    if (flag === undefined) delete process.env['BASE_PURCHASE_V1_ENABLED']; else process.env['BASE_PURCHASE_V1_ENABLED'] = flag;
    const app = await buildApp(TEST_CONFIG, db);
    try {
      const cookie = await auth(f.wallet);
      const read = await app.inject({ method: 'GET', url: `/base/purchases/v1/${f.request.idempotencyKey}`, cookies: cookie });
      expect(read.statusCode).toBe(200); expect(read.json().purchase.quote).toEqual(known.purchase!.quote);
      const replay = await app.inject({ method: 'POST', url: '/base/purchases/v1/quote', cookies: cookie, payload: f.request });
      expect(replay.statusCode).toBe(200);
      const fresh = await app.inject({ method: 'POST', url: '/base/purchases/v1/quote', cookies: cookie, payload: { ...f.request, idempotencyKey: randomUUID() } });
      expect(fresh.statusCode).toBe(503); expect(fresh.json().error.code).toBe('BASE_PURCHASE_DISABLED');
      const unauth = await app.inject({ method: 'GET', url: `/base/purchases/v1/${f.request.idempotencyKey}` });
      expect(unauth.statusCode).toBe(401);
      const malformed = await app.inject({ method: 'GET', url: '/base/purchases/v1/nope', cookies: cookie });
      expect(malformed.statusCode).toBe(400);
      for (const response of [read, replay, fresh, unauth, malformed]) expect(response.headers['cache-control']).toBe('private, no-store');
    } finally { await app.close(); }
  });
  it('concurrent lost-reply retries produce one reference and key mismatch cannot become another target', async () => {
    const f = await fixture(); const values = await Promise.all(Array.from({ length: 4 }, () => f.quote()));
    values.forEach(v => expect(v.purchase!.quote).toEqual(values[0]!.purchase!.quote));
    expect(await db.select().from(deposits).where(eq(deposits.playerWallet, f.wallet))).toHaveLength(1);
    await expect(f.quote({ ...f.request, baseId: randomUUID() })).rejects.toMatchObject({ code: 'BASE_PURCHASE_MISMATCH' });
    await expect(f.quote({ ...f.request, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'PAYMENT_TARGET_RESERVED' });
  });
  it('legacy pending references cannot be silently upgraded or relabeled', async () => {
    const f = await fixture(); const old = await createDepositIntent(db, f.wallet, 'builder', { baseId: f.baseId }, now);
    await expect(f.quote()).rejects.toMatchObject({ code: 'PAYMENT_TARGET_RESERVED' });
    expect((await getRow(old.id)).payload).not.toHaveProperty('basePurchaseV1');
    expect((await getBasePurchase(db, f.wallet, f.request.idempotencyKey)).purchase).toBeNull();
  });
  for (const kind of ['builder', 'expansion'] as const) it(`${kind} reservations are target-scoped and do not lock out unrelated wallets`, async () => {
    const other = await createTestPlayer(db);
    await db.insert(deposits).values({ playerWallet: other.wallet, kind, reference: randomWallet(), status: 'pending' });
    const f = await fixture(kind); const s = await f.quote();
    expect(s.purchase!.quote.request).toEqual(f.request);
    const buyer = await createTestPlayer(db);
    await db.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, f.baseId));
    await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    await db.insert(baseSlots).values({ wallet: buyer.wallet, baseId: f.baseId, slot: 1 });
    await expect(quoteBasePurchase(db, buyer.wallet, { ...f.request, idempotencyKey: randomUUID() }, network, now))
      .rejects.toMatchObject({ code: 'PAYMENT_TARGET_RESERVED' });
    expect((await getRow(s.purchase!.quote.depositId)).status).toBe('pending');
  });
  it('changed count at quote refuses before any payable reference is created', async () => {
    const f = await fixture(); await db.update(bases).set({ builders: 2 }).where(eq(bases.id, f.baseId));
    await expect(f.quote()).rejects.toMatchObject({ code: 'BASE_PURCHASE_CHANGED' });
    expect(await db.select().from(deposits).where(eq(deposits.playerWallet, f.wallet))).toHaveLength(0);
  });
  for (const kind of ['builder', 'expansion', 'mine', 'goldforge'] as const) it(`${kind} cannot settle into a replacement epoch of the original base`, async () => {
    const f = await fixture(kind); const s = await f.quote(); const q = s.purchase!.quote;
    await db.update(bases).set({ landPaidAt: new Date(now.getTime() + 1) }).where(eq(bases.id, f.baseId));
    await expect(creditDeposit(db, q.depositId, payment(s), now)).rejects.toMatchObject({ statusCode: 409 });
    expect((await getRow(q.depositId)).status).toBe('pending');
    expect(await db.select().from(builderJobs).where(eq(builderJobs.baseId, f.baseId))).toHaveLength(0);
    expect(await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, `mine-up:${q.depositId}`))).toHaveLength(0);
  });
  for (const mutation of ['level', 'type', 'ceiling'] as const) it(`native upgrade ${mutation} mismatch rolls back the complete credit and funding`, async () => {
    const f = await fixture('mine'); if (f.request.kind !== 'mine') throw new Error('fixture');
    const status = await f.quote(); const q = status.purchase!.quote;
    if (mutation === 'level') await db.update(buildings).set({ level: f.request.fromLevel + 1 }).where(eq(buildings.id, f.request.buildingId));
    if (mutation === 'type') await db.update(buildings).set({ type: 'goldforge' }).where(eq(buildings.id, f.request.buildingId));
    if (mutation === 'ceiling') {
      // This checks the locked final guard itself, independently of valid creation pricing.
      const { applyPaidUpgrade } = await import('../src/game/base');
      await expect(db.transaction(tx => applyPaidUpgrade(tx, f.wallet, f.request.kind === 'mine' ? f.request.buildingId : '', randomUUID(), now,
        f.baseId, true, { ...f.request as Extract<BasePurchaseRequest, {kind:'mine'}>, maxCostShards: '1' }))).rejects.toMatchObject({ code: 'BASE_PURCHASE_CHANGED' });
    } else await expect(creditDeposit(db, q.depositId, payment(status), now)).rejects.toBeDefined();
    expect((await getRow(q.depositId)).status).toBe('pending');
    expect(await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, `mine-up:${q.depositId}`))).toHaveLength(0);
    expect(await db.select().from(builderJobs).where(eq(builderJobs.baseId, f.baseId))).toHaveLength(0);
  });
  it('legacy higher SOL quote still pays the current SHARDS price without native level semantics', async () => {
    const f = await fixture('mine'); if (f.request.kind !== 'mine') throw new Error('fixture');
    const intent = await createDepositIntent(db, f.wallet, 'mine', { baseId: f.baseId, buildingId: f.request.buildingId }, now);
    const row = await getRow(intent.id); const high = Number(upgradeSolLamports('mine', f.request.toLevel)) + 1;
    await db.update(deposits).set({ payload: { ...(row.payload as object), amountLamports: high } }).where(eq(deposits.id, intent.id));
    await creditDeposit(db, intent.id, { wallet: f.wallet, kind: 'mine', txSignature: signature(), lamports: BigInt(high), finalized: true }, now);
    expect((await getRow(intent.id)).status).toBe('credited');
    expect(await db.select().from(builderJobs).where(eq(builderJobs.baseId, f.baseId))).toHaveLength(1);
  });
  it('unversioned worker cannot finalize or bind a v1 signature, and v1 verifier proof is mandatory', async () => {
    const f = await fixture(); const status = await f.quote(); const id = status.purchase!.quote.depositId; const pay = payment(status);
    const { basePurchaseV1: _ignored, ...oldPay } = pay;
    await expect(creditDeposit(db, id, oldPay, now)).rejects.toMatchObject({ code: 'BASE_PURCHASE_RAIL_UNAVAILABLE' });
    await expect(db.update(deposits).set({ paymentSignature: signature() }).where(eq(deposits.id, id))).rejects.toBeDefined();
    await expect(db.update(deposits).set({ status: 'expired' }).where(eq(deposits.id, id))).rejects.toBeDefined();
    await expect(verifyDepositNow(db, async () => oldPay, f.wallet, id, new Date(Date.parse(status.purchase!.quote.retryAt) + 1)))
      .rejects.toMatchObject({ code: 'BASE_PURCHASE_RAIL_UNAVAILABLE' });
    expect((await getRow(id)).status).toBe('pending');
  });
  it('database rejects quote mutation, legacy upgrade, deletion and truncation without changing original proof', async () => {
    const f = await fixture(); const s = await f.quote(); const id = s.purchase!.quote.depositId; const row = await getRow(id);
    await expect(db.update(deposits).set({ payload: { ...(row.payload as object), amountLamports: 1 } }).where(eq(deposits.id, id))).rejects.toBeDefined();
    await expect(db.delete(deposits).where(eq(deposits.id, id))).rejects.toBeDefined();
    await expect(db.transaction(async tx => { await tx.execute(sql`truncate deposits cascade`); })).rejects.toBeDefined();
    const other = await fixture(); const legacy = await createDepositIntent(db, other.wallet, 'builder', { baseId: other.baseId });
    await expect(db.update(deposits).set({ payload: { ...(row.payload as object), baseId: other.baseId } }).where(eq(deposits.id, legacy.id))).rejects.toBeDefined();
    await creditDeposit(db, id, payment(s), now);
    await expect(db.update(deposits).set({ amount: 1n }).where(eq(deposits.id, id))).rejects.toBeDefined();
    await expect(db.update(deposits).set({ status: 'pending' }).where(eq(deposits.id, id))).rejects.toBeDefined();
  });
  it('deferred guard rejects an old-style upgrade credit with no exact original SHARDS ledger', async () => {
    const f = await fixture('mine'); const s = await f.quote(); const id = s.purchase!.quote.depositId;
    await expect(db.transaction(async tx => {
      await allowBasePurchaseTerminal(tx, id);
      await tx.update(deposits).set({ status: 'credited', txSignature: signature(), amount: BigInt(s.purchase!.quote.amountLamports), mint: NATIVE_SOL_MINT, finalizedAt: now }).where(eq(deposits.id, id));
    })).rejects.toBeDefined();
    expect((await getRow(id)).status).toBe('pending');
  });
  it('rail drift is indeterminate even after TTL, while history never reads configuration', async () => {
    const f = await fixture('expansion'); const s = await f.quote(); const q = s.purchase!.quote;
    const verifier = makeCombinedDepositVerifier({} as Connection, { liquidity: new PublicKey(network.treasuryLiquidity), basePurchaseNetwork: { ...network, cluster: 'mainnet-beta' } });
    await expect(verifyDepositNow(db, verifier, f.wallet, q.depositId, new Date(Date.parse(q.retryAt) + 1))).rejects.toMatchObject({ code: 'BASE_PURCHASE_RAIL_UNAVAILABLE' });
    expect((await getBasePurchase(db, f.wallet, f.request.idempotencyKey)).purchase!.status).toBe('pending');
  });
  it('confirmed exact signature binding freezes one signature without granting or extending the original window', async () => {
    const f = await fixture(); const s = await f.quote(); const q = s.purchase!.quote; const sig = signature();
    await submitDepositPayment(db, async intent => { expect(intent.basePurchaseV1).toEqual(q); return { txSignature: sig }; }, f.wallet, q.depositId, sig);
    const got = await getBasePurchase(db, f.wallet, f.request.idempotencyKey);
    expect(got.purchase).toMatchObject({ quote: q, status: 'pending', paymentSignature: sig, receipt: null });
    await expect(submitDepositPayment(db, async () => { throw new Error('must not verify replacement'); }, f.wallet, q.depositId, signature())).rejects.toBeDefined();
    await verifyDepositNow(db, async () => null, f.wallet, q.depositId, new Date(Date.parse(q.retryAt) + 1));
    expect((await getRow(q.depositId)).status).toBe('pending');
  });
  it('a different finalized candidate under the public reference cannot replace the original confirmed signature or become failed evidence', async () => {
    const f = await fixture(); const s = await f.quote(); const q = s.purchase!.quote; const sig = signature();
    await submitDepositPayment(db, async () => ({ txSignature: sig }), f.wallet, q.depositId, sig);
    const alternate = payment(s);
    for (const at of [now, new Date(Date.parse(q.retryAt) + 1)]) {
      await expect(verifyDepositNow(db, async () => alternate, f.wallet, q.depositId, at))
        .rejects.toMatchObject({ code: 'BASE_PURCHASE_EVIDENCE_UNAVAILABLE' });
    }
    await expect(db.transaction(async tx => {
      await allowBasePurchaseTerminal(tx, q.depositId);
      await tx.update(deposits).set({ status: 'failed', txSignature: alternate.txSignature, amount: alternate.lamports, finalizedAt: now })
        .where(eq(deposits.id, q.depositId));
    })).rejects.toBeDefined();
    expect((await getBasePurchase(db, f.wallet, f.request.idempotencyKey)).purchase)
      .toMatchObject({ status: 'pending', paymentSignature: sig, txSignature: null, receipt: null });
    await verifyDepositNow(db, async () => ({ ...alternate, txSignature: sig }), f.wallet, q.depositId, now);
    expect((await getBasePurchase(db, f.wallet, f.request.idempotencyKey)).purchase)
      .toMatchObject({ status: 'credited', paymentSignature: sig, txSignature: sig });
  });
  it('exact builder payment validates compiled and legacy messages and rejects altered public rail accounts and bytes', async () => {
    const q = (await (await fixture()).quote()).purchase!.quote; const tx = builderTransaction(q);
    expect(matchesBasePurchaseBuilderTransaction(tx, q)).toBe(true);
    const legacy = { transaction: { message: { accountKeys: tx.transaction.message.staticAccountKeys,
      instructions: [{ programIdIndex: 7, accounts: [1, 0, 2, 3, 4, 5, 6], data: bs58.encode(tx.transaction.message.compiledInstructions[0]!.data) }] } } };
    expect(matchesBasePurchaseBuilderTransaction(legacy, q)).toBe(true);
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const changed = builderTransaction(q); changed.transaction.message.staticAccountKeys[index] = new PublicKey(randomWallet());
      expect(matchesBasePurchaseBuilderTransaction(changed, q)).toBe(false);
    }
    for (const index of [0, 8, 9]) {
      const changed = builderTransaction(q); changed.transaction.message.compiledInstructions[0]!.data[index]! ^= 1;
      expect(matchesBasePurchaseBuilderTransaction(changed, q)).toBe(false);
    }
    const extra = builderTransaction(q); extra.transaction.message.compiledInstructions[0]!.accountKeyIndexes.push(0);
    expect(matchesBasePurchaseBuilderTransaction(extra, q)).toBe(false);
  });
  for (const offset of [-1n, 1n]) it(`a real builder payment at wrong amount ${offset} cannot disappear as unpaid or be confirmed`, async () => {
    const f = await fixture(); const s = await f.quote(); const q = s.purchase!.quote;
    const amount = BigInt(q.amountLamports) + offset; const tx = builderTransaction(q, amount); const sig = signature();
    const rpc = { getTransaction: async () => tx,
      getSignaturesForAddress: async () => [{ signature: sig, err: null, blockTime: now.getTime() / 1000 }] } as unknown as Connection;
    const parse = () => [{ reference: q.reference, wallet: q.wallet, kind: 8, lamports: amount }];
    const chain = makeChainDepositVerifier(rpc, parse);
    const dep = { id: q.depositId, playerWallet: f.wallet, kind: 'builder' as const, reference: q.reference,
      createdAt: now, expectedLamports: BigInt(q.amountLamports), basePurchaseV1: q };
    expect(await chain(dep)).toMatchObject({ txSignature: sig, lamports: amount });
    const commit = makeCombinedDepositCommitVerifier(rpc, { liquidity: new PublicKey(network.treasuryLiquidity), basePurchaseNetwork: network }, parse);
    expect(await commit({ ...dep, paymentSignature: sig })).toBeNull();
    await verifyDepositNow(db, async d => { const paid = await chain(d); return paid && { ...paid, basePurchaseV1: q }; }, f.wallet, q.depositId,
      new Date(Date.parse(q.retryAt) + 1));
    expect((await getBasePurchase(db, f.wallet, f.request.idempotencyKey)).purchase)
      .toMatchObject({ status: 'failed', txSignature: sig, amount: String(amount), receipt: null });
    expect((await db.select().from(bases).where(eq(bases.id, f.baseId)))[0]!.builders).toBe(1);
  });
  it('unpaid expiry is terminal retained history and an attempted expired/failed quote never means refund', async () => {
    const f = await fixture(); const s = await f.quote(); const q = s.purchase!.quote;
    await verifyDepositNow(db, async () => null, f.wallet, q.depositId, new Date(Date.parse(q.retryAt) + 1));
    expect((await getBasePurchase(db, f.wallet, f.request.idempotencyKey)).purchase).toMatchObject({ status: 'expired', receipt: null });
    expect((await f.quote()).purchase!.quote).toEqual(q);
  });
});
