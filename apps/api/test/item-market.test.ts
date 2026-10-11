/**
 * In-app item market (Lane B, SOL-settled). The money/item contract:
 *  - an item is conserved (held in the listing, never duplicated or lost),
 *  - buyer pays seller 95% + our treasury 5% via a VERIFIED split (no verify →
 *    no item; the 5% is unskippable),
 *  - the item is reserved before payment so it can't vanish under a paying buyer,
 *  - ONE finalized signature settles at most ONE listing (no dup/fee-bypass),
 *  - a buyer who paid can always claim (settle isn't blocked by expiry), and a
 *    seller can never reclaim an item a buyer already paid for.
 */
import { BuildingType, MARKETPLACE } from '@shardkeep/shared';
import bs58 from 'bs58';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  bases, baseSlots, buildings, deedOwnershipObservations, heroEquipment,
  itemListings, playerItems, players,
} from '../src/db/schema';
import {
  cancelListing, getListings, listItem as listItemRaw, reserveListing, settleListing, submitPayment,
  type ItemMarketDeps,
} from '../src/game/itemMarket';
import { equipHeroItem, getItems } from '../src/game/items';
import { assertLockedMarketLandAuthority } from '../src/game/routes';
import { bootstrapSystemAccounts } from '../src/ledger';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb();
const db = conn.db;

const FEE = 'FeeTreasury1111111111111111111111111111111';
const signatureOf = (byte: number): string => bs58.encode(new Uint8Array(64).fill(byte));
const confirmCommitted: NonNullable<ItemMarketDeps['verifyPaymentCommit']> = async (p) => (
  { txSignature: p.paymentSignature }
);
/** Verifier that ALWAYS confirms payment, returning a given signature. */
const paidWith = (sig: string): ItemMarketDeps => ({
  feeTreasury: FEE,
  verifyPayment: async () => ({ txSignature: sig }),
  verifyPaymentCommit: confirmCommitted,
});
/** Distinct-signature happy path (unique sig per call). */
let sigN = 0;
const paidDeps: ItemMarketDeps = {
  feeTreasury: FEE,
  verifyPayment: async () => ({ txSignature: `sig-${++sigN}` }),
  verifyPaymentCommit: confirmCommitted,
};
/** Buyer hasn't paid / not finalized. */
const unpaidDeps: ItemMarketDeps = {
  feeTreasury: FEE,
  verifyPayment: async () => null,
  verifyPaymentCommit: confirmCommitted,
};
let listRequestN = 0;
const listItem = (
  dbArg: typeof db, seller: string, itemId: string, priceLamports: bigint,
  requestKey = `item-market-test-${++listRequestN}`,
) => listItemRaw(dbArg, seller, itemId, priceLamports, requestKey);

const qtyOf = async (w: string, itemId: string): Promise<number> => {
  const [r] = await db.select({ q: playerItems.qty }).from(playerItems)
    .where(and(eq(playerItems.playerWallet, w), eq(playerItems.itemId, itemId)));
  return r?.q ?? 0;
};
const statusOf = async (id: string): Promise<string> => {
  const [r] = await db.select({ s: itemListings.status }).from(itemListings).where(eq(itemListings.id, id));
  return r!.s;
};
/** Age a reservation past its TTL (the sweep runs on read/reserve/cancel). */
const expire = (id: string): Promise<unknown> =>
  db.update(itemListings).set({ reservedUntil: sql`now() - interval '1 hour'` }).where(eq(itemListings.id, id));
async function sellerWith(itemId: string, n: number) {
  const p = await createTestPlayer(db);
  await db.insert(playerItems).values({ playerWallet: p.wallet, itemId, qty: n });
  return p;
}

let stableDeedN = 120;
async function grantStableLand(wallet: string): Promise<string> {
  const assetId = bs58.encode(new Uint8Array(32).fill(stableDeedN++));
  const checkedAt = new Date();
  const [base] = await db.insert(bases).values({
    ownerWallet: wallet, deedAssetId: assetId, status: 'active', landPaidAt: checkedAt,
  }).returning({ id: bases.id });
  await db.insert(baseSlots).values({ wallet, slot: 1, baseId: base!.id, active: true });
  await db.insert(deedOwnershipObservations).values({
    baseId: base!.id, assetId, owner: wallet, slot: BigInt(stableDeedN), checkedAt,
    source: 'item-market-authority-test', status: 'owned', auditHash: `market-${assetId}`,
  });
  return base!.id;
}

async function transferStableLand(wallet: string, baseId: string): Promise<void> {
  const recipient = await createTestPlayer(db);
  await db.transaction(async (tx) => {
    await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    await tx.delete(baseSlots).where(eq(baseSlots.baseId, baseId));
    await tx.update(bases).set({ ownerWallet: recipient.wallet, status: 'inactive' })
      .where(eq(bases.id, baseId));
  });
}

/** Hold the exact player root a real deed transfer locks, then commit the loss
 * only after the market operation is already in flight. This models a route
 * refresh that passed immediately before the transfer won the transaction race. */
async function holdStableLandTransfer(wallet: string, baseId: string) {
  const recipient = await createTestPlayer(db);
  let markLocked!: () => void;
  let releaseTransfer!: () => void;
  const locked = new Promise<void>((resolve) => { markLocked = resolve; });
  const release = new Promise<void>((resolve) => { releaseTransfer = resolve; });
  const done = db.transaction(async (tx) => {
    await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    markLocked();
    await release;
    await tx.delete(baseSlots).where(eq(baseSlots.baseId, baseId));
    await tx.update(bases).set({ ownerWallet: recipient.wallet, status: 'inactive' })
      .where(eq(bases.id, baseId));
  });
  await Promise.race([
    locked,
    done.then(() => { throw new Error('land transfer completed before its barrier was released'); }),
  ]);
  return { release: releaseTransfer, done };
}

beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { await conn.sql.end(); });

describe('item market (SOL-settled)', () => {
  it('holds one unit for concurrent exact retries and binds the request key', async () => {
    const s = await sellerWith('keg_of_haste', 2);
    const key = 'same-list-request-key';
    const results = await Promise.all(Array.from({ length: 8 }, () => (
      listItem(db, s.wallet, 'keg_of_haste', 1_000_000n, key)
    )));
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(await qtyOf(s.wallet, 'keg_of_haste')).toBe(1);
    expect(await db.select().from(itemListings)
      .where(eq(itemListings.idempotencyKey, `item-list:${s.wallet}:${key}`))).toHaveLength(1);
    await expect(listItem(db, s.wallet, 'keg_of_haste', 2_000_000n, key))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(await qtyOf(s.wallet, 'keg_of_haste')).toBe(1);
  });

  it('stable authority fence rejects listing after a seller transfer wins the route-to-mutation race', async () => {
    // WHY: a finalized refresh outside the transaction is only an observation.
    // The seller can transfer that deed before inventory is escrowed unless the
    // list transaction shares the transfer's player/base/slot/observation locks.
    const seller = await sellerWith('keg_of_haste', 1);
    const baseId = await grantStableLand(seller.wallet);
    const loss = await holdStableLandTransfer(seller.wallet, baseId);
    const key = `stable-list-race-${++listRequestN}`;
    const action = listItemRaw(
      db, seller.wallet, 'keg_of_haste', 1_000_000n, key, assertLockedMarketLandAuthority,
    );
    const rejected = expect(action).rejects.toThrow(/buy your land|ownership/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    loss.release();
    await loss.done;
    await rejected;
    expect(await qtyOf(seller.wallet, 'keg_of_haste')).toBe(1);
    expect(await db.select({ id: itemListings.id }).from(itemListings)
      .where(eq(itemListings.idempotencyKey, `item-list:${seller.wallet}:${key}`))).toHaveLength(0);
  });

  it('stable authority fence rejects reserve after the seller transfer wins the race', async () => {
    const seller = await sellerWith('keg_of_haste', 1);
    const buyer = await createTestPlayer(db);
    const sellerBase = await grantStableLand(seller.wallet);
    await grantStableLand(buyer.wallet);
    const listing = await listItemRaw(
      db, seller.wallet, 'keg_of_haste', 1_000_000n,
      `stable-seller-reserve-${++listRequestN}`, assertLockedMarketLandAuthority,
    );
    const loss = await holdStableLandTransfer(seller.wallet, sellerBase);
    const deps = { ...unpaidDeps, authorizeLandMutation: assertLockedMarketLandAuthority };
    const action = reserveListing(db, deps, buyer.wallet, listing.id);
    const rejected = expect(action).rejects.toThrow(/seller no longer owns land/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    loss.release();
    await loss.done;
    await rejected;
    expect(await statusOf(listing.id)).toBe('active');
  });

  it('stable authority fence rejects reserve after the buyer transfer wins the race', async () => {
    const seller = await sellerWith('keg_of_haste', 1);
    const buyer = await createTestPlayer(db);
    await grantStableLand(seller.wallet);
    const buyerBase = await grantStableLand(buyer.wallet);
    const listing = await listItemRaw(
      db, seller.wallet, 'keg_of_haste', 1_000_000n,
      `stable-buyer-reserve-${++listRequestN}`, assertLockedMarketLandAuthority,
    );
    const loss = await holdStableLandTransfer(buyer.wallet, buyerBase);
    const deps = { ...unpaidDeps, authorizeLandMutation: assertLockedMarketLandAuthority };
    const action = reserveListing(db, deps, buyer.wallet, listing.id);
    const rejected = expect(action).rejects.toThrow(/buy your land|ownership/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    loss.release();
    await loss.done;
    await rejected;
    expect(await statusOf(listing.id)).toBe('active');
  });

  it('recovers the exact committed reservation after both parties transfer their land', async () => {
    // WHY: reserve retry is the buyer's recovery read after a dropped response.
    // Once a signature is broadcast it must not be land-gated or rotated to a
    // new reference, even if the buyer and seller have since transferred deeds.
    const seller = await sellerWith('keg_of_haste', 1);
    const buyer = await createTestPlayer(db);
    const sellerBase = await grantStableLand(seller.wallet);
    const buyerBase = await grantStableLand(buyer.wallet);
    const listing = await listItemRaw(
      db, seller.wallet, 'keg_of_haste', 1_000_000n,
      `stable-reserve-recovery-${++listRequestN}`, assertLockedMarketLandAuthority,
    );
    const authority = vi.fn(assertLockedMarketLandAuthority);
    const deps = { ...unpaidDeps, authorizeLandMutation: authority };
    const reserved = await reserveListing(db, deps, buyer.wallet, listing.id);
    await submitPayment(db, deps, buyer.wallet, listing.id, signatureOf(111));
    await transferStableLand(seller.wallet, sellerBase);
    await transferStableLand(buyer.wallet, buyerBase);
    const callsBeforeRetry = authority.mock.calls.length;

    const recovered = await reserveListing(db, deps, buyer.wallet, listing.id);
    expect(recovered).toEqual(reserved);
    expect(authority).toHaveBeenCalledTimes(callsBeforeRetry);
  });

  it('refuses to list a dropOnly relic, and does not touch the inventory', async () => {
    // WHY (owner 2026-08-09, plan risk R8): the Warzone Aegis is a FORGE DROP —
    // it costs nothing to obtain, so listing one converts a free win straight into
    // SOL, paid non-custodially to the seller's own wallet. `buyItem` already
    // refuses it in the buy direction and Shop keeps it out of the purchasable
    // catalog; the market is the third door and must enforce the same policy.
    // Free onboarding is what makes this urgent: forge drop odds are EQUAL per
    // wallet, so without this the cheapest route to SOL income is more accounts.
    // Asserted at LIST time (not settle) so no money can be in flight, and the
    // held unit must not be taken — the reject fires before the inventory update.
    const s = await sellerWith('warzone_aegis', 1);
    await expect(listItem(db, s.wallet, 'warzone_aegis', 1_000_000n))
      .rejects.toThrow(/cannot be sold/);
    expect(await qtyOf(s.wallet, 'warzone_aegis')).toBe(1);
    const open = await db.select({ id: itemListings.id }).from(itemListings)
      .where(eq(itemListings.sellerWallet, s.wallet));
    expect(open.length).toBe(0);
  });

  it('list holds the item; cancel returns it', async () => {
    const s = await sellerWith('keg_of_haste', 2);
    const { id } = await listItem(db, s.wallet, 'keg_of_haste', 1_000_000n);
    expect(await qtyOf(s.wallet, 'keg_of_haste')).toBe(1);
    await cancelListing(db, paidDeps, s.wallet, id);
    expect(await qtyOf(s.wallet, 'keg_of_haste')).toBe(2);
    await expect(cancelListing(db, paidDeps, s.wallet, id)).rejects.toThrow();
  });

  it('never lists the copy reserved by a hero loadout', async () => {
    // Every personal item is sellable, but only a loose copy can leave custody:
    // the one shown on a hero remains reserved for that loadout.
    const s = await sellerWith('wardens_helm', 1);
    await db.insert(buildings).values({
      playerWallet: s.wallet, type: BuildingType.HeroAltar, level: 1, tx: 1, ty: 1,
    });
    await equipHeroItem(db, s.wallet, 'vex', 'helm', 'wardens_helm', 0);
    await expect(listItem(db, s.wallet, 'wardens_helm', 1_000_000n))
      .rejects.toThrow(/no unequipped copy/);
    expect(await qtyOf(s.wallet, 'wardens_helm')).toBe(1);

    await db.update(playerItems).set({ qty: 2 }).where(and(
      eq(playerItems.playerWallet, s.wallet), eq(playerItems.itemId, 'wardens_helm'),
    ));
    const { id } = await listItem(db, s.wallet, 'wardens_helm', 1_000_000n);
    expect(await qtyOf(s.wallet, 'wardens_helm')).toBe(1);
    await cancelListing(db, paidDeps, s.wallet, id);
    expect(await qtyOf(s.wallet, 'wardens_helm')).toBe(2);
  });

  it('serializes gear equip against listing so exactly one owns the loose copy', async () => {
    const s = await sellerWith('wardens_helm', 1);
    await db.insert(buildings).values({
      playerWallet: s.wallet, type: BuildingType.HeroAltar, level: 1, tx: 1, ty: 1,
    });
    const [equip, listing] = await Promise.allSettled([
      equipHeroItem(db, s.wallet, 'vex', 'helm', 'wardens_helm', 0),
      listItem(db, s.wallet, 'wardens_helm', 1_000_000n),
    ]);
    expect([equip, listing].filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const worn = await db.select().from(heroEquipment).where(and(
      eq(heroEquipment.playerWallet, s.wallet), eq(heroEquipment.itemId, 'wardens_helm'),
    ));
    if (equip.status === 'fulfilled') {
      expect(listing.status).toBe('rejected');
      if (listing.status === 'rejected') expect(String(listing.reason)).toMatch(/no unequipped copy/);
      expect(await qtyOf(s.wallet, 'wardens_helm')).toBe(1);
      expect(worn).toHaveLength(1);
    } else {
      expect(String(equip.reason)).toMatch(/do not own|item not owned|owned copies/);
      expect(listing.status).toBe('fulfilled');
      expect(await qtyOf(s.wallet, 'wardens_helm')).toBe(0);
      expect(worn).toHaveLength(0);
      if (listing.status === 'fulfilled') await cancelListing(db, paidDeps, s.wallet, listing.value.id);
    }
  });

  it('returns escrowed items even when the backpack filled meanwhile', async () => {
    // A cancellation is restoration, not acquisition: capacity may enter an
    // explicit overflow state, but the escrowed unit can never be destroyed.
    const s = await sellerWith('keg_of_haste', 160);
    const { id } = await listItem(db, s.wallet, 'keg_of_haste', 1_000_000n);
    await db.insert(playerItems).values({ playerWallet: s.wallet, itemId: 'finishers_seal', qty: 1 });
    await cancelListing(db, paidDeps, s.wallet, id);
    const inventory = await getItems(db, s.wallet);
    expect(await qtyOf(s.wallet, 'keg_of_haste')).toBe(160);
    expect(inventory.capacity).toEqual({ used: 161, max: 160, overflow: true });
  });

  it('rejects unknown or unowned items, including retired keep-skin ids', async () => {
    // WHY: the catalog is the sole listing gate. The three keep skins were
    // deleted from it (M23 a8, D-009 refund via the worker sweep), so even a
    // legacy DB row holding one may never re-enter SOL custody — the sweep
    // consumes such rows; the market must simply not know the id.
    const s = await createTestPlayer(db);
    await expect(listItem(db, s.wallet, 'powder_charge', 1_000_000n)).rejects.toThrow(/none of that item/);
    await expect(listItem(db, s.wallet, 'not_in_catalog', 1_000_000n)).rejects.toThrow(/unknown inventory item/);
    const s2 = await sellerWith('skin_keep_frost', 1);
    await expect(listItem(db, s2.wallet, 'skin_keep_frost', 1_000_000n))
      .rejects.toThrow(/unknown inventory item/);
    expect(await qtyOf(s2.wallet, 'skin_keep_frost')).toBe(1); // row untouched for the refund sweep
  });

  it('settles a gear listing through the same conserved custody path', async () => {
    const s = await sellerWith('wardens_helm', 1);
    const b = await createTestPlayer(db);
    const { id } = await listItem(db, s.wallet, 'wardens_helm', 2_000_000n);
    await reserveListing(db, paidDeps, b.wallet, id);
    const res = await settleListing(db, paidDeps, b.wallet, id);
    expect(res).toMatchObject({ settled: true, itemId: 'wardens_helm' });
    expect(await qtyOf(s.wallet, 'wardens_helm')).toBe(0);
    expect(await qtyOf(b.wallet, 'wardens_helm')).toBe(1);
  });

  it('reserve returns the 95/5 split params and locks the listing', async () => {
    const s = await sellerWith('finishers_seal', 1);
    const b = await createTestPlayer(db);
    const price = 1_000_000n;
    const { id } = await listItem(db, s.wallet, 'finishers_seal', price);
    const r = await reserveListing(db, paidDeps, b.wallet, id);
    const fee = (price * BigInt(MARKETPLACE.feeBps)) / 10_000n; // 50_000
    expect(r.seller).toBe(s.wallet);
    expect(r.feeTreasury).toBe(FEE);
    expect(r.feeLamports).toBe(fee.toString());
    expect(r.sellerLamports).toBe((price - fee).toString());
    expect(r.reference.length).toBeGreaterThanOrEqual(43); // bs58 of 32 bytes (43–44 chars)
    expect(await statusOf(id)).toBe('reserved');
  });

  it('cannot reserve your own listing, nor one someone else is live-buying', async () => {
    const s = await sellerWith('keg_of_haste', 1);
    const { id } = await listItem(db, s.wallet, 'keg_of_haste', 1_000_000n);
    await expect(reserveListing(db, paidDeps, s.wallet, id)).rejects.toThrow(/your own/);
    const b1 = await createTestPlayer(db);
    await reserveListing(db, paidDeps, b1.wallet, id);
    const b2 = await createTestPlayer(db);
    await expect(reserveListing(db, paidDeps, b2.wallet, id)).rejects.toThrow(/not available/);
    const again = await reserveListing(db, paidDeps, b1.wallet, id); // same buyer, idempotent
    expect(again.listingId).toBe(id);
  });

  it('settle grants the item on a VERIFIED payment and marks it sold', async () => {
    const s = await sellerWith('finishers_seal', 1);
    const b = await createTestPlayer(db);
    const { id } = await listItem(db, s.wallet, 'finishers_seal', 2_000_000n);
    await reserveListing(db, paidDeps, b.wallet, id);
    const res = await settleListing(db, paidDeps, b.wallet, id);
    expect(res.settled).toBe(true);
    expect(res.itemId).toBe('finishers_seal');
    expect(await qtyOf(b.wallet, 'finishers_seal')).toBe(1);
    expect(await statusOf(id)).toBe('sold');
  });

  it('settle does NOT grant while the payment is unverified', async () => {
    const s = await sellerWith('powder_charge', 1);
    const b = await createTestPlayer(db);
    const { id } = await listItem(db, s.wallet, 'powder_charge', 3_000_000n);
    await reserveListing(db, unpaidDeps, b.wallet, id);
    const res = await settleListing(db, unpaidDeps, b.wallet, id);
    expect(res.settled).toBe(false);
    expect(await qtyOf(b.wallet, 'powder_charge')).toBe(0);
    expect(await statusOf(id)).toBe('reserved');
  });

  it('settle is idempotent — a retry after sale never double-grants', async () => {
    const s = await sellerWith('keg_of_haste', 1);
    const b = await createTestPlayer(db);
    const { id } = await listItem(db, s.wallet, 'keg_of_haste', 1_000_000n);
    await reserveListing(db, paidDeps, b.wallet, id);
    await settleListing(db, paidDeps, b.wallet, id);
    const again = await settleListing(db, paidDeps, b.wallet, id);
    expect(again.settled).toBe(true);
    expect(await qtyOf(b.wallet, 'keg_of_haste')).toBe(1);
  });

  it('SECURITY #1: one signature settles at most ONE listing (no dup / fee bypass)', async () => {
    // The exploit: tag ONE on-chain transfer with two reservation references and
    // settle both. The unique tx_signature index makes the 2nd settle fail.
    const s = await sellerWith('keg_of_haste', 2);
    const b = await createTestPlayer(db);
    const { id: l1 } = await listItem(db, s.wallet, 'keg_of_haste', 1_000_000n);
    const { id: l2 } = await listItem(db, s.wallet, 'keg_of_haste', 1_000_000n);
    const oneSig = paidWith('reused-signature'); // same finalized sig for both
    await reserveListing(db, oneSig, b.wallet, l1);
    await reserveListing(db, oneSig, b.wallet, l2);
    await settleListing(db, oneSig, b.wallet, l1); // ok
    await expect(settleListing(db, oneSig, b.wallet, l2)).rejects.toThrow(/already used/);
    expect(await qtyOf(b.wallet, 'keg_of_haste')).toBe(1); // exactly one item, not two
  });

  it('SECURITY #2: a buyer can settle AFTER the reservation lapses (never blocked)', async () => {
    const s = await sellerWith('finishers_seal', 1);
    const b = await createTestPlayer(db);
    const { id } = await listItem(db, s.wallet, 'finishers_seal', 1_000_000n);
    await reserveListing(db, paidDeps, b.wallet, id);
    await expire(id); // reservation window passed, but they paid
    const res = await settleListing(db, paidDeps, b.wallet, id);
    expect(res.settled).toBe(true);
    expect(await qtyOf(b.wallet, 'finishers_seal')).toBe(1);
  });

  it('SECURITY #2: seller CANNOT reclaim a lapsed reservation the buyer paid for', async () => {
    const s = await sellerWith('keg_of_haste', 1);
    const b = await createTestPlayer(db);
    const { id } = await listItem(db, s.wallet, 'keg_of_haste', 1_000_000n);
    await reserveListing(db, paidDeps, b.wallet, id);
    await expire(id);
    // The buyer paid → cancel settles to the buyer and refuses the reclaim.
    await expect(cancelListing(db, paidDeps, s.wallet, id)).rejects.toThrow(/already paid/);
    expect(await qtyOf(b.wallet, 'keg_of_haste')).toBe(1); // buyer got it
    expect(await qtyOf(s.wallet, 'keg_of_haste')).toBe(0); // seller did NOT reclaim
    expect(await statusOf(id)).toBe('sold');
  });

  it('seller CAN reclaim a lapsed reservation the buyer did NOT pay for', async () => {
    const s = await sellerWith('keg_of_haste', 1);
    const b = await createTestPlayer(db);
    const { id } = await listItem(db, s.wallet, 'keg_of_haste', 1_000_000n);
    await reserveListing(db, unpaidDeps, b.wallet, id);
    await expire(id);
    await cancelListing(db, unpaidDeps, s.wallet, id);
    expect(await qtyOf(s.wallet, 'keg_of_haste')).toBe(1); // reclaimed
    expect(await statusOf(id)).toBe('cancelled');
  });

  it('a lapsed UNPAID reservation reopens for other buyers', async () => {
    const s = await sellerWith('keg_of_haste', 1);
    const b1 = await createTestPlayer(db);
    const { id } = await listItem(db, s.wallet, 'keg_of_haste', 1_000_000n);
    await reserveListing(db, unpaidDeps, b1.wallet, id);
    await expire(id);
    const { listings } = await getListings(db); // lapsed → shown as buyable
    expect(listings.some((l) => l.id === id)).toBe(true);
    const b2 = await createTestPlayer(db);
    const r = await reserveListing(db, unpaidDeps, b2.wallet, id); // b1 didn't pay → b2 takes it
    expect(r.listingId).toBe(id);
    expect(await statusOf(id)).toBe('reserved');
  });

  it('expired-payment rescue cannot settle a same-buyer replacement generation', async () => {
    const seller = await sellerWith('keg_of_haste', 1);
    const originalBuyer = await createTestPlayer(db);
    const taker = await createTestPlayer(db);
    const { id } = await listItem(db, seller.wallet, 'keg_of_haste', 1_000_000n);
    const oldQuote = await reserveListing(db, unpaidDeps, originalBuyer.wallet, id);
    await expire(id);

    let entered!: () => void;
    let release!: () => void;
    const verifying = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const rescueDeps: ItemMarketDeps = {
      ...unpaidDeps,
      verifyPayment: async () => {
        entered();
        await blocked;
        return { txSignature: signatureOf(112) };
      },
    };
    const takeover = reserveListing(db, rescueDeps, taker.wallet, id);
    await verifying;

    const replacement = await reserveListing(db, unpaidDeps, originalBuyer.wallet, id);
    expect(replacement.reference).not.toBe(oldQuote.reference);
    release();

    await expect(takeover).rejects.toThrow(/reservation changed while payment was being verified/);
    expect((await db.select().from(itemListings).where(eq(itemListings.id, id)))[0])
      .toMatchObject({
        status: 'reserved', reservedBy: originalBuyer.wallet,
        reference: replacement.reference, txSignature: null,
      });
    expect(await qtyOf(originalBuyer.wallet, 'keg_of_haste')).toBe(0);
    expect(await qtyOf(taker.wallet, 'keg_of_haste')).toBe(0);
  });

  it('SAFEGUARD: a committed payment locks the listing — the seller cannot reclaim it past the short grace', async () => {
    // The complete safeguard (owner 2026-07-24): once the buyer registers their
    // broadcast signature, the reservation is held long past finalization, so a
    // paid buyer can never lose the item even under network lag.
    const s = await sellerWith('keg_of_haste', 1);
    const b = await createTestPlayer(db);
    const { id } = await listItem(db, s.wallet, 'keg_of_haste', 1_000_000n);
    await reserveListing(db, paidDeps, b.wallet, id);
    await submitPayment(db, paidDeps, b.wallet, id, signatureOf(1)); // confirmed broadcast proof
    // Age past the 90s reclaim grace but WITHIN the settle timeout: an
    // uncommitted reservation would be reclaimable here — a committed one is NOT.
    await db.update(itemListings).set({ reservedUntil: sql`now() - interval '3 minutes'` }).where(eq(itemListings.id, id));
    await expect(cancelListing(db, unpaidDeps, s.wallet, id)).rejects.toThrow(/sale is in progress/);
    // The listing is NOT shown as buyable to others while the payment is pending.
    const { listings } = await getListings(db);
    expect(listings.some((l) => l.id === id)).toBe(false);
    // The buyer can still settle (verified payment → item delivered).
    const res = await settleListing(db, paidDeps, b.wallet, id);
    expect(res.settled).toBe(true);
    expect(await qtyOf(b.wallet, 'keg_of_haste')).toBe(1);
  });

  it('settlement forwards the committed signature and exact reservation boundary', async () => {
    const s = await sellerWith('keg_of_haste', 1);
    const b = await createTestPlayer(db);
    const started = new Date('2026-08-12T05:00:00.000Z');
    const { id } = await listItem(db, s.wallet, 'keg_of_haste', 1_000_000n);
    await reserveListing(db, unpaidDeps, b.wallet, id, started);
    const signature = signatureOf(2);
    await submitPayment(db, unpaidDeps, b.wallet, id, signature, started);
    let proof: Parameters<NonNullable<ItemMarketDeps['verifyPayment']>>[0] | undefined;
    const exactDeps: ItemMarketDeps = {
      feeTreasury: FEE,
      verifyPayment: async (params) => { proof = params; return { txSignature: signature }; },
    };
    await settleListing(db, exactDeps, b.wallet, id);
    expect(proof?.paymentSignature).toBe(signature);
    expect(proof?.notBefore?.toISOString()).toBe(started.toISOString());
  });

  it('an indeterminate capped scan can never reopen a committed reservation', async () => {
    const s = await sellerWith('keg_of_haste', 1);
    const b = await createTestPlayer(db);
    const { id } = await listItem(db, s.wallet, 'keg_of_haste', 1_000_000n);
    await reserveListing(db, unpaidDeps, b.wallet, id);
    await submitPayment(db, unpaidDeps, b.wallet, id, signatureOf(3));
    await db.update(itemListings).set({ reservedUntil: sql`now() - interval '30 days'` })
      .where(eq(itemListings.id, id));
    const scanError = new Error('indeterminate signature scan');
    const indeterminate: ItemMarketDeps = {
      feeTreasury: FEE,
      verifyPayment: async () => { throw scanError; },
    };
    await expect(cancelListing(db, indeterminate, s.wallet, id))
      .rejects.toBe(scanError);
    expect(await statusOf(id)).toBe('reserved');
    expect(await qtyOf(s.wallet, 'keg_of_haste')).toBe(0);
  });

  it('reserve needs the fee treasury configured, and caps pending purchases per buyer', async () => {
    const b = await createTestPlayer(db);
    const s0 = await sellerWith('keg_of_haste', 1);
    const { id: any0 } = await listItem(db, s0.wallet, 'keg_of_haste', 1_000_000n);
    await expect(reserveListing(db, {}, b.wallet, any0)).rejects.toThrow(/not configured/);

    const cap = MARKETPLACE.itemMarket.maxReservationsPerBuyer;
    const ids: string[] = [];
    for (let i = 0; i < cap + 1; i++) {
      const s = await sellerWith('keg_of_haste', 1);
      const { id } = await listItem(db, s.wallet, 'keg_of_haste', 1_000_000n);
      ids.push(id);
    }
    for (let i = 0; i < cap; i++) await reserveListing(db, unpaidDeps, b.wallet, ids[i]!);
    await expect(reserveListing(db, unpaidDeps, b.wallet, ids[cap]!)).rejects.toThrow(/pending purchases/);
  });

  it('rejects malformed and unconfirmed payment commitments without extending the reservation', async () => {
    const s = await sellerWith('keg_of_haste', 1);
    const b = await createTestPlayer(db);
    const { id } = await listItem(db, s.wallet, 'keg_of_haste', 1_000_000n);
    await reserveListing(db, unpaidDeps, b.wallet, id);
    const verifyPaymentCommit = vi.fn(async () => null);
    const rejectDeps: ItemMarketDeps = {
      feeTreasury: FEE, verifyPayment: async () => null, verifyPaymentCommit,
    };

    await expect(submitPayment(db, rejectDeps, b.wallet, id, 'not-a-solana-signature'))
      .rejects.toThrow(/invalid Solana/);
    expect(verifyPaymentCommit).not.toHaveBeenCalled();
    await expect(submitPayment(db, rejectDeps, b.wallet, id, signatureOf(4)))
      .rejects.toThrow(/not a confirmed exact/);
    const [row] = await db.select({ paymentSig: itemListings.paymentSig }).from(itemListings)
      .where(eq(itemListings.id, id));
    expect(row?.paymentSig).toBeNull();
  });

  it('binds one confirmed signature to one listing; exact retry is idempotent', async () => {
    const s = await sellerWith('keg_of_haste', 2);
    const b = await createTestPlayer(db);
    const { id: first } = await listItem(db, s.wallet, 'keg_of_haste', 1_000_000n);
    const { id: second } = await listItem(db, s.wallet, 'keg_of_haste', 1_000_000n);
    await reserveListing(db, unpaidDeps, b.wallet, first);
    await reserveListing(db, unpaidDeps, b.wallet, second);
    const signature = signatureOf(5);

    await expect(submitPayment(db, unpaidDeps, b.wallet, first, signature))
      .resolves.toEqual({ committed: true });
    await expect(submitPayment(db, unpaidDeps, b.wallet, first, signature))
      .resolves.toEqual({ committed: true });
    await expect(submitPayment(db, unpaidDeps, b.wallet, first, signatureOf(6)))
      .rejects.toThrow(/another payment signature/);
    await settleListing(db, paidWith(signature), b.wallet, first);
    await expect(submitPayment(db, {}, b.wallet, first, signature))
      .resolves.toEqual({ committed: true }); // still exact after settlement advanced
    await expect(submitPayment(db, unpaidDeps, b.wallet, second, signature))
      .rejects.toThrow(/already used by another listing/);
  });

  it('serializes concurrent cross-buyer reuse of one payment signature', async () => {
    const s1 = await sellerWith('keg_of_haste', 1);
    const s2 = await sellerWith('keg_of_haste', 1);
    const b1 = await createTestPlayer(db);
    const b2 = await createTestPlayer(db);
    const l1 = (await listItem(db, s1.wallet, 'keg_of_haste', 1_000_000n)).id;
    const l2 = (await listItem(db, s2.wallet, 'keg_of_haste', 1_000_000n)).id;
    await reserveListing(db, unpaidDeps, b1.wallet, l1);
    await reserveListing(db, unpaidDeps, b2.wallet, l2);
    const signature = signatureOf(9);

    const results = await Promise.allSettled([
      submitPayment(db, unpaidDeps, b1.wallet, l1, signature),
      submitPayment(db, unpaidDeps, b2.wallet, l2, signature),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const [bound] = await db.select({ n: sql<number>`count(*)::int` }).from(itemListings)
      .where(eq(itemListings.paymentSig, signature));
    expect(bound?.n).toBe(1);
  });

  it('serializes finalized settlement against a concurrent commitment of the same signature', async () => {
    const s1 = await sellerWith('keg_of_haste', 1);
    const s2 = await sellerWith('keg_of_haste', 1);
    const buyer = await createTestPlayer(db);
    const settledListing = (await listItem(db, s1.wallet, 'keg_of_haste', 1_000_000n)).id;
    const committedListing = (await listItem(db, s2.wallet, 'keg_of_haste', 1_000_000n)).id;
    await reserveListing(db, unpaidDeps, buyer.wallet, settledListing);
    await reserveListing(db, unpaidDeps, buyer.wallet, committedListing);
    const signature = signatureOf(10);

    let arrived = 0;
    let release!: () => void;
    const bothProofsStarted = new Promise<void>((resolve) => { release = resolve; });
    const barrier = async (): Promise<void> => {
      arrived++;
      if (arrived === 2) release();
      await bothProofsStarted;
    };
    const raceDeps: ItemMarketDeps = {
      feeTreasury: FEE,
      verifyPayment: async () => { await barrier(); return { txSignature: signature }; },
      verifyPaymentCommit: async (p) => { await barrier(); return { txSignature: p.paymentSignature }; },
    };

    const results = await Promise.allSettled([
      settleListing(db, raceDeps, buyer.wallet, settledListing),
      submitPayment(db, raceDeps, buyer.wallet, committedListing, signature),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const [sold] = await db.select({ status: itemListings.status }).from(itemListings)
      .where(eq(itemListings.id, settledListing));
    const [pinned] = await db.select({ paymentSig: itemListings.paymentSig }).from(itemListings)
      .where(eq(itemListings.id, committedListing));
    expect(sold?.status === 'sold' && pinned?.paymentSig === signature).toBe(false);
    expect((sold?.status === 'sold') !== (pinned?.paymentSig === signature)).toBe(true);
  });

  it('rejects a late commitment after the uncommitted reclaim grace', async () => {
    const s = await sellerWith('keg_of_haste', 1);
    const b = await createTestPlayer(db);
    const started = new Date('2026-08-12T06:00:00.000Z');
    const { id } = await listItem(db, s.wallet, 'keg_of_haste', 1_000_000n);
    await reserveListing(db, unpaidDeps, b.wallet, id, started);
    const late = new Date(started.getTime()
      + (MARKETPLACE.itemMarket.reserveTtlSec + MARKETPLACE.itemMarket.reclaimGraceSec) * 1_000 + 1);
    await expect(submitPayment(db, unpaidDeps, b.wallet, id, signatureOf(7), late))
      .rejects.toThrow(/after the reservation grace/);
  });

  it('revalidates reference, price, and parties after the confirmed proof', async () => {
    const s = await sellerWith('keg_of_haste', 1);
    const b = await createTestPlayer(db);
    const { id } = await listItem(db, s.wallet, 'keg_of_haste', 1_000_000n);
    await reserveListing(db, unpaidDeps, b.wallet, id);
    const signature = signatureOf(8);
    const changingDeps: ItemMarketDeps = {
      feeTreasury: FEE,
      verifyPayment: async () => null,
      verifyPaymentCommit: async (p) => {
        await db.update(itemListings).set({ reference: bs58.encode(new Uint8Array(32).fill(99)) })
          .where(eq(itemListings.id, id));
        return { txSignature: p.paymentSignature };
      },
    };
    await expect(submitPayment(db, changingDeps, b.wallet, id, signature))
      .rejects.toThrow(/terms changed/);
  });

  it('counts committed unresolved rows and uncommitted grace against the rolling cap', async () => {
    const b = await createTestPlayer(db);
    const cap = MARKETPLACE.itemMarket.maxReservationsPerBuyer;
    const started = new Date();
    const ids: string[] = [];
    for (let i = 0; i < cap + 1; i++) {
      const s = await sellerWith('keg_of_haste', 1);
      ids.push((await listItem(db, s.wallet, 'keg_of_haste', 1_000_000n)).id);
    }
    for (let i = 0; i < cap; i++) await reserveListing(db, unpaidDeps, b.wallet, ids[i]!, started);

    const withinGrace = new Date(started.getTime()
      + MARKETPLACE.itemMarket.reserveTtlSec * 1_000
      + Math.max(1, Math.floor(MARKETPLACE.itemMarket.reclaimGraceSec * 500)));
    await expect(reserveListing(db, unpaidDeps, b.wallet, ids[cap]!, withinGrace))
      .rejects.toThrow(/pending purchases/);

    for (let i = 0; i < cap; i++) {
      await submitPayment(db, unpaidDeps, b.wallet, ids[i]!, signatureOf(20 + i), started);
    }
    await db.update(itemListings)
      .set({ reservedUntil: new Date(started.getTime() - 30 * 24 * 60 * 60 * 1_000) })
      .where(eq(itemListings.reservedBy, b.wallet));
    const [committed] = await db.select({ reference: itemListings.reference }).from(itemListings)
      .where(eq(itemListings.id, ids[0]!));
    const same = await reserveListing(db, unpaidDeps, b.wallet, ids[0]!, started);
    expect(same.reference).toBe(committed?.reference); // no fresh-reference roll
    await expect(reserveListing(db, unpaidDeps, b.wallet, ids[cap]!, started))
      .rejects.toThrow(/pending purchases/);
  });

  it('serializes eight distinct-listing reserves under the per-buyer cap', async () => {
    const b = await createTestPlayer(db);
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const s = await sellerWith('keg_of_haste', 1);
      ids.push((await listItem(db, s.wallet, 'keg_of_haste', 1_000_000n)).id);
    }
    const results = await Promise.allSettled(ids.map((id) => reserveListing(db, unpaidDeps, b.wallet, id)));
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    expect(fulfilled).toHaveLength(MARKETPLACE.itemMarket.maxReservationsPerBuyer);
    const [reserved] = await db.select({ n: sql<number>`count(*)::int` }).from(itemListings)
      .where(and(eq(itemListings.status, 'reserved'), eq(itemListings.reservedBy, b.wallet)));
    expect(reserved?.n).toBe(MARKETPLACE.itemMarket.maxReservationsPerBuyer);
  });

  it('book: floor summary spans the WHOLE open book, and filter/sort shape the rows', async () => {
    // WHY: the browse UI renders a floor-price rail and a "vs floor" hint when
    // listing. A floor computed over the FILTERED or paginated slice would move
    // when the player changed a filter — i.e. quote a price that isn't the floor.
    // Prices are unique-ish and high here so other tests' 1_000_000n rows can't
    // collide with the ordering assertions.
    const s = await sellerWith('keg_of_haste', 3);
    const s2 = await sellerWith('finishers_seal', 1);
    await listItem(db, s.wallet, 'keg_of_haste', 900_000_000n);
    await listItem(db, s.wallet, 'keg_of_haste', 700_000_000n); // the keg floor
    await listItem(db, s2.wallet, 'finishers_seal', 800_000_000n);

    const all = await getListings(db);
    const kegSum = all.summary.find((x) => x.itemId === 'keg_of_haste')!;
    const sealSum = all.summary.find((x) => x.itemId === 'finishers_seal')!;
    expect(BigInt(kegSum.floorLamports)).toBeLessThanOrEqual(700_000_000n);
    expect(kegSum.listed).toBeGreaterThanOrEqual(2);
    expect(BigInt(sealSum.floorLamports)).toBe(800_000_000n);
    // summary is floor-ascending so the rail reads cheapest-first
    const floors = all.summary.map((x) => BigInt(x.floorLamports));
    expect([...floors].sort((a, b) => (a < b ? -1 : 1))).toEqual(floors);

    // filter narrows the ROWS but must not narrow the SUMMARY
    const onlySeal = await getListings(db, new Date(), { itemId: 'finishers_seal' });
    expect(onlySeal.listings.every((l) => l.itemId === 'finishers_seal')).toBe(true);
    expect(onlySeal.summary.some((x) => x.itemId === 'keg_of_haste')).toBe(true);

    // default sort is cheapest-first; price_desc inverts it
    const kegAsc = await getListings(db, new Date(), { itemId: 'keg_of_haste' });
    const ascP = kegAsc.listings.map((l) => BigInt(l.priceLamports));
    expect([...ascP].sort((a, b) => (a < b ? -1 : 1))).toEqual(ascP);
    const kegDesc = await getListings(db, new Date(), { itemId: 'keg_of_haste', sort: 'price_desc' });
    const descP = kegDesc.listings.map((l) => BigInt(l.priceLamports));
    expect([...descP].sort((a, b) => (a > b ? -1 : 1))).toEqual(descP);
  });

  it('book: every listing carries the seller\'s PUBLIC name — display name, else 4…4 wallet, never the full address', async () => {
    // Tester ef22cdb7 asked to see WHO is selling. The book is a public, unauthenticated
    // read, so the identity it carries must be the same one the leaderboard already
    // publishes: the chosen display name, or the abbreviated wallet. A full second copy
    // of the address in a free-text field would be a bulk-harvest surface (FORGE
    // globalWalletHeadChars rationale), so sellerName must never equal or contain it.
    const named = await sellerWith('keg_of_haste', 1);
    const anon = await sellerWith('keg_of_haste', 1);
    const name = `Arc${Date.now().toString(36)}${named.wallet.slice(0, 4)}`;
    await db.update(players).set({ name, nameKey: name.toLowerCase() }).where(eq(players.wallet, named.wallet));
    const a = await listItem(db, named.wallet, 'keg_of_haste', 650_000_000n);
    const b = await listItem(db, anon.wallet, 'keg_of_haste', 660_000_000n);

    const { listings } = await getListings(db, new Date(), { itemId: 'keg_of_haste' });
    const la = listings.find((l) => l.id === a.id)!;
    const lb = listings.find((l) => l.id === b.id)!;
    expect(la.sellerName).toBe(name);
    expect(lb.sellerName).toBe(`${anon.wallet.slice(0, 4)}…${anon.wallet.slice(-4)}`);
    for (const l of listings) {
      expect(typeof l.sellerName).toBe('string');
      expect(l.sellerName.length).toBeGreaterThan(0);
      expect(l.sellerName).not.toBe(l.seller);
      expect(l.sellerName.includes(l.seller)).toBe(false);
    }
  });
});
