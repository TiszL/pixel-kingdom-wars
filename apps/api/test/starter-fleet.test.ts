/** Internal registry only. Fixtures create canonical-shaped completed jobs;
 * no test seeding helper is exported to the runtime or proves paid placement. */
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { BUILD_COSTS, BuildingType } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { baseRaidLocks, bases, baseSlots, builderJobs, buildings, deedOwnershipObservations, fleetInstallations, players, raids } from '../src/db/schema';
import { completeDueJobs } from '../src/game/base';
import { assertFreshLockedBaseAuthority, registerOwnedDeed, transferStableBase } from '../src/game/baseOwnership';
import { getStarterFleet, installStarterFleet, StarterFleetEvidenceSchema } from '../src/game/starterFleet';
import { connectTestDb, createTestPlayer } from './helpers';
import { isolateDeedTestFixtures } from './deed-fixtures';

const conn = connectTestDb(), db = conn.db;
afterAll(() => conn.sql.end());
const authority = (baseId: string) => ({ baseId, assertAuthority: async (tx: Parameters<typeof assertFreshLockedBaseAuthority>[0], wallet: string, id: string) => { await assertFreshLockedBaseAuthority(tx, wallet, id); } });
async function baseFixture() {
  const { wallet } = await createTestPlayer(db);
  const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active' }).returning();
  await db.insert(baseSlots).values({ wallet, slot: 1, baseId: base!.id });
  return { wallet, baseId: base!.id };
}
type Fixture = Awaited<ReturnType<typeof baseFixture>>;
async function berthFixture(f: Fixture) {
  const [berth] = await db.insert(buildings).values({ playerWallet: f.wallet, baseId: f.baseId, type: BuildingType.Berth, tx: 2, ty: 2 }).returning();
  const completedAt = new Date(Date.now() - 1_000);
  const [job] = await db.insert(builderJobs).values({ playerWallet: f.wallet, baseId: f.baseId, buildingId: berth!.id, kind: 'build',
    startedAt: new Date(completedAt.getTime() - BUILD_COSTS.berth.buildSec * 1_000), finishesAt: completedAt, completedAt }).returning();
  return { berth: berth!, job: job! };
}
const install = (f: Fixture, berthId: string) => installStarterFleet(db, f.wallet, berthId, authority(f.baseId));
const current = (f: Fixture) => getStarterFleet(db, f.wallet, authority(f.baseId));
const rows = (f: Fixture) => db.select().from(fleetInstallations).where(eq(fleetInstallations.baseId, f.baseId));

describe('starter family registry', () => {
  it('reads no installation without auto-creating, and installs only exact completed berth evidence', async () => {
    const f = await baseFixture(), b = await berthFixture(f);
    expect(await current(f)).toBeNull(); expect(await rows(f)).toEqual([]);
    const proof = await install(f, b.berth.id);
    expect(proof).toMatchObject({ baseId: f.baseId, berthId: b.berth.id, family: 'starter', installedWallet: f.wallet,
      custodyWallet: f.wallet, completedBuildJobId: b.job.id, berthCompletedAt: b.job.completedAt!.toISOString() });
    expect(await current(f)).toEqual(proof);
    expect(await installStarterFleet(db, f.wallet, b.berth.id.toUpperCase(), authority(f.baseId.toUpperCase()))).toEqual(proof);
    expect(StarterFleetEvidenceSchema.safeParse({ ...proof, uses: 100 }).success).toBe(false);
  });

  it('serializes concurrent same-berth installation to one immutable family row', async () => {
    const f = await baseFixture(), b = await berthFixture(f);
    const all = await Promise.all(Array.from({ length: 5 }, () => install(f, b.berth.id)));
    expect(new Set(all.map(p => p.installationId)).size).toBe(1); expect(await rows(f)).toHaveLength(1);
  });

  it('allows one winner for different concurrent berths competing for the same family', async () => {
    const f = await baseFixture(), a = await berthFixture(f), b = await berthFixture(f);
    const all = await Promise.allSettled([install(f, a.berth.id), install(f, b.berth.id)]);
    expect(all.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(all.filter(r => r.status === 'rejected')).toHaveLength(1); expect(await rows(f)).toHaveLength(1);
  });

  it.each(['missing', 'wrong-type', 'other-base', 'legacy-base', 'no-build-proof', 'unfinished'] as const)('refuses %s berth instead of inventing completion', async invalid => {
    const f = await baseFixture(), b = await berthFixture(f);
    let id = b.berth.id;
    if (invalid === 'missing') id = randomUUID();
    if (invalid === 'wrong-type') await db.update(buildings).set({ type: BuildingType.Camp }).where(eq(buildings.id, id));
    if (invalid === 'other-base') await db.update(buildings).set({ baseId: (await baseFixture()).baseId }).where(eq(buildings.id, id));
    if (invalid === 'legacy-base') await db.update(buildings).set({ baseId: null }).where(eq(buildings.id, id));
    if (invalid === 'no-build-proof') await db.delete(builderJobs).where(eq(builderJobs.id, b.job.id));
    if (invalid === 'unfinished') await db.update(builderJobs).set({ completedAt: null }).where(eq(builderJobs.id, b.job.id));
    await expect(install(f, id)).rejects.toMatchObject({ code: 'STARTER_BERTH_UNAVAILABLE' });
    expect(await rows(f)).toEqual([]);
  });

  it.each(['wallet', 'inactive', 'slot', 'authority'] as const)('reauthorizes %s before install or reading saved evidence', async failure => {
    const f = await baseFixture(), b = await berthFixture(f), proof = await install(f, b.berth.id);
    let wallet = f.wallet;
    if (failure === 'wallet') wallet = (await createTestPlayer(db)).wallet;
    if (failure === 'inactive') await db.update(bases).set({ status: 'inactive' }).where(eq(bases.id, f.baseId));
    if (failure === 'slot') await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    const ctx = authority(f.baseId);
    if (failure === 'authority') ctx.assertAuthority = async () => { throw new Error('authority unavailable'); };
    await expect(installStarterFleet(db, wallet, b.berth.id, ctx)).rejects.toThrow();
    await expect(getStarterFleet(db, wallet, ctx)).rejects.toThrow();
    expect((await rows(f))[0]!.id).toBe(proof.installationId);
  });

  it('does not complete a due job implicitly; canonical completion admits its berth afterward', async () => {
    const f = await baseFixture(), b = await berthFixture(f);
    await db.update(builderJobs).set({ completedAt: null }).where(eq(builderJobs.id, b.job.id));
    await expect(install(f, b.berth.id)).rejects.toMatchObject({ code: 'STARTER_BERTH_UNAVAILABLE' });
    expect((await db.select().from(builderJobs).where(eq(builderJobs.id, b.job.id)))[0]!.completedAt).toBeNull();
    await completeDueJobs(db, f.wallet, new Date(), f.baseId);
    expect((await install(f, b.berth.id)).completedBuildJobId).toBe(b.job.id);
  });

  it('refuses an actual raid lock without creating an installation', async () => {
    const f = await baseFixture(), attacker = await baseFixture(), b = await berthFixture(f);
    const [raid] = await db.insert(raids).values({ idempotencyKey: randomUUID(), attackerWallet: attacker.wallet,
      attackerBaseId: attacker.baseId, defenderWallet: f.wallet, defenderBaseId: f.baseId,
      seed: 1n, snapshot: {}, armySnapshot: {}, simVersion: 9, ordersDeadlineAt: new Date(Date.now() + 60_000) }).returning();
    await db.insert(baseRaidLocks).values({ baseId: f.baseId, raidId: raid!.id, expiresAt: new Date(Date.now() + 60_000) });
    await expect(install(f, b.berth.id)).rejects.toMatchObject({ code: 'BASE_BEING_RAIDED' });
    await expect(current(f)).rejects.toMatchObject({ code: 'BASE_BEING_RAIDED' }); expect(await rows(f)).toEqual([]);
  });

  it('keeps installation through first-land upgrade and real deed transfer without rebinding historical wallets', async () => {
    // Registration really admits a deed; prior suites must not consume this
    // test's observer capacity. Restore their exact slot state even on failure.
    const restore = await isolateDeedTestFixtures(db);
    try {
      const f = await baseFixture(), b = await berthFixture(f), proof = await install(f, b.berth.id);
      const mint = Keypair.generate().publicKey.toBase58();
      expect((await registerOwnedDeed(db, f.wallet, mint)).id).toBe(f.baseId);
      await db.insert(deedOwnershipObservations).values({ baseId: f.baseId, assetId: mint, owner: f.wallet, slot: 100n,
        checkedAt: new Date(), status: 'owned', source: 'rpc-finalized', auditHash: randomUUID() });
      expect(await current(f)).toEqual(proof);
      // ownershipEligible intentionally refuses off-curve escrow/PDA owners.
      const buyer = { wallet: Keypair.generate().publicKey.toBase58() };
      await db.insert(players).values(buyer);
      await transferStableBase(db, f.baseId, f.wallet, buyer.wallet, mint, { owner: buyer.wallet, collection: 'test', frozen: false, delegate: null, slot: 101, observedAtMs: Date.now() });
      const moved = { wallet: buyer.wallet, baseId: f.baseId };
      expect(await current(moved)).toEqual({ ...proof, custodyWallet: buyer.wallet });
      expect(await install(moved, b.berth.id)).toEqual({ ...proof, custodyWallet: buyer.wallet });
      expect((await db.select().from(buildings).where(eq(buildings.id, b.berth.id)))[0]!.playerWallet).toBe(f.wallet);
      expect((await db.select().from(builderJobs).where(eq(builderJobs.id, b.job.id)))[0]!.playerWallet).toBe(f.wallet);
      await expect(current(f)).rejects.toMatchObject({ code: 'BASE_NOT_OWNED' }); expect(await rows(f)).toHaveLength(1);
    } finally { await restore(); }
  });

  it('rolls back the registry if its surrounding command fails', async () => {
    const f = await baseFixture(), b = await berthFixture(f);
    await expect(db.transaction(async tx => {
      await installStarterFleet(tx, f.wallet, b.berth.id, authority(f.baseId)); throw new Error('command failed');
    })).rejects.toThrow('command failed'); expect(await rows(f)).toEqual([]);
  });

  it('restricts deletion of bound berth/build proof and never mutates or replaces installation history', async () => {
    const f = await baseFixture(), b = await berthFixture(f), proof = await install(f, b.berth.id);
    await expect(db.delete(buildings).where(eq(buildings.id, b.berth.id))).rejects.toThrow();
    await expect(db.delete(builderJobs).where(eq(builderJobs.id, b.job.id))).rejects.toThrow();
    await expect(db.update(fleetInstallations).set({ installedWallet: (await createTestPlayer(db)).wallet }).where(eq(fleetInstallations.id, proof.installationId))).rejects.toThrow();
    await expect(db.delete(fleetInstallations).where(eq(fleetInstallations.id, proof.installationId))).rejects.toThrow();
    expect(await current(f)).toEqual(proof);
  });

  it.each(['type', 'base', 'completion'] as const)('rejects a saved installation if current %s validity changes', async invalid => {
    const f = await baseFixture(), b = await berthFixture(f), proof = await install(f, b.berth.id);
    if (invalid === 'type') await db.update(buildings).set({ type: BuildingType.Camp }).where(eq(buildings.id, b.berth.id));
    if (invalid === 'base') await db.update(buildings).set({ baseId: (await baseFixture()).baseId }).where(eq(buildings.id, b.berth.id));
    if (invalid === 'completion') await db.update(builderJobs).set({ completedAt: new Date(b.job.completedAt!.getTime() + 1) }).where(eq(builderJobs.id, b.job.id));
    await expect(current(f)).rejects.toMatchObject({ code: 'STARTER_BERTH_UNAVAILABLE' });
    await expect(install(f, b.berth.id)).rejects.toMatchObject({ code: 'STARTER_BERTH_UNAVAILABLE' });
    expect((await rows(f))[0]!.id).toBe(proof.installationId);
  });

  it('SQL refuses forged family/berth/job facts even before a caller can publish evidence', async () => {
    const f = await baseFixture(), b = await berthFixture(f), other = await berthFixture(f);
    const row = { baseId: f.baseId, berthId: b.berth.id, family: 'starter' as const,
      installedWallet: f.wallet, completedBuildJobId: b.job.id, berthCompletedAt: b.job.completedAt! };
    await expect(db.insert(fleetInstallations).values({ ...row, family: 'advanced' as 'starter' })).rejects.toThrow();
    await expect(db.insert(fleetInstallations).values({ ...row, completedBuildJobId: other.job.id })).rejects.toThrow();
    await expect(db.insert(fleetInstallations).values({ ...row, installedWallet: (await createTestPlayer(db)).wallet })).rejects.toThrow();
    expect(await rows(f)).toEqual([]);
  });
});
