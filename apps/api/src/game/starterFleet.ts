/** DARK starter installation registry, native accepted decisions @11504e2 §6.
 * No dispatch, earning, NFT, uses, cost, placement or combat authority. Future
 * dispatch must call this inside its own transaction before reserving the fleet.
 */
import { BuildingType } from '@shardkeep/shared';
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx, DbTx } from '../db/client';
import { builderJobs, buildings, fleetInstallations, players } from '../db/schema';
import { HttpError } from '../lib/errors';
import { lockStablePrerequisiteBase, type StableBaseMutationContext } from './stableBasePrerequisites';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
export const StarterFleetEvidenceSchema = z.object({
  version: z.literal(1), installationId: uuid, baseId: uuid, berthId: uuid,
  family: z.literal('starter'), custodyWallet: z.string().min(1), installedWallet: z.string().min(1),
  completedBuildJobId: uuid, berthCompletedAt: z.string().datetime(), installedAt: z.string().datetime(),
}).strict();
export type StarterFleetEvidence = z.infer<typeof StarterFleetEvidenceSchema>;
type Installation = typeof fleetInstallations.$inferSelect;
const unavailable = () => new HttpError(409, 'A completed original berth is required', 'STARTER_BERTH_UNAVAILABLE');

async function lockAuthority(tx: DbTx, wallet: string, authority: StableBaseMutationContext) {
  const [player] = await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('update');
  if (!player) throw new HttpError(404, 'player not found');
  return lockStablePrerequisiteBase(tx, wallet, authority);
}

async function completedBerth(tx: DbTx, baseId: string, berthId: string, original?: Installation) {
  // Stable base ID is custody; buildings.playerWallet remains historical after
  // a deed transfer. Never use that legacy field as current ownership.
  const [berth] = await tx.select().from(buildings)
    .where(and(eq(buildings.id, berthId), eq(buildings.baseId, baseId))).for('update');
  if (!berth || berth.type !== BuildingType.Berth || berth.level < 1) throw unavailable();
  const [unfinished] = await tx.select({ id: builderJobs.id }).from(builderJobs)
    .where(and(eq(builderJobs.buildingId, berthId), eq(builderJobs.kind, 'build'), isNull(builderJobs.completedAt))).limit(1);
  if (unfinished) throw unavailable();
  // Absence of a pending timer is insufficient: retain the positive canonical
  // build completion, not a caller assertion or manually seeded empty berth.
  const [job] = await tx.select().from(builderJobs).where(and(
    eq(builderJobs.buildingId, berthId), eq(builderJobs.baseId, baseId), eq(builderJobs.kind, 'build'),
    isNotNull(builderJobs.completedAt), isNull(builderJobs.cancelledAt),
    ...(original ? [eq(builderJobs.id, original.completedBuildJobId)] : []),
  )).orderBy(asc(builderJobs.completedAt), asc(builderJobs.id)).limit(1);
  if (!job?.completedAt || (original && job.completedAt.getTime() !== original.berthCompletedAt.getTime())) throw unavailable();
  return job;
}

function evidence(row: Installation, custodyWallet: string): StarterFleetEvidence {
  return StarterFleetEvidenceSchema.parse({ version: 1, installationId: row.id, baseId: row.baseId,
    berthId: row.berthId, family: row.family, custodyWallet, installedWallet: row.installedWallet,
    completedBuildJobId: row.completedBuildJobId, berthCompletedAt: row.berthCompletedAt.toISOString(),
    installedAt: row.createdAt.toISOString() });
}

/** Explicit current authenticated command; exactly one starter on this base.
 * A different requested berth cannot silently replace the original installation. */
export async function installStarterFleet(
  db: DbOrTx, wallet: string, berthId: string, authority: StableBaseMutationContext,
): Promise<StarterFleetEvidence> {
  berthId = uuid.parse(berthId); authority = { ...authority, baseId: uuid.parse(authority.baseId) };
  return (db as Db).transaction(async tx => {
    const base = await lockAuthority(tx, wallet, authority);
    const [prior] = await tx.select().from(fleetInstallations)
      .where(and(eq(fleetInstallations.baseId, base.id), eq(fleetInstallations.family, 'starter')));
    if (prior) {
      if (prior.berthId !== berthId) throw new HttpError(409, 'The starter family already has a berth', 'STARTER_FAMILY_OCCUPIED');
      await completedBerth(tx, base.id, berthId, prior);
      return evidence(prior, base.ownerWallet);
    }
    const job = await completedBerth(tx, base.id, berthId);
    const [occupied] = await tx.select({ id: fleetInstallations.id }).from(fleetInstallations).where(eq(fleetInstallations.berthId, berthId));
    if (occupied) throw new HttpError(409, 'The berth is already occupied', 'STARTER_BERTH_OCCUPIED');
    // A completion can commit while this transaction waits for custody locks.
    // PostgreSQL now() would retain the earlier transaction-start timestamp.
    const [row] = await tx.insert(fleetInstallations).values({ baseId: base.id, berthId, family: 'starter',
      installedWallet: base.ownerWallet, completedBuildJobId: job.id, berthCompletedAt: job.completedAt!, createdAt: new Date() }).returning();
    if (!row) throw new Error('starter installation was not persisted');
    return evidence(row, base.ownerWallet);
  });
}

/** Current validity only. Historical evidence never substitutes for current
 * authority/berth state; this function does not auto-create an installation. */
export async function getStarterFleet(
  db: DbOrTx, wallet: string, authority: StableBaseMutationContext,
): Promise<StarterFleetEvidence | null> {
  authority = { ...authority, baseId: uuid.parse(authority.baseId) };
  return (db as Db).transaction(async tx => {
    const base = await lockAuthority(tx, wallet, authority);
    const [row] = await tx.select().from(fleetInstallations)
      .where(and(eq(fleetInstallations.baseId, base.id), eq(fleetInstallations.family, 'starter')));
    if (!row) return null;
    await completedBerth(tx, base.id, row.berthId, row);
    return evidence(row, base.ownerWallet);
  });
}
