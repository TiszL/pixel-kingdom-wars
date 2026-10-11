/** Synthetic HTTP/SQL term evidence only; never genuine timed eligibility. */
import { randomUUID } from 'node:crypto';
import { BUILD_COSTS, BuildingType, PHASE_E_HARVESTER } from '@shardkeep/shared';
import type { HarvesterSourceRequest } from '@shardkeep/shared/harvesterApi';
import type { Db } from '../../src/db/client';
import { builderJobs, buildings } from '../../src/db/schema';
import { createStarterExpeditionFixture } from './starterExpeditions';

export async function createHarvesterFixture(db: Db, options: { wallet?: string; now?: Date } = {}) {
  const f = await createStarterExpeditionFixture(db, { ...options, now: options.now ?? new Date() });
  const [facility] = await db.insert(buildings).values({ baseId: f.baseId, playerWallet: f.wallet,
    type: BuildingType.Harvester, tx: 9, ty: 2 }).returning();
  const completedAt = new Date(f.now.getTime() - 1_000);
  const [job] = await db.insert(builderJobs).values({ baseId: f.baseId, playerWallet: f.wallet, buildingId: facility!.id, kind: 'build',
    startedAt: new Date(completedAt.getTime() - BUILD_COSTS[BuildingType.Harvester].buildSec * 1_000), finishesAt: completedAt, completedAt }).returning();
  const request: HarvesterSourceRequest = { idempotencyKey: randomUUID(), baseId: f.baseId, harvesterId: facility!.id,
    expectedSourceId: null, policyVersion: PHASE_E_HARVESTER.currentPolicyVersion };
  return { ...f, harvesterId: facility!.id, jobId: job!.id, request,
    reader: { async readOperatingTerm(at = f.now.toISOString()) { return { snapshot: f.snapshot,
      finality: { commitment: 'finalized' as const, contextSlot: '200', observedAt: at } }; } } };
}
