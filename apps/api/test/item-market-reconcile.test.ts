/**
 * Item-market reservation reconciler (tester report 24b9184d, 2026-09-16).
 * What matters and why:
 *  - a PAID reservation delivers even when the buyer's client never polls
 *    again — settlement must not depend on a browser tab (the seller was
 *    paid; the buyer is owed exactly one delivery into the frozen base);
 *  - a lapsed UNPAID reservation is released back to the book with a
 *    `superseded` receipt at the same moment a takeover could have reopened
 *    it, so a seller's unit never sits invisible for hours and the buyer's
 *    saved receipt states the truth;
 *  - every uncertain outcome (missing finalized proof, RPC disagreement, a
 *    committed signature the chain has not finalized, a different finalized
 *    payment than the committed one) leaves the row UNTOUCHED — silence is
 *    never proof of non-payment, so nothing here can hand a paid item away;
 *  - a row a pass could not resolve is retried only after reconcileRetrySec
 *    and logged once (security review 2026-09-17 #1): a batch of permanently
 *    stuck rows must never starve a newer lapsed reservation of its first read.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { PaymentProofUnavailableError } from '@shardkeep/chain';
import { MARKETPLACE } from '@shardkeep/shared';
import type { MarketReserveRequest } from '@shardkeep/shared/market';
import bs58 from 'bs58';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { baseItems, bases, baseSlots, itemListings, playerItems } from '../src/db/schema';
import {
  cancelListing, getListings, getMarketTradeHistory, getPendingMarketPurchases, listItem, reserveListing,
  settleListing, submitPayment, type ItemMarketDeps,
} from '../src/game/itemMarket';
import { reconcileMarketReservations } from '../src/game/itemMarketReconcile';
import { reservationByKey, reservationReceipt } from '../src/game/itemMarketReceipts';
import { payReservation } from '../src/game/itemMarketV1';
import { connectTestDb, createTestPlayer, randomWallet } from './helpers';

const conn = connectTestDb(); const db = conn.db;
const oldMode = process.env['MULTI_BASE_ENABLED'];
beforeAll(() => { process.env['MULTI_BASE_ENABLED'] = 'false'; });
afterAll(async () => { if (oldMode === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = oldMode; await conn.sql.end(); });
const signatureSeed = randomBytes(64);
const sig = (byte: number) => { const bytes = Buffer.from(signatureSeed); bytes[0] = byte; return bs58.encode(bytes); };
const price = BigInt(MARKETPLACE.itemMarket.minPriceLamports);
const context = (baseId: string) => ({ baseId, assertAuthority: async () => {} });
const { reserveTtlSec, reclaimGraceSec, settleTimeoutSec, reconcileRetrySec, reconcileBatch } = MARKETPLACE.itemMarket;
/** Reservation made long enough ago that even a COMMITTED row passed its settle timeout. */
const aged = () => new Date(Date.now() - (reserveTtlSec + settleTimeoutSec + 1) * 1000);
/** Uncommitted row past its reclaim grace — takeable, and releasable by the worker. */
const lapsed = () => new Date(Date.now() - (reserveTtlSec + reclaimGraceSec + 1) * 1000);
/** Expired but still inside the grace — nobody but the buyer may act. */
const expiredInGrace = () => new Date(Date.now() - (reserveTtlSec + 10) * 1000);
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
  const listed = await listItem(db, seller.wallet, 'wardens_helm', price, randomUUID(), undefined, sourceBaseId ? context(sourceBaseId) : undefined);
  const request: MarketReserveRequest = { idempotencyKey: randomUUID(), itemId: listed.itemId, sourceBaseId, buyerBaseId, seller: seller.wallet, priceLamports: price.toString() };
  const reserve = async (now = new Date(), input = request, options = deps) => {
    await reserveListing(db, options, buyer.wallet, listed.id, now, buyerBaseId ? context(buyerBaseId) : undefined, input);
    return (await reservationByKey(db, buyer.wallet, input.idempotencyKey))!;
  };
  const listing = async () => (await db.select().from(itemListings).where(eq(itemListings.id, listed.id)))[0]!;
  const quantity = async (wallet: string, baseId: string | null) => baseId
    ? (await db.select().from(baseItems).where(and(eq(baseItems.baseId, baseId), eq(baseItems.itemId, listed.itemId))))[0]?.qty ?? 0
    : (await db.select().from(playerItems).where(and(eq(playerItems.playerWallet, wallet), eq(playerItems.itemId, listed.itemId))))[0]?.qty ?? 0;
  return { seller, buyer, deps, listed, request, reserve, listing, quantity, sourceBaseId, buyerBaseId };
}
/** Finalized proof that finds exactly `signature` for the reservation's reference. */
const paidWith = (signature: string): ItemMarketDeps['verifyPayment'] => async () => ({ txSignature: signature });
/** The shared test DB carries other suites' reserved rows: scope each pass to the fixture's listings. */
const only = (...listingIds: string[]) => ({ listingIds });
/** A pass `reconcileRetrySec` after `from`: when a row this pass could not resolve becomes eligible again. */
const retryAfter = (from: Date) => new Date(from.getTime() + reconcileRetrySec * 1000 + 1_000);

describe.sequential('market reservation reconciler', () => {
  it('settles a committed reservation whose buyer never polled, once, into the FROZEN receiving base', async () => {
    const f = await fixture(true); const started = expiredInGrace(); const row = await f.reserve(started);
    await submitPayment(db, f.deps, f.buyer.wallet, f.listed.id, sig(10), new Date(started.getTime() + 5_000));
    // The buyer moved their active slot to another deed after reserving: the
    // frozen destination still receives the delivery (it is what they paid for).
    const [other] = await db.insert(bases).values({ ownerWallet: f.buyer.wallet, status: 'active', landPaidAt: new Date() }).returning();
    await db.update(baseSlots).set({ baseId: other!.id }).where(eq(baseSlots.wallet, f.buyer.wallet));
    const verifyPayment = vi.fn(paidWith(sig(10)));
    const first = await reconcileMarketReservations(db, { ...f.deps, verifyPayment }, new Date(), only(f.listed.id));
    expect(first).toMatchObject({ configured: true, scanned: 1, settled: 1, released: 0, held: 0, uncertain: 0 });
    expect(verifyPayment).toHaveBeenCalledWith(expect.objectContaining({ reference: row.reference, paymentSignature: sig(10), buyer: f.buyer.wallet }));
    expect(await f.quantity(f.buyer.wallet, f.buyerBaseId)).toBe(1);
    expect(await f.quantity(f.buyer.wallet, other!.id)).toBe(0);
    expect(await f.listing()).toMatchObject({ status: 'sold', buyerWallet: f.buyer.wallet, txSignature: sig(10) });
    expect((await reservationReceipt(db, row))).toMatchObject({ state: 'settled', txSignature: sig(10) });
    // A second pass finds nothing reserved: exactly one delivery, ever.
    expect(await reconcileMarketReservations(db, { ...f.deps, verifyPayment }, new Date(), only(f.listed.id))).toMatchObject({ scanned: 0, settled: 0 });
    expect(await f.quantity(f.buyer.wallet, f.buyerBaseId)).toBe(1);
    expect((await getMarketTradeHistory(db, f.buyer.wallet)).trades[0]).toMatchObject({ role: 'bought', txSignature: sig(10) });
  });

  it('settles a lapsed pre-contract (unkeyed) reservation whose payment is found by its reference', async () => {
    const f = await fixture(); const legacy = { ...f.deps, cluster: undefined };
    const old = await reserveListing(db, legacy, f.buyer.wallet, f.listed.id, lapsed());
    expect((await getPendingMarketPurchases(db, f.buyer.wallet)).purchases).toHaveLength(1);
    const verifyPayment = vi.fn(paidWith(sig(11)));
    expect(await reconcileMarketReservations(db, { ...legacy, verifyPayment }, new Date(), only(f.listed.id))).toMatchObject({ scanned: 1, settled: 1 });
    expect(verifyPayment).toHaveBeenCalledWith(expect.objectContaining({ reference: old.reference, paymentSignature: undefined }));
    expect(await f.quantity(f.buyer.wallet, null)).toBe(1);
    expect((await getPendingMarketPurchases(db, f.buyer.wallet)).purchases).toEqual([]);
  });

  it('settles a recorded reservation the buyer paid but never reported (client closed before /paid), by reference scan, exactly once', async () => {
    // Tester report 260d9b67 shape: reserve → the wallet approves and
    // broadcasts → the tab closes before /paid or any /settle poll. The row is
    // `reserved` with NO payment_sig, so only the finalized reference scan can
    // find the payment. The seller was paid; the buyer is owed one delivery.
    const f = await fixture(true); const row = await f.reserve(lapsed());
    expect(await f.listing()).toMatchObject({ paymentSig: null, reconcileAttemptedAt: null });
    const verifyPayment = vi.fn(paidWith(sig(19)));
    // The buyer reopens the app at the very moment the worker runs: both prove
    // the same finalized payment and exactly one of them may deliver.
    const [pass, own] = await Promise.all([
      reconcileMarketReservations(db, { ...f.deps, verifyPayment }, new Date(), only(f.listed.id)),
      settleListing(db, { ...f.deps, verifyPayment }, f.buyer.wallet, f.listed.id, row.reference),
    ]);
    expect(pass).toMatchObject({ configured: true, scanned: 1, settled: 1, released: 0, held: 0, uncertain: 0 });
    expect(own).toMatchObject({ settled: true, itemId: f.listed.itemId });
    expect(verifyPayment).toHaveBeenCalledWith(expect.objectContaining({ reference: row.reference, buyer: f.buyer.wallet, paymentSignature: undefined, notBefore: row.createdAt }));
    expect(await f.quantity(f.buyer.wallet, f.buyerBaseId)).toBe(1);
    expect(await f.listing()).toMatchObject({ status: 'sold', buyerWallet: f.buyer.wallet, txSignature: sig(19) });
    expect(await reservationReceipt(db, row)).toMatchObject({ state: 'settled', txSignature: sig(19), payable: false });
    // Every later actor is idempotent: another pass, the saved-receipt recovery, a repeated /settle.
    expect(await reconcileMarketReservations(db, { ...f.deps, verifyPayment }, retryAfter(new Date()), only(f.listed.id))).toMatchObject({ scanned: 0, settled: 0 });
    expect((await payReservation(db, { ...f.deps, verifyPayment }, f.buyer.wallet, row.id, row.reference, undefined, true)).state).toBe('settled');
    expect(await settleListing(db, { ...f.deps, verifyPayment }, f.buyer.wallet, f.listed.id, row.reference)).toMatchObject({ settled: true });
    expect(await f.quantity(f.buyer.wallet, f.buyerBaseId)).toBe(1);
    expect((await getMarketTradeHistory(db, f.buyer.wallet)).trades).toHaveLength(1);
  });

  it('a batch full of stuck rows cannot starve a fresh lapsed reservation; stuck rows are logged once and retried after the interval', async () => {
    // Security review 2026-09-17 #1 / KNOWN_ISSUES: a pass took the 25 oldest
    // reserved rows, so 25 permanently uncertain ones (a pinned signature the
    // RPC no longer returns) filled every batch and a newer lapsed reservation
    // was never read — its seller's unit hidden and its buyer told nothing,
    // forever, at two RPC calls and a console.error per stuck row per minute.
    const stuck: Awaited<ReturnType<typeof fixture>>[] = []; const stuckRefs = new Set<string>();
    for (let i = 0; i < reconcileBatch + 1; i++) { const f = await fixture(); stuckRefs.add((await f.reserve(lapsed())).reference); stuck.push(f); }
    const ids = stuck.map((s) => s.listed.id);
    const verifyPayment = vi.fn(async (p: { reference: string }) => {
      if (stuckRefs.has(p.reference)) throw new PaymentProofUnavailableError('marketplace signature proof is unavailable');
      return null; // any other row is provably unpaid
    });
    const deps = { ...dependencies(), verifyPayment };
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Two passes attempt every stuck row once (25, then the 26th) and log each exactly once.
      const t0 = new Date();
      expect(await reconcileMarketReservations(db, deps, t0, only(...ids))).toMatchObject({ scanned: reconcileBatch, uncertain: reconcileBatch, released: 0, settled: 0 });
      const t1 = new Date(t0.getTime() + 60_000);
      expect(await reconcileMarketReservations(db, deps, t1, only(...ids))).toMatchObject({ scanned: 1, uncertain: 1 });
      expect(quiet).toHaveBeenCalledTimes(reconcileBatch + 1);
      for (const s of stuck) expect((await s.listing()).reconcileAttemptedAt).not.toBeNull();
      // A reservation lapses after the stuck rows were attempted: the next pass
      // reads it alone (the stuck rows wait out reconcileRetrySec) and releases it.
      const fresh = await fixture(); const freshRow = await fresh.reserve(lapsed());
      const t2 = new Date(t1.getTime() + 60_000);
      verifyPayment.mockClear();
      expect(await reconcileMarketReservations(db, deps, t2, only(...ids, fresh.listed.id))).toMatchObject({ scanned: 1, released: 1, uncertain: 0 });
      expect(verifyPayment).toHaveBeenCalledTimes(1);
      expect(verifyPayment).toHaveBeenCalledWith(expect.objectContaining({ reference: freshRow.reference }));
      expect(await fresh.listing()).toMatchObject({ status: 'active', reference: null, reconcileAttemptedAt: null });
      expect((await reservationReceipt(db, freshRow)).state).toBe('superseded');
      // Even once every stuck row is eligible again, a never-attempted row is
      // read before any of them; the retried stuck rows are counted, not logged.
      const again = await fixture(); const againRow = await again.reserve(lapsed());
      verifyPayment.mockClear(); quiet.mockClear();
      expect(await reconcileMarketReservations(db, deps, retryAfter(t1), only(...ids, again.listed.id))).toMatchObject({ scanned: reconcileBatch, released: 1, uncertain: reconcileBatch - 1 });
      expect(verifyPayment).toHaveBeenCalledWith(expect.objectContaining({ reference: againRow.reference }));
      expect(await again.listing()).toMatchObject({ status: 'active', reconcileAttemptedAt: null });
      expect(quiet).not.toHaveBeenCalled();
      // Every stuck row is exactly as it was: reserved by its buyer, never released, receipt intact.
      for (const s of stuck) expect(await s.listing()).toMatchObject({ status: 'reserved', reservedBy: s.buyer.wallet });
    } finally { quiet.mockRestore(); }
  });

  it('releases a lapsed UNPAID reservation to the book with a superseded receipt and no custody change', async () => {
    const f = await fixture(); const row = await f.reserve(lapsed());
    const verifyPayment = vi.fn(async () => null);
    expect(await reconcileMarketReservations(db, { ...f.deps, verifyPayment }, new Date(), only(f.listed.id))).toMatchObject({ scanned: 1, settled: 0, released: 1, uncertain: 0 });
    expect(verifyPayment).toHaveBeenCalledTimes(1);
    expect(await f.listing()).toMatchObject({ status: 'active', reservedBy: null, reservedUntil: null, reference: null, paymentSig: null, buyerBaseId: null });
    const receipt = await reservationReceipt(db, row);
    expect(receipt).toMatchObject({ state: 'superseded', payable: false, paymentSignature: null, txSignature: null });
    expect(receipt.resolvedAt).not.toBeNull();
    // The unit stays in market custody (the seller listed it for sale); nobody was granted anything.
    expect(await f.quantity(f.seller.wallet, null)).toBe(0);
    expect(await f.quantity(f.buyer.wallet, null)).toBe(0);
    expect((await getListings(db)).listings.some((l) => l.id === f.listed.id)).toBe(true);
    // The old buyer's recovery check answers from the receipt alone — no RPC, no delivery, no new quote.
    verifyPayment.mockClear();
    expect((await payReservation(db, { ...f.deps, verifyPayment }, f.buyer.wallet, row.id, row.reference, undefined, true)).state).toBe('superseded');
    expect(verifyPayment).not.toHaveBeenCalled();
    // And the listing is genuinely buyable again by someone else.
    const next = await createTestPlayer(db);
    const fresh = await reserveListing(db, f.deps, next.wallet, f.listed.id);
    expect(fresh.reference).not.toBe(row.reference);
    expect((await f.listing()).reservedBy).toBe(next.wallet);
  });

  it('never touches a live or in-grace reservation, and waits on a legacy committed one', async () => {
    const live = await fixture(); await live.reserve();
    const inGrace = await fixture(); await inGrace.reserve(expiredInGrace());
    const legacy = await fixture(); const started = expiredInGrace();
    await reserveListing(db, { ...legacy.deps, cluster: undefined }, legacy.buyer.wallet, legacy.listed.id, started);
    await submitPayment(db, { ...legacy.deps, cluster: undefined }, legacy.buyer.wallet, legacy.listed.id, sig(12), new Date(started.getTime() + 5_000));
    const verifyPayment = vi.fn(async () => null);
    // Only the committed legacy row is even read; uncommitted rows inside the grace are not scanned.
    for (const f of [live, inGrace]) expect(await reconcileMarketReservations(db, { ...f.deps, verifyPayment }, new Date(), only(f.listed.id))).toMatchObject({ scanned: 0 });
    expect(verifyPayment).not.toHaveBeenCalled();
    const pass = await reconcileMarketReservations(db, { ...legacy.deps, cluster: undefined, verifyPayment }, new Date(), only(legacy.listed.id));
    expect(verifyPayment).toHaveBeenCalledTimes(1);
    expect(verifyPayment).toHaveBeenCalledWith(expect.objectContaining({ buyer: legacy.buyer.wallet, paymentSignature: sig(12) }));
    expect(pass).toMatchObject({ scanned: 1, settled: 0, released: 0, waiting: 1, held: 0 });
    for (const f of [live, inGrace, legacy]) expect((await f.listing()).status).toBe('reserved');
    expect((await legacy.listing()).paymentSig).toBe(sig(12));
  });

  it('holds a committed recorded reservation whose finalized proof is still missing — never releases it', async () => {
    const f = await fixture(); const started = aged(); const row = await f.reserve(started);
    await submitPayment(db, f.deps, f.buyer.wallet, f.listed.id, sig(13), new Date(started.getTime() + 5_000));
    const first = new Date();
    const pass = await reconcileMarketReservations(db, { ...f.deps, verifyPayment: async () => null }, first, only(f.listed.id));
    expect(pass).toMatchObject({ scanned: 1, settled: 0, released: 0, held: 1, uncertain: 0 });
    expect(await f.listing()).toMatchObject({ status: 'reserved', reservedBy: f.buyer.wallet, paymentSig: sig(13), reconcileAttemptedAt: first });
    expect((await reservationReceipt(db, row)).state).toBe('committed');
    // A held row is not re-read every minute (two RPC calls per pass, forever,
    // for a proof that finality has not produced yet): it waits reconcileRetrySec.
    // The buyer's own /settle poll is never gated by this.
    const verifyPayment = vi.fn(paidWith(sig(13)));
    expect(await reconcileMarketReservations(db, { ...f.deps, verifyPayment }, new Date(first.getTime() + 60_000), only(f.listed.id))).toMatchObject({ scanned: 0 });
    expect(verifyPayment).not.toHaveBeenCalled();
    // Finality arrives later: the pass after the retry interval delivers to the buyer who committed.
    expect(await reconcileMarketReservations(db, { ...f.deps, verifyPayment }, retryAfter(first), only(f.listed.id))).toMatchObject({ scanned: 1, settled: 1 });
    expect(await f.quantity(f.buyer.wallet, null)).toBe(1);
  });

  it('leaves a lapsed reservation untouched when finalized proof is unavailable or the RPCs disagree, retried after the interval and logged once', async () => {
    const f = await fixture(); const row = await f.reserve(lapsed());
    const unavailable = async () => { throw new PaymentProofUnavailableError('finalized reference transaction body is unavailable'); };
    const disagree = async () => { throw new Error('independent RPCs disagree for item-market reference'); };
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let at = new Date();
      for (const verifyPayment of [unavailable, disagree]) {
        expect(await reconcileMarketReservations(db, { ...f.deps, verifyPayment }, at, only(f.listed.id))).toMatchObject({ scanned: 1, released: 0, settled: 0, uncertain: 1 });
        expect(await f.listing()).toMatchObject({ status: 'reserved', reservedBy: f.buyer.wallet, reference: row.reference, reconcileAttemptedAt: at });
        expect((await reservationReceipt(db, row)).state).toBe('reserved');
        // Not re-read on the next minute's pass: an absent proof does not appear by polling harder.
        expect(await reconcileMarketReservations(db, { ...f.deps, verifyPayment }, new Date(at.getTime() + 60_000), only(f.listed.id))).toMatchObject({ scanned: 0 });
        at = retryAfter(at);
      }
      // One console.error for the row's first failed attempt; the retry after the interval is counted, not logged.
      expect(quiet).toHaveBeenCalledTimes(1);
      expect(quiet).toHaveBeenCalledWith(expect.stringContaining(`[market-reconcile] listing ${f.listed.id}`), expect.any(PaymentProofUnavailableError));
    } finally { quiet.mockRestore(); }
  });

  it('does nothing without a verifier, and a verifier-less cancel can no longer reclaim a lapsed reservation', async () => {
    const f = await fixture(); await f.reserve(lapsed());
    expect(await reconcileMarketReservations(db, { cluster: 'devnet', feeTreasury: f.deps.feeTreasury }, new Date(), only(f.listed.id))).toMatchObject({ configured: false, scanned: 0 });
    expect(await reconcileMarketReservations(db, { cluster: 'devnet', verifyPayment: f.deps.verifyPayment }, new Date(), only(f.listed.id))).toMatchObject({ configured: false, scanned: 0 });
    // Before 2026-09-16 an UNRECORDED lapsed row with no verifier read as "unpaid" and the seller
    // got the unit back — a paying legacy buyer could lose the item. Silence is uncertainty.
    const legacy = await fixture(); await reserveListing(db, { ...legacy.deps, cluster: undefined }, legacy.buyer.wallet, legacy.listed.id, lapsed());
    for (const g of [f, legacy]) {
      await expect(cancelListing(db, { cluster: g.deps.cluster, feeTreasury: g.deps.feeTreasury }, g.seller.wallet, g.listed.id)).rejects.toThrow(/verification is unavailable/);
      expect((await g.listing()).status).toBe('reserved');
      expect(await g.quantity(g.seller.wallet, null)).toBe(0);
    }
  });

  it('refuses to settle a committed signature against a DIFFERENT finalized payment and keeps the row intact', async () => {
    // The buyer committed X (proven at confirmed); the finalized reference scan
    // finds Y instead. The receipt's committed signature is the payment the DB
    // fences pin (a settled receipt must carry payment_sig = tx_signature), so
    // this is refused deterministically: no grant, no release, nothing lost —
    // and it stays visible to the reconciler every pass until ops decide.
    const f = await fixture(); const started = expiredInGrace(); const row = await f.reserve(started);
    await submitPayment(db, f.deps, f.buyer.wallet, f.listed.id, sig(14), new Date(started.getTime() + 5_000));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const other = { ...f.deps, verifyPayment: paidWith(sig(15)) };
      await expect(settleListing(db, other, f.buyer.wallet, f.listed.id)).rejects.toThrow(/recorded reservation changed/);
      expect(await reconcileMarketReservations(db, other, new Date(), only(f.listed.id))).toMatchObject({ scanned: 1, settled: 0, released: 0, uncertain: 1 });
      expect(quiet).toHaveBeenCalledWith(expect.stringContaining(`[market-reconcile] listing ${f.listed.id}`), expect.anything());
    } finally { quiet.mockRestore(); }
    expect(await f.listing()).toMatchObject({ status: 'reserved', paymentSig: sig(14), txSignature: null, buyerWallet: null });
    expect((await reservationReceipt(db, row))).toMatchObject({ state: 'committed', paymentSignature: sig(14) });
    expect(await f.quantity(f.buyer.wallet, null)).toBe(0);
  });

  it('expired-then-paid is deterministic: settle wins before any takeover, and a payment after supersession is logged, never delivered', async () => {
    // Case 2 (settlePaidExpired doc): the payment finalized while the row was
    // takeable — the reconciler delivers to the original buyer and the would-be
    // taker is refused.
    const first = await fixture(); const row = await first.reserve(lapsed());
    expect(await reconcileMarketReservations(db, { ...first.deps, verifyPayment: paidWith(sig(16)) }, new Date(), only(first.listed.id))).toMatchObject({ settled: 1 });
    const taker = await createTestPlayer(db);
    await expect(reserveListing(db, first.deps, taker.wallet, first.listed.id)).rejects.toThrow(/not available/);
    expect((await reservationReceipt(db, row)).state).toBe('settled');
    expect(await first.quantity(first.buyer.wallet, null)).toBe(1);

    // Case 3: the reservation was released unpaid and sold to someone else; a
    // signature that proves the OLD quote arrives afterwards. It cannot settle
    // (terminal receipt, different generation) and SOL is non-custodial, so the
    // server reports the superseded receipt and logs the orphaned payment for
    // support instead of pretending the check is still pending.
    const second = await fixture(); const stale = await second.reserve(lapsed());
    expect(await reconcileMarketReservations(db, { ...second.deps, verifyPayment: async () => null }, new Date(), only(second.listed.id))).toMatchObject({ released: 1 });
    const other = await createTestPlayer(db);
    const theirs = await reserveListing(db, second.deps, other.wallet, second.listed.id);
    await settleListing(db, { ...second.deps, verifyPayment: paidWith(sig(17)) }, other.wallet, second.listed.id, theirs.reference);
    const loud = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const verifyPaymentCommit = vi.fn(async (p: { paymentSignature: string }) => ({ txSignature: p.paymentSignature }));
      const receipt = await payReservation(db, { ...second.deps, verifyPaymentCommit }, second.buyer.wallet, stale.id, stale.reference, sig(18), true);
      expect(receipt).toMatchObject({ state: 'superseded', paymentSignature: null, txSignature: null, payable: false });
      expect(verifyPaymentCommit).toHaveBeenCalledWith(expect.objectContaining({ reference: stale.reference, paymentSignature: sig(18), buyer: second.buyer.wallet }));
      expect(loud).toHaveBeenCalledWith(expect.stringContaining(`[market] LATE PAYMENT ${sig(18)} proves a superseded reservation ${stale.id}`));
    } finally { loud.mockRestore(); }
    expect(await second.listing()).toMatchObject({ status: 'sold', buyerWallet: other.wallet, txSignature: sig(17) });
    expect(await second.quantity(other.wallet, null)).toBe(1);
    expect(await second.quantity(second.buyer.wallet, null)).toBe(0);
  });
});
