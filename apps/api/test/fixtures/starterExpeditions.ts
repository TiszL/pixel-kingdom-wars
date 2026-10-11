/** Synthetic DB-test authority only. Never imported by production; this reader
 * does NOT prove a real finalized auction. Acceptance still uses real service. */
import { randomUUID } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { BUILD_COSTS, BuildingType, PHASE_E_POLICY } from '@shardkeep/shared';
import { starterRoutePreview } from '@shardkeep/shared/phaseEExpeditions';
import bs58 from 'bs58';
import type { Db } from '../../src/db/client';
import { bases, baseSlots, builderJobs, buildings } from '../../src/db/schema';
import { assertFreshLockedBaseAuthority } from '../../src/game/baseOwnership';
import { dispatchStarterExpedition, type StarterExpeditionCommand } from '../../src/game/starterExpeditionDispatch';
import type { ExpeditionTermReader, ExpeditionTermSnapshot } from '../../src/game/expeditionTerms';
import { installStarterFleet } from '../../src/game/starterFleet';
import { createTestPlayer } from '../helpers';

export async function createStarterExpeditionFixture(db: Db, options: { wallet?: string; now?: Date } = {}) {
  const wallet = options.wallet ?? (await createTestPlayer(db)).wallet;
  const now = options.now ?? new Date('2035-01-01T01:00:00.000Z');
  const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active' }).returning();
  const baseId = base!.id;
  // Each normal fixture owns its wallet. Optional wallet callers must provide a
  // wallet with room for this slot; fixtures do not bypass custody constraints.
  await db.insert(baseSlots).values({ wallet, slot: 1, baseId });
  const authority = { baseId, assertAuthority: async (tx: Parameters<typeof assertFreshLockedBaseAuthority>[0], actor: string, id: string) => {
    await assertFreshLockedBaseAuthority(tx, actor, id);
  } };
  async function facility(type: BuildingType.Berth | BuildingType.Lodge, x: number) {
    const [building] = await db.insert(buildings).values({ playerWallet: wallet, baseId, type, tx: x, ty: 2 }).returning();
    // Synthetic future dispatch clocks must not invent a berth completed after
    // the real installation timestamp. Freeze a genuinely earlier facility
    // baseline; dispatch/return timing still uses the caller's explicit clock.
    const completedAt = new Date(Math.min(now.getTime(), Date.now()) - 1_000);
    const [job] = await db.insert(builderJobs).values({ playerWallet: wallet, baseId, buildingId: building!.id, kind: 'build',
      startedAt: new Date(completedAt.getTime() - BUILD_COSTS[type].buildSec * 1_000), finishesAt: completedAt, completedAt }).returning();
    return { building: building!, job: job! };
  }
  const berth = await facility(BuildingType.Berth, 2), lodge = await facility(BuildingType.Lodge, 5);
  const installation = await installStarterFleet(db, wallet, berth.building.id, authority);
  const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte)).toBase58();
  const startsAt = new Date(now.getTime() - 3_600_000).toISOString();
  const snapshot: ExpeditionTermSnapshot = { version: 1, termId: randomUUID(), startsAt,
    endsAt: new Date(Date.parse(startsAt) + PHASE_E_POLICY.seekerIsland.operatingTermSec * 1_000).toISOString(),
    source: { kind: 'solana_auction_round', genesisHash: key(201), programId: key(202), auctionConfig: Keypair.generate().publicKey.toBase58(), round: '1' },
    spots: Array.from({ length: PHASE_E_POLICY.seekerIsland.totalSpots }, (_, spotId) => ({ spotId, ownerWallet: null,
      auctionAccount: key(spotId + 1), settlementSignature: bs58.encode(new Uint8Array(64).fill(7)), settlementSlot: String(100 + spotId), termsHash: 'ab'.repeat(32) })) };
  // Each synthetic attempt observes at its requested admission time. Tests of
  // stale/future observations still replace this reader with their exact proof.
  const reader: ExpeditionTermReader = { async readOperatingTerm(dispatchAt) {
    return { snapshot, finality: { commitment: 'finalized', observedAt: dispatchAt, contextSlot: '200' } };
  } };
  const preview = starterRoutePreview('crownlands', 'introduction');
  const command: StarterExpeditionCommand = { id: randomUUID(), baseId, installationId: installation.installationId,
    routeId: preview.routeId, routeVersion: preview.routeCatalogueVersion, rewardVersion: preview.rewardTableVersion };
  const f = { wallet, baseId, installationId: installation.installationId, berthId: berth.building.id,
    lodgeId: lodge.building.id, lodgeJobId: lodge.job.id, authority, command, reader, snapshot, now,
    dispatch: (): ReturnType<typeof dispatchStarterExpedition> => dispatchStarterExpedition(db, f.wallet, f.command, f.authority, { reader: f.reader, clock: () => f.now }),
  };
  return f;
}
