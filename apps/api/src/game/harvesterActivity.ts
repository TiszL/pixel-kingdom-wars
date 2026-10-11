/** Current accepted-lease animation, never a promise of positive output. */
import { BuildingType } from '@shardkeep/shared';
import { and, eq } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import { builderJobs } from '../db/schema';
import type { settleDueHarvesterSources } from './harvesterSettlement';
import type { ServiceActivity } from './serviceActivity';

type CurrentBuilding = { id: string; type: string; level: number; underConstruction?: boolean };
type SettledSources = Awaited<ReturnType<typeof settleDueHarvesterSources>>;

/** Caller owns the protected base transaction and passes its already settled
 * originals and validated Workshop projection from the same cutoff. */
export async function withHarvesterActivity(tx: DbTx, wallet: string, baseId: string,
  buildings: readonly CurrentBuilding[], cutoff: Date, activity: ServiceActivity | null,
  settled: SettledSources): Promise<ServiceActivity | null> {
  if (!('rollback' in tx)) throw new Error('Harvester activity requires the protected base transaction');
  if (!Number.isFinite(+cutoff)) throw new Error('Invalid Harvester activity cutoff');
  if (activity === null) return null;
  // The canonical source-head table has one original per base. Never select
  // a convenient candidate if its closure or identity is inconsistent.
  if (settled.length > 1) return null;
  const working = new Set<string>();
  for (const proof of settled) {
    const source = proof.source;
    if (source.actorWallet !== wallet || source.baseId !== baseId || cutoff < source.admittedAt) return null;
    // Expired heads can remain pending, and a custody stop can survive deferred
    // delivery. Neither is operating authority. Cap-zero events are different:
    // the original machine is still operating within its accepted lease.
    if (proof.closure || proof.stop || cutoff >= source.leaseExpiresAt) continue;
    const matches = buildings.filter(b => b.id === source.harvesterId);
    const facility = matches[0];
    if (matches.length !== 1 || !facility || facility.type !== BuildingType.Harvester
      || facility.level < 1 || facility.underConstruction === true) return null;
    const jobs = await tx.select().from(builderJobs).where(and(
      eq(builderJobs.buildingId, source.harvesterId), eq(builderJobs.kind, 'build')));
    const original = jobs.find(job => job.id === source.harvesterCompletedJobId);
    if (!original || original.baseId !== baseId || original.cancelledAt !== null
      || original.completedAt === null || +original.completedAt !== +source.harvesterCompletedAt
      || original.completedAt > source.admittedAt || jobs.some(job => job.completedAt === null)) return null;
    if (activity.services.filter(service => service.buildingId === facility.id).length !== 1) return null;
    working.add(facility.id);
  }
  return { version: 1, services: activity.services.map(service => working.has(service.buildingId)
    ? { buildingId: service.buildingId, state: 'working' } : service) };
}
