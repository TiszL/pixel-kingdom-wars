/**
 * Land Deed minting (Phase 6, ONRAMP-WALLETS-PLAN §6) — one TRADEABLE Metaplex
 * Core NFT per base: the TITLE TO THE LAND the player bought, minted once the
 * 0.2 SOL purchase is credited.
 *
 * Invariants (ITEMS-LOOTBOX-MARKETPLACE-PLAN §8/§9 — do not weaken):
 *  - The deed conveys STRUCTURES/PROGRESS/LAND only, never currency.
 *  - Attackability is a pure function of SERVER state; gameplay NEVER reads
 *    deed/DAS state, so no on-chain deed action can grant protection.
 *  - Deeds are NOT soulbound. `mintLandDeed` sets `frozen: !tradingEnabled`
 *    (packages/chain/src/landDeed.ts) and MARKETPLACE.tradingEnabled is true, so
 *    deeds arrive THAWED and transferable, which is what makes game/baseClaim.ts
 *    and game/baseTransfer.ts (a traded deed conveys the base) meaningful. The
 *    "soulbound (frozen) until the liquidity event" wording this header used to
 *    carry has been false since trading was enabled — corrected 2026-08-09.
 *
 * Minting is best-effort and NEVER blocks or fails the purchase credit: the
 * credit path fire-and-forgets this, and GET /base self-heals a missing deed
 * later. Unconfigured (no minter) → everything is a no-op. That is also why the
 * ROUTE GATE reads `players.entryPaidAt` and never `deedAssetId`: a swallowed
 * mint failure must not lock a paying player out of what they bought.
 */
import { and, asc, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { bases, baseSlots, baseTransfers, players } from '../db/schema';
import { assertDeedObserverCapacity } from './baseOwnership';
import { serverTrack } from '../telemetry';

/** Two-phase minter. `assetFor` is local/read-only and gives the API the exact
 * Core address to persist BEFORE `mint` may broadcast. Production derives the
 * signer from the stable base UUID + admin secret; a retry under a rotated key
 * therefore returns a different address and fails closed against the stored
 * one instead of creating an orphan. */
export interface DeedMinter {
  assetFor(operationId: string): string;
  mint(owner: string, operationId: string, expectedAsset: string): Promise<{ asset: string }>;
}

let minter: DeedMinter | null = null;
/** Server boot wires the chain minter here (null/omit → deeds disabled). */
export function configureDeedMinter(m: DeedMinter | null): void {
  minter = m;
}

/**
 * How long a mint claim is honoured before another caller may take it over.
 * Generous: a Core mint is one devnet transaction, so anything past this is a
 * crashed or hung process rather than a slow one. Too short re-introduces the
 * double-mint; too long delays the self-heal for a player with no deed.
 */
const CLAIM_STALE_MS = 5 * 60_000;

/**
 * Mint the player's Land Deed if configured, PAID FOR, and not already minted.
 * Safe to call from hot paths; errors are logged, never thrown.
 *
 * THE CLAIM IS THE WHOLE POINT. This used to be guarded by an in-process `Set`
 * whose `.add()` happened one `await` too late, so two overlapping callers both
 * got through — and the two callers that overlap are exactly the two that fire
 * together on entry (the deposit watcher's credit and the client's first
 * GET /base poll). A single conditional UPDATE moves that decision into the
 * database, where it is atomic, survives a restart, and holds across processes.
 *
 * THE PAYMENT CHECK IS PART OF THE CLAIM (2026-08-09, free onboarding). It used
 * to live entirely in the CALL SITES — and one of those call sites is GET /base,
 * which is now FREE. Without `entryPaidAt IS NOT NULL` in this WHERE, every
 * player who has never paid a lamport is minted a real, collection-verified,
 * royalty-bearing Land Deed on their first /base poll, inverting the entire
 * model: the deed is what 0.2 SOL BUYS. It belongs here rather than at the call
 * sites because there is no call site that should ever mint an unpaid deed, and
 * a precondition that lives in callers is a precondition one new caller deletes.
 */
async function ensureMintBase(db: Db, wallet: string, requestedBaseId?: string): Promise<string | null> {
  if (requestedBaseId) return requestedBaseId;
  return db.transaction(async (tx) => {
    const [player] = await tx.select().from(players).where(eq(players.wallet, wallet)).for('update');
    if (!player) return null;
    const owned = await tx.select({ id: bases.id }).from(bases)
      .where(eq(bases.ownerWallet, wallet)).orderBy(asc(bases.createdAt)).limit(2).for('update');
    if (owned.length > 0) return owned.length === 1 ? owned[0]!.id : null;
    if (!player.entryPaidAt) return null;
    // Rolling-upgrade recovery only. A deed seller intentionally retains legacy
    // player columns, so either transfer evidence or the same deed elsewhere is
    // proof that those columns must not materialize a replacement base.
    const [sale] = await tx.select({ id: baseTransfers.id }).from(baseTransfers)
      .where(eq(baseTransfers.fromWallet, wallet)).limit(1);
    const deedElsewhere = player.deedAssetId
      ? (await tx.select({ id: bases.id }).from(bases)
        .where(eq(bases.deedAssetId, player.deedAssetId)).limit(1))[0]
      : undefined;
    if (sale || deedElsewhere) return null;
    const [base] = await tx.insert(bases).values({
      ownerWallet: wallet, deedAssetId: player.deedAssetId,
      deedMintAssetId: player.deedMintAssetId ?? player.deedAssetId,
      keepLevel: player.keepLevel, builders: player.builders, expansions: player.expansions,
      landPaidAt: player.entryPaidAt, deedMintingAt: player.deedMintingAt,
    }).returning({ id: bases.id });
    await tx.insert(baseSlots).values({ wallet, slot: 1, baseId: base!.id, selectedAt: new Date() });
    await tx.execute(sql`update buildings set base_id=${base!.id} where player_wallet=${wallet} and base_id is null`);
    await tx.execute(sql`update obstacles set base_id=${base!.id} where player_wallet=${wallet} and base_id is null`);
    await tx.execute(sql`update builder_jobs set base_id=${base!.id} where player_wallet=${wallet} and base_id is null`);
    await tx.execute(sql`update layouts set base_id=${base!.id} where player_wallet=${wallet} and base_id is null`);
    await tx.execute(sql`update shields set base_id=${base!.id} where player_wallet=${wallet} and base_id is null`);
    await tx.execute(sql`update plots set base_id=${base!.id} where player_wallet=${wallet} and base_id is null`);
    return base!.id;
  });
}

export async function mintDeedIfConfigured(db: Db, wallet: string, requestedBaseId?: string): Promise<void> {
  const activeMinter = minter;
  if (!activeMinter) return;
  try {
    const baseId = await ensureMintBase(db, wallet, requestedBaseId);
    if (!baseId) return;
    const claim = await db.transaction(async (tx) => {
      const [player] = await tx.select().from(players).where(eq(players.wallet, wallet)).for('update');
      if (!player) return null;
      const owned = await tx.select({ id: bases.id }).from(bases)
        .where(eq(bases.ownerWallet, wallet)).limit(2);
      const [base] = await tx.select().from(bases)
        .where(and(eq(bases.id, baseId), eq(bases.ownerWallet, wallet)))
        .for('update');
      if (!base?.landPaidAt) return null;

      // Repair the rolling-upgrade half-write without minting a second NFT.
      if (base.deedAssetId) {
        if (base.deedMintAssetId !== base.deedAssetId) {
          await tx.update(bases).set({ deedMintAssetId: base.deedAssetId })
            .where(eq(bases.id, baseId));
        }
        if (owned.length === 1 && player.deedAssetId !== base.deedAssetId) {
          await tx.update(players).set({
            deedAssetId: base.deedAssetId,
            deedMintAssetId: base.deedAssetId,
            deedMintingAt: null,
          })
            .where(eq(players.wallet, wallet));
        }
        return null;
      }
      if (base.deedMintingAt && !base.deedMintAssetId) {
        // Rolling-deploy fence: the pre-0072 process persisted only a timestamp,
        // so an accepted-but-unconfirmed transaction may already have created
        // an asset whose random signer is unrecoverable. Generating a new fixed
        // signer here would recreate the exact orphan bug this path fixes.
        throw new Error(
          `legacy ambiguous deed claim for base ${baseId} has no fixed asset id; `
          + 'manual chain reconciliation must prove the old mint absent before retry',
        );
      }
      const staleBefore = new Date(Date.now() - CLAIM_STALE_MS);
      if (base.deedMintingAt && base.deedMintingAt >= staleBefore) return null;
      // A retry's persisted fixed address already holds one capacity slot even
      // when its time lease was released after an ambiguous RPC failure.
      if (base.status === 'active') {
        await assertDeedObserverCapacity(tx, base.deedMintAssetId ? 0 : 1);
      }
      const plannedAsset = activeMinter.assetFor(baseId);
      if (base.deedMintAssetId && base.deedMintAssetId !== plannedAsset) {
        throw new Error(
          `persisted deed asset ${base.deedMintAssetId} does not match the current signer `
          + `${plannedAsset} for base ${baseId}; refusing to mint after key/derivation rotation`,
        );
      }
      const stamp = new Date();
      // This is the exactly-once boundary: expected public address + claim are
      // committed together, and only then is the broadcaster invoked below.
      // 0072 also requires this transaction-local marker: it makes every
      // timestamp-only pre-0072 writer fail before its UPDATE ... RETURNING can
      // grant permission to its random-signer broadcaster. Requiring the exact
      // id alone is insufficient because an old pod could steal a released retry.
      await tx.execute(sql`select set_config('shardkeep.fixed_deed_mint_claim', 'on', true)`);
      await tx.update(bases).set({
        deedMintAssetId: plannedAsset, deedMintingAt: stamp, updatedAt: stamp,
      }).where(eq(bases.id, baseId));
      if (owned.length === 1) {
        await tx.update(players).set({ deedMintAssetId: plannedAsset, deedMintingAt: stamp })
          .where(eq(players.wallet, wallet));
      }
      return { stamp, asset: plannedAsset };
    });

    // Unpaid, already minted, or a mint is genuinely in flight — all three are
    // "not our turn", and all three are silent by design (this runs on GET /base).
    if (!claim) return;

    try {
      const { asset } = await activeMinter.mint(wallet, baseId, claim.asset);
      if (asset !== claim.asset) {
        throw new Error(
          `deed minter returned ${asset}, but base ${baseId} reserved ${claim.asset}; refusing attachment`,
        );
      }
      await db.transaction(async (tx) => {
        await tx.select({ wallet: players.wallet }).from(players)
          .where(eq(players.wallet, wallet)).for('update');
        const [base] = await tx.select().from(bases)
          .where(and(eq(bases.id, baseId), eq(bases.ownerWallet, wallet))).for('update');
        if (!base || base.deedAssetId) return;
        const owned = await tx.select({ id: bases.id }).from(bases)
          .where(eq(bases.ownerWallet, wallet)).limit(2);
        // Convert the durable reservation into the attached deed atomically.
        // Cardinality does not change: deedMintAssetId already consumed this
        // observer slot. Clearing/re-admitting would also invert the canonical
        // capacity→asset-registry advisory-lock order enforced by 0072.
        await tx.update(bases).set({
          deedAssetId: asset, deedMintAssetId: asset, deedMintingAt: null, updatedAt: new Date(),
        })
          .where(and(eq(bases.id, baseId), isNull(bases.deedAssetId)));
        if (owned.length === 1 && owned[0]!.id === baseId) {
          await tx.update(players).set({
            deedAssetId: asset, deedMintAssetId: asset, deedMintingAt: null,
          })
            .where(eq(players.wallet, wallet));
        }
      });
      // Analytics (M23 a13): the authoritative land_deed_minted, after the
      // attach transaction commits. eventId = asset — retries dedupe.
      serverTrack('land_deed_minted', wallet, {}, { eventId: `deed:${asset}` });
    } catch (e) {
      // Release only the time lease. The expected asset address is deliberately
      // retained: send failure is ambiguous, so every retry must query/reuse the
      // same address and can never allocate another tradeable deed.
      await db.transaction(async (tx) => {
        await tx.update(bases).set({ deedMintingAt: null })
          .where(and(
            eq(bases.id, baseId), isNull(bases.deedAssetId), eq(bases.deedMintingAt, claim.stamp),
          ));
        await tx.update(players).set({ deedMintingAt: null })
          .where(and(eq(players.wallet, wallet), eq(players.deedMintingAt, claim.stamp)));
      });
      throw e;
    }
  } catch (e) {
    console.error(`[deed-mint] ${wallet}: mint failed (self-heals on next /base):`, e);
  }
}

/** Worker-only, bounded self-heal for paid bases whose request-path mint was
 * missed while the public API intentionally had no deed signer. Inactive sixth+
 * purchases need this too: activation capacity and deed ownership are separate.
 * Claims remain atomic inside mintDeedIfConfigured, so ticks/restarts are safe. */
let reconcileAfterBaseId: string | undefined;
export async function reconcileMissingDeeds(db: Db, limit = 10): Promise<{ attempted: number }> {
  if (!minter) return { attempted: 0 };
  const eligible = and(
    isNotNull(bases.landPaidAt),
    isNull(bases.deedAssetId),
    or(
      isNull(bases.deedMintingAt),
      lt(bases.deedMintingAt, new Date(Date.now() - CLAIM_STALE_MS)),
    ),
  );
  const read = (after?: string) => db.select({ id: bases.id, wallet: bases.ownerWallet }).from(bases)
    .where(after ? and(eligible, gt(bases.id, after)) : eligible)
    .orderBy(asc(bases.id)).limit(limit);
  let rows = await read(reconcileAfterBaseId);
  // Cursor rotation prevents one permanently failing wallet in the first batch
  // from starving every later paid player. On wrap, retry failures normally.
  if (rows.length === 0 && reconcileAfterBaseId) {
    reconcileAfterBaseId = undefined;
    rows = await read();
  }
  reconcileAfterBaseId = rows.at(-1)?.id;
  for (const row of rows) await mintDeedIfConfigured(db, row.wallet, row.id);
  return { attempted: rows.length };
}

/** Test seam: how long a claim survives before it is considered abandoned. */
export const DEED_CLAIM_STALE_MS = CLAIM_STALE_MS;
