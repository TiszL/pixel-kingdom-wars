/** Called only inside getBaseState's authorized post-settlement transaction. */
import { BuildingType } from '@shardkeep/shared';
import { StarterFleetBerthSchema, StarterFleetInstallationSchema } from '@shardkeep/shared/starterFleetApi';
import { and, asc, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import { builderJobs, buildings, fleetInstallations } from '../db/schema';

export async function readStarterFleetView(tx: DbTx, baseId: string) {
  const [installed] = await tx.select().from(fleetInstallations)
    .where(and(eq(fleetInstallations.baseId, baseId), eq(fleetInstallations.family, 'starter')));
  const berths = await tx.select({ id: buildings.id }).from(buildings).where(and(
    eq(buildings.baseId, baseId), eq(buildings.type, BuildingType.Berth), gt(buildings.level, 0),
  )).orderBy(asc(buildings.id));
  const eligibleBerths = [];
  for (const berth of berths) {
    if (installed && installed.berthId !== berth.id) continue;
    const [occupied] = await tx.select({ id: fleetInstallations.id }).from(fleetInstallations).where(eq(fleetInstallations.berthId, berth.id));
    if (occupied && occupied.id !== installed?.id) continue;
    const [unfinished] = await tx.select({ id: builderJobs.id }).from(builderJobs).where(and(
      eq(builderJobs.buildingId, berth.id), eq(builderJobs.kind, 'build'), isNull(builderJobs.completedAt),
    )).limit(1);
    if (unfinished) continue;
    const [job] = await tx.select().from(builderJobs).where(and(eq(builderJobs.baseId, baseId),
      eq(builderJobs.buildingId, berth.id), eq(builderJobs.kind, 'build'), isNotNull(builderJobs.completedAt), isNull(builderJobs.cancelledAt),
      ...(installed ? [eq(builderJobs.id, installed.completedBuildJobId)] : []),
    )).orderBy(asc(builderJobs.completedAt), asc(builderJobs.id)).limit(1);
    if (!job?.completedAt) continue;
    if (installed && installed.berthCompletedAt.getTime() !== job.completedAt.getTime()) continue;
    eligibleBerths.push(StarterFleetBerthSchema.parse({ berthId: berth.id, completedBuildJobId: job.id, berthCompletedAt: job.completedAt.toISOString() }));
  }
  if (installed && !eligibleBerths.some(b => b.berthId === installed.berthId)) throw new Error('Invalid current starter berth proof');
  const installation = installed ? StarterFleetInstallationSchema.parse({ installationId: installed.id,
    baseId, berthId: installed.berthId, family: installed.family, completedBuildJobId: installed.completedBuildJobId,
    berthCompletedAt: installed.berthCompletedAt.toISOString(), installedAt: installed.createdAt.toISOString() }) : null;
  return { installation, eligibleBerths };
}
