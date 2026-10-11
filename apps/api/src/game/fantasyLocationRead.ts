/** Read-only persisted locations: keep publishing independent of the gameplay
 * allocator and its legacy Earth mask dependencies. */
import { getFantasyTile, type FantasyTile } from '@shardkeep/shared/fantasyWorld';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { bases, deposits, fantasyLandClaims, fantasyRetirementExclusions, fantasyWorldTiles } from '../db/schema';
import { fantasyWorldEnabled } from '../config';
import { HttpError } from '../lib/errors';

/** Historical addresses remain private even while native purchases are paused
 * or a compatible rollback disables the presentation flag. Payment recovery
 * reads its original binding directly and never calls this HTTP-only guard. */
export async function fantasyPresentationActive(db: DbOrTx): Promise<boolean> {
  return fantasyWorldEnabled() || (await db.execute(sql`SELECT 1 WHERE
    EXISTS (SELECT 1 FROM fantasy_purchase_cutover)
    OR EXISTS (SELECT 1 FROM fantasy_land_claims WHERE state='assigned')`)).length > 0;
}

export async function requireLegacyWorldPresentation(db: DbOrTx): Promise<void> {
  if (await fantasyPresentationActive(db)) throw new HttpError(409, 'Update the game to view the fantasy world', 'WORLD_UPDATE_REQUIRED');
}

export type FantasyClaim = typeof fantasyLandClaims.$inferSelect;

export async function isFantasyRetired(db: DbOrTx, baseId: string, mintId?: string | null): Promise<boolean> {
  const [row] = await db.select({ baseId: fantasyRetirementExclusions.baseId })
    .from(fantasyRetirementExclusions).where(sql`${fantasyRetirementExclusions.baseId}=${baseId}
      ${mintId ? sql`OR ${fantasyRetirementExclusions.mintId}=${mintId}` : sql``}`).limit(1);
  return Boolean(row);
}

export async function getFantasyClaim(db: DbOrTx, baseId: string): Promise<FantasyClaim | null> {
  const [row] = await db.select().from(fantasyLandClaims).where(and(
    eq(fantasyLandClaims.baseId, baseId), inArray(fantasyLandClaims.state, ['held', 'assigned']),
  ));
  return row ?? null;
}

/** Held destinations never masquerade as an owned or publicly occupied tile. */
export async function resolveFantasyLocation(db: DbOrTx, baseId: string): Promise<FantasyTile | null> {
  const [row] = await db.select({
    tileId: fantasyLandClaims.tileId, worldId: fantasyLandClaims.worldId,
    realmId: fantasyWorldTiles.realmId, allocation: fantasyWorldTiles.allocation,
    currentMint: bases.deedAssetId,
    expectedMint: fantasyLandClaims.expectedMint,
  }).from(fantasyLandClaims)
    .innerJoin(bases, eq(bases.id, fantasyLandClaims.baseId))
    .innerJoin(fantasyWorldTiles, and(
      eq(fantasyWorldTiles.worldId, fantasyLandClaims.worldId), eq(fantasyWorldTiles.tileId, fantasyLandClaims.tileId),
    )).where(and(eq(fantasyLandClaims.baseId, baseId), eq(fantasyLandClaims.state, 'assigned')));
  if (!row) return null;
  if (row.expectedMint !== null && row.currentMint !== row.expectedMint) throw new Error('Fantasy deed identity changed');
  if (await isFantasyRetired(db, baseId, row.currentMint)) throw new Error('Retired base has a fantasy assignment');
  const tile = getFantasyTile(row.tileId);
  if (!tile || tile.allocation !== 'ordinary') throw new Error('Persisted fantasy location is not ordinary deed land');
  if (row.worldId !== tile.worldId || row.realmId !== tile.realmId || row.allocation !== tile.allocation) {
    throw new Error('Persisted fantasy location differs from the frozen catalog');
  }
  return tile;
}

/** True iff the base's assigned claim rests on the zero-amount `devFixture` receipt
 * that seedDevFantasyLocation writes — the one kind of claim the dev realm switch
 * (DEV_LOGIN_REALM) may present elsewhere. A purchase, a migrated deed or a base
 * with no claim never qualifies, whatever the host's env says. */
export async function isDevFixtureFantasyClaim(db: DbOrTx, baseId: string): Promise<boolean> {
  const [row] = await db.select({ amount: deposits.amount, payload: deposits.payload }).from(fantasyLandClaims)
    .innerJoin(deposits, eq(deposits.id, fantasyLandClaims.depositId))
    .where(and(eq(fantasyLandClaims.baseId, baseId), eq(fantasyLandClaims.state, 'assigned'), eq(fantasyLandClaims.source, 'purchase')));
  return row?.amount === 0n && (row.payload as { devFixture?: unknown } | null)?.devFixture === true;
}
