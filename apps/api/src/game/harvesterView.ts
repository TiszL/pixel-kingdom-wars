/** Authorized selected-base projection; never assign a home or renew a lease. */
import { BuildingType } from '@shardkeep/shared';
import { harvesterPolicyV1 } from '@shardkeep/shared/harvesterApi';
import { and, asc, eq, gte, inArray, or } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import { bases, builderJobs, buildings, harvesterSourceHeads } from '../db/schema';
import { readExpeditionHomePreview } from './expeditionHome';
import { harvesterSourceSummary } from './harvesterCommands';
import { readHarvesterSource } from './harvesterSources';

/** Caller owns its player/base/slot and has settled accepted earning at cutoff.
 * The wallet's other-base head is immutable public metadata only: no extra base
 * lock or settlement after this base's accounting locks. */
export async function readHarvesterView(tx: DbTx, base: typeof bases.$inferSelect, cutoff: Date) {
  const candidates = await tx.select().from(buildings).where(and(eq(buildings.baseId, base.id),
    eq(buildings.type, BuildingType.Harvester), gte(buildings.level, 1))).orderBy(asc(buildings.id));
  const jobs = candidates.length ? await tx.select().from(builderJobs).where(and(eq(builderJobs.baseId, base.id),
    eq(builderJobs.kind, 'build'), inArray(builderJobs.buildingId, candidates.map(row => row.id)))) : [];
  const facilities = candidates.flatMap(row => {
    const matching = jobs.filter(job => job.buildingId === row.id);
    const completed = matching.find(job => job.completedAt !== null && job.cancelledAt === null && job.completedAt <= cutoff);
    return completed?.completedAt && !matching.some(job => job.completedAt === null)
      ? [{ baseId: base.id, harvesterId: row.id, completedBuildJobId: completed.id, harvesterCompletedAt: completed.completedAt.toISOString() }] : [];
  });
  const heads = await tx.select().from(harvesterSourceHeads).where(or(eq(harvesterSourceHeads.wallet, base.ownerWallet), eq(harvesterSourceHeads.baseId, base.id)));
  const own = heads.find(head => head.wallet === base.ownerWallet);
  const original = own ? await readHarvesterSource(tx, own.sourceId) : null;
  if (own && (!original || original.actorWallet !== base.ownerWallet || original.baseId !== own.baseId))
    throw new Error('Current Harvester head differs from original source');
  const walletSource = original ? harvesterSourceSummary(original) : null;
  return { serverNow: cutoff.toISOString(), home: await readExpeditionHomePreview(tx, base), facilities,
    source: walletSource?.baseId === base.id ? walletSource : null, walletSource, policy: harvesterPolicyV1() };
}
