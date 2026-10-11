/** D-128: one persisted resolver for fantasy land. A visible continent is not
 * authority to own it; reserved Solana allocations and islands fail closed. */
import {
  FANTASY_CATALOG_HASH, FANTASY_WORLD_ID, fantasyTiles, getFantasyTile,
  type FantasyTile,
} from '@shardkeep/shared/fantasyWorld';
import { randomInt } from 'node:crypto';
import type { RealmId } from '@shardkeep/shared/baseVisual';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db, DbOrTx, DbTx } from '../db/client';
import {
  bases, baseSlots, deposits, fantasyLandClaims,
  fantasyWorldCatalog, fantasyWorldTiles, fantasyPurchaseCutover, fantasyRetirementExclusions, players, plotReservations,
} from '../db/schema';
import { HttpError } from '../lib/errors';
import { assertFreshLockedBaseAuthority } from './baseOwnership';

export { getFantasyClaim, isFantasyRetired, resolveFantasyLocation } from './fantasyLocationRead';
export type { FantasyClaim } from './fantasyLocationRead';
import { getFantasyClaim, isFantasyRetired, resolveFantasyLocation } from './fantasyLocationRead';

export function assertFantasyCatalogContents(persisted: ReadonlyArray<{ tileId: number; realmId: string; allocation: string }>): void {
  const expected = [...fantasyTiles()];
  if (persisted.length !== expected.length || new Set(persisted.map((row) => row.tileId)).size !== expected.length
    || persisted.some((row) => {
      const tile = getFantasyTile(row.tileId);
      return !tile || tile.realmId !== row.realmId || tile.allocation !== row.allocation;
    })) throw new Error('Persisted fantasy catalog differs from this build');
}

/** Call after canonical player/base locks when assigning. */
export async function lockFantasyAllocation(tx: DbTx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('shardkeep:fantasy-location'))`);
}

export async function fantasyPurchasesCutOver(db: DbOrTx): Promise<boolean> {
  const [row] = await db.select().from(fantasyPurchaseCutover).limit(1);
  return Boolean(row);
}

export interface PendingLegacyFantasyPurchase { depositId: string; wallet: string; baseId: string; reservationId: string }
export async function pendingLegacyFantasyPurchases(db: DbOrTx): Promise<PendingLegacyFantasyPurchase[]> {
  const rows = await db.select({ depositId: deposits.id, wallet: deposits.playerWallet, baseId: plotReservations.baseId,
    reservationId: plotReservations.id, state: plotReservations.state }).from(deposits)
    .leftJoin(plotReservations, eq(plotReservations.depositId, deposits.id)).where(sql`
      ${deposits.kind} IN ('entry','deed') AND ${deposits.status}='pending'
      AND (${plotReservations.addressKind}='legacy-earth' OR (${plotReservations.id} IS NULL
        AND ${deposits.payload}->'landAddress'->>'kind' IS DISTINCT FROM 'fantasy'))
    `).orderBy(asc(deposits.id));
  return rows.map(row => {
    if (!row.baseId || !row.reservationId || !['reserved', 'paid'].includes(row.state ?? '')) {
      throw new HttpError(409, 'An issued legacy payment needs explicit reconciliation before cutover', 'LEGACY_PAYMENT_RECONCILIATION_REQUIRED');
    }
    return { depositId: row.depositId, wallet: row.wallet, baseId: row.baseId, reservationId: row.reservationId };
  });
}

/** Caller locks these players -> bases -> deposits before allocation. Reject a
 * newly committed intent rather than acquiring its locks in reverse order. */
export async function stageLockedLegacyFantasyPurchases(tx: DbTx, locked: PendingLegacyFantasyPurchase[]): Promise<number> {
  await lockFantasyAllocation(tx);
  const current = await pendingLegacyFantasyPurchases(tx);
  if (JSON.stringify(current) !== JSON.stringify(locked)) throw new HttpError(503, 'Legacy payments changed; retry cutover preparation', 'FANTASY_CUTOVER_RETRY');
  for (const row of current) await reserveFantasyPurchase(tx, row.depositId, row.baseId, undefined, { crownlandsOnly: true });
  return current.length;
}

/** A native quote prepares every issued Earth intent before its own transaction.
 * The final latch rechecks this under allocation lock, closing the race if a
 * legacy quote committed in between. No payload, signature or address changes. */
export async function stagePendingLegacyFantasyPurchases(db: Db): Promise<number> {
  return db.transaction(async tx => {
    const pending = await pendingLegacyFantasyPurchases(tx);
    const wallets = [...new Set(pending.map(row => row.wallet))].sort();
    const baseIds = [...new Set(pending.map(row => row.baseId))].sort();
    if (wallets.length) await tx.select().from(players).where(inArray(players.wallet, wallets)).orderBy(asc(players.wallet)).for('update');
    if (baseIds.length) await tx.select().from(bases).where(inArray(bases.id, baseIds)).orderBy(asc(bases.id)).for('update');
    if (pending.length) await tx.select().from(deposits).where(inArray(deposits.id, pending.map(row => row.depositId))).orderBy(asc(deposits.id)).for('update');
    return stageLockedLegacyFantasyPurchases(tx, pending);
  });
}

/** Explicit one-way operator step, or part of the first successful native
 * quote transaction. Installing or viewing the catalog never enables sales. */
export async function activateFantasyPurchaseCutover(tx: DbTx, now = new Date()): Promise<void> {
  await lockFantasyAllocation(tx);
  const [catalog] = await tx.select().from(fantasyWorldCatalog).where(eq(fantasyWorldCatalog.worldId, FANTASY_WORLD_ID));
  if (catalog?.catalogHash !== FANTASY_CATALOG_HASH) throw new Error('Fantasy catalog must be prepared before cutover');
  for (const pending of await pendingLegacyFantasyPurchases(tx)) {
    const claim = await getFantasyClaim(tx, pending.baseId);
    if (!claim || claim.state !== 'held' || claim.source !== 'purchase' || claim.depositId !== pending.depositId
      || requireOrdinaryFantasyTile(claim.tileId).realmId !== 'crownlands') {
      throw new HttpError(503, 'Prepare every issued legacy payment before cutover', 'FANTASY_CUTOVER_RETRY');
    }
  }
  // A legacy payment may have settled after the reviewed snapshot but before
  // the pending-intent census. No paid deed (including an unfinished mint) may
  // disappear at cutover. Existing canonical pending locks + its exact recheck
  // serialize concurrent credit; the allocator also fences new Earth inserts.
  const uncovered = await tx.execute(sql`SELECT 1 FROM ${bases} b
    WHERE b.land_paid_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ${fantasyLandClaims} c WHERE c.base_id=b.id
        AND c.state IN ('held','assigned') AND (c.expected_mint IS NULL OR c.expected_mint=b.deed_asset_id))
      AND NOT EXISTS (SELECT 1 FROM ${fantasyRetirementExclusions} e WHERE e.base_id=b.id
        AND e.mint_id IS NOT DISTINCT FROM b.deed_asset_id)
    LIMIT 1`);
  if (uncovered.length) throw new HttpError(409, 'Paid deed census changed; review missing identities before cutover', 'FANTASY_CENSUS_DRIFT');
  await tx.insert(fantasyPurchaseCutover).values({ worldId: FANTASY_WORLD_ID, activatedAt: now }).onConflictDoNothing();
}

export async function installFantasyCatalog(tx: DbTx): Promise<void> {
  await lockFantasyAllocation(tx);
  const tiles = [...fantasyTiles()];
  const [existing] = await tx.select().from(fantasyWorldCatalog)
    .where(eq(fantasyWorldCatalog.worldId, FANTASY_WORLD_ID));
  if (existing) {
    const persisted = await tx.select().from(fantasyWorldTiles)
      .where(eq(fantasyWorldTiles.worldId, FANTASY_WORLD_ID));
    if (existing.catalogHash !== FANTASY_CATALOG_HASH || existing.tileCount !== tiles.length) throw new Error('Persisted fantasy catalog differs from this build');
    assertFantasyCatalogContents(persisted);
    return;
  }
  await tx.insert(fantasyWorldCatalog).values({
    worldId: FANTASY_WORLD_ID, catalogHash: FANTASY_CATALOG_HASH, tileCount: tiles.length,
  });
  // SQL parameter bound, not a gameplay quantity.
  for (let offset = 0; offset < tiles.length; offset += 1_000) {
    await tx.insert(fantasyWorldTiles).values(tiles.slice(offset, offset + 1_000).map((tile) => ({
      worldId: tile.worldId, tileId: tile.tileId, realmId: tile.realmId, allocation: tile.allocation,
    })));
  }
}

export function requireOrdinaryFantasyTile(tileId: number): FantasyTile {
  const tile = getFantasyTile(tileId);
  if (!tile || tile.allocation !== 'ordinary') {
    throw new HttpError(409, 'This terrain is reserved or cannot be owned', 'FANTASY_TILE_UNAVAILABLE');
  }
  return tile;
}

/** Activation/transfer callers already hold player -> base locks. They may
 * consume a held legacy destination only after exact finalized authority and
 * an owner-matching active slot. The persistent tile survives all later moves. */
export async function activateHeldFantasyLocation(tx: DbTx, wallet: string, baseId: string, now = new Date()): Promise<FantasyTile | null> {
  const base = await assertFreshLockedBaseAuthority(tx, wallet, baseId, now);
  if (await isFantasyRetired(tx, baseId, base.deedAssetId)) return null;
  const [slot] = await tx.select().from(baseSlots).where(and(
    eq(baseSlots.baseId, baseId), eq(baseSlots.wallet, wallet), eq(baseSlots.active, true),
  )).orderBy(asc(baseSlots.slot)).for('update');
  if (!slot) throw new HttpError(409, 'Fantasy destination requires an active owned base', 'BASE_NOT_OWNED');
  await lockFantasyAllocation(tx);
  const claim = await getFantasyClaim(tx, baseId);
  if (!claim) return null;
  if (claim.state === 'held') {
    if (claim.source !== 'migration-inactive' || claim.expectedMint !== base.deedAssetId) {
      throw new HttpError(409, 'Fantasy destination is not ready for activation', 'FANTASY_CLAIM_NOT_READY');
    }
    await tx.update(fantasyLandClaims).set({ state: 'assigned', assignedAt: now })
      .where(and(eq(fantasyLandClaims.id, claim.id), eq(fantasyLandClaims.state, 'held')));
  }
  return resolveFantasyLocation(tx, baseId);
}

/** The caller owns player/base/deposit locks. This is invoked for fresh native
 * purchases and held Crownlands destinations of already-issued Earth intents. */
export async function reserveFantasyPurchase(
  tx: DbTx, depositId: string, baseId: string, requestedTile?: number,
  opts: { crownlandsOnly?: boolean } = {},
): Promise<FantasyTile> {
  await lockFantasyAllocation(tx);
  const [catalog] = await tx.select().from(fantasyWorldCatalog).where(eq(fantasyWorldCatalog.worldId, FANTASY_WORLD_ID));
  if (catalog?.catalogHash !== FANTASY_CATALOG_HASH) throw new HttpError(503, 'Fantasy land is not prepared', 'FANTASY_WORLD_NOT_READY');
  const [base] = await tx.select().from(bases).where(eq(bases.id, baseId)).for('update');
  const [deposit] = await tx.select().from(deposits).where(eq(deposits.id, depositId));
  const frozen = deposit?.payload as { baseId?: string } | null;
  if (!base || base.landPaidAt || base.deedAssetId || await isFantasyRetired(tx, baseId, base.deedAssetId)) {
    throw new HttpError(409, 'Base cannot reserve another land identity', 'FANTASY_TILE_UNAVAILABLE');
  }
  if (!deposit || deposit.playerWallet !== base.ownerWallet || frozen?.baseId !== baseId
    || !['entry', 'deed'].includes(deposit.kind) || !['pending', 'credited'].includes(deposit.status)) {
    throw new Error('Fantasy reservation requires the exact frozen land payment base');
  }
  const existing = await getFantasyClaim(tx, baseId);
  if (existing) {
    if (existing.depositId !== depositId || existing.state !== 'held'
      || (requestedTile !== undefined && existing.tileId !== requestedTile)) {
      throw new HttpError(409, 'Payment already belongs to another fantasy destination', 'RESERVATION_MISMATCH');
    }
    return requireOrdinaryFantasyTile(existing.tileId);
  }
  const live = await tx.select({ tileId: fantasyLandClaims.tileId }).from(fantasyLandClaims)
    .where(and(eq(fantasyLandClaims.worldId, FANTASY_WORLD_ID), inArray(fantasyLandClaims.state, ['held', 'assigned'])));
  const occupied = new Set(live.map((row) => row.tileId));
  let chosen: FantasyTile | null = null;
  if (requestedTile !== undefined) {
    const tile = requireOrdinaryFantasyTile(requestedTile);
    if (!occupied.has(tile.tileId) && (!opts.crownlandsOnly || tile.realmId === 'crownlands')) chosen = tile;
  } else {
    let seen = 0;
    for (const tile of fantasyTiles(opts.crownlandsOnly ? 'crownlands' : undefined)) {
      if (tile.allocation !== 'ordinary' || occupied.has(tile.tileId)) continue;
      if (randomInt(++seen) === 0) chosen = tile;
    }
  }
  if (!chosen) throw new HttpError(409, 'Fantasy tile is already reserved', 'FANTASY_TILE_UNAVAILABLE');
  await tx.insert(fantasyLandClaims).values({ worldId: chosen.worldId, tileId: chosen.tileId,
    baseId, state: 'held', source: 'purchase', depositId });
  return chosen;
}

/** Credit depends on the persisted address, even when new purchases are off. */
export async function assignPaidFantasyClaim(tx: DbTx, depositId: string, baseId: string, now: Date): Promise<FantasyTile | null> {
  await lockFantasyAllocation(tx);
  const claim = await getFantasyClaim(tx, baseId);
  if (!claim) return null;
  if (claim.depositId !== depositId || claim.source !== 'purchase') throw new Error('Paid fantasy claim identity differs from deposit');
  const [deposit] = await tx.select().from(deposits).where(eq(deposits.id, depositId));
  if (deposit?.status !== 'credited') throw new Error('Fantasy assignment requires credited payment');
  if (claim.state === 'held') await tx.update(fantasyLandClaims).set({ state: 'assigned', assignedAt: now })
    .where(eq(fantasyLandClaims.id, claim.id));
  return requireOrdinaryFantasyTile(claim.tileId);
}

/** Only a proven unsigned expiry releases a purchase hold. A paid failure is
 * quarantined for explicit reconciliation; turning a flag off releases nothing. */
export async function releaseExpiredFantasyClaim(tx: DbTx, depositId: string, now = new Date()): Promise<void> {
  const [deposit] = await tx.select().from(deposits).where(eq(deposits.id, depositId));
  if (deposit?.status !== 'expired' || deposit.paymentSignature || deposit.txSignature) {
    throw new Error('Fantasy release requires an unsigned, never-paid expiry');
  }
  await lockFantasyAllocation(tx);
  await tx.update(fantasyLandClaims).set({ state: 'released', releasedAt: now }).where(and(
    eq(fantasyLandClaims.depositId, depositId), eq(fantasyLandClaims.state, 'held'), eq(fantasyLandClaims.source, 'purchase'),
  ));
}

/** Existing sanctioned dev-login has an explicit payment bypass. Keep that
 * local fixture on native terrain without a fake NFT or any chain transaction.
 * `realmId` places a NEW claim only: an assigned claim is immutable by trigger
 * (drizzle/0118 fantasy_claim_identity_guard — no rebinding, release or delete),
 * so an already-seated base returns its tile whatever realm is asked for; the dev
 * realm switch presents another realm without touching it (baseVisual.ts). */
export async function seedDevFantasyLocation(db: DbOrTx, wallet: string, baseId: string, realmId: RealmId = 'crownlands'): Promise<FantasyTile> {
  if (process.env['NODE_ENV'] === 'production' || process.env['DEV_LOGIN'] !== 'true') {
    throw new Error('Fantasy development fixtures require non-production DEV_LOGIN');
  }
  return db.transaction(async (tx) => {
    await tx.select().from(players).where(eq(players.wallet, wallet)).for('update');
    const [base] = await tx.select().from(bases).where(and(eq(bases.id, baseId), eq(bases.ownerWallet, wallet))).for('update');
    if (!base?.landPaidAt || await isFantasyRetired(tx, baseId, base.deedAssetId)) throw new Error('Invalid development base');
    await installFantasyCatalog(tx);
    const existing = await getFantasyClaim(tx, baseId);
    if (existing?.state === 'assigned') return requireOrdinaryFantasyTile(existing.tileId);
    if (existing) throw new Error('Development login cannot consume a held payment or migration claim');
    const occupied = new Set((await tx.select({ tileId: fantasyLandClaims.tileId }).from(fantasyLandClaims)
      .where(inArray(fantasyLandClaims.state, ['held', 'assigned']))).map((claim) => claim.tileId));
    const tile = [...fantasyTiles(realmId)].find((candidate) => candidate.allocation === 'ordinary' && !occupied.has(candidate.tileId));
    if (!tile) throw new Error('No ordinary development land in this realm');
    const [receipt] = await tx.insert(deposits).values({ playerWallet: wallet, kind: 'entry',
      reference: `dev-fantasy:${baseId}`, status: 'credited', amount: 0n, finalizedAt: new Date(),
      payload: { devFixture: true, baseId, landAddress: { kind: 'fantasy', worldId: tile.worldId, tileId: tile.tileId } },
    }).returning();
    await tx.insert(fantasyLandClaims).values({ worldId: tile.worldId, tileId: tile.tileId, baseId,
      source: 'purchase', depositId: receipt!.id, state: 'assigned', assignedAt: new Date() });
    return tile;
  });
}
