import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import type { Db } from '../src/db/client';
import { bases, baseSlots, deedOwnershipObservations, players } from '../src/db/schema';
import { fantasyManifestHash, planFantasyMigration, rehearseFantasyMigration } from '../src/db/fantasyMigration';

export async function fantasyBaseFixture(db: Db, options: { inactive?: boolean; installClaim?: boolean; snapshotAt?: Date } = {}) {
  const now = options.snapshotAt ?? new Date();
  const wallet = Keypair.generate().publicKey.toBase58();
  const mintId = Keypair.generate().publicKey.toBase58();
  const baseId = randomUUID();
  await db.insert(players).values({ wallet });
  await db.insert(bases).values({ id: baseId, ownerWallet: wallet, deedAssetId: mintId,
    landPaidAt: now, status: options.inactive ? 'inactive' : 'active' });
  if (!options.inactive) await db.insert(baseSlots).values({ wallet, slot: 1, baseId });
  await db.insert(deedOwnershipObservations).values({ baseId, assetId: mintId, owner: wallet,
    slot: 100n, checkedAt: now, status: 'owned', source: 'rpc-finalized', auditHash: randomUUID() });
  const identity = { baseId, mintId, ownerWallet: wallet };
  if (options.installClaim) {
    const claims = await db.query.fantasyLandClaims.findMany();
    const manifest = planFantasyMigration({ snapshotAt: now.toISOString(),
      active: options.inactive ? [] : [identity], inactive: options.inactive ? [identity] : [], exclusions: [],
      unavailableTileIds: claims.filter((claim) => claim.state !== 'released').map((claim) => claim.tileId) });
    await rehearseFantasyMigration(db, manifest, fantasyManifestHash(manifest));
  }
  return { ...identity, wallet, now };
}
