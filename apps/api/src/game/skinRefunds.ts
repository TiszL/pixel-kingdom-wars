/**
 * D-009 refund sweep for the three RETIRED keep-skin cosmetics (owner
 * 2026-08-15, M23 a8: "completely remove base skins from game").
 *
 * MONEY PATH. Purchases recycled KEEP into emission_pool, so the refund is the
 * exact inverse posting: `skin.refund` moves qty × original price from
 * emission_pool back to player_keep, per owned copy, through the ledger's
 * double-entry engine. The idempotency key is PER PHYSICAL ROW —
 * `skin.refund:<wallet>:<itemId>:<player_items.id>` — because the ledger post
 * and the row delete commit in ONE transaction (a crash rolls back both, so
 * "paid but not consumed" cannot exist). A row that ENTERS player_items after
 * a sweep — a cancelled escrow unit returning to its seller, or a mid-sale
 * settle granting the skin to its buyer — is a genuinely distinct copy that no
 * prior posting covered: it gets a fresh row id, hence a fresh key, hence its
 * own refund. Keying by wallet+item alone would consume such a copy with NO
 * credit (security review 2026-08-15 finding 1 — a D-009 violation).
 *
 *   - row gone                      → nothing selected, no double refund;
 *   - same row re-run (any crash)   → the whole prior tx rolled back, key is
 *                                     unused, refund posts exactly once;
 *   - a reserved mid-sale listing resolves AFTER a run → the resulting owner's
 *     NEW row is refunded by the NEXT run (worker boot).
 *
 * Custody rules honoured before any money moves: an ACTIVE listing of a skin
 * is cancelled through the market's own unwind (returning the held unit to the
 * seller) so the refund covers it; a RESERVED one is a possible in-flight SOL
 * sale and is SKIPPED loudly — it settles or expires, and the next sweep
 * catches the resulting owner.
 *
 * Deliberately NO schema migration: players.keep_skin and
 * base_profiles.keep_skin stay as dead columns (additive discipline). This
 * sweep NULLs players.keep_skin; base_profiles.keep_skin has been all-NULL
 * since 0077. The 0077 fence functions still name the retired ids — dead but
 * load-bearing references for historical rows; do not edit migrations.
 *
 * Mail is best-effort info only (MAIL_DELIVERY_ENABLED=false must never block
 * the ledger refund), and the KEEP moves through the ledger — never through
 * the emission_pool-funded mail-reward lane.
 */
import { REMOVED_SKIN_REFUNDS, type RemovedSkinId } from '@shardkeep/shared';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { itemListings, playerItems, players } from '../db/schema';
import { deliverSystemMail } from '../mail';
import { cancelListing } from './itemMarket';
import { grantGems } from './gemsGrants';

const REMOVED_IDS = Object.keys(REMOVED_SKIN_REFUNDS) as RemovedSkinId[];

/** Display copy for the refund mail (the catalog entries no longer exist). */
const REMOVED_SKIN_NAMES: Record<RemovedSkinId, string> = {
  skin_keep_gilded: 'GILDED KEEP',
  skin_keep_frost: 'FROST KEEP',
  skin_keep_voidstone: 'VOIDSTONE KEEP',
};

function isRemovedSkinId(id: string): id is RemovedSkinId {
  return Object.prototype.hasOwnProperty.call(REMOVED_SKIN_REFUNDS, id);
}

export interface SkinRefundSweepResult {
  /** Wallet×item positions credited by THIS run (duplicates re-runs excluded). */
  refunded: number;
  /** Info mails delivered (≤ refunded; mail is best-effort). */
  mailed: number;
  /** Open reserved (mid-sale) listings left for a later run. */
  skippedReserved: number;
}

/** Idempotent worker-boot sweep. Never throws per-row problems into the boot
 * path: each wallet's refund is its own transaction, and a failed row is
 * logged loudly and retried on the next run. */
export async function refundRemovedSkins(db: Db, now = new Date()): Promise<SkinRefundSweepResult> {
  const result: SkinRefundSweepResult = { refunded: 0, mailed: 0, skippedReserved: 0 };

  // 1. Unwind open listings FIRST, so a held unit rejoins player_items and the
  //    refund below covers it. Cosmetics were wallet custody (baseId NULL).
  const open = await db.select().from(itemListings).where(and(
    inArray(itemListings.itemId, REMOVED_IDS),
    notInArray(itemListings.status, ['sold', 'cancelled']),
  ));
  for (const listing of open) {
    if (listing.status === 'reserved') {
      // A buyer may have SOL in flight. The seller must never reclaim a paid
      // item, and this sweep has no payment verifier — leave it to the market
      // lifecycle (settle/expire); the next boot sweep refunds the outcome.
      result.skippedReserved++;
      console.error(
        `[skin-refund] SKIPPING reserved listing ${listing.id} (${listing.itemId}, seller `
        + `${listing.sellerWallet}) — mid-sale; it settles or lapses, next sweep catches it`,
      );
      continue;
    }
    if (listing.status !== 'active' || listing.baseId !== null) {
      // Base-custody or unknown-state skin listings should not exist (the
      // market fences threw on them). Surface, do not guess.
      console.error(
        `[skin-refund] ANOMALOUS skin listing ${listing.id} (status=${listing.status}, `
        + `baseId=${listing.baseId}) — left untouched; investigate`,
      );
      continue;
    }
    try {
      // HARD invariant: only ACTIVE rows may reach the empty-deps cancel.
      // cancelListing with no verifyPayment would let settlePaidExpired
      // short-circuit and reclaim a PAID buyer's item if a reserved row ever
      // slipped through (security review 2026-08-15 finding 3). The status
      // checks above guarantee this, and this guard makes a future refactor
      // fail loudly instead of silently stealing a purchase.
      if (listing.status !== 'active') throw new Error(`non-active listing ${listing.id} reached empty-deps cancel`);
      await cancelListing(db, {}, listing.sellerWallet, listing.id, now);
      console.log(`[skin-refund] cancelled active listing ${listing.id} (${listing.itemId}) → unit returned to ${listing.sellerWallet}`);
    } catch (e) {
      console.error(`[skin-refund] FAILED to cancel listing ${listing.id} — its unit stays escrowed until the next run:`, e);
    }
  }

  // 2. Refund and consume every owned copy, one wallet×item per transaction.
  const owned = await db.select({ playerWallet: playerItems.playerWallet, itemId: playerItems.itemId })
    .from(playerItems).where(inArray(playerItems.itemId, REMOVED_IDS));
  for (const row of owned) {
    if (!isRemovedSkinId(row.itemId)) continue; // unreachable given the WHERE; type guard
    const itemId = row.itemId;
    const wallet = row.playerWallet;
    const priceKeep = REMOVED_SKIN_REFUNDS[itemId];
    let credited: bigint | null = null;
    // The consumed row's id, for the per-row mail dedupe key below. Written
    // inside the transaction; only read after it commits with a credit.
    let refundedRowId: string | null = null;
    try {
      credited = await db.transaction(async (tx) => {
        // Player lock first — the same root order buy/list/equip use — so this
        // cannot deadlock against a concurrent inventory mutation.
        const [player] = await tx.select({ wallet: players.wallet }).from(players)
          .where(eq(players.wallet, wallet)).for('update');
        if (!player) return null;
        const [current] = await tx.select({ id: playerItems.id, qty: playerItems.qty })
          .from(playerItems)
          .where(and(eq(playerItems.playerWallet, wallet), eq(playerItems.itemId, itemId)))
          .for('update');
        if (!current) return null; // raced away since the outer SELECT
        refundedRowId = current.id;
        let amount = 0n;
        if (current.qty > 0) {
          // D-152: historical refunds are Gems grants (`grant:refund:<rowId>`),
          // minted against the reward budget. Zero rows are expected today
          // (pinned by skin-refunds.test.ts); a refund that ever runs is
          // backed KEEP-for-Gem like every grant.
          const posted = await grantGems(tx, {
            wallet,
            gems: BigInt(current.qty) * BigInt(priceKeep),
            reason: 'refund',
            // PER-ROW key (see header): a copy re-entering the inventory after
            // an escrow return or mid-sale settle has a new row id and MUST be
            // refunded as its own position, never swallowed as a "duplicate".
            ref: `skin.refund:${wallet}:${itemId}:${current.id}`,
            metadata: { itemId, qty: current.qty, refundKeepPerUnit: priceKeep, playerItemsRowId: current.id, reason: 'M23 a8 keep-skin removal (D-009)' },
          });
          if (posted.duplicate) {
            // Structurally unreachable: the post and the delete commit in one
            // transaction, so a row that still exists cannot carry an already-
            // posted key. Defensive rail only — if it EVER fires, something
            // rewrote ledger keys or resurrected a deleted row id; do not
            // credit twice, but scream.
            console.error(
              `[skin-refund] IMPOSSIBLE duplicate for ledger key skin.refund:${wallet}:${itemId}:${current.id} `
              + '— row consumed without a second credit; investigate the ledger history for this key',
            );
          } else {
            amount = BigInt(current.qty) * BigInt(priceKeep);
          }
        }
        // qty-0 rows are dead discovery markers for a retired item — consume too.
        await tx.delete(playerItems).where(eq(playerItems.id, current.id));
        await tx.update(players).set({ keepSkin: null })
          .where(and(eq(players.wallet, wallet), eq(players.keepSkin, itemId)));
        return amount;
      });
    } catch (e) {
      console.error(`[skin-refund] FAILED refund for ${wallet}/${itemId} — refund is OWED; the next sweep retries:`, e);
      continue;
    }
    if (credited === null || credited === 0n) continue;
    result.refunded++;
    console.log(`[skin-refund] refunded ${credited} KEEP to ${wallet} for ${itemId}`);
    // 3. Best-effort info mail. MAIL_DELIVERY_ENABLED=false (or any mail
    //    failure) must never block or roll back the ledger refund above.
    try {
      await deliverSystemMail(db, {
        recipientWallet: wallet,
        // Mirrors the ledger's per-row key so a SECOND legitimate refund (an
        // escrow copy returning later) also gets its own mail instead of being
        // deduped against the first.
        deliveryKey: `skin.refund:${wallet}:${itemId}:${refundedRowId}`,
        subject: 'BASE SKINS RETIRED — PURCHASE REFUNDED',
        body: `Keep skins have been retired from Pixel Kingdom Wars. Your ${REMOVED_SKIN_NAMES[itemId]} `
          + `has been removed from your inventory and its full purchase price — ${credited} KEEP — `
          + 'has already been returned to your balance. Money moved is money honoured.',
      }, now);
      result.mailed++;
    } catch (e) {
      console.warn(`[skin-refund] info mail not delivered to ${wallet} (refund itself is complete):`, e);
    }
  }

  // 4. Stray equipped pointers with no matching inventory row (e.g. the only
  //    copy is escrowed in a reserved listing). The renderer stopped reading
  //    this in M22 and the equip surface is gone, so NULLing is safe.
  await db.update(players).set({ keepSkin: null })
    .where(inArray(players.keepSkin, REMOVED_IDS));

  return result;
}
