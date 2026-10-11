/** Shared positive Lodge completion, inside an authorized locked base snapshot. */
import { BuildingType } from '@shardkeep/shared';
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import { builderJobs, buildings } from '../db/schema';

/** Does not complete jobs or grant authority. The caller compares the returned
 * original completion with its post-lock cutoff before advertising/admitting. */
export async function readCompletedLodge(tx: DbTx, baseId: string): Promise<Date | null> {
  const lodges = await tx.select().from(buildings).where(and(eq(buildings.baseId, baseId), eq(buildings.type, BuildingType.Lodge)))
    .orderBy(asc(buildings.id)).for('update');
  for (const lodge of lodges) {
    if (lodge.level < 1) continue;
    const [pending] = await tx.select({ id: builderJobs.id }).from(builderJobs).where(and(
      eq(builderJobs.buildingId, lodge.id), eq(builderJobs.kind, 'build'), isNull(builderJobs.completedAt))).limit(1);
    if (pending) continue;
    const [completed] = await tx.select().from(builderJobs).where(and(eq(builderJobs.baseId, baseId),
      eq(builderJobs.buildingId, lodge.id), eq(builderJobs.kind, 'build'), isNotNull(builderJobs.completedAt), isNull(builderJobs.cancelledAt)))
      .orderBy(asc(builderJobs.completedAt), asc(builderJobs.id)).limit(1);
    if (completed?.completedAt) return completed.completedAt;
  }
  return null;
}
