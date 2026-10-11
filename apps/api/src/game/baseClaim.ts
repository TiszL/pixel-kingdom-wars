/**
 * PULL-BASED base claim — the apply mechanism for sellable deeds
 * (CLANS-SELLABLE-DEEDS-PLAN S1-Q, decided by the owner 2026-07-29: "deed nfts
 * should be tradeable and should have royalty fee"; the 5% royalty already
 * lives on the deed collection and on each asset — marketplace-honoured, NOT
 * enforced on chain (ruleSet None) — nothing on-chain changes here).
 *
 * THE HAZARD this closes: once deeds thaw, a deed can change hands on Tensor /
 * Magic Eden while the base stays keyed to the SELLER's wallet server-side. If
 * nothing applies the transfer, the buyer owns an NFT that conveys NOTHING.
 *
 * WHY PULL, not the S1 watcher (security review verdict "do not ship the
 * watcher as wired"): the buyer asks, and the server re-reads chain truth AT
 * THAT MOMENT for exactly the asset it is about to act on. There is no stored
 * observation to go stale, no indexer-lag window, and an escrowed (frozen /
 * delegated / PDA-owned) deed simply isn't claimable yet instead of locking the
 * seller out. `sweepDeedTransfers` stays unwired; `transferBase` — already
 * hardened and tested — does the move, unchanged.
 *
 * TRUST BOUNDARY: the client supplies NOTHING. The claimant is the session
 * wallet; the deed and the seller are derived from DAS + server truth. A body
 * on POST /base/claim is ignored by construction.
 */
import { and, inArray, ne } from 'drizzle-orm';
import {
  getFinalizedCoreAssetOwner, getOwnedCoreAssets, type FinalizedAssetOwnership, type GameSolanaCluster,
} from '@shardkeep/chain';
import { MARKETPLACE } from '@shardkeep/shared';
import type { Db } from '../db/client';
import { bases, players } from '../db/schema';
import { multiBaseEnabled } from '../config';
import { ownershipEligible, transferBase, type OwnershipReader } from './baseTransfer';
import { markDeedDirty } from './deedMetadata';
import { observeDeedOwnership, transferStableBase } from './baseOwnership';

/** Chain reads the claim path needs. Prod builds these from Helius DAS; tests
 *  inject fakes (the same seam `sweepDeedTransfers` uses for `ownerOf`). */
export interface DeedReaders {
  /** Core asset ids in the deed collection currently owned by `wallet` — ONE
   *  DAS search, used only to narrow candidates. Never trusted on its own. */
  ownedDeeds: (wallet: string) => Promise<string[]>;
  /** Authoritative per-asset read (owner + frozen + delegate + collection).
   *  This — not the search above — is what a claim is decided on. */
  ownerOf: OwnershipReader;
  /** Deed collection every candidate must belong to. */
  collection: string | null;
}

/** Real readers, or null when DAS/collection config is missing — in which case
 *  claiming is simply unavailable (fail closed: we never transfer a base on an
 *  unverifiable read). */
export function makeDeedReaders(
  deps: {
    heliusApiKey?: string | undefined;
    rpcUrl?: string | undefined;
    deedCollection?: string | undefined;
    cluster?: GameSolanaCluster | undefined;
  },
): DeedReaders | null {
  const { heliusApiKey, rpcUrl, deedCollection, cluster = 'devnet' } = deps;
  if (!heliusApiKey || !rpcUrl || !deedCollection) return null;
  return {
    ownedDeeds: async (wallet) => (await getOwnedCoreAssets({
      heliusApiKey, owner: wallet, collection: deedCollection, cluster,
    })).map((a) => a.id),
    // DAS narrows the candidate set only. The decision reads the Core asset
    // account itself at finalized commitment and pins its collection.
    ownerOf: (assetId) => getFinalizedCoreAssetOwner({
      rpcUrl, assetId, expectedCollection: deedCollection,
    }),
    collection: deedCollection,
  };
}

/**
 * `none` — this wallet holds no deed whose base belongs to someone else.
 * `not_transferable` — it holds such a deed, but the on-chain read says it is
 *   frozen / delegated / escrowed (or DAS disagrees about the owner): a listing
 *   in escrow is NOT a completed sale, so it must not move a base.
 * `unavailable` — DAS isn't configured; claiming is off, nothing was inspected.
 */
export type ClaimReason = 'ok' | 'none' | 'not_transferable' | 'unavailable';

export interface ClaimableBase {
  deedAssetId: string;
  /** Current server-side holder — the seller the base moves off of. */
  sellerWallet: string;
  /** Stable identity when the additive multi-base model is enabled. */
  baseId?: string;
}

/** Read-only: is there a base this wallet's deed entitles it to claim? */
export async function findClaimableBase(
  db: Db, readers: DeedReaders | null, wallet: string,
): Promise<{ claimable: ClaimableBase | null; reason: ClaimReason }> {
  if (!readers) return { claimable: null, reason: 'unavailable' };
  const owned = (await readers.ownedDeeds(wallet)).slice(0, MARKETPLACE.claim.maxCandidates);
  if (owned.length === 0) return { claimable: null, reason: 'none' };

  // Candidates = deeds this wallet appears to hold that are STILL registered to
  // a different player. A deed already registered to the claimant is excluded
  // here — that is what makes a repeat claim a no-op rather than an error.
  const rows = multiBaseEnabled()
    ? await db.select({ wallet: bases.ownerWallet, deed: bases.deedAssetId, baseId: bases.id })
      .from(bases)
      .where(and(inArray(bases.deedAssetId, owned), ne(bases.ownerWallet, wallet)))
      .orderBy(bases.ownerWallet, bases.id).limit(MARKETPLACE.claim.maxCandidates)
    : (await db.select({ wallet: players.wallet, deed: players.deedAssetId })
      .from(players)
      .where(and(inArray(players.deedAssetId, owned), ne(players.wallet, wallet)))
      .orderBy(players.wallet).limit(MARKETPLACE.claim.maxCandidates))
      .map((r) => ({ ...r, baseId: undefined }));
  if (rows.length === 0) return { claimable: null, reason: 'none' };

  let ineligible = false;
  for (const r of rows) {
    const deed = r.deed!;
    const o = await readers.ownerOf(deed);
    // Unreadable/burnt, or the search lied about the owner (stale index, or a
    // client-independent mismatch) → never act. Only an asset whose
    // authoritative owner IS the claimant may convey a base.
    if (!o || o.owner !== wallet) { ineligible = true; continue; }
    // Review #3 guards, unchanged: frozen (still soulbound), delegated or
    // escrow-PDA-owned deeds are "not a sale yet", and the collection is pinned.
    if (!ownershipEligible(o, readers.collection)) { ineligible = true; continue; }
    return {
      claimable: {
        deedAssetId: deed, sellerWallet: r.wallet,
        ...(r.baseId ? { baseId: r.baseId } : {}),
      },
      reason: 'ok',
    };
  }
  return { claimable: null, reason: ineligible ? 'not_transferable' : 'none' };
}

/**
 * Apply it. Idempotent by state: after a successful claim the deed is
 * registered to the claimant, so a second call finds nothing and answers
 * `{ claimed: false, reason: 'none' }` — never a second transfer, never a
 * second audit row. `transferBase` still owns every invariant (deed pinned to
 * the asset we just verified, buyer must be baseless, currency stays with the
 * seller); its rejections surface as-is.
 */
export async function claimBase(
  db: Db, readers: DeedReaders | null, wallet: string,
  clock: () => Date = () => new Date(),
): Promise<{ claimed: boolean; reason: ClaimReason; deedAssetId?: string }> {
  const found = await findClaimableBase(db, readers, wallet);
  if (!found.claimable) return { claimed: false, reason: found.reason };
  const { deedAssetId, sellerWallet, baseId } = found.claimable;
  if (multiBaseEnabled() && baseId) {
    // Every stable transfer carries the exact finalized slot into the locked
    // ownership fence. A stale web claim must not undo a newer native claim or
    // observer result, including ordinary bases without a fantasy location.
    const proof = await readers?.ownerOf(deedAssetId);
    const observedAtMs = clock().getTime();
    if (!proof || proof.owner !== wallet || !ownershipEligible(proof, readers?.collection ?? null)
      || !('slot' in proof) || !Number.isSafeInteger(proof.slot) || Number(proof.slot) < 0) {
      return { claimed: false, reason: 'not_transferable' };
    }
    const observed = observeDeedOwnership(proof as FinalizedAssetOwnership, observedAtMs);
    await transferStableBase(db, baseId, sellerWallet, wallet, deedAssetId, observed, clock);
  }
  else await transferBase(db, sellerWallet, wallet, deedAssetId);
  // The published document now describes the WRONG base (F2): republish it for
  // its new holder on the next R2 sweep instead of waiting for a trait to move.
  markDeedDirty(deedAssetId);
  console.log(`[base-claim] ${deedAssetId}: base claimed ${sellerWallet} → ${wallet}`);
  return { claimed: true, reason: 'ok', deedAssetId };
}
