/**
 * D-035/D-031 item-market custody at the deed boundary. One held unit has one
 * home throughout list → cancel/sale; equipment, transfers and the wallet
 * compatibility shadow cannot manufacture a second economic copy.
 */
import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  baseHeroEquipment, baseHeroLoadouts, baseItems, bases, baseSlots,
  deedOwnershipObservations, itemListings, playerItems,
} from '../src/db/schema';
import {
  cancelListing, getListings, getMyListings, listItem, reserveListing, settleListing,
  type ItemMarketDeps,
} from '../src/game/itemMarket';
import { requireExactFinalizedOwnedBaseAuthority } from '../src/game/baseOwnership';
import type { StableBaseMutationContext } from '../src/game/stableBasePrerequisites';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const priorMultiBase = process.env['MULTI_BASE_ENABLED'];
const FEE = 'DeedItemFee11111111111111111111111111111111';
let signature = 0;
const marketDeps: ItemMarketDeps = {
  feeTreasury: FEE,
  verifyPayment: async () => ({ txSignature: `deed-item-payment-${++signature}` }),
  refreshStableSourceAuthority: async () => {},
};

function context(baseId: string): StableBaseMutationContext {
  return { baseId, assertAuthority: async () => {} };
}

async function stableBase(wallet: string, slot: number) {
  const [base] = await db.insert(bases).values({
    ownerWallet: wallet,
    status: 'active',
    landPaidAt: new Date('2026-08-12T00:00:00.000Z'),
  }).returning();
  await db.insert(baseSlots).values({ wallet, slot, baseId: base!.id, active: true });
  return base!;
}

async function onCurvePlayer() {
  for (;;) {
    const player = await createTestPlayer(db);
    if (PublicKey.isOnCurve(new PublicKey(player.wallet).toBytes())) return player;
  }
}

async function baseQty(baseId: string, itemId: string): Promise<number> {
  const [row] = await db.select({ qty: baseItems.qty }).from(baseItems)
    .where(and(eq(baseItems.baseId, baseId), eq(baseItems.itemId, itemId)));
  return row?.qty ?? 0;
}

async function walletQty(wallet: string, itemId: string): Promise<number> {
  const [row] = await db.select({ qty: playerItems.qty }).from(playerItems)
    .where(and(eq(playerItems.playerWallet, wallet), eq(playerItems.itemId, itemId)));
  return row?.qty ?? 0;
}

async function transferBase(baseId: string, to: string): Promise<void> {
  await db.delete(baseSlots).where(eq(baseSlots.baseId, baseId));
  await db.update(bases).set({ ownerWallet: to, status: 'inactive' }).where(eq(bases.id, baseId));
}

beforeAll(() => { process.env['MULTI_BASE_ENABLED'] = 'true'; });
afterEach(() => { process.env['MULTI_BASE_ENABLED'] = 'true'; });
afterAll(async () => {
  if (priorMultiBase === undefined) delete process.env['MULTI_BASE_ENABLED'];
  else process.env['MULTI_BASE_ENABLED'] = priorMultiBase;
  await conn.sql.end();
});

describe.sequential('stable deed item market', () => {
  it('isolates two deeds and subtracts base equipment before listing', async () => {
    const seller = await createTestPlayer(db);
    const [a, b] = await Promise.all([
      stableBase(seller.wallet, 1), stableBase(seller.wallet, 2),
    ]);
    await db.insert(baseItems).values([
      { baseId: a.id, itemId: 'wardens_helm', qty: 1 },
      { baseId: b.id, itemId: 'wardens_helm', qty: 1 },
    ]);
    await db.insert(baseHeroLoadouts).values({ baseId: a.id, hero: 'vex' });
    await db.insert(baseHeroEquipment).values({
      baseId: a.id, hero: 'vex', slot: 'helm', itemId: 'wardens_helm',
    });

    await expect(listItem(
      db, seller.wallet, 'wardens_helm', 1_000_000n, randomUUID(), undefined, context(a.id),
    )).rejects.toThrow(/no unequipped copy/);
    const listed = await listItem(
      db, seller.wallet, 'wardens_helm', 1_000_000n, randomUUID(), undefined, context(b.id),
    );

    expect(listed.baseId).toBe(b.id);
    expect(await baseQty(a.id, 'wardens_helm')).toBe(1);
    expect(await baseQty(b.id, 'wardens_helm')).toBe(0);
    expect(await walletQty(seller.wallet, 'wardens_helm')).toBe(0);
  });

  it('moves cancellation authority and the held copy with a transferred deed', async () => {
    const seller = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    const base = await stableBase(seller.wallet, 1);
    await db.insert(baseItems).values({ baseId: base.id, itemId: 'keg_of_haste', qty: 1 });
    const listing = await listItem(
      db, seller.wallet, 'keg_of_haste', 1_000_000n, randomUUID(), undefined, context(base.id),
    );
    await transferBase(base.id, buyer.wallet);

    // The public book names the wallet that will actually be paid — the CURRENT
    // deed owner — never the original lister (tester ef22cdb7 sellerName).
    const shown = (await getListings(db)).listings.find((row) => row.id === listing.id)!;
    expect(shown.seller).toBe(buyer.wallet);
    expect(shown.sellerName).toBe(`${buyer.wallet.slice(0, 4)}…${buyer.wallet.slice(-4)}`);

    await expect(cancelListing(
      db, marketDeps, seller.wallet, listing.id, new Date(), context(base.id),
    )).rejects.toMatchObject({ statusCode: 404 });
    expect((await getMyListings(db, buyer.wallet)).map((row) => row.id)).toContain(listing.id);

    await cancelListing(db, marketDeps, buyer.wallet, listing.id, new Date(), context(base.id));
    expect(await baseQty(base.id, 'keg_of_haste')).toBe(1);
    expect(await walletQty(seller.wallet, 'keg_of_haste')).toBe(0);
    expect(await walletQty(buyer.wallet, 'keg_of_haste')).toBe(0);
  });

  it('settles once into the frozen buyer deed even after that deed transfers', async () => {
    const seller = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    const nextOwner = await createTestPlayer(db);
    const source = await stableBase(seller.wallet, 1);
    const [destination, other] = await Promise.all([
      stableBase(buyer.wallet, 1), stableBase(buyer.wallet, 2),
    ]);
    await db.insert(baseItems).values({ baseId: source.id, itemId: 'powder_charge', qty: 1 });
    const listing = await listItem(
      db, seller.wallet, 'powder_charge', 1_000_000n, randomUUID(), undefined, context(source.id),
    );
    const reserved = await reserveListing(
      db, marketDeps, buyer.wallet, listing.id, new Date(), context(destination.id),
    );
    expect(reserved.buyerBaseId).toBe(destination.id);
    await transferBase(destination.id, nextOwner.wallet);

    expect(await settleListing(db, marketDeps, buyer.wallet, listing.id))
      .toMatchObject({ settled: true, itemId: 'powder_charge' });
    expect(await baseQty(source.id, 'powder_charge')).toBe(0);
    expect(await baseQty(destination.id, 'powder_charge')).toBe(1);
    expect(await baseQty(other.id, 'powder_charge')).toBe(0);
    expect(await walletQty(buyer.wallet, 'powder_charge')).toBe(0);
    expect((await db.select().from(itemListings).where(eq(itemListings.id, listing.id)))[0])
      .toMatchObject({ status: 'sold', baseId: source.id, buyerBaseId: destination.id });
  });

  it('quotes the current deed owner after transfer, never the listing creator', async () => {
    const creator = await createTestPlayer(db);
    const currentOwner = await createTestPlayer(db);
    const purchaser = await createTestPlayer(db);
    const source = await stableBase(creator.wallet, 1);
    const destination = await stableBase(purchaser.wallet, 1);
    await db.insert(baseItems).values({ baseId: source.id, itemId: 'finishers_seal', qty: 1 });
    const listing = await listItem(
      db, creator.wallet, 'finishers_seal', 1_000_000n, randomUUID(), undefined, context(source.id),
    );
    await transferBase(source.id, currentOwner.wallet);
    await db.update(bases).set({ status: 'active' }).where(eq(bases.id, source.id));
    await db.insert(baseSlots).values({
      wallet: currentOwner.wallet, slot: 1, baseId: source.id, active: true,
    });

    const quote = await reserveListing(
      db, marketDeps, purchaser.wallet, listing.id, new Date(), context(destination.id),
    );
    expect(quote.seller).toBe(currentOwner.wallet);
    expect((await db.select().from(itemListings).where(eq(itemListings.id, listing.id)))[0])
      .toMatchObject({ sellerWallet: currentOwner.wallet, baseId: source.id });

    await settleListing(db, marketDeps, purchaser.wallet, listing.id);
    expect(await baseQty(source.id, 'finishers_seal')).toBe(0);
    expect(await baseQty(destination.id, 'finishers_seal')).toBe(1);
    expect(await walletQty(creator.wallet, 'finishers_seal')).toBe(0);
    expect(await walletQty(currentOwner.wallet, 'finishers_seal')).toBe(0);
    expect(await walletQty(purchaser.wallet, 'finishers_seal')).toBe(0);
  });

  it('forces an exact finalized source-deed read for every new reservation despite fresh cached ownership', async () => {
    const seller = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    const nextOwner = await onCurvePlayer();
    const source = await stableBase(seller.wallet, 1);
    const destination = await stableBase(buyer.wallet, 1);
    const deedAssetId = `item-market-deed-${randomUUID()}`;
    await db.update(bases).set({ deedAssetId }).where(eq(bases.id, source.id));
    await db.insert(deedOwnershipObservations).values({
      baseId: source.id, assetId: deedAssetId, owner: seller.wallet, slot: 10n,
      checkedAt: new Date(), source: 'item-market-cache-prime', status: 'owned',
      auditHash: `cached-${deedAssetId}`,
    });
    await db.insert(baseItems).values({ baseId: source.id, itemId: 'keg_of_haste', qty: 1 });
    const listing = await listItem(
      db, seller.wallet, 'keg_of_haste', 1_000_000n, randomUUID(), undefined, context(source.id),
    );

    let reads = 0;
    const refresh = vi.fn(async (wallet: string, baseId: string) => {
      await requireExactFinalizedOwnedBaseAuthority(db, wallet, baseId, async () => {
        reads++;
        return {
          owner: nextOwner.wallet, frozen: false, delegate: null,
          collection: 'collection', slot: 10 + reads,
        };
      }, 'collection');
    });
    const deps = { ...marketDeps, refreshStableSourceAuthority: refresh };

    // The cached row above is fresh and says seller=owned. The exact read still
    // observes the finalized transfer, applies it, and rejects this commitment.
    await expect(reserveListing(
      db, deps, buyer.wallet, listing.id, new Date(), context(destination.id),
    )).rejects.toMatchObject({ code: 'DEED_AUTHORITY_UNAVAILABLE' });
    expect(reads).toBe(1);
    expect(refresh).toHaveBeenLastCalledWith(seller.wallet, source.id);
    expect((await db.select().from(itemListings).where(eq(itemListings.id, listing.id)))[0]?.status)
      .toBe('active');
    expect((await db.select().from(bases).where(eq(bases.id, source.id)))[0])
      .toMatchObject({ ownerWallet: nextOwner.wallet, status: 'inactive' });

    // After the buyer activates the received deed, a retry refreshes its CURRENT
    // owner (not historical seller_wallet) and freezes that owner as recipient.
    await db.update(bases).set({ status: 'active' }).where(eq(bases.id, source.id));
    await db.insert(baseSlots).values({
      wallet: nextOwner.wallet, slot: 1, baseId: source.id, active: true,
    });
    const quote = await reserveListing(
      db, deps, buyer.wallet, listing.id, new Date(), context(destination.id),
    );
    expect(reads).toBe(2);
    expect(refresh).toHaveBeenLastCalledWith(nextOwner.wallet, source.id);
    expect(quote.seller).toBe(nextOwner.wallet);
    expect(await reserveListing(
      db, deps, buyer.wallet, listing.id, new Date(), context(destination.id),
    )).toEqual(quote);
    expect(reads).toBe(2); // protected quote recovery performs no new chain read
  });

  it('never applies an old verified payment to a same-buyer renewed stable reservation', async () => {
    const seller = await createTestPlayer(db);
    const currentOwner = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    const source = await stableBase(seller.wallet, 1);
    const [oldDestination, newDestination] = await Promise.all([
      stableBase(buyer.wallet, 1), stableBase(buyer.wallet, 2),
    ]);
    await db.insert(baseItems).values({ baseId: source.id, itemId: 'powder_charge', qty: 1 });
    const listing = await listItem(
      db, seller.wallet, 'powder_charge', 1_000_000n, randomUUID(), undefined, context(source.id),
    );
    const oldQuote = await reserveListing(
      db, marketDeps, buyer.wallet, listing.id, new Date(), context(oldDestination.id),
    );
    await db.update(itemListings).set({ reservedUntil: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(itemListings.id, listing.id));

    let entered!: () => void;
    let release!: () => void;
    const verifying = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const oldSignature = `stable-generation-payment-${randomUUID()}`;
    const settleDeps: ItemMarketDeps = {
      ...marketDeps,
      verifyPayment: async () => {
        entered();
        await blocked;
        return { txSignature: oldSignature };
      },
    };
    const settling = settleListing(db, settleDeps, buyer.wallet, listing.id);
    await verifying;

    await transferBase(source.id, currentOwner.wallet);
    await db.update(bases).set({ status: 'active' }).where(eq(bases.id, source.id));
    await db.insert(baseSlots).values({
      wallet: currentOwner.wallet, slot: 1, baseId: source.id, active: true,
    });
    const renewed = await reserveListing(
      // Renewal now always scans the old legacy payment first. Model that
      // scan returning unpaid while the earlier proof remains in flight; a
      // positive result must rescue the old buyer instead of renewing at all.
      db, { ...marketDeps, verifyPayment: async () => null }, buyer.wallet, listing.id, new Date(), context(newDestination.id),
    );
    expect(renewed.reference).not.toBe(oldQuote.reference);
    expect(renewed.seller).toBe(currentOwner.wallet);

    release();
    await expect(settling).rejects.toThrow(/listing was just taken/);
    expect((await db.select().from(itemListings).where(eq(itemListings.id, listing.id)))[0])
      .toMatchObject({
        status: 'reserved', sellerWallet: currentOwner.wallet,
        reference: renewed.reference, buyerBaseId: newDestination.id,
        txSignature: null,
      });
    expect(await baseQty(source.id, 'powder_charge')).toBe(0);
    expect(await baseQty(oldDestination.id, 'powder_charge')).toBe(0);
    expect(await baseQty(newDestination.id, 'powder_charge')).toBe(0);
  });

  it('fences stable items from wallet shadows and refuses retired keep-skin listings', async () => {
    // The cosmetics that once justified wallet custody were removed from the
    // game (M23 a8, D-009 refund via the worker sweep). What survives here:
    // a wallet compatibility shadow must never fund a stable listing, and a
    // legacy skin row is an UNKNOWN catalog id — the market may not move it,
    // in either custody book, while it waits for the refund sweep.
    const seller = await createTestPlayer(db);
    const sellerBase = await stableBase(seller.wallet, 1);
    await db.insert(playerItems).values([
      { playerWallet: seller.wallet, itemId: 'skin_keep_frost', qty: 1 },
      // A compatibility shadow must never fund a stable consumable listing.
      { playerWallet: seller.wallet, itemId: 'finishers_seal', qty: 5 },
    ]);
    await db.insert(baseItems).values([
      { baseId: sellerBase.id, itemId: 'skin_keep_frost', qty: 7 },
      { baseId: sellerBase.id, itemId: 'finishers_seal', qty: 1 },
    ]);

    await expect(listItem(
      db, seller.wallet, 'finishers_seal', 1_000_000n, randomUUID(), async () => {},
    )).rejects.toMatchObject({ statusCode: 409, code: 'BASE_ID_REQUIRED' });
    expect(await walletQty(seller.wallet, 'finishers_seal')).toBe(5);
    expect(await baseQty(sellerBase.id, 'finishers_seal')).toBe(1);

    await expect(listItem(
      db, seller.wallet, 'skin_keep_frost', 1_000_000n, randomUUID(), async () => {},
    )).rejects.toThrow(/unknown inventory item/);
    await expect(listItem(
      db, seller.wallet, 'skin_keep_frost', 1_000_000n, randomUUID(), async () => {},
      context(sellerBase.id),
    )).rejects.toThrow(/unknown inventory item/);
    // Every legacy copy stays exactly where it was: the wallet copy awaits the
    // refund sweep; a base-custody skin row (impossible in production — 0076
    // deleted them) is simply inert.
    expect(await walletQty(seller.wallet, 'skin_keep_frost')).toBe(1);
    expect(await baseQty(sellerBase.id, 'skin_keep_frost')).toBe(7);
  });
});
