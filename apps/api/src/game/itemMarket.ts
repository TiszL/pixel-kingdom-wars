/**
 * In-app item market — Lane B server book (owner 2026-07-24: in-game items sold
 * for SOL, direct non-custodial settlement). Deed gear/consumables and account
 * cosmetics trade peer-to-peer through distinct, structurally fenced custody:
 *
 *   list    — hold 1 unit out of the seller's inventory into the listing.
 *   reserve — buyer locks the listing (TTL) and gets the payment params.
 *   pay     — buyer signs ONE tx: seller gets 95%, our fee treasury 5% (off
 *             the buyer's own wallet; SOL never pools in a game wallet).
 *   settle  — server verifies the finalized, reference-tagged payment, then
 *             hands the item to the buyer in-game.
 *   cancel  — return the held unit to the seller.
 *
 * The item is RESERVED before payment, so it can't vanish under a paying buyer;
 * the SOL leg is a plain buyer-signed transfer (no escrow, no program), and the
 * 5% is enforced because the server won't grant unless BOTH legs verify.
 */
import { randomBytes } from 'node:crypto';
import { isCanonicalSolanaSignature, PaymentProofUnavailableError } from '@shardkeep/chain';
import { ITEMS, MARKETPLACE, REMOVED_SKIN_REFUNDS, type ItemSpec } from '@shardkeep/shared';
import bs58 from 'bs58';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { multiBaseEnabled } from '../config';
import type { Db, DbTx } from '../db/client';
import { invalidateWalletBalances } from './walletBalances';
import {
  baseHeroEquipment, baseItems, baseRaidLocks, bases,
  heroEquipment, itemListings, itemMarketReservations, itemMarketCancellations, playerItems, players,
} from '../db/schema';
import { HttpError } from '../lib/errors';
import { shortWallet } from './tester';
import type { MarketReserveRequest } from '@shardkeep/shared/market';
import { completeReservation, recordedReservation, requireReserveRequest, reservationByKey,
  sameQuote, type MarketCancellation } from './itemMarketReceipts';
import {
  lockStablePrerequisiteBase,
  requireStableBaseMutationContext,
  type StableBaseMutationContext,
} from './stableBasePrerequisites';

const RESERVE_TTL_MS = MARKETPLACE.itemMarket.reserveTtlSec * 1000;

/**
 * Payment verifier the server injects: confirms a buyer-signed, reference-tagged
 * FINALIZED tx delivered exactly sellerLamports to the seller AND feeLamports to the
 * fee treasury. Returns the tx signature, or null if not seen yet (keep polling).
 */
export type MarketPaymentVerifier = (p: {
  reference: string; buyer: string; seller: string; feeTreasury: string;
  sellerLamports: bigint; feeLamports: bigint;
  paymentSignature?: string | undefined; notBefore?: Date | undefined;
}) => Promise<{ txSignature: string } | null>;

/** Exact transaction proof used before a buyer-submitted signature is allowed
 * to extend a reservation. CONFIRMED is sufficient to pin; settlement still
 * uses MarketPaymentVerifier and requires FINALIZED. */
export type MarketPaymentCommitVerifier = (p: {
  reference: string; buyer: string; seller: string; feeTreasury: string;
  sellerLamports: bigint; feeLamports: bigint; paymentSignature: string;
}) => Promise<{ txSignature: string } | null>;

/** Stable-land proof executed inside the marketplace transaction after its
 * canonical player locks, immediately before a new listing/reservation mutates. */
export type MarketLandAuthority = (tx: DbTx, wallet: string) => Promise<void>;

/** Force a new stable listing commitment through one exact finalized Core
 * ownership read before the database-side authority/raid locks are taken. */
export type MarketStableSourceAuthority = (wallet: string, baseId: string) => Promise<void>;

export interface ItemMarketDeps {
  /** Exact startup economy identity. Absent only for pre-contract callers. */
  cluster?: 'devnet' | 'mainnet-beta' | undefined;
  /** Our 5% fee destination (a treasury / Squads multisig at mainnet). */
  feeTreasury?: string | undefined;
  /** On-chain payment verifier (finalized). Absent → settlement unavailable. */
  verifyPayment?: MarketPaymentVerifier | undefined;
  /** Direct exact-signature verifier (confirmed). Absent → /paid unavailable. */
  verifyPaymentCommit?: MarketPaymentCommitVerifier | undefined;
  /** Multi-base land authority fence. Omitted while the stable feature is off. */
  authorizeLandMutation?: MarketLandAuthority | undefined;
  /** Exact finalized source-deed refresh for each NEW stable reservation. A
   * protected retry is a recovery read and deliberately skips this callback. */
  refreshStableSourceAuthority?: MarketStableSourceAuthority | undefined;
}

/** Cancellation may recover custody from an inactive deed. Its finalized proof
 * therefore needs an explicit out-of-transaction refresh: the bounded observer
 * only keeps active deeds warm, while the callback below still rechecks the
 * freshly persisted evidence under the source-base lock. */
export interface RecoverableListingBaseContext extends StableBaseMutationContext {
  prepareAuthority?: (wallet: string, baseId: string) => Promise<void>;
}

function isCatalogItem(itemId: string): boolean {
  // Land deeds never enter player_items/ITEMS: they keep the atomic Core-NFT
  // transfer lane. Every other known DB item may use this custody book unless
  // its own drop-only policy rejects it below.
  return Object.prototype.hasOwnProperty.call(ITEMS, itemId);
}

function itemSpec(itemId: string) {
  return (ITEMS as Record<string, ItemSpec | undefined>)[itemId];
}

/** D-035 left only account cosmetics in wallet custody; every other catalog
 * item follows the deed in stable mode. The keep-skin cosmetics were removed
 * (M23 a8), so today's catalog is entirely base-custody — the kind check stays
 * as the structural guard for the still-possible `cosmetic` ItemKind. */
function isBaseCustodyItem(itemId: string): boolean {
  return itemSpec(itemId)?.kind !== 'cosmetic';
}

/** Cancellation is an unwind, so the current deed owner may recover a held
 * item even when the deed is inactive. It still cannot mutate custody through
 * an in-flight raid, and finalized ownership is rechecked by the route seam. */
async function lockRecoverableListingBase(
  tx: DbTx,
  wallet: string,
  context: StableBaseMutationContext,
) {
  const [base] = await tx.select().from(bases).where(and(
    eq(bases.id, context.baseId), eq(bases.ownerWallet, wallet),
  )).for('update');
  if (!base) throw new HttpError(404, 'base not owned', 'BASE_NOT_OWNED');
  const [raidLock] = await tx.select({ raidId: baseRaidLocks.raidId })
    .from(baseRaidLocks).where(eq(baseRaidLocks.baseId, base.id)).for('update');
  if (raidLock) {
    throw new HttpError(
      423,
      'You are being raided. Please wait to continue playing or watch it live.',
      'BASE_BEING_RAIDED',
    );
  }
  await context.assertAuthority(tx, wallet, base.id);
  return base;
}

/** Forge relics (e.g. the Warzone Aegis): won, never bought — and never SOLD. */
function isDropOnly(itemId: string): boolean {
  return (ITEMS as Record<string, { dropOnly?: boolean } | undefined>)[itemId]?.dropOnly === true;
}

/** 5% fee (multiply-before-divide); seller nets the rest. */
function splitPrice(price: bigint): { feeLamports: bigint; sellerLamports: bigint } {
  const feeLamports = (price * BigInt(MARKETPLACE.feeBps)) / 10_000n;
  return { feeLamports, sellerLamports: price - feeLamports };
}

type Listing = typeof itemListings.$inferSelect;
async function paymentTerms(db: Db | DbTx, deps: ItemMarketDeps, listing: Listing) {
  const record = await recordedReservation(db, listing);
  if (record) {
    if (!sameQuote(record, listing) || record.cluster !== deps.cluster) throw new HttpError(503, 'recorded marketplace quote or network is unavailable');
    return { feeTreasury: record.feeTreasury, sellerLamports: record.sellerLamports, feeLamports: record.feeLamports,
      notBefore: record.createdAt, record };
  }
  if (!deps.feeTreasury) throw new HttpError(503, 'marketplace payments are not configured');
  return { feeTreasury: deps.feeTreasury, ...splitPrice(listing.priceLamports), notBefore: reservationStartedAt(listing), record: null };
}
type FrozenReservation = Pick<Listing,
  | 'id' | 'itemId' | 'sellerWallet' | 'priceLamports' | 'baseId'
  | 'reservedBy' | 'reservedUntil' | 'reference' | 'buyerBaseId' | 'paymentSig'
> & { reservedBy: string; reservedUntil: Date; reference: string };
const RECLAIM_GRACE_MS = MARKETPLACE.itemMarket.reclaimGraceSec * 1000;
const SETTLE_TIMEOUT_MS = MARKETPLACE.itemMarket.settleTimeoutSec * 1000;
/**
 * When a lapsed reservation becomes RECLAIMABLE / takeable. A reservation with a
 * COMMITTED payment (paymentSig set — the buyer told us they broadcast) is held
 * far longer (settleTimeout) so any valid payment finalizes and settles to the
 * buyer before it can be reclaimed; an uncommitted one only waits the short
 * finalization grace. Settle BY THE RESERVER is never gated by this — a paid
 * buyer can always claim. settlePaidExpired still runs before any reclaim.
 */
function reclaimCutoffMs(l: Listing): number {
  return l.paymentSig ? SETTLE_TIMEOUT_MS : RECLAIM_GRACE_MS;
}
const reservationStartedAt = (l: Listing): Date | undefined => l.reservedUntil
  ? new Date(l.reservedUntil.getTime() - RESERVE_TTL_MS)
  : undefined;
export const isReclaimable = (l: Listing, now: Date): boolean =>
  !!l.reservedUntil && l.reservedUntil.getTime() <= now.getTime() - reclaimCutoffMs(l);

const isProtectedRetry = (l: Listing, buyer: string, now: Date): boolean =>
  l.status === 'reserved' && l.reservedBy === buyer && !!l.reference && !!l.reservedUntil
  && (l.paymentSig !== null || !isReclaimable(l, now));

function freezeReservation(l: Listing): FrozenReservation {
  if (l.status !== 'reserved' || !l.reservedBy || !l.reservedUntil || !l.reference) {
    throw new HttpError(409, 'reservation changed — refresh');
  }
  return {
    id: l.id,
    itemId: l.itemId,
    sellerWallet: l.sellerWallet,
    priceLamports: l.priceLamports,
    baseId: l.baseId,
    reservedBy: l.reservedBy,
    reservedUntil: l.reservedUntil,
    reference: l.reference,
    buyerBaseId: l.buyerBaseId,
    paymentSig: l.paymentSig,
  };
}

/** Identity of one reservation generation. `paymentSig` is intentionally
 * separate: pinning the exact verified signature is allowed to race settlement,
 * while changing any quote/custody field creates a different generation. */
function sameReservationGeneration(l: Listing, frozen: FrozenReservation): boolean {
  return l.id === frozen.id
    && l.itemId === frozen.itemId
    && l.sellerWallet === frozen.sellerWallet
    && l.priceLamports === frozen.priceLamports
    && l.baseId === frozen.baseId
    && l.reservedBy === frozen.reservedBy
    && l.reference === frozen.reference
    && l.buyerBaseId === frozen.buyerBaseId;
}

function reservationGenerationPredicate(frozen: FrozenReservation): SQL | undefined {
  return and(
    eq(itemListings.id, frozen.id),
    eq(itemListings.status, 'reserved'),
    eq(itemListings.itemId, frozen.itemId),
    eq(itemListings.sellerWallet, frozen.sellerWallet),
    eq(itemListings.priceLamports, frozen.priceLamports),
    frozen.baseId === null ? isNull(itemListings.baseId) : eq(itemListings.baseId, frozen.baseId),
    eq(itemListings.reservedBy, frozen.reservedBy),
    eq(itemListings.reference, frozen.reference),
    frozen.buyerBaseId === null
      ? isNull(itemListings.buyerBaseId)
      : eq(itemListings.buyerBaseId, frozen.buyerBaseId),
  );
}

function exactReservationPredicate(frozen: FrozenReservation): SQL | undefined {
  return and(
    reservationGenerationPredicate(frozen),
    frozen.paymentSig === null
      ? isNull(itemListings.paymentSig)
      : eq(itemListings.paymentSig, frozen.paymentSig),
  );
}

function exactSettlementPredicate(
  frozen: FrozenReservation, txSignature: string,
): SQL | undefined {
  return and(
    reservationGenerationPredicate(frozen),
    frozen.paymentSig === null
      ? or(isNull(itemListings.paymentSig), eq(itemListings.paymentSig, txSignature))
      : eq(itemListings.paymentSig, frozen.paymentSig),
  );
}

function isExactSettledGeneration(
  l: Listing | undefined, frozen: FrozenReservation, txSignature: string,
): boolean {
  return !!l && l.status === 'sold' && l.buyerWallet === frozen.reservedBy
    && l.txSignature === txSignature && sameReservationGeneration(l, frozen);
}

/** SQL mirror of isReclaimable for a reserved row — uncommitted past the grace,
 *  or committed past the settle timeout. Shared by the cancel claim + browse. */
function reclaimablePredicate(now: Date): SQL | undefined {
  const graceCutoff = new Date(now.getTime() - RECLAIM_GRACE_MS);
  const settleCutoff = new Date(now.getTime() - SETTLE_TIMEOUT_MS);
  return or(
    and(eq(itemListings.status, 'reserved'), isNull(itemListings.paymentSig), lte(itemListings.reservedUntil, graceCutoff)),
    and(eq(itemListings.status, 'reserved'), isNotNull(itemListings.paymentSig), lte(itemListings.reservedUntil, settleCutoff)),
  );
}

/** Serialize and reject cross-column signature reuse for both money paths. */
async function lockUnusedPaymentSignature(tx: DbTx, listingId: string, txSignature: string, reference: string): Promise<void> {
  // Both the confirmed commitment and finalized settlement paths must share
  // this lock. Otherwise listing A can write tx_signature while listing B
  // concurrently writes the same value to payment_sig, bypassing each path's
  // cross-column check.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`item-market-payment:${txSignature}`}, 0))`);
  const [reused] = await tx.select({ id: itemListings.id }).from(itemListings)
    .where(and(
      ne(itemListings.id, listingId),
      or(eq(itemListings.paymentSig, txSignature), eq(itemListings.txSignature, txSignature)),
    ))
    .limit(1);
  if (reused) throw new HttpError(422, 'that payment signature is already used by another listing');
  const [historical] = await tx.select({ id: itemMarketReservations.id }).from(itemMarketReservations)
    .where(and(ne(itemMarketReservations.reference, reference), or(eq(itemMarketReservations.paymentSig, txSignature), eq(itemMarketReservations.txSignature, txSignature)))).limit(1);
  if (historical) throw new HttpError(422, 'that payment signature is already used by another reservation');
}

/** Grant the item + mark sold under the reserved-by-buyer guard, inside a tx.
 * A verified payment is an owed delivery, so settlement is intentionally not
 * rejected if the buyer filled their pack after reserving; GET /items exposes
 * the resulting overflow and new shop purchases remain blocked.
 * The unique tx_signature index (migration 0032) remains defense in depth for
 * out-of-band writes. Returns null if a concurrent settle already claimed it. */
async function finalizeSale(
  tx: DbTx, frozen: FrozenReservation, txSignature: string,
): Promise<string | null> {
  // Match submitPayment's player → signature → listing order. Besides making the
  // money paths deterministic, this avoids a same-buyer deadlock when the item
  // grant's player_items foreign key checks the player row after settlement.
  const [buyerPlayer] = await tx.select({ wallet: players.wallet }).from(players)
    .where(eq(players.wallet, frozen.reservedBy)).for('update');
  if (!buyerPlayer) throw new HttpError(404, 'player not found');
  await lockUnusedPaymentSignature(tx, frozen.id, txSignature, frozen.reference);
  let claimed;
  try {
    claimed = await tx.update(itemListings)
      .set({
        status: 'sold', buyerWallet: frozen.reservedBy, txSignature, settledAt: sql`now()`,
      })
      // The RPC proof ran outside this transaction. Bind its result to the exact
      // frozen generation so a same-buyer renewal cannot redirect an old payment
      // to a new seller/reference/destination while verification is in flight.
      .where(exactSettlementPredicate(frozen, txSignature))
      .returning({
        itemId: itemListings.itemId,
        baseId: itemListings.baseId,
        buyerBaseId: itemListings.buyerBaseId,
      });
  } catch (e) {
    // Drizzle wraps the pg error, so check the code on the error AND its cause,
    // plus the unique-index name as a fallback (security review 2026-07-24 #1).
    const code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    const msg = e instanceof Error ? e.message : '';
    if (code === '23505' || msg.includes('item_listings_tx_sig_uq')) {
      throw new HttpError(422, 'that payment was already used to buy another listing');
    }
    throw e;
  }
  if (claimed.length === 0) return null;
  await completeReservation(tx, frozen, txSignature);
  const item = claimed[0]!;
  if (item.baseId) {
    if (!isBaseCustodyItem(item.itemId)) {
      throw new Error(`stable item listing ${frozen.id} contains an account cosmetic`);
    }
    // The destination is frozen when the buyer reserves. A later deed transfer
    // moves the destination inventory with it; payment still honours exactly
    // one delivery and never falls back into an economic wallet shadow.
    if (!item.buyerBaseId) throw new Error(`stable item listing ${frozen.id} has no buyer base`);
    await tx.insert(baseItems).values({ baseId: item.buyerBaseId, itemId: item.itemId })
      .onConflictDoUpdate({
        target: [baseItems.baseId, baseItems.itemId],
        set: { qty: sql`${baseItems.qty} + 1` },
      });
  } else {
    // Account cosmetics and fenced pre-cutover/flag-off listings retain the
    // wallet path. Stable non-cosmetic writers can never create this shape.
    await tx.insert(playerItems).values({ playerWallet: frozen.reservedBy, itemId: item.itemId })
      .onConflictDoUpdate({
        target: [playerItems.playerWallet, playerItems.itemId],
        set: { qty: sql`${playerItems.qty} + 1` },
      });
  }
  return item.itemId;
}

/** List one unequipped unit for `priceLamports`. Stable gear/consumables leave
 * one exact base inventory; account cosmetics and flag-off rows leave the
 * wallet inventory. Deeds stay on their Core NFT lane; earned drop-only items
 * remain non-tradable by owner policy. */
export async function listItem(
  db: Db, seller: string, itemId: string, priceLamports: bigint, requestKey: string,
  authorizeLandMutation?: MarketLandAuthority,
  stableBaseContext?: StableBaseMutationContext,
) {
  if (!isCatalogItem(itemId)) {
    throw new HttpError(422, 'unknown inventory item (bases are Core NFTs — sell them on Tensor/Magic Eden)');
  }
  // dropOnly items are FORGE DROPS: they cost nothing, so listing one converts a
  // free win straight into SOL paid to the seller's own wallet (settlement is
  // non-custodial — reservePayload sends the seller their 95% directly). `buyItem`
  // already refuses them in the other direction (items.ts) and the Shop keeps them
  // out of its purchasable catalog; this is the third door, and free onboarding is what makes it
  // matter: a Warzone Aegis is worth up to maxPriceLamports and the forge's drop odds
  // are EQUAL per wallet, so without this the cheapest way to buy SOL income is to
  // make more accounts. Rejecting the LIST (not the settle) is what keeps the fix
  // ahead of any money moving. Owner decision 2026-08-09 (R8 / §7 Q3).
  //
  // UNCONDITIONAL, NOT BEHIND `FREE_ONBOARDING` (security review 2026-08-09 F2).
  // "dropOnly items are not tradeable for SOL" is a rule the codebase ALREADY
  // enforced in two of its three doors — items.ts refuses to buy them and the Shop
  // hides their buy action — so this door was simply inconsistent with the other two, which is
  // a defect at any flag setting. Flag-off delta, stated rather than hidden: a
  // landowner who won a relic before today could list it and can no longer. That is
  // the correct end state (the Forge is the relic's only source, by design), and
  // gating it would mean the same inventory is sellable or not depending on an ops
  // switch. SETTLEMENT is deliberately left alone: an already-paid buyer must never
  // lose an item to a rule added after their payment.
  if (isDropOnly(itemId)) {
    throw new HttpError(422, 'forged relics cannot be sold — the Gold Forge is their only source');
  }
  // Crafted materials (E2-WORKSHOP-CONTRACT §2: a Forge Ingot leaves a base only
  // through a Gold Forge commitment or the KEEP-market slice, never this SOL
  // lane) — UNCONDITIONAL like dropOnly (security review 2026-09-20, Workshop
  // finding 1): listing one would drain `held` past the holding cap and open the
  // first SHARDS → SOL conversion path, contradicting D-150's KEEP-market burn.
  if (itemSpec(itemId)?.acquisition?.type === 'craft') {
    throw new HttpError(422, 'crafted materials are not sold on the SOL market — commit them or trade them for KEEP', 'ITEM_NOT_LISTABLE');
  }
  const { minPriceLamports, maxPriceLamports, maxActiveListingsPerSeller } = MARKETPLACE.itemMarket;
  if (priceLamports < BigInt(minPriceLamports) || priceLamports > BigInt(maxPriceLamports)) {
    throw new HttpError(422, `price must be between ${minPriceLamports} and ${maxPriceLamports} lamports`);
  }
  const stableCustody = multiBaseEnabled() && isBaseCustodyItem(itemId);
  const baseContext = stableCustody
    ? requireStableBaseMutationContext(stableBaseContext)
    : undefined;
  const idempotencyKey = `item-list:${seller}:${requestKey}`;
  return db.transaction(async (tx) => {
    // Same lock root/order as equipment changes. This closes the equip/list
    // race: the unit can become held by a listing OR worn, never both.
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, seller)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    const [existing] = await tx.select().from(itemListings)
      .where(eq(itemListings.idempotencyKey, idempotencyKey));
    if (existing) {
      if (existing.sellerWallet !== seller || existing.itemId !== itemId
        || existing.priceLamports !== priceLamports
        || existing.baseId !== (baseContext?.baseId ?? null)) {
        throw new HttpError(409, 'listing idempotency key was already used for another item or price');
      }
      return {
        id: existing.id, itemId, baseId: existing.baseId,
        priceLamports: priceLamports.toString(),
      };
    }
    if (baseContext) await lockStablePrerequisiteBase(tx, seller, baseContext);
    else if (authorizeLandMutation) await authorizeLandMutation(tx, seller);
    const active = await tx.select({ n: sql<number>`count(*)::int` }).from(itemListings)
      .leftJoin(bases, eq(bases.id, itemListings.baseId))
      .where(and(
        or(
          and(isNull(itemListings.baseId), eq(itemListings.sellerWallet, seller)),
          eq(bases.ownerWallet, seller),
        ),
        ne(itemListings.status, 'sold'), ne(itemListings.status, 'cancelled'),
      ));
    if ((active[0]?.n ?? 0) >= maxActiveListingsPerSeller) {
      throw new HttpError(422, `you already have ${maxActiveListingsPerSeller} open listings`);
    }
    const [owned] = baseContext
      ? await tx.select({ qty: baseItems.qty, acquiredVia: baseItems.acquiredVia }).from(baseItems)
        .where(and(eq(baseItems.baseId, baseContext.baseId), eq(baseItems.itemId, itemId)))
        .for('update')
      : await tx.select({ qty: playerItems.qty, acquiredVia: playerItems.acquiredVia }).from(playerItems)
        .where(and(eq(playerItems.playerWallet, seller), eq(playerItems.itemId, itemId)))
        .for('update');
    // D-152 (owner: system-shop consumables are account-bound): a stack bought
    // with Gems never reaches the SOL lane, or "non-withdrawable" would be false
    // (refuter R1). Refused at LIST like dropOnly above; settlement of a listing
    // made before the rule is untouched. The whole stack is bound once any copy
    // was paid in Gems — the row cannot tell the copies apart.
    if (owned?.acquiredVia === 'shop_gems') {
      throw new HttpError(422, 'items bought with Gems are bound to your account and cannot be listed', 'ITEM_NOT_LISTABLE');
    }
    const [worn] = baseContext
      ? await tx.select({ n: sql<number>`count(*)::int` }).from(baseHeroEquipment)
        .where(and(eq(baseHeroEquipment.baseId, baseContext.baseId), eq(baseHeroEquipment.itemId, itemId)))
      : await tx.select({ n: sql<number>`count(*)::int` }).from(heroEquipment)
        .where(and(eq(heroEquipment.playerWallet, seller), eq(heroEquipment.itemId, itemId)));
    if ((owned?.qty ?? 0) <= 0) throw new HttpError(422, 'you have none of that item to list');
    const wornCopies = worn?.n ?? 0;
    if (owned!.qty <= wornCopies) {
      throw new HttpError(422, 'you have no unequipped copy of that item to list');
    }
    if (baseContext) {
      await tx.update(baseItems)
        .set({ qty: sql`${baseItems.qty} - 1` })
        .where(and(eq(baseItems.baseId, baseContext.baseId), eq(baseItems.itemId, itemId)));
    } else {
      await tx.update(playerItems)
        .set({ qty: sql`${playerItems.qty} - 1` })
        .where(and(eq(playerItems.playerWallet, seller), eq(playerItems.itemId, itemId)));
    }
    const [row] = await tx.insert(itemListings)
      .values({
        sellerWallet: seller, idempotencyKey, itemId, priceLamports, status: 'active',
        ...(baseContext ? { baseId: baseContext.baseId } : {}),
      })
      .returning();
    return {
      id: row!.id, itemId, baseId: row!.baseId,
      priceLamports: priceLamports.toString(),
    };
  });
}

/**
 * If an EXPIRED reservation was actually PAID, settle it to that buyer (used
 * before a takeover/cancel/release so a paying buyer never loses the item to a
 * reopen — security review 2026-07-24 #2). Runs the RPC verify OUTSIDE any
 * lock. Returns true if it settled the prior buyer (caller must then abort its
 * own action).
 *
 * EXPIRED-THEN-PAID, deterministically (tester report 24b9184d, 2026-09-16):
 *  1. Past `reservedUntil` but before the reclaim cutoff — only the reserver
 *     can act; their own /settle is never gated by expiry, and the worker
 *     reconciler settles a committed row for them.
 *  2. Past the reclaim cutoff — every actor that could move the listing on
 *     (takeover, cancel, reconciler release) FIRST runs this finalized,
 *     strict-uncertainty proof. A payment that finalized settles to the
 *     original buyer and the actor is refused; unavailable proof throws and
 *     nothing moves. The cutoff exceeds a blockhash's validity, so a payment
 *     signed inside the reservation cannot still be in flight here.
 *  3. After the generation was superseded — a payment for the OLD reference
 *     can only exist if a client signed after the payment window (the web
 *     refuses). It can never settle (the receipt is terminal and the listing
 *     belongs to another generation) and SOL went straight to the seller, so
 *     there is no custodial refund: payReservation logs it loudly for ops and
 *     the receipt stays `superseded` with the submitted signature retained
 *     client-side for support.
 */
export async function settlePaidExpired(db: Db, deps: ItemMarketDeps, l: Listing): Promise<boolean> {
  if (!l.reference || !l.reservedBy) return false;
  const record = await recordedReservation(db, l);
  // No verifier is UNCERTAINTY, never proof of non-payment: a reserved row
  // with a reference may hold a paying buyer's SOL, so nothing may reclaim,
  // take over or release it until finalized proof is available.
  if (!deps.verifyPayment || (!record && !deps.feeTreasury)) {
    throw new HttpError(503, record
      ? 'recorded marketplace payment verification is unavailable'
      : 'marketplace payment verification is unavailable — a lapsed reservation cannot be proven unpaid');
  }
  const frozen = freezeReservation(l);
  const { feeLamports, sellerLamports, feeTreasury, notBefore } = await paymentTerms(db, deps, l);
  const paid = await deps.verifyPayment({
    reference: l.reference, buyer: l.reservedBy, seller: l.sellerWallet, feeTreasury,
    sellerLamports, feeLamports, paymentSignature: l.paymentSig ?? undefined,
    notBefore,
  });
  if (!paid) {
    if (record?.paymentSig) throw new HttpError(503, 'confirmed market payment awaits authoritative finality', 'MARKET_PAYMENT_UNCERTAIN');
    return false;
  }
  const settled = await db.transaction(async (tx) => {
    const itemId = await finalizeSale(tx, frozen, paid.txSignature);
    if (itemId !== null) return true;
    const [again] = await tx.select().from(itemListings).where(eq(itemListings.id, frozen.id));
    return isExactSettledGeneration(again, frozen, paid.txSignature);
  });
  // A positive chain proof must never be applied to whatever reservation happens
  // to occupy the row after RPC. Fail loudly so takeover/cancel also cannot act
  // on that replacement using the old generation's unpaid verdict.
  if (!settled) throw new HttpError(409, 'reservation changed while payment was being verified');
  invalidateWalletBalances(l.reservedBy);
  invalidateWalletBalances(l.sellerWallet);
  return true;
}

/**
 * Release a lapsed UNPAID reservation back to the open book: the listing
 * returns to `active` (its held unit stays in market custody, for sale) and
 * the recorded receipt becomes `superseded`. The caller has ALREADY proven the
 * generation unpaid through settlePaidExpired; this only performs the atomic
 * state change under the exact frozen generation, so a concurrent settle,
 * takeover or cancel wins by changing the row first.
 *
 * `superseded` rather than `cancelled`: the DB consistency fence pins a
 * cancelled receipt to a cancelled listing, while a superseded receipt only
 * requires that the listing no longer carries its reference — exactly the
 * takeover outcome, and the state the buyer's saved receipt reports. A
 * `committed` receipt can never be released (its lifecycle cannot regress);
 * settlePaidExpired throws MARKET_PAYMENT_UNCERTAIN for it before this point.
 * Returns false if the generation moved on meanwhile.
 */
export async function releaseLapsedReservation(db: Db, l: Listing, now = new Date()): Promise<boolean> {
  if (l.status !== 'reserved' || !isReclaimable(l, now)) return false;
  const frozen = freezeReservation(l);
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(itemListings).where(eq(itemListings.id, frozen.id)).for('update');
    if (!locked || !sameReservationGeneration(locked, frozen) || locked.paymentSig !== frozen.paymentSig
      || !isReclaimable(locked, now)) return false;
    const record = await recordedReservation(tx, locked);
    if (record && record.state !== 'reserved') return false;
    const released = await tx.update(itemListings)
      .set({ status: 'active', reservedBy: null, reservedUntil: null, reference: null, paymentSig: null, buyerBaseId: null, reconcileAttemptedAt: null })
      .where(exactReservationPredicate(frozen))
      .returning({ id: itemListings.id });
    if (released.length === 0) return false;
    if (record) {
      await tx.update(itemMarketReservations).set({ state: 'superseded', resolvedAt: now })
        .where(and(eq(itemMarketReservations.id, record.id), eq(itemMarketReservations.state, 'reserved')));
    }
    return true;
  });
}

/**
 * Cancel your own listing. An ACTIVE listing cancels immediately. A RESERVED
 * one can only be cancelled AFTER it expires, and only once we confirm the
 * buyer did NOT pay — if they did, the sale settles to them instead (the seller
 * never reclaims an item someone paid for). Returns the held unit on cancel.
 */
export async function cancelListing(
  db: Db,
  deps: ItemMarketDeps,
  seller: string,
  listingId: string,
  now = new Date(),
  stableBaseContext?: RecoverableListingBaseContext,
  cancellation?: MarketCancellation,
) {
  const [pre] = await db.select().from(itemListings).where(eq(itemListings.id, listingId));
  if (!pre) throw new HttpError(404, 'listing not found or not yours');
  if (cancellation && (cancellation.actorWallet !== seller || cancellation.listingId !== pre.id
    || cancellation.itemId !== pre.itemId || cancellation.sourceBaseId !== pre.baseId || cancellation.priceLamports !== pre.priceLamports
    || cancellation.expectedStatus !== pre.status || cancellation.expectedReference !== pre.reference)) {
    throw new HttpError(409, 'listing changed since cancellation review', 'MARKET_CONSENT_CHANGED');
  }
  if (pre.baseId) {
    const [current] = await db.select({ ownerWallet: bases.ownerWallet }).from(bases)
      .where(and(eq(bases.id, pre.baseId), eq(bases.ownerWallet, seller)));
    if (!current) throw new HttpError(404, 'listing not found or not yours');
    if (!stableBaseContext || stableBaseContext.baseId !== pre.baseId) {
      throw new HttpError(409, 'listing base authority is required', 'BASE_ID_REQUIRED');
    }
  } else if (pre.sellerWallet !== seller) {
    throw new HttpError(404, 'listing not found or not yours');
  }
  let reclaimGeneration: FrozenReservation | undefined;
  if (pre.status === 'reserved') {
    if (!isReclaimable(pre, now)) throw new HttpError(422, 'a sale is in progress — wait for it to clear or lapse');
    reclaimGeneration = freezeReservation(pre);
    if (await settlePaidExpired(db, deps, pre)) throw new HttpError(409, 'a buyer already paid — the item went to them');
  } else if (pre.status !== 'active') {
    throw new HttpError(422, 'listing is not cancellable');
  }
  // Paid rescue above is intentionally first: an owed buyer must still receive
  // the item even if the source deed changed hands. Only an actual unwind needs
  // the caller's current finalized authority over that exact (possibly inactive)
  // source deed.
  if (pre.baseId) await stableBaseContext!.prepareAuthority?.(seller, pre.baseId);
  return db.transaction(async (tx) => {
    const [actor] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, seller)).for('update');
    if (!actor) throw new HttpError(404, 'player not found');
    const [locked] = await tx.select().from(itemListings)
      .where(eq(itemListings.id, listingId)).for('update');
    if (!locked || locked.baseId !== pre.baseId) throw new HttpError(422, 'listing changed — refresh');
    if (reclaimGeneration
      && (!sameReservationGeneration(locked, reclaimGeneration)
        || locked.paymentSig !== reclaimGeneration.paymentSig)) {
      throw new HttpError(422, 'listing changed — refresh');
    }
    if (stableBaseContext) await lockRecoverableListingBase(tx, seller, stableBaseContext);
    // Atomic claim: active, OR a reclaimable reservation (grace/settle timeout).
    const claimed = await tx.update(itemListings)
      .set({
        status: 'cancelled', reservedBy: null, reservedUntil: null,
        reference: null, paymentSig: null, buyerBaseId: null, settledAt: sql`now()`,
      })
      .where(and(
        pre.baseId ? eq(itemListings.baseId, pre.baseId) : eq(itemListings.sellerWallet, seller),
        reclaimGeneration
          ? exactReservationPredicate(reclaimGeneration)
          : and(eq(itemListings.id, listingId), eq(itemListings.status, 'active')),
      ))
      .returning({ itemId: itemListings.itemId, baseId: itemListings.baseId });
    if (claimed.length === 0) throw new HttpError(422, 'listing changed — refresh');
    if (pre.reference) await tx.update(itemMarketReservations).set({ state: 'cancelled', resolvedAt: new Date() })
      .where(and(eq(itemMarketReservations.listingId, pre.id), eq(itemMarketReservations.reference, pre.reference)));
    if (cancellation) {
      const result = await tx.update(itemMarketCancellations).set({ state: 'cancelled', resolvedAt: new Date() })
        .where(and(eq(itemMarketCancellations.id, cancellation.id), eq(itemMarketCancellations.state, 'pending'))).returning({ id: itemMarketCancellations.id });
      if (result.length !== 1) throw new HttpError(409, 'cancellation already resolved');
    }
    const item = claimed[0]!;
    if (item.baseId) {
      if (!isBaseCustodyItem(item.itemId)) {
        throw new Error(`stable item listing ${listingId} contains an account cosmetic`);
      }
      await tx.insert(baseItems).values({ baseId: item.baseId, itemId: item.itemId })
        .onConflictDoUpdate({
          target: [baseItems.baseId, baseItems.itemId],
          set: { qty: sql`${baseItems.qty} + 1` },
        });
    } else {
      await tx.insert(playerItems).values({ playerWallet: seller, itemId: item.itemId })
        .onConflictDoUpdate({
          target: [playerItems.playerWallet, playerItems.itemId],
          set: { qty: sql`${playerItems.qty} + 1` },
        });
    }
    return { cancelled: listingId };
  });
}

/**
 * Reserve a listing (locks it for RESERVE_TTL) and return the payment params the
 * buyer signs. Re-reserving your own live reservation returns it unchanged. If
 * the listing is held by an EXPIRED reservation, we first check whether that
 * buyer paid (→ settle to them, reject the takeover); only an expired UNPAID
 * reservation is reopened. Capped per buyer (anti-grief).
 */
export async function reserveListing(
  db: Db,
  deps: ItemMarketDeps,
  buyer: string,
  listingId: string,
  now = new Date(),
  buyerBaseContext?: StableBaseMutationContext,
  request?: MarketReserveRequest,
) {
  if (request) {
    const old = await reservationByKey(db, buyer, request.idempotencyKey);
    if (old) { requireReserveRequest(old, listingId, request); return recordedReservePayload(old); }
    if (!deps.cluster) throw new HttpError(503, 'versioned marketplace network is unavailable');
  }
  if (!deps.feeTreasury) throw new HttpError(503, 'marketplace payments are not configured');
  // Resolve a lapsed reservation's payment OUTSIDE the lock, before we try to take over.
  const [pre] = await db.select().from(itemListings).where(eq(itemListings.id, listingId));
  if (!pre) throw new HttpError(404, 'listing not found');
  // A retired keep-skin (M23 a8/D-054) must not take NEW real-SOL commitments:
  // the item can no longer render or be owned, and its escrowed unit is owed a
  // D-009 refund. Existing reservations still settle/expire through the normal
  // lifecycle above, so a buyer who already paid is never stranded (security
  // review 2026-08-15 finding 2).
  if (Object.prototype.hasOwnProperty.call(REMOVED_SKIN_REFUNDS, pre.itemId)
    && !isProtectedRetry(pre, buyer, now)) {
    throw new HttpError(422, 'this item was retired from the game — its listing can no longer be bought');
  }
  const protectedRetry = isProtectedRetry(pre, buyer, now);
  const checkedGeneration = pre.status === 'reserved' ? freezeReservation(pre) : null;
  if (pre.status === 'reserved' && isReclaimable(pre, now)) {
    if (await settlePaidExpired(db, deps, pre)) throw new HttpError(409, 'just sold to another buyer');
  }

  // On an open stable listing, the deed's current owner is the effective seller
  // and payment recipient. seller_wallet remains the frozen quote recipient once
  // a reservation exists; an unpaid takeover refreshes it to the then-current
  // owner. This prevents a deed seller extracting an item after conveying it.
  let effectiveSeller = pre.sellerWallet;
  if (pre.baseId) {
    const [source] = await db.select({ ownerWallet: bases.ownerWallet }).from(bases)
      .where(eq(bases.id, pre.baseId));
    if (!source) throw new HttpError(409, 'listing source deed no longer exists');
    effectiveSeller = source.ownerWallet;
  }

  // A NEW stable reservation is a real-money commitment. Cached ownership is
  // insufficient at this boundary: force one exact finalized Core read before
  // freezing the recipient. Use the source base's current DB owner rather than
  // the listing's historical quote recipient, so a mismatch can apply a deed
  // transfer and a later retry can authorize its newly activated owner.
  if (pre.baseId && !protectedRetry) {
    if (!deps.refreshStableSourceAuthority) {
      throw new HttpError(503, 'marketplace source-deed verification is not configured');
    }
    await deps.refreshStableSourceAuthority(effectiveSeller, pre.baseId);
  }

  return db.transaction(async (tx) => {
    // Buyer and seller are both eligibility inputs. Lock their player roots in
    // lexical order before the listing and either wallet's stable authority
    // rows. A concurrent deed transfer therefore cannot commit between the
    // route refresh and a NEW reservation.
    const participants = [...new Set([buyer, effectiveSeller])].sort();
    const lockedPlayers = await tx.select({ wallet: players.wallet }).from(players)
      .where(inArray(players.wallet, participants)).orderBy(asc(players.wallet)).for('update');
    if (lockedPlayers.length !== participants.length) throw new HttpError(404, 'buyer or seller not found');
    const [listing] = await tx.select().from(itemListings).where(eq(itemListings.id, listingId)).for('update');
    if (!listing) throw new HttpError(404, 'listing not found');
    if (request) {
      const old = await reservationByKey(tx, buyer, request.idempotencyKey);
      if (old) { requireReserveRequest(old, listingId, request); return recordedReservePayload(old); }
    }
    if (listing.baseId !== pre.baseId) throw new HttpError(409, 'listing source changed — refresh');

    // Same buyer re-reserving a protected reservation → return it unchanged.
    // A confirmed commitment is unresolved until another actor's reclaim path
    // proves it unpaid, so the buyer cannot roll it into a fresh reference.
    if (isProtectedRetry(listing, buyer, now)) {
      const recorded = await recordedReservation(tx, listing);
      if (request) throw new HttpError(409, recorded ? 'recover the existing reservation key' : 'recover the existing purchase in the web game',
        recorded ? 'MARKET_EXISTING_RESERVATION' : 'MARKET_LEGACY_RECOVERY_REQUIRED');
      if (recorded) return recordedReservePayload(recorded);
      return reservePayload(listing, deps.feeTreasury!, listing.reference!, listing.reservedUntil!);
    }
    const takeable = listing.status === 'active' || (listing.status === 'reserved' && isReclaimable(listing, now));
    if (!takeable) throw new HttpError(422, 'listing is not available right now');
    if (effectiveSeller === buyer) throw new HttpError(422, 'you cannot buy your own listing');
    if (request && (request.itemId !== listing.itemId || request.sourceBaseId !== listing.baseId
      || request.seller !== effectiveSeller || BigInt(request.priceLamports) !== listing.priceLamports
      || request.buyerBaseId !== (listing.baseId ? buyerBaseContext?.baseId : null))) {
      throw new HttpError(409, 'market offer changed — review it again', 'MARKET_CONSENT_CHANGED');
    }
    // A legacy same-buyer retry must not replace a different generation than
    // the one checked for payment, including a signature pinned during RPC.
    if (checkedGeneration && (!sameReservationGeneration(listing, checkedGeneration)
      || listing.paymentSig !== checkedGeneration.paymentSig)) {
      throw new HttpError(409, 'reservation changed while payment was being checked');
    }

    // Eligibility is required only when creating/replacing a commitment. The
    // protected same-buyer return above is a recovery read: it must keep working
    // after either party transfers land (and especially after payment broadcast),
    // because generating a new reference would strand the in-flight purchase.
    if (listing.baseId) {
      if (!isBaseCustodyItem(listing.itemId)) {
        throw new HttpError(409, 'listing custody is inconsistent — refresh');
      }
      const buyerContext = requireStableBaseMutationContext(buyerBaseContext);
      const sellerContext: StableBaseMutationContext = {
        baseId: listing.baseId,
        assertAuthority: buyerContext.assertAuthority,
      };
      // Every source/destination deed is locked and checked at the commitment
      // boundary. Sorting by stable UUID prevents opposite-direction buys from
      // inverting base locks after the canonical participant-wallet locks.
      const baseParticipants = [
        { wallet: effectiveSeller, context: sellerContext },
        { wallet: buyer, context: buyerContext },
      ].sort((a, b) => a.context.baseId.localeCompare(b.context.baseId));
      for (const participant of baseParticipants) {
        await lockStablePrerequisiteBase(tx, participant.wallet, participant.context);
      }
    } else if (deps.authorizeLandMutation) {
      for (const wallet of participants) {
        try {
          await deps.authorizeLandMutation(tx, wallet);
        } catch (error) {
          if (wallet === effectiveSeller) {
            throw new HttpError(409, 'this listing is no longer available — the seller no longer owns land');
          }
          throw error;
        }
      }
    }

    // Per-buyer unresolved-reservation cap (anti-grief). A submitted and proven
    // payment remains committed until the row resolves, even after its long
    // settle timeout. Uncommitted rows count through their reclaim grace, not
    // merely the shorter advertised reservation TTL.
    const graceCutoff = new Date(now.getTime() - RECLAIM_GRACE_MS);
    const [cnt] = await tx.select({ n: sql<number>`count(*)::int` }).from(itemListings)
      .where(and(
        eq(itemListings.status, 'reserved'), eq(itemListings.reservedBy, buyer), ne(itemListings.id, listingId),
        or(
          isNotNull(itemListings.paymentSig),
          and(isNull(itemListings.paymentSig), gt(itemListings.reservedUntil, graceCutoff)),
        ),
      ));
    if ((cnt?.n ?? 0) >= MARKETPLACE.itemMarket.maxReservationsPerBuyer) {
      throw new HttpError(422, `you already have ${MARKETPLACE.itemMarket.maxReservationsPerBuyer} pending purchases — finish or let them lapse`);
    }

    const reference = bs58.encode(randomBytes(32));
    const reservedUntil = new Date(now.getTime() + RESERVE_TTL_MS);
    if (deps.cluster) {
      if (listing.reference) await tx.update(itemMarketReservations).set({ state: 'superseded', resolvedAt: now })
        .where(and(eq(itemMarketReservations.listingId, listing.id), eq(itemMarketReservations.reference, listing.reference)));
      const split = splitPrice(listing.priceLamports);
      await tx.insert(itemMarketReservations).values({ listingId: listing.id, buyerWallet: buyer,
        requestKey: request?.idempotencyKey ?? null, requestPayload: request ?? null, itemId: listing.itemId,
        sourceBaseId: listing.baseId, buyerBaseId: listing.baseId ? buyerBaseContext!.baseId : null,
        sellerWallet: effectiveSeller, cluster: deps.cluster, reference, priceLamports: listing.priceLamports,
        feeBps: MARKETPLACE.feeBps, ...split, feeTreasury: deps.feeTreasury!, createdAt: now, payableUntil: reservedUntil });
    }
    // Fresh reference + cleared paymentSig — a new buyer's payment must not be
    // confused with a prior (unpaid) reserver's committed signature.
    await tx.update(itemListings)
      .set({
        status: 'reserved', sellerWallet: effectiveSeller,
        reservedBy: buyer, reservedUntil, reference, paymentSig: null,
        buyerBaseId: listing.baseId ? buyerBaseContext!.baseId : null,
        reconcileAttemptedAt: null,
      })
      .where(eq(itemListings.id, listing.id));
    return reservePayload({
      ...listing,
      sellerWallet: effectiveSeller,
      buyerBaseId: listing.baseId ? buyerBaseContext!.baseId : null,
    }, deps.feeTreasury!, reference, reservedUntil);
  });
}

function reservePayload(l: Listing, feeTreasury: string, reference: string, reservedUntil: Date) {
  const { feeLamports, sellerLamports } = splitPrice(l.priceLamports);
  return {
    listingId: l.id, seller: l.sellerWallet, feeTreasury, reference,
    baseId: l.baseId, buyerBaseId: l.buyerBaseId,
    priceLamports: l.priceLamports.toString(),
    sellerLamports: sellerLamports.toString(),
    feeLamports: feeLamports.toString(),
    reservedUntil: reservedUntil.toISOString(),
  };
}

function recordedReservePayload(row: typeof itemMarketReservations.$inferSelect) {
  return { listingId: row.listingId, seller: row.sellerWallet, feeTreasury: row.feeTreasury, reference: row.reference,
    baseId: row.sourceBaseId, buyerBaseId: row.buyerBaseId, priceLamports: row.priceLamports.toString(),
    sellerLamports: row.sellerLamports.toString(), feeLamports: row.feeLamports.toString(), reservedUntil: row.payableUntil.toISOString() };
}

/**
 * Settle a reserved listing once the buyer's split payment finalizes. Verifies
 * BOTH legs on-chain (else no grant → the 5% is unskippable), then hands over
 * the item. The buyer who reserved can ALWAYS claim what they paid for — settle
 * is NOT blocked by reservation expiry (only a genuine reopen by someone else
 * moves the listing on). Idempotent; a signature settles at most one listing.
 */
export async function settleListing(db: Db, deps: ItemMarketDeps, buyer: string, listingId: string, expectedReference?: string, expectedSignature?: string) {
  const [listing] = await db.select().from(itemListings).where(eq(itemListings.id, listingId));
  if (!listing) throw new HttpError(404, 'listing not found');
  if (expectedReference !== undefined && listing.reference !== expectedReference) throw new HttpError(409, 'reservation generation changed');
  if (expectedSignature !== undefined && (!isCanonicalSolanaSignature(expectedSignature)
    || (listing.paymentSig !== null && listing.paymentSig !== expectedSignature)
    || (listing.txSignature !== null && listing.txSignature !== expectedSignature))) throw new HttpError(409, 'payment signature differs from this reservation');
  if (listing.status === 'sold') {
    if (listing.buyerWallet !== buyer) throw new HttpError(422, 'listing already sold');
    invalidateWalletBalances(buyer);
    invalidateWalletBalances(listing.sellerWallet);
    return { settled: true, itemId: listing.itemId }; // idempotent
  }
  if (listing.status !== 'reserved' || listing.reservedBy !== buyer) throw new HttpError(422, 'reserve the listing first');
  if (!deps.verifyPayment) throw new HttpError(503, 'marketplace payments are not configured');
  const frozen = freezeReservation(listing);

  const { feeLamports, sellerLamports, feeTreasury, notBefore } = await paymentTerms(db, deps, listing);
  const paid = await deps.verifyPayment({
    reference: listing.reference!, buyer, seller: listing.sellerWallet, feeTreasury,
    sellerLamports, feeLamports, paymentSignature: listing.paymentSig ?? expectedSignature,
    notBefore,
  }).catch((error: unknown) => {
    // A just-broadcast payment can be confirmed before its finalized body is
    // available. Only settlement may wait here: cancellation/replacement keeps
    // propagating uncertainty and cannot release the item or issue a new quote.
    if (error instanceof PaymentProofUnavailableError) return null;
    throw error;
  });
  if (!paid) return { settled: false }; // not finalized yet — client keeps polling

  const result = await db.transaction(async (tx) => {
    const itemId = await finalizeSale(tx, frozen, paid.txSignature);
    if (itemId === null) {
      const [again] = await tx.select().from(itemListings).where(eq(itemListings.id, listingId));
      if (isExactSettledGeneration(again, frozen, paid.txSignature)) {
        return { settled: true, itemId: again!.itemId };
      }
      throw new HttpError(422, 'listing was just taken');
    }
    return { settled: true, itemId, txSignature: paid.txSignature };
  });
  // Native refreshes /wallet/balances immediately after this receipt. Do not
  // return its pre-payment 30-second cache as the buyer's refreshed balance.
  invalidateWalletBalances(buyer);
  invalidateWalletBalances(listing.sellerWallet);
  return result;
}

/**
 * The buyer registers the payment signature they just broadcast (safeguard).
 * From this point the reservation is LOCKED to them — no reopen can steal a
 * listing they've paid for, even if finalization lags. The exact transaction is
 * proven at confirmed before pinning and proven again at finalized to settle.
 */
export async function submitPayment(
  db: Db, deps: ItemMarketDeps, buyer: string, listingId: string, signature: string, now = new Date(),
  expectedReference?: string,
) {
  if (!isCanonicalSolanaSignature(signature)) {
    throw new HttpError(422, 'invalid Solana transaction signature');
  }

  // Snapshot the immutable quote before RPC. The proof is intentionally outside
  // the database transaction; the locked phase below binds every quoted field
  // again before paymentSig changes reclaim semantics.
  const [quoted] = await db.select().from(itemListings).where(eq(itemListings.id, listingId));
  if (!quoted) throw new HttpError(404, 'listing not found');
  if (expectedReference !== undefined && quoted.reference !== expectedReference) throw new HttpError(409, 'reservation generation changed');
  if (quoted.status === 'sold' && quoted.buyerWallet === buyer) {
    if (quoted.paymentSig === signature || quoted.txSignature === signature) return { committed: true };
    throw new HttpError(409, 'this listing is already bound to another payment signature');
  }
  if (quoted.status !== 'reserved' || quoted.reservedBy !== buyer || !quoted.reference) {
    throw new HttpError(422, 'reserve the listing first (or it already resolved)');
  }
  if (quoted.paymentSig) {
    if (quoted.paymentSig === signature) return { committed: true };
    throw new HttpError(409, 'this listing is already bound to another payment signature');
  }
  const frozen = freezeReservation(quoted);
  if (!deps.verifyPaymentCommit) {
    throw new HttpError(503, 'marketplace payment confirmation is not configured');
  }
  // Once the uncommitted grace lapses, another buyer may legitimately take the
  // listing. A late submit cannot silently convert that takeable row into a long
  // lock; finalized settlement/reclaim scanning remains the money-honouring path.
  if (isReclaimable(quoted, now)) throw new HttpError(422, 'payment commitment arrived after the reservation grace');

  const { feeLamports, sellerLamports, feeTreasury } = await paymentTerms(db, deps, quoted);
  const proof = await deps.verifyPaymentCommit({
    reference: quoted.reference,
    buyer,
    seller: quoted.sellerWallet,
    feeTreasury,
    sellerLamports,
    feeLamports,
    paymentSignature: signature,
  });
  if (!proof || proof.txSignature !== signature) {
    throw new HttpError(422, 'payment signature is not a confirmed exact marketplace split');
  }

  return db.transaction(async (tx) => {
    // Same root as reserveListing: one buyer cannot commit two listings around
    // the unresolved cap or race a changing reservation snapshot.
    const [buyerPlayer] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, buyer)).for('update');
    if (!buyerPlayer) throw new HttpError(404, 'player not found');

    // payment_sig has no historical unique constraint, so both commit and
    // settlement serialize and check the two signature columns together.
    await lockUnusedPaymentSignature(tx, listingId, signature, frozen.reference);

    const [listing] = await tx.select().from(itemListings)
      .where(eq(itemListings.id, listingId)).for('update');
    if (!listing || listing.status !== 'reserved' || listing.reservedBy !== buyer || !listing.reference) {
      throw new HttpError(422, 'reserve the listing first (or it already resolved)');
    }
    if (listing.paymentSig) {
      if (listing.paymentSig === signature) return { committed: true };
      throw new HttpError(409, 'this listing is already bound to another payment signature');
    }
    if (isReclaimable(listing, now)) {
      throw new HttpError(422, 'payment commitment arrived after the reservation grace');
    }
    if (!sameReservationGeneration(listing, frozen)) {
      throw new HttpError(409, 'listing terms changed while the payment was being confirmed');
    }
    const pinned = await tx.update(itemListings).set({ paymentSig: signature })
      .where(exactReservationPredicate(frozen)).returning({ id: itemListings.id });
    if (pinned.length === 0) {
      throw new HttpError(409, 'listing terms changed while the payment was being confirmed');
    }
    const record = await recordedReservation(tx, listing);
    if (record) {
      if (!sameQuote(record, listing) || record.state !== 'reserved') throw new HttpError(409, 'recorded reservation changed');
      await tx.update(itemMarketReservations).set({ state: 'committed', paymentSig: signature }).where(eq(itemMarketReservations.id, record.id));
    }
    return { committed: true };
  });
}

/** Browse buyable listings (active, or a reservation past its reclaim cutoff). */
/** Sort orders the browse UI offers. `floor` = cheapest first — the default,
 *  because that is the price a buyer actually pays. */
export type ListingSort = 'floor' | 'price_desc' | 'newest';

/**
 * The public book. Beyond the raw rows this returns a per-item SUMMARY —
 * floor price + listed count for every item type with an open listing — which is
 * what lets the client render a floor-price rail (and a seller price against the
 * floor) without pulling the whole book and aggregating client-side.
 *
 * `itemId` filters to one item type; `sort` orders the rows. Both are optional so
 * the un-parameterised call keeps working.
 */
export async function getListings(
  db: Db, now = new Date(), opts: { limit?: number; itemId?: string; sort?: ListingSort } = {},
) {
  // Retired keep-skins (M23 a8/D-054) are out of the public book: they cannot
  // be rendered, bought or re-reserved, so showing their leftover escrow rows
  // would only advertise dead inventory (security review 2026-08-15 finding 2).
  const openPredicate = and(
    or(eq(itemListings.status, 'active'), reclaimablePredicate(now)),
    notInArray(itemListings.itemId, Object.keys(REMOVED_SKIN_REFUNDS)),
  );
  const where = opts.itemId ? and(openPredicate, eq(itemListings.itemId, opts.itemId)) : openPredicate;
  const order = opts.sort === 'newest' ? desc(itemListings.createdAt)
    : opts.sort === 'price_desc' ? desc(itemListings.priceLamports)
      : asc(itemListings.priceLamports); // 'floor' (default)

  // The seller a buyer sees is the CURRENT deed owner for a base-sourced listing
  // (the wallet that gets paid), so the public name joins on that same wallet.
  const rows = await db.select({ listing: itemListings, currentBaseOwner: bases.ownerWallet, sellerName: players.name })
    .from(itemListings).leftJoin(bases, eq(bases.id, itemListings.baseId))
    .leftJoin(players, eq(players.wallet, sql`coalesce(${bases.ownerWallet}, ${itemListings.sellerWallet})`))
    .where(where)
    .orderBy(order)
    .limit(Math.min(opts.limit ?? 100, 200));

  // Floor + count per item type, over the WHOLE open book (never the filtered or
  // paginated slice — a floor that moved when you changed a filter would be a lie).
  const summaryRows = await db
    .select({
      itemId: itemListings.itemId,
      floorLamports: sql<string>`min(${itemListings.priceLamports})::text`,
      listed: sql<number>`count(*)::int`,
    })
    .from(itemListings).where(openPredicate)
    .groupBy(itemListings.itemId);

  return {
    feeBps: MARKETPLACE.feeBps,
    listings: rows.map(({ listing: r, currentBaseOwner, sellerName }) => {
      const seller = currentBaseOwner ?? r.sellerWallet;
      return {
        id: r.id, seller, baseId: r.baseId,
        itemId: r.itemId, priceLamports: r.priceLamports.toString(),
        createdAt: r.createdAt,
        // Tester ef22cdb7: buyers want to see WHO is selling. Same public identity
        // the leaderboard shows — the chosen display name, else the 4…4 wallet
        // (never a second copy of the full address). Additive for native clients.
        sellerName: sellerName ? sellerName : shortWallet(seller),
      };
    }),
    summary: summaryRows
      .map((s) => ({ itemId: s.itemId, floorLamports: s.floorLamports, listed: s.listed }))
      .sort((a, b) => (BigInt(a.floorLamports) < BigInt(b.floorLamports) ? -1 : 1)),
  };
}

/** The caller's own open listings (active or reserved) — to cancel. */
export async function getMyListings(db: Db, seller: string) {
  const rows = await db.select({
    id: itemListings.id,
    itemId: itemListings.itemId,
    baseId: itemListings.baseId,
    priceLamports: itemListings.priceLamports,
    status: itemListings.status,
    createdAt: itemListings.createdAt,
  }).from(itemListings)
    .leftJoin(bases, eq(bases.id, itemListings.baseId))
    .where(and(
      or(
        and(isNull(itemListings.baseId), eq(itemListings.sellerWallet, seller)),
        eq(bases.ownerWallet, seller),
      ),
      ne(itemListings.status, 'sold'), ne(itemListings.status, 'cancelled'),
    ))
    .orderBy(desc(itemListings.createdAt));
  return rows.map((r) => ({
    id: r.id, itemId: r.itemId, baseId: r.baseId,
    priceLamports: r.priceLamports.toString(), status: r.status,
  }));
}

/** Authenticated recovery discovery. Only the retained original buyer may see
 * these references; this read never reserves, verifies payment or grants items.
 * Keyed v1 purchases already have their durable journal recovery UI. */
export async function getPendingMarketPurchases(db: Db, buyer: string, after?: string) {
  const rows = await db.select().from(itemListings).where(and(
    eq(itemListings.status, 'reserved'), eq(itemListings.reservedBy, buyer),
    isNotNull(itemListings.reference), after ? gt(itemListings.id, after) : undefined,
    sql`not exists (select 1 from ${itemMarketReservations} r where r.listing_id = ${itemListings.id}
      and r.reference = ${itemListings.reference} and r.request_key is not null)`,
  )).orderBy(asc(itemListings.id)).limit(51);
  const page = rows.slice(0, 50);
  return { purchases: page.map((r) => ({ listingId: r.id, itemId: r.itemId,
    reference: r.reference!, priceLamports: r.priceLamports.toString(),
    buyerBaseId: r.buyerBaseId, reservedUntil: r.reservedUntil })),
    next: rows.length > 50 ? page[page.length - 1]!.id : null };
}

/** Completed trades belong to the wallets that actually bought/sold, never to
 * a later owner of either deed. No reconstructed pre-contract fee quote. */
export async function getMarketTradeHistory(db: Db, wallet: string) {
  const rows = await db.select().from(itemListings).where(and(
    eq(itemListings.status, 'sold'), isNotNull(itemListings.txSignature),
    or(eq(itemListings.sellerWallet, wallet), eq(itemListings.buyerWallet, wallet)),
  )).orderBy(desc(itemListings.settledAt), desc(itemListings.id)).limit(51);
  return { trades: rows.slice(0, 50).map((r) => ({ listingId: r.id, itemId: r.itemId,
    role: r.buyerWallet === wallet ? 'bought' as const : 'sold' as const,
    priceLamports: r.priceLamports.toString(), buyerBaseId: r.buyerBaseId,
    txSignature: r.txSignature!, settledAt: r.settledAt })), hasMore: rows.length > 50 };
}
