/**
 * Sellable bases — the server half (CLANS-SELLABLE-DEEDS-PLAN S1/S2, built
 * 2026-07-27; hardened same night per the program-security review, verdict
 * "do not ship the watcher as wired" → every minimum fix applied and the
 * watcher REMOVED from boot: whether transfers apply push-based (watcher +
 * N-sweep confirmation) or pull-based (the buyer claims on sign-in, which the
 * reviewer pushes for) is an OWNER decision queued for morning [S1-Q]).
 *
 * THE INVARIANT (deed contract §8/§9): a deed conveys STRUCTURES / PROGRESS /
 * LAND — never currency. transferBase touches NO ledger account: KEEP, shards,
 * SOL credit, items, army, trophies, league, quests, streaks and clan
 * membership all stay with the seller. Mutation-tested.
 *
 * Handover policy (plan Q-S1/Q-S2 conservative defaults, pending sign-off):
 *  - the BUYER must be baseless — a deed listing is how a NEW player buys a
 *    started base; otherwise the transfer PARKS and retries;
 *  - the SELLER resets to fresh unpaid state, keeping every balance;
 *  - NOTHING of value is destroyed (review #4/#5): due jobs complete first,
 *    pending jobs move with the base (a half-built structure stays half-built
 *    for the buyer — never silently completed, never silently refund-lost),
 *    and shields move with the base they protect (incl. the 10-SOL warzone
 *    shield).
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { PublicKey } from '@solana/web3.js';
import type { AssetOwnership } from '@shardkeep/chain';
import type { Db } from '../db/client';
import { baseAbandons, baseTransfers, buildings, builderJobs, obstacles, players, plots, shields } from '../db/schema';
import { CAPS } from '@shardkeep/shared';
import { HttpError } from '../lib/errors';
import { completeDueJobs } from './base';
import { reanchorMineAccrual } from './emission';
import { assertLegacyHarvesterBoundarySafe } from './harvesterSettlement';

/**
 * Atomically hand the base from `from` to `to`. Both player rows FOR UPDATE in
 * deterministic order. `expectDeed` (review #1) pins the transfer to the deed
 * the caller OBSERVED — a stale sweep row from before a re-mint can never move
 * the seller's NEW base on the strength of an observation about the old asset.
 */
export async function transferBase(db: Db, from: string, to: string, expectDeed: string): Promise<{
  buildings: number; obstacles: number; plot: boolean; jobsMoved: number; shieldsMoved: number;
}> {
  if (from === to) throw new HttpError(422, 'transfer to self is a no-op');
  const now = new Date();
  return db.transaction(async (tx) => {
    // Buyer row may not exist yet (a wallet that bought a deed before ever
    // logging in) — the wallet IS the identity, so create it here.
    await tx.insert(players).values({ wallet: to }).onConflictDoNothing();
    const locked = await tx.select().from(players)
      .where(inArray(players.wallet, [from, to]))
      .orderBy(players.wallet) // deterministic lock order — no ABBA deadlock
      .for('update');
    const seller = locked.find((p) => p.wallet === from);
    const buyer = locked.find((p) => p.wallet === to);
    if (!seller) throw new HttpError(404, 'seller not found');
    // Review #1: the deed must STILL be the one the caller observed. `holds no
    // deed` covers replays; the equality covers the stale-row/new-deed race.
    if (!seller.deedAssetId) throw new HttpError(422, 'seller holds no deed (already transferred?)');
    if (seller.deedAssetId !== expectDeed) {
      throw new HttpError(409, 'deed changed since observation — re-observe before transferring');
    }
    await assertLegacyHarvesterBoundarySafe(tx, [from, to]);

    /**
     * Q-S1: the buyer must be BASELESS. Never merge, and never overwrite.
     *
     * TWO REFUSALS, NOT ONE (2026-08-09, free onboarding — plan risk R4). This
     * used to be a single condition, `entryPaidAt || buildings > 0`, and free
     * onboarding makes the second clause true for EVERY free builder: the exact
     * population that buys a started base could no longer claim one. The naive
     * fix — dropping the buildings check — is worse than the bug: transferBase
     * re-points the seller's buildings/obstacles/jobs onto the buyer's wallet
     * WITHOUT deleting the buyer's own rows, so a free base would be silently
     * merged into the purchased one (two Keeps, overlapping footprints), and the
     * player's own work would be destroyed by an action they took to gain a base.
     *
     * So the two cases are separated, because they mean different things and the
     * client can only act on one of them:
     *  - ALREADY A LANDOWNER (`entryPaidAt`) — terminal. One wallet = one parcel,
     *    enforced on chain (`pay_entry` uses Anchor `init`); there is nothing to
     *    do but sell/transfer the deed to a different wallet. Machine code
     *    BUYER_OWNS_LAND.
     *  - A FREE BASE IN THE WAY (buildings but no land) — RECOVERABLE. The player
     *    must explicitly abandon it first (abandonFreeBase below, behind a typed
     *    confirmation on POST /base/abandon), and only then does the claim apply.
     *    Machine code BUYER_HAS_FREE_BASE. Never abandoned implicitly here: that
     *    would put the decision to destroy a base inside a money path.
     *
     * Both stay 422 with the same "transfer parked" semantics for the deed sweep,
     * which catches the throw and retries next pass (sweepDeedTransfers) — so a
     * player who abandons later still gets the base they bought.
     */
    const buyerBuildings = await tx.select({ n: sql<number>`count(*)::int` }).from(buildings)
      .where(eq(buildings.playerWallet, to));
    if (buyer?.entryPaidAt) {
      throw new HttpError(422, 'buyer already owns land — transfer parked', 'BUYER_OWNS_LAND');
    }
    if ((buyerBuildings[0]?.n ?? 0) > 0) {
      throw new HttpError(
        422,
        'buyer already has a base — abandon it before claiming this one',
        'BUYER_HAS_FREE_BASE',
      );
    }

    // Review #5: complete everything ALREADY DUE first (paid-and-waited work
    // lands for the seller's account state: upgrades bump levels, clears pay).
    await completeDueJobs(tx, from, now);

    // SETTLE THE MINE CLOCK ON BOTH SIDES BEFORE THE BASE MOVES (security
    // review 2026-07-29 F1 — a proved ledger over-credit). mine_state is keyed
    // by WALLET and accrues lazily: accrue() applies the CURRENT quota across
    // the whole elapsed window. Claiming a base lifts the buyer's quota from 0
    // to the acquired base's in an instant, so a stale anchor mints shards from
    // shard_genesis for a period they did not own the mine (measured: 5,722
    // shards on a Keep-6 base with a 5-day-old anchor, repeatable per claim).
    // The mirror is a silent SELLER LOSS: their quota drops to 0, so unsettled
    // accrual earned before the sale evaporates — on a path whose whole promise
    // is that the seller keeps every balance. Re-anchoring both banks the
    // seller at their real pre-move quota and advances the buyer's clock at
    // quota 0, which is exactly what reanchorMineAccrual exists for.
    await reanchorMineAccrual(tx, from, now);
    await reanchorMineAccrual(tx, to, now);

    // THE MOVE: structures, obstacles, land — and the in-flight state WITH them
    // (review #4/#5): pending jobs re-point to the buyer, so an under-
    // construction building STAYS under construction (deleting the job was an
    // instant-completion exploit); shields re-point because they protect the
    // BASE (destroying a 10-SOL warzone shield on transfer burned real money).
    //
    // THE OBSTACLE MOVE TAKES TOMBSTONES WITH IT, deliberately (the buyer must not
    // inherit terrain that has already been cleared as standing rock), and that is
    // exactly why `ensureStartingBase` cannot key its once-per-wallet terrain guard
    // on obstacle rows alone: this statement leaves the SELLER with none. The audit
    // row written below (`base_transfers.from_wallet`) is the permanent trace it
    // reads instead — security review 2026-08-09 F5. If that row ever stops being
    // written, a base sale becomes a repeatable +5-shards-per-clear faucet again.
    const movedB = await tx.update(buildings).set({ playerWallet: to })
      .where(eq(buildings.playerWallet, from)).returning({ id: buildings.id });
    const movedO = await tx.update(obstacles).set({ playerWallet: to })
      .where(eq(obstacles.playerWallet, from)).returning({ id: obstacles.id });
    const movedP = await tx.update(plots).set({ playerWallet: to })
      .where(eq(plots.playerWallet, from)).returning({ playerWallet: plots.playerWallet });
    const movedJ = await tx.update(builderJobs).set({ playerWallet: to })
      .where(and(eq(builderJobs.playerWallet, from), isNull(builderJobs.completedAt)))
      .returning({ id: builderJobs.id });
    const movedS = await tx.update(shields).set({ playerWallet: to })
      .where(eq(shields.playerWallet, from)).returning({ id: shields.id });

    // Seller resets FIRST (Q-S2 default: fresh unpaid shell, balances intact) —
    // order matters: players_deed_asset_uq forbids two holders even for one
    // statement, so the deed must leave the seller before it lands on the buyer.
    await tx.update(players).set({
      keepLevel: 1,
      expansions: 0,
      // F3: builders are BASE CAPACITY bought with SOL, exactly like expansions
      // — and builderJobs already move with the base, so leaving the cap behind
      // let a 1-builder buyer hold 3 concurrent jobs while the seller kept the
      // slots they sold. Conveys with the base; the seller resets to the base
      // allotment.
      builders: 1,
      deedAssetId: null,
      entryPaidAt: null,
    }).where(eq(players.wallet, from));

    // PROGRESS the deed conveys. Trophies/league/streaks deliberately stay.
    await tx.update(players).set({
      keepLevel: seller.keepLevel,
      expansions: seller.expansions,
      builders: Math.min(seller.builders, CAPS.buildersMax),
      deedAssetId: seller.deedAssetId,
      entryPaidAt: seller.entryPaidAt ?? now,
    }).where(eq(players.wallet, to));

    // Review #2b: the audit row makes a bad transfer reconstructible — full
    // prior state, same tx, append-only.
    await tx.insert(baseTransfers).values({
      deedAssetId: expectDeed,
      fromWallet: from,
      toWallet: to,
      priorKeepLevel: seller.keepLevel,
      priorExpansions: seller.expansions,
      priorEntryPaidAt: seller.entryPaidAt,
      buildingsMoved: movedB.length,
      jobsMoved: movedJ.length,
      shieldsMoved: movedS.length,
    });

    return {
      buildings: movedB.length, obstacles: movedO.length, plot: movedP.length > 0,
      jobsMoved: movedJ.length, shieldsMoved: movedS.length,
    };
  });
}

/**
 * ABANDON A FREE BASE so a purchased one can be claimed (plan risk R4's other
 * half). The explicit step transferBase refuses to take implicitly.
 *
 * REFUSES A BASE WITH LAND, three ways, because the whole point is that this can
 * only ever destroy work that was free:
 *  - `entryPaidAt` set → 422. A landowner's base is what their deed conveys;
 *    deleting it would destroy an asset someone may already have bought.
 *  - a `plots` row → 422. No land ⇒ no plot, so a plot means either land or a
 *    state this function must not guess about.
 *  - a live deed (`deedAssetId`) → 422, belt and braces on the two above.
 *
 * WHAT IT DELETES: buildings and unfinished builder jobs — the base.
 * WHAT IT TOMBSTONES: obstacles (`clearedAt`), never deletes — see F5 below.
 * WHAT IT KEEPS: every ledger balance (§9: nothing of value is destroyed and no
 * currency moves), army, heroes, research, trophies, items, quests. The starter
 * grant's idempotency key survives too, so abandoning is not a 500-shard faucet.
 * The mine's accrual buffer is BANKED first, so it is not a 500-shard LOSS either.
 */
export async function abandonFreeBase(db: Db, wallet: string, now = new Date()): Promise<{
  buildings: number; obstacles: number; jobs: number;
}> {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(players).where(eq(players.wallet, wallet)).for('update');
    if (!p) throw new HttpError(404, 'player not found');
    if (p.entryPaidAt) throw new HttpError(422, 'you own this land — a landowner cannot abandon their base');
    if (p.deedAssetId) throw new HttpError(422, 'this base holds a Land Deed and cannot be abandoned');
    const plot = await tx.select({ x: plots.x }).from(plots).where(eq(plots.playerWallet, wallet));
    if (plot.length > 0) throw new HttpError(422, 'this base holds a parcel and cannot be abandoned');
    await assertLegacyHarvesterBoundarySafe(tx, [wallet]);

    // SETTLE THE MINE CLOCK BEFORE THE MINES GO (security review 2026-08-09 F12 —
    // the same omission the 2026-07-29 F1 review fixed for transferBase, 90 lines
    // above, and it must not be re-litigated a third time). mine_state is keyed by
    // WALLET, and `accrue` applies the CURRENT quota across the WHOLE elapsed
    // window. Deleting the mines drops this wallet's quota to 0, so without this
    // call: (a) everything accrued since the last collect is silently destroyed —
    // `accrue` returns the old buffer untouched when quota <= 0, so the elapsed
    // window is simply never banked; and (b) collectMine 422s on
    // "build a Mine first", so even the already-banked buffer becomes
    // uncollectable until they own a mine again. Both are silent player losses on
    // the path a player takes in order to GAIN a base. Re-anchoring banks them at
    // their real pre-abandon quota and advances the clock to now, so the post-
    // abandon quota-0 window credits nothing.
    await reanchorMineAccrual(tx, wallet, now);

    // Jobs first: builder_jobs references buildings, so deleting buildings while a
    // job points at one would trip the FK rather than clean up.
    const jobs = await tx.delete(builderJobs).where(eq(builderJobs.playerWallet, wallet))
      .returning({ id: builderJobs.id });
    const b = await tx.delete(buildings).where(eq(buildings.playerWallet, wallet))
      .returning({ id: buildings.id });

    /**
     * TOMBSTONE THE TERRAIN, NEVER DELETE IT (security review 2026-08-09 F5 — an
     * infinite shard faucet). Deleting these rows was the faucet: the generator in
     * `ensureStartingBase` is a pure function of the tile coordinates, the next
     * `GET /base` re-ran it because the Keep was gone, and the clear reward is
     * keyed on the JOB id — so the same tiles paid their +5 net again, with no
     * cooldown and no per-wallet cap. (Measured honestly: a plot is 189 obstacles,
     * 73 of them small, but `clearObstacle` only allows tiles INSIDE the claim and
     * the reset below puts `expansions` back to 0, so a repeat cycle reaches 4 tiles
     * — one small — for +5 a cycle rather than the +365 a whole-plot reading
     * suggests. Small and unbounded is still a faucet.) Tombstoning keeps one row
     * per tile forever,
     * which is both halves of the fix: the reward can never be earned twice for a
     * tile, and the surviving rows are what `ensureStartingBase` now keys its
     * once-per-wallet generation guard on.
     *
     * `clearedAt` is the EXISTING tombstone semantics ("cleared obstacles never
     * respawn", HANDOFF §3.9) and every reader already filters on
     * `clearedAt IS NULL`, so nothing renders, blocks placement or scouts. It is
     * also what keeps the CLAIM path sound: transferBase re-points the seller's
     * obstacle rows onto this wallet, and a standing leftover of the buyer's own
     * terrain could otherwise land under a building the seller had already built
     * on that tile.
     */
    const o = await tx.update(obstacles).set({ clearedAt: now })
      .where(and(eq(obstacles.playerWallet, wallet), isNull(obstacles.clearedAt)))
      .returning({ id: obstacles.id });

    // Back to a fresh shell so the claimed base's progress lands cleanly. Both
    // columns are SOL-bought capacity that a deedless wallet cannot have raised
    // (non-`entry` deposit intents are refused for an unpaid wallet), so this
    // resets nothing anyone paid for — and the audit row below records the prior
    // values regardless, which is the point of writing one.
    await tx.update(players).set({ keepLevel: 1, expansions: 0 }).where(eq(players.wallet, wallet));

    /**
     * THE AUDIT ROW (security review 2026-08-09 F13). `transferBase` writes one
     * "so a bad transfer is reconstructible, append-only" — and abandoning is the
     * ONLY destructive route in the game, so it needed one more than transfer did:
     * a "my base is gone" support case had literally no record to answer from.
     * Same pattern: full prior state, same transaction, append-only, never updated.
     */
    await tx.insert(baseAbandons).values({
      playerWallet: wallet,
      priorKeepLevel: p.keepLevel,
      priorExpansions: p.expansions,
      buildingsDeleted: b.length,
      obstaclesTombstoned: o.length,
      jobsDeleted: jobs.length,
    });

    return { buildings: b.length, obstacles: o.length, jobs: jobs.length };
  });
}

/** Ownership reader seam — tests inject a fake; prod uses chain getAssetOwner. */
export type OwnershipReader = (assetId: string) => Promise<AssetOwnership | null>;

/** Review #3: only a PLAIN, thawed, undelegated wallet in the deed collection
 *  may receive a base. Escrow PDAs, frozen listings and delegated assets are
 *  all "not a sale yet" — skip, never transfer, never lock the seller out. */
export function ownershipEligible(o: AssetOwnership, expectedCollection: string | null): boolean {
  if (o.frozen || o.delegate) return false;
  if (expectedCollection && o.collection !== expectedCollection) return false;
  try {
    return PublicKey.isOnCurve(new PublicKey(o.owner).toBytes()); // a signable wallet, not a PDA
  } catch {
    return false; // not base58 / not 32 bytes
  }
}

/** In-memory N-consecutive-sweep confirmation (review #2a): one lagging or
 *  wrong indexer read must never move a base; only the SAME new owner observed
 *  on `required` consecutive sweeps applies. */
export interface ConfirmState { owner: string; seen: number }

/**
 * One watcher sweep (S1). NOT WIRED AT BOOT — the apply mechanism (push with
 * confirmation vs pull-based claim) is an owner decision [S1-Q]; this function
 * is the tested engine either mechanism will drive.
 */
export async function sweepDeedTransfers(
  db: Db, ownerOf: OwnershipReader,
  opts: {
    expectedCollection?: string | null;
    confirmations?: Map<string, ConfirmState>;
    requiredConfirmations?: number;
    maxTransfersPerSweep?: number;
  } = {},
): Promise<{ checked: number; transferred: number }> {
  const required = opts.requiredConfirmations ?? 2;
  const maxApply = opts.maxTransfersPerSweep ?? 3; // review #2d: an indexer glitch may not move the world
  const confirmations = opts.confirmations ?? new Map<string, ConfirmState>();
  const rows = await db.select({ wallet: players.wallet, deed: players.deedAssetId })
    .from(players).where(sql`${players.deedAssetId} IS NOT NULL`)
    .orderBy(players.wallet); // review #8: reproducible order
  let transferred = 0;
  for (const r of rows) {
    if (transferred >= maxApply) break;
    try {
      const ownership = await ownerOf(r.deed!);
      if (!ownership || ownership.owner === r.wallet) { confirmations.delete(r.deed!); continue; }
      if (!ownershipEligible(ownership, opts.expectedCollection ?? null)) { confirmations.delete(r.deed!); continue; }
      const prev = confirmations.get(r.deed!);
      const seen = prev && prev.owner === ownership.owner ? prev.seen + 1 : 1;
      confirmations.set(r.deed!, { owner: ownership.owner, seen });
      if (seen < required) continue; // not confirmed yet — observe again next sweep
      await transferBase(db, r.wallet, ownership.owner, r.deed!);
      confirmations.delete(r.deed!);
      transferred++;
      console.log(`[deed-transfer] ${r.deed}: base handed ${r.wallet} → ${ownership.owner} (after ${seen} confirmations)`);
    } catch (e) {
      // Parked transfers (buyer has a base) and transient failures retry next
      // sweep; neither may block the rest of the row set.
      console.error(`[deed-transfer] ${r.deed} (retries next sweep):`, e);
    }
  }
  return { checked: rows.length, transferred };
}
