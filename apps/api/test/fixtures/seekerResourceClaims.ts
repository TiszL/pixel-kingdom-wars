/** R1 fixture authority; real admission, earning, return and payout services. */
import { randomUUID } from 'node:crypto';
import { PHASE_E_HARVESTER } from '@shardkeep/shared';
import { PhaseERawResourceIdSchema } from '@shardkeep/shared/phaseEResources';
import type { Db, DbTx } from '../../src/db/client';
import { bases, baseSlots } from '../../src/db/schema';
import { assertFreshLockedBaseAuthority } from '../../src/game/baseOwnership';
import { selectHarvesterSource } from '../../src/game/harvesterSources';
import { settleDueHarvesterSources } from '../../src/game/harvesterSettlement';
import { settleDueStarterExpeditions } from '../../src/game/starterExpeditionReturns';
import { createTestPlayer } from '../helpers';
import { createHarvesterFixture } from './harvesters';

export async function createResourceTaxFixture(db: Db, options: { zeroWinners?: boolean; singleWinner?: boolean; settleHarvester?: boolean } = {}) {
 const source = await createHarvesterFixture(db), winner = await createTestPlayer(db), other = await createTestPlayer(db);
 const [base] = await db.insert(bases).values({ ownerWallet: winner.wallet, status: 'active' }).returning();
 await db.insert(baseSlots).values({ wallet: winner.wallet, slot: 1, baseId: base!.id });
 Object.assign(source.snapshot, { spots: source.snapshot.spots.map(spot => ({ ...spot,
  ownerWallet: options.zeroWinners ? null : options.singleWinner ? spot.spotId === 0 ? winner.wallet : null
   : [0, 20].includes(spot.spotId) ? winner.wallet : spot.spotId === 21 ? other.wallet : null })) });
 const trip = await source.dispatch();
 await db.transaction(tx => settleDueStarterExpeditions(tx, source.baseId, trip.returnsAt));
 const harvester = await selectHarvesterSource(db, source.wallet, { id: randomUUID(), baseId: source.baseId,
  harvesterId: source.harvesterId, policyVersion: PHASE_E_HARVESTER.currentPolicyVersion }, source.authority,
  { clock: () => source.now, reader: source.reader });
 const settle = async (ordinal: number) => db.transaction(tx => settleDueHarvesterSources(tx, source.baseId,
  new Date(harvester.admittedAt.getTime() + ordinal * PHASE_E_HARVESTER.v1.cadenceSec * 1_000)));
 if (options.settleHarvester !== false) await settle(15);
 const authority = { baseId: base!.id, assertAuthority: async (tx: DbTx, wallet: string, baseId: string) => { await assertFreshLockedBaseAuthority(tx, wallet, baseId); } };
 const command = (spotId = 0) => ({ idempotencyKey: randomUUID(), baseId: base!.id, termId: trip.termId, resourceId: PhaseERawResourceIdSchema.parse(trip.resourceId), spotId });
 return { source, winner, other, baseId: base!.id, trip, harvester, settle, authority, command };
}
