import { randomBytes, randomUUID } from 'node:crypto';
import { PaymentProofUnavailableError } from '@shardkeep/chain';
import type { Connection } from '@solana/web3.js';
import { MARKETPLACE } from '@shardkeep/shared';
import { MarketReserveRequestSchema, type MarketReserveRequest } from '@shardkeep/shared/market';
import bs58 from 'bs58';
import { and, eq, sql } from 'drizzle-orm';
import { createDb } from '../src/db/client';
import { TEST_DATABASE_URL } from './db-url';
import { assertMarketRecoveryCompatible } from '../src/game/itemMarketCompatibility';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { baseItems, bases, baseSlots, itemListings, itemMarketCancellations, itemMarketReservations, playerItems, players, sessions } from '../src/db/schema';
import { cancelListing, getPendingMarketPurchases, getMarketTradeHistory, listItem, reserveListing, settleListing, submitPayment, type ItemMarketDeps } from '../src/game/itemMarket';
import { actionDayCounts, utcDay } from '../src/game/actionDay';
import { recomputeTesterMilestones } from '../src/game/tester';
import { cancellationByKey, listingCreationReceipt, reservationByKey, reservationReceipt } from '../src/game/itemMarketReceipts';
import { cancelListingV1, payReservation } from '../src/game/itemMarketV1';
import { connectTestDb, createTestPlayer, randomWallet, TEST_CONFIG } from './helpers';
import { getWalletBalances } from '../src/game/walletBalances';

const conn = connectTestDb(); const db = conn.db;
const oldMode = process.env['MULTI_BASE_ENABLED'];
beforeAll(() => { process.env['MULTI_BASE_ENABLED'] = 'false'; });
afterAll(async () => { if (oldMode === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = oldMode; await conn.sql.end(); });
const signatureSeed = randomBytes(64);
const sig = (byte: number) => { const bytes = Buffer.from(signatureSeed); bytes[0] = byte; return bs58.encode(bytes); };
const price = BigInt(MARKETPLACE.itemMarket.minPriceLamports);
const context = (baseId: string) => ({ baseId, assertAuthority: async () => {} });
function dependencies(): ItemMarketDeps { return { cluster: 'devnet', feeTreasury: randomWallet(), verifyPayment: async () => null,
  verifyPaymentCommit: async (p) => ({ txSignature: p.paymentSignature }), refreshStableSourceAuthority: async () => {} }; }
async function fixture(stable = false) {
  const seller = await createTestPlayer(db); const buyer = await createTestPlayer(db); const deps = dependencies();
  let sourceBaseId: string | null = null; let buyerBaseId: string | null = null;
  if (stable) {
    process.env['MULTI_BASE_ENABLED'] = 'true';
    for (const wallet of [seller.wallet, buyer.wallet]) {
      const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active', landPaidAt: new Date() }).returning();
      await db.insert(baseSlots).values({ wallet, slot: 1, baseId: base!.id, active: true });
      if (wallet === seller.wallet) sourceBaseId = base!.id; else buyerBaseId = base!.id;
    }
    await db.insert(baseItems).values({ baseId: sourceBaseId!, itemId: 'wardens_helm', qty: 1 });
  } else { process.env['MULTI_BASE_ENABLED'] = 'false'; await db.insert(playerItems).values({ playerWallet: seller.wallet, itemId: 'wardens_helm', qty: 1 }); }
  const listKey = randomUUID(); const listed = await listItem(db, seller.wallet, 'wardens_helm', price, listKey, undefined, sourceBaseId ? context(sourceBaseId) : undefined);
  const request: MarketReserveRequest = { idempotencyKey: randomUUID(), itemId: listed.itemId, sourceBaseId, buyerBaseId, seller: seller.wallet, priceLamports: price.toString() };
  const reserve = async (input = request, now = new Date(), options = deps) => {
    await reserveListing(db, options, buyer.wallet, listed.id, now, buyerBaseId ? context(buyerBaseId) : undefined, input);
    return (await reservationByKey(db, buyer.wallet, input.idempotencyKey))!;
  };
  const quantity = async (wallet: string, baseId: string | null) => baseId
    ? (await db.select().from(baseItems).where(and(eq(baseItems.baseId, baseId), eq(baseItems.itemId, listed.itemId))))[0]?.qty ?? 0
    : (await db.select().from(playerItems).where(and(eq(playerItems.playerWallet, wallet), eq(playerItems.itemId, listed.itemId))))[0]?.qty ?? 0;
  return { seller, buyer, deps, listed, listKey, request, reserve, quantity, sourceBaseId, buyerBaseId };
}
const aged = () => new Date(Date.now() - (MARKETPLACE.itemMarket.reserveTtlSec + MARKETPLACE.itemMarket.settleTimeoutSec + 1) * 1000);

describe.sequential('retained legacy market purchase recovery', () => {
  it('discovers only the original buyer legacy rows without making an old quote payable or mutating it', async () => {
    const f = await fixture(); const old = await reserveListing(db, { ...f.deps, cluster: undefined }, f.buyer.wallet, f.listed.id, aged());
    const before = (await db.select().from(itemListings).where(eq(itemListings.id, f.listed.id)))[0];
    const pending = await getPendingMarketPurchases(db, f.buyer.wallet);
    expect(pending.purchases).toEqual([expect.objectContaining({ listingId: f.listed.id, reference: old.reference, buyerBaseId: null })]);
    expect(pending.purchases[0]).not.toHaveProperty('feeTreasury');
    expect((await getPendingMarketPurchases(db, f.seller.wallet)).purchases).toEqual([]);
    expect((await db.select().from(itemListings).where(eq(itemListings.id, f.listed.id)))[0]).toEqual(before);
    expect(await reservationByKey(db, f.buyer.wallet, f.request.idempotencyKey)).toBeNull();
    const keyed = await fixture(); await keyed.reserve();
    expect((await getPendingMarketPurchases(db, keyed.buyer.wallet)).purchases).toEqual([]);
  });
  it('rescues an expired paid legacy same-buyer retry before any new reference or second grant', async () => {
    const f = await fixture(); const deps = { ...f.deps, cluster: undefined };
    const old = await reserveListing(db, deps, f.buyer.wallet, f.listed.id, aged());
    const verifyPayment = vi.fn(async () => ({ txSignature: sig(70) }));
    await expect(reserveListing(db, { ...deps, verifyPayment }, f.buyer.wallet, f.listed.id)).rejects.toThrow(/sold/);
    expect(verifyPayment).toHaveBeenCalledWith(expect.objectContaining({ reference: old.reference, buyer: f.buyer.wallet }));
    expect((await db.select().from(itemListings).where(eq(itemListings.id, f.listed.id)))[0]?.reference).toBe(old.reference);
    expect(await f.quantity(f.buyer.wallet, null)).toBe(1);
    await settleListing(db, { ...deps, verifyPayment }, f.buyer.wallet, f.listed.id, old.reference);
    expect(await f.quantity(f.buyer.wallet, null)).toBe(1);
  });
  it('does not overwrite a legacy generation replaced while its payment scan is in flight', async () => {
    const f = await fixture(); const deps = { ...f.deps, cluster: undefined };
    await reserveListing(db, deps, f.buyer.wallet, f.listed.id, aged());
    const replacement = randomWallet();
    const verifyPayment = async () => {
      await db.update(itemListings).set({ reference: replacement }).where(eq(itemListings.id, f.listed.id));
      return null;
    };
    await expect(reserveListing(db, { ...deps, verifyPayment }, f.buyer.wallet, f.listed.id)).rejects.toThrow(/changed/);
    expect((await db.select().from(itemListings).where(eq(itemListings.id, f.listed.id)))[0]?.reference).toBe(replacement);
    expect(await f.quantity(f.buyer.wallet, null)).toBe(0);
  });
  it('keeps recovery private, exact-reference and land-independent; actual settlement earns tester credit once', async () => {
    const f = await fixture(true); const deps = { ...f.deps, cluster: undefined };
    const old = await reserveListing(db, deps, f.buyer.wallet, f.listed.id, aged(), context(f.buyerBaseId!));
    const next = await createTestPlayer(db);
    await db.update(bases).set({ ownerWallet: next.wallet, status: 'inactive' }).where(eq(bases.id, f.buyerBaseId!));
    await db.update(players).set({ entryPaidAt: null }).where(eq(players.wallet, f.buyer.wallet));
    process.env['MULTI_BASE_ENABLED'] = 'false';
    const verifyPayment = vi.fn(async () => ({ txSignature: sig(71) }));
    const app = await buildApp(TEST_CONFIG, db, { market: { feeTreasury: deps.feeTreasury!, verifyPayment } });
    const cookies = async (wallet: string) => {
      const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
      return { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
    };
    try {
      const buyerCookies = await cookies(f.buyer.wallet); const strangerCookies = await cookies(next.wallet);
      const url = `/market/purchases/${f.listed.id}/check`;
      expect((await app.inject({ method: 'GET', url: '/market/purchases/pending' })).statusCode).toBe(401);
      const found = await app.inject({ method: 'GET', url: '/market/purchases/pending', cookies: buyerCookies });
      expect(found.statusCode).toBe(200); expect(found.headers['cache-control']).toBe('private, no-store');
      expect(found.json().purchases[0]).toMatchObject({ reference: old.reference, buyerBaseId: f.buyerBaseId });
      expect(verifyPayment).not.toHaveBeenCalled();
      expect((await app.inject({ method: 'POST', url, cookies: buyerCookies, payload: { reference: randomWallet() } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'POST', url, cookies: strangerCookies, payload: { reference: old.reference } })).statusCode).toBe(422);
      expect(verifyPayment).not.toHaveBeenCalled();
      expect((await getMarketTradeHistory(db, f.buyer.wallet)).trades).toEqual([]);
      const done = await app.inject({ method: 'POST', url, cookies: buyerCookies, payload: { reference: old.reference } });
      expect(done.statusCode).toBe(200); expect(done.json().settled).toBe(true);
      expect(done.headers['cache-control']).toBe('private, no-store');
      await app.inject({ method: 'POST', url, cookies: buyerCookies, payload: { reference: old.reference } });
      expect(await f.quantity(f.buyer.wallet, f.buyerBaseId)).toBe(1);
      expect((await getPendingMarketPurchases(db, f.buyer.wallet)).purchases).toEqual([]);
      expect((await getMarketTradeHistory(db, f.buyer.wallet)).trades[0]).toMatchObject({ role: 'bought', txSignature: sig(71) });
      expect((await getMarketTradeHistory(db, f.seller.wallet)).trades[0]?.role).toBe('sold');
      expect((await getMarketTradeHistory(db, next.wallet)).trades).toEqual([]);
      const today = utcDay(new Date());
      expect((await actionDayCounts(db, f.buyer.wallet, [today])).get(today)?.get('market_bought')?.count).toBe(1);
      expect((await recomputeTesterMilestones(db, f.buyer.wallet)).some((a) => a.key === 'market_bought')).toBe(true);
      expect((await recomputeTesterMilestones(db, f.buyer.wallet)).some((a) => a.key === 'market_bought')).toBe(false);
    } finally { await app.close(); }
  });
});

describe.sequential('versioned market quote and command receipts', () => {
  it('keeps a just-paid purchase committed while finalized proof is unavailable, then settles and delivers once', async () => {
    const f = await fixture(); const row = await f.reserve(); const signature = sig(90);
    const committed = await payReservation(db, f.deps, f.buyer.wallet, row.id, row.reference, signature);
    const before = (await db.select().from(itemListings).where(eq(itemListings.id, f.listed.id)))[0];
    const uncertain = { ...f.deps, verifyPayment: async () => { throw new PaymentProofUnavailableError('marketplace signature proof is unavailable'); } };
    const waiting = await payReservation(db, uncertain, f.buyer.wallet, row.id, row.reference, signature, true);
    expect(waiting).toMatchObject({ state: 'committed', payable: false, paymentSignature: signature, txSignature: null, quote: committed.quote });
    expect((await db.select().from(itemListings).where(eq(itemListings.id, f.listed.id)))[0]).toEqual(before);
    expect(await f.quantity(f.buyer.wallet, null)).toBe(0);
    // The same uncertainty must NEVER release the paid item for cancellation or another quote.
    const afterHold = new Date(before!.reservedUntil!.getTime() + MARKETPLACE.itemMarket.settleTimeoutSec * 1000 + 1);
    await expect(cancelListing(db, uncertain, f.seller.wallet, f.listed.id, afterHold)).rejects.toThrow(/proof is unavailable/);
    await expect(f.reserve({ ...f.request, idempotencyKey: randomUUID() }, new Date(), uncertain)).rejects.toThrow();
    const proved = { ...f.deps, verifyPayment: async () => ({ txSignature: signature }) };
    const settled = await payReservation(db, proved, f.buyer.wallet, row.id, row.reference, signature, true);
    expect(settled).toMatchObject({ state: 'settled', txSignature: signature, quote: committed.quote });
    await payReservation(db, proved, f.buyer.wallet, row.id, row.reference, signature, true);
    expect(await f.quantity(f.buyer.wallet, null)).toBe(1);
  });
  it('refreshes buyer and seller chain balances after payment instead of reporting a pre-payment cache', async () => {
    const f = await fixture(); const row = await f.reserve(); const signature = sig(91);
    let paid = false;
    const buyerAfter = 1_000_000_000 - Number(row.priceLamports) - 5_000;
    const sellerAfter = 1_000_000_000 + Number(row.sellerLamports);
    const getBalance = vi.fn(async (owner: { toBase58(): string }) => !paid ? 1_000_000_000
      : owner.toBase58() === f.buyer.wallet ? buyerAfter : sellerAfter);
    const connection = { getBalance, getParsedTokenAccountsByOwner: async () => ({ value: [] }) } as unknown as Connection;
    const read = (wallet: string) => getWalletBalances(wallet, { gameRpcUrl: 'https://game.invalid' }, 10, { connectionFactory: () => connection });
    await read(f.buyer.wallet); await read(f.seller.wallet);
    paid = true;
    await payReservation(db, { ...f.deps, verifyPayment: async () => ({ txSignature: signature }) }, f.buyer.wallet, row.id, row.reference, signature, true);
    expect((await read(f.buyer.wallet)).sol).toBe(buyerAfter / 1e9);
    expect((await read(f.seller.wallet)).sol).toBe(sellerAfter / 1e9);
    expect(getBalance).toHaveBeenCalledTimes(4);
  });
  it('concurrent exact keys create one generation and changed consent cannot reuse it', async () => {
    const f = await fixture(); const results = await Promise.all([f.reserve(), f.reserve()]);
    expect(results[0].id).toBe(results[1].id);
    expect((await db.select().from(itemMarketReservations).where(eq(itemMarketReservations.listingId, f.listed.id))).length).toBe(1);
    await expect(f.reserve({ ...f.request, priceLamports: (price + 1n).toString() })).rejects.toThrow(/different terms/);
    await expect(f.reserve({ ...f.request, idempotencyKey: randomUUID() })).rejects.toThrow(/existing reservation/);
    expect(await f.quantity(f.seller.wallet, null)).toBe(0);
  });
  it('rejects changed offer before a new reference is recorded', async () => {
    const f = await fixture();
    await expect(f.reserve({ ...f.request, seller: randomWallet() })).rejects.toThrow(/offer changed/);
    expect(await reservationByKey(db, f.buyer.wallet, f.request.idempotencyKey)).toBeNull();
    expect((await db.select().from(itemListings).where(eq(itemListings.id, f.listed.id)))[0]?.status).toBe('active');
  });
  it('historical listing proof follows the immutable creator key after source ownership changes', async () => {
    const f = await fixture(true); const before = await listingCreationReceipt(db, f.seller.wallet, f.listKey);
    const next = await createTestPlayer(db);
    await db.update(bases).set({ ownerWallet: next.wallet }).where(eq(bases.id, f.sourceBaseId!));
    await db.update(baseSlots).set({ wallet: next.wallet }).where(eq(baseSlots.baseId, f.sourceBaseId!));
    await f.reserve({ ...f.request, seller: next.wallet });
    expect((await db.select().from(itemListings).where(eq(itemListings.id, f.listed.id)))[0]?.sellerWallet).toBe(next.wallet);
    expect(await listingCreationReceipt(db, f.seller.wallet, f.listKey)).toEqual(before);
    expect(await listingCreationReceipt(db, next.wallet, f.listKey)).toBeNull();
  });
  it('legacy protected retry and payment verification consume original fee and network terms', async () => {
    const f = await fixture(); const row = await f.reserve(); const changed = { ...f.deps, feeTreasury: randomWallet() };
    const quote = await reserveListing(db, changed, f.buyer.wallet, f.listed.id);
    expect(quote.feeTreasury).toBe(row.feeTreasury);
    const proof = vi.fn(async (p: Parameters<NonNullable<ItemMarketDeps['verifyPaymentCommit']>>[0]) => ({ txSignature: p.paymentSignature }));
    await submitPayment(db, { ...changed, verifyPaymentCommit: proof }, f.buyer.wallet, f.listed.id, sig(1));
    expect(proof.mock.calls[0]?.[0]).toMatchObject({ feeTreasury: row.feeTreasury, sellerLamports: row.sellerLamports, feeLamports: row.feeLamports });
    const r = (await reservationByKey(db, f.buyer.wallet, f.request.idempotencyKey))!;
    expect(r.state).toBe('committed'); expect(r.paymentSig).toBe(sig(1));
    await expect(payReservation(db, { ...changed, cluster: 'mainnet-beta' }, f.buyer.wallet, row.id, row.reference, sig(1), true)).rejects.toThrow(/network/);
  });
  it('settled proof and exact delivery survive both deed transfers and repeated requests', async () => {
    const f = await fixture(true); const row = await f.reserve(); const stranger = await createTestPlayer(db);
    await db.update(bases).set({ ownerWallet: stranger.wallet, status: 'inactive' }).where(eq(bases.id, f.sourceBaseId!));
    await db.update(bases).set({ ownerWallet: stranger.wallet, status: 'inactive' }).where(eq(bases.id, f.buyerBaseId!));
    const deps = { ...f.deps, verifyPayment: async () => ({ txSignature: sig(2) }) };
    const receipt = await payReservation(db, deps, f.buyer.wallet, row.id, row.reference, sig(2), true);
    expect(receipt.state).toBe('settled'); expect(receipt.txSignature).toBe(sig(2));
    expect(await f.quantity(f.buyer.wallet, f.buyerBaseId)).toBe(1);
    expect((await payReservation(db, deps, f.buyer.wallet, row.id, row.reference, sig(2), true)).quote).toEqual(receipt.quote);
    expect(await f.quantity(f.buyer.wallet, f.buyerBaseId)).toBe(1);
    await expect(payReservation(db, deps, stranger.wallet, row.id, row.reference, sig(2), true)).rejects.toThrow(/not found/);
    expect((await f.reserve()).id).toBe(row.id);
  });
  it('same buyer replacement rescues a paid recorded generation instead of issuing another quote', async () => {
    const f = await fixture(); const old = await f.reserve(f.request, aged());
    await expect(f.reserve({ ...f.request, idempotencyKey: randomUUID() }, new Date(), { ...f.deps, verifyPayment: async () => ({ txSignature: sig(3) }) })).rejects.toThrow(/sold/);
    expect((await reservationByKey(db, f.buyer.wallet, f.request.idempotencyKey))?.state).toBe('settled');
    expect(await f.quantity(f.buyer.wallet, null)).toBe(1);
    expect((await f.reserve()).reference).toBe(old.reference);
  });
  it('v1 same buyer takeover rescues an expired unrecorded legacy payment first', async () => {
    const f = await fixture(); const legacy = { ...f.deps, cluster: undefined };
    const old = await reserveListing(db, legacy, f.buyer.wallet, f.listed.id, aged());
    await expect(f.reserve(f.request, new Date(), { ...f.deps, verifyPayment: async () => ({ txSignature: sig(4) }) })).rejects.toThrow(/sold/);
    expect(await reservationByKey(db, f.buyer.wallet, f.request.idempotencyKey)).toBeNull();
    expect((await db.select().from(itemListings).where(eq(itemListings.id, f.listed.id)))[0]?.reference).toBe(old.reference);
    expect(await f.quantity(f.buyer.wallet, null)).toBe(1);
  });
  it('superseded history never settles into a new generation or becomes payable again', async () => {
    const f = await fixture(); const old = await f.reserve(f.request, aged());
    const next = await f.reserve({ ...f.request, idempotencyKey: randomUUID() });
    const result = await payReservation(db, { ...f.deps, verifyPayment: async () => ({ txSignature: sig(5) }) }, f.buyer.wallet, old.id, old.reference, sig(5), true);
    expect(result.state).toBe('superseded'); expect(result.payable).toBe(false);
    expect(await f.quantity(f.buyer.wallet, null)).toBe(0);
    expect((await db.select().from(itemListings).where(eq(itemListings.id, f.listed.id)))[0]?.reference).toBe(next.reference);
  });
  it('a recorded verified commitment stays held when finalized history is absent', async () => {
    const f = await fixture(); const start = aged(); const row = await f.reserve(f.request, start);
    await submitPayment(db, f.deps, f.buyer.wallet, f.listed.id, sig(6), start);
    await expect(cancelListing(db, f.deps, f.seller.wallet, f.listed.id)).rejects.toThrow(/finality/);
    expect((await reservationByKey(db, f.buyer.wallet, f.request.idempotencyKey))?.state).toBe('committed');
    expect(await f.quantity(f.seller.wallet, null)).toBe(0);
    expect(row.reference).not.toBeNull();
  });
  it('records cancellation attribution atomically and exact retries never return a second item', async () => {
    const f = await fixture(); const request = { idempotencyKey: randomUUID(), itemId: f.listed.itemId,
      sourceBaseId: null, priceLamports: price.toString(), status: 'active' as const, reference: null };
    const results = await Promise.all([cancelListingV1(db, f.deps, f.seller.wallet, f.listed.id, request, context), cancelListingV1(db, f.deps, f.seller.wallet, f.listed.id, request, context)]);
    expect(results[0]).toEqual(results[1]); expect(results[0].state).toBe('cancelled');
    expect(await f.quantity(f.seller.wallet, null)).toBe(1);
    expect((await cancellationByKey(db, f.seller.wallet, request.idempotencyKey))?.actorWallet).toBe(f.seller.wallet);
    await expect(cancelListingV1(db, f.deps, f.seller.wallet, f.listed.id, { ...request, priceLamports: (price + 1n).toString() }, context)).rejects.toThrow(/different terms/);
  });
  it('paid rescue records a settled cancellation outcome rather than claiming a returned item', async () => {
    const f = await fixture(); const row = await f.reserve(f.request, aged());
    const request = { idempotencyKey: randomUUID(), itemId: f.listed.itemId, sourceBaseId: null,
      priceLamports: price.toString(), status: 'reserved' as const, reference: row.reference };
    const result = await cancelListingV1(db, { ...f.deps, verifyPayment: async () => ({ txSignature: sig(7) }) }, f.seller.wallet, f.listed.id, request, context);
    expect(result.state).toBe('settled'); expect(result.settlement).toMatchObject({ buyer: f.buyer.wallet, reference: row.reference, txSignature: sig(7) });
    expect(await f.quantity(f.seller.wallet, null)).toBe(0); expect(await f.quantity(f.buyer.wallet, null)).toBe(1);
  });
  it('pending cancellation cannot acquire the source deed again through a new owner context', async () => {
    const f = await fixture(true); const row = await f.reserve(f.request, aged());
    const request = { idempotencyKey: randomUUID(), itemId: f.listed.itemId, sourceBaseId: f.sourceBaseId,
      priceLamports: price.toString(), status: 'reserved' as const, reference: row.reference };
    await expect(cancelListingV1(db, { ...f.deps, verifyPayment: async () => { throw new Error('RPC unavailable'); } }, f.seller.wallet, f.listed.id, request, context)).rejects.toThrow(/RPC unavailable/);
    expect((await cancellationByKey(db, f.seller.wallet, request.idempotencyKey))?.state).toBe('pending');
    const next = await createTestPlayer(db); await db.update(bases).set({ ownerWallet: next.wallet }).where(eq(bases.id, f.sourceBaseId!));
    const prepare = vi.fn(context);
    const result = await cancelListingV1(db, f.deps, f.seller.wallet, f.listed.id, request, prepare);
    expect(result.state).toBe('refused'); expect(await f.quantity(next.wallet, f.sourceBaseId)).toBe(0);
    expect((await db.select().from(itemListings).where(eq(itemListings.id, f.listed.id)))[0]?.status).toBe('reserved');
  });
  it('a crash after paid rescue reconciles the original pending cancellation without repeating RPC', async () => {
    const f = await fixture(); const row = await f.reserve(f.request, aged());
    const request = { idempotencyKey: randomUUID(), itemId: f.listed.itemId, sourceBaseId: null,
      priceLamports: price.toString(), status: 'reserved' as const, reference: row.reference };
    await expect(cancelListingV1(db, { ...f.deps, verifyPayment: async () => { throw new Error('disconnect'); } }, f.seller.wallet, f.listed.id, request, context)).rejects.toThrow(/disconnect/);
    await settleListing(db, { ...f.deps, verifyPayment: async () => ({ txSignature: sig(8) }) }, f.buyer.wallet, f.listed.id);
    const verifier = vi.fn(async () => { throw new Error('must not run'); });
    const result = await cancelListingV1(db, { ...f.deps, verifyPayment: verifier }, f.seller.wallet, f.listed.id, request, context);
    expect(result.state).toBe('settled'); expect(verifier).not.toHaveBeenCalled();
  });
  it('never adopts a protected legacy quote with guessed network or fee history', async () => {
    const f = await fixture(); await reserveListing(db, { ...f.deps, cluster: undefined }, f.buyer.wallet, f.listed.id);
    await expect(f.reserve()).rejects.toMatchObject({ code: 'MARKET_LEGACY_RECOVERY_REQUIRED' });
    expect(await reservationByKey(db, f.buyer.wallet, f.request.idempotencyKey)).toBeNull();
  });
  it('a pending cancellation GET is read-only and historical keys stay available without land', async () => {
    const f = await fixture(); const row = await f.reserve(f.request, aged());
    const request = { idempotencyKey: randomUUID(), itemId: f.listed.itemId, sourceBaseId: null,
      priceLamports: price.toString(), status: 'reserved' as const, reference: row.reference };
    await expect(cancelListingV1(db, { ...f.deps, verifyPayment: async () => { throw new Error('disconnect'); } }, f.seller.wallet, f.listed.id, request, context)).rejects.toThrow();
    const app = await buildApp(TEST_CONFIG, db);
    const cookies = async (wallet: string) => {
      const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
      return { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
    };
    try {
      const sellerCookies = await cookies(f.seller.wallet); const buyerCookies = await cookies(f.buyer.wallet);
      const cancelUrl = `/market/v1/cancellations/by-key/${request.idempotencyKey}`;
      const before = await cancellationByKey(db, f.seller.wallet, request.idempotencyKey);
      const response = await app.inject({ method: 'GET', url: cancelUrl, cookies: sellerCookies });
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('private, no-store'); expect(response.json().state).toBe('pending');
      expect(await cancellationByKey(db, f.seller.wallet, request.idempotencyKey)).toEqual(before);
      expect((await app.inject({ method: 'GET', url: cancelUrl, cookies: buyerCookies })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: cancelUrl })).statusCode).toBe(401);
      const oldList = await app.inject({ method: 'POST', url: '/market/v1/list', cookies: sellerCookies,
        payload: { idempotencyKey: f.listKey, itemId: f.listed.itemId, baseId: null, priceLamports: price.toString() } });
      expect(oldList.statusCode).toBe(200);
      const oldReserve = await app.inject({ method: 'POST', url: `/market/v1/listings/${f.listed.id}/reserve`, cookies: buyerCookies, payload: f.request });
      expect(oldReserve.statusCode).toBe(200); expect(oldReserve.json().quote.reference).toBe(row.reference);
      await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, f.buyer.wallet));
      const book = await app.inject({ method: 'GET', url: '/market/listings', cookies: buyerCookies });
      expect(book.statusCode).toBe(200);
      expect(book.json().features.itemMarket.version).toBe(1);
    } finally { await app.close(); }
  });
  it('schema rejects substitute wallets missing consent and noncanonical price strings', () => {
    const valid = { idempotencyKey: randomUUID(), itemId: 'wardens_helm', sourceBaseId: null, buyerBaseId: null, seller: randomWallet(), priceLamports: price.toString() };
    for (const input of [{ ...valid, buyer: randomWallet() }, { ...valid, sourceBaseId: randomUUID() }, { ...valid, priceLamports: '01' }, { ...valid, priceLamports: '1e9' }]) {
      expect(MarketReserveRequestSchema.safeParse(input).success).toBe(false);
    }
  });
});


describe.sequential('marketplace receipt database fences', () => {
  async function rejectsConstraint(action: () => Promise<unknown>, message: RegExp) {
    let caught: unknown;
    try { await action(); } catch (error) { caught = error; }
    expect(caught).toBeDefined();
    expect(String((caught as { cause?: { message?: string } })?.cause?.message ?? (caught as Error)?.message)).toMatch(message);
  }
  it('retains immutable quote and cancellation intent and rejects compatible-writer lifecycle regression', async () => {
    const f = await fixture(); const row = await f.reserve();
    await rejectsConstraint(() => db.update(itemMarketReservations).set({ feeTreasury: randomWallet() }).where(eq(itemMarketReservations.id, row.id)), /quote is immutable/);
    await rejectsConstraint(() => db.delete(itemMarketReservations).where(eq(itemMarketReservations.id, row.id)), /receipts are retained/);
    await submitPayment(db, f.deps, f.buyer.wallet, f.listed.id, sig(40));
    await rejectsConstraint(() => db.update(itemMarketReservations).set({ state: 'superseded', resolvedAt: new Date() }).where(eq(itemMarketReservations.id, row.id)), /lifecycle cannot regress/);
    const fresh = await fixture();
    const request = { idempotencyKey: randomUUID(), itemId: fresh.listed.itemId, sourceBaseId: null,
      priceLamports: price.toString(), status: 'active' as const, reference: null };
    await cancelListingV1(db, fresh.deps, fresh.seller.wallet, fresh.listed.id, request, context);
    const cancellation = (await cancellationByKey(db, fresh.seller.wallet, request.idempotencyKey))!;
    await rejectsConstraint(() => db.update(itemMarketCancellations).set({ actorWallet: fresh.buyer.wallet }).where(eq(itemMarketCancellations.id, cancellation.id)), /evidence is immutable/);
    await rejectsConstraint(() => db.delete(itemMarketCancellations).where(eq(itemMarketCancellations.id, cancellation.id)), /receipts are retained/);
  });
  it('rejects old-style settle cancel and re-reserve writes without corresponding history even from a capable connection', async () => {
    const f = await fixture(); const row = await f.reserve();
    for (const values of [{ status: 'sold', buyerWallet: f.buyer.wallet, txSignature: sig(41) },
      { status: 'cancelled', reservedBy: null, reservedUntil: null, reference: null, buyerBaseId: null },
      { reference: randomWallet() }]) {
      await rejectsConstraint(() => db.update(itemListings).set(values).where(eq(itemListings.id, f.listed.id)), /generation disagrees|fresh reservation requires immutable quote/);
    }
    expect((await reservationReceipt(db, row)).payable).toBe(true);
    expect(await f.quantity(f.buyer.wallet, null)).toBe(0);
  });
  it('validates final transaction state and exposes no payable quote during a mismatched intermediate state', async () => {
    const f = await fixture(); const row = await f.reserve();
    await expect(db.transaction(async (tx) => {
      await tx.update(itemListings).set({ reference: randomWallet() }).where(eq(itemListings.id, f.listed.id));
      expect((await reservationReceipt(tx, row)).payable).toBe(false);
      throw new Error('test rollback');
    })).rejects.toThrow('test rollback');
    await rejectsConstraint(() => db.transaction(async (tx) => {
      await tx.update(itemMarketReservations).set({ state: 'settled', txSignature: sig(42), resolvedAt: new Date() }).where(eq(itemMarketReservations.id, row.id));
      await tx.execute(sql`set constraints all immediate`);
    }), /settlement disagrees/);
    // Normal settlement updates listing, receipt and inventory atomically.
    await settleListing(db, { ...f.deps, verifyPayment: async () => ({ txSignature: sig(42) }) }, f.buyer.wallet, f.listed.id);
    expect((await reservationReceipt(db, row)).state).toBe('settled');
    expect(await f.quantity(f.buyer.wallet, null)).toBe(1);
  });
  it('does not permit an unrecorded replacement reference after a recorded generation', async () => {
    const f = await fixture(); const row = await f.reserve();
    await rejectsConstraint(() => db.transaction(async (tx) => {
      await tx.update(itemMarketReservations).set({ state: 'superseded', resolvedAt: new Date() }).where(eq(itemMarketReservations.id, row.id));
      await tx.update(itemListings).set({ reference: randomWallet() }).where(eq(itemListings.id, f.listed.id));
    }), /fresh reservation requires immutable quote/);
    expect((await reservationReceipt(db, row)).state).toBe('reserved');
  });
  it('startup and write capability fences reject old binaries after retained evidence exists', async () => {
    const f = await fixture(); const row = await f.reserve();
    expect((await db.execute(sql`select public.shardkeep_item_market_required_contract() as required`))[0]?.['required']).toBe(1);
    await assertMarketRecoveryCompatible(db);
    await expect(assertMarketRecoveryCompatible(db, 'e199-legacy')).rejects.toThrow(/requires marketplace-receipts-v1/);
    const old = createDb(TEST_DATABASE_URL, { marketRecoveryWriter: false, legacyTestEscape: true });
    try {
      await rejectsConstraint(() => old.db.update(itemListings).set({ reference: randomWallet() }).where(eq(itemListings.id, f.listed.id)), /writer required/);
      await rejectsConstraint(() => old.db.update(itemMarketReservations).set({ state: 'superseded', resolvedAt: new Date() }).where(eq(itemMarketReservations.id, row.id)), /writer required/);
    } finally { await old.sql.end(); }
  });
  it('untouched pre-migration reservations can still complete through the legacy path without invented history', async () => {
    // Production cutover forbids wallet-held noncosmetic items independently of
    // marketplace history; the supported old quote retains both stable bases.
    const f = await fixture(true); const legacy = { ...f.deps, cluster: undefined };
    await reserveListing(db, legacy, f.buyer.wallet, f.listed.id, new Date(), context(f.buyerBaseId!));
    const strict = createDb(TEST_DATABASE_URL, { marketRecoveryWriter: false });
    try {
      await settleListing(strict.db, { ...legacy, verifyPayment: async () => ({ txSignature: sig(43) }) }, f.buyer.wallet, f.listed.id);
      expect(await reservationByKey(db, f.buyer.wallet, f.request.idempotencyKey)).toBeNull();
      expect(await f.quantity(f.buyer.wallet, f.buyerBaseId)).toBe(1);
    } finally { await strict.sql.end(); }
  });
  it('new unrecorded references are refused outside the explicit legacy fixture escape', async () => {
    const f = await fixture(); const strict = createDb(TEST_DATABASE_URL);
    try {
      await rejectsConstraint(() => reserveListing(strict.db, { ...f.deps, cluster: undefined }, f.buyer.wallet, f.listed.id), /fresh reservation requires immutable quote/);
      expect((await db.select().from(itemListings).where(eq(itemListings.id, f.listed.id)))[0]?.status).toBe('active');
    } finally { await strict.sql.end(); }
  });
  it('uncertain finalized proof never replaces or cancels an uncommitted generation', async () => {
    const f = await fixture(); const row = await f.reserve(f.request, aged());
    const uncertain = { ...f.deps, verifyPayment: async () => { throw new Error('finalized reference transaction body is unavailable'); } };
    await expect(f.reserve({ ...f.request, idempotencyKey: randomUUID() }, new Date(), uncertain)).rejects.toThrow(/body is unavailable/);
    await expect(cancelListing(db, uncertain, f.seller.wallet, f.listed.id)).rejects.toThrow(/body is unavailable/);
    expect((await reservationReceipt(db, row)).state).toBe('reserved');
    expect(await f.quantity(f.seller.wallet, null)).toBe(0);
  });
});
