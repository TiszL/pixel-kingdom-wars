/** Five-base invariants: identity is explicit, activation is capped, transfers
 * move only the base owner, and reservations freeze before payment. */
import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { BASE_OWNERSHIP, BuildingType, CAPS, FORGE, GLOBE, OBSTACLES } from '@shardkeep/shared';
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import type { Db, DbTx } from '../src/db/client';
import {
  baseRaidLocks, bases, baseSlots, baseTransfers, buildings, builderJobs, deedOwnershipObservations, deposits,
  baseForgePositions, baseItems, forgeContributions, ledgerTransactions, mineState, obstacles, playerItems,
  players, plotReservations, plots, raids, streaks, valleys,
} from '../src/db/schema';
import {
  activateBase, assertFreshLockedActiveBaseAuthorities, assertFreshLockedBaseAuthority,
  DeedReadUnavailableError, ensureWalletBaseIdentity, listWalletBases, lockActiveBase,
  maxActiveBaseKeepLevel, refreshBaseOwnership, registerOwnedDeed, reserveEarthCell,
  requireFreshBaseAuthority, sweepActiveBaseOwnership, transferStableBase,
  requireFreshActiveBaseAuthorities,
} from '../src/game/baseOwnership';
import { HttpError } from '../src/lib/errors';
import { getGlobeSnapshot, resetGlobeCache } from '../src/lib/globeCache';
import { getValleySnapshot, resetMapCache } from '../src/lib/mapCache';
import {
  clearObstacle, completeDueJobs, ensureStartingBase, moveBuilding, moveWallsBatch, placeBuilding, speedupJob,
  upgradeBuilding, type StableBaseMutationContext,
} from '../src/game/base';
import { rewardShards } from '../src/game/spend';
import { getOrCreateBaseAccount, getOrCreatePlayerAccount } from '../src/ledger';
import { rewardBaseShards } from '../src/game/baseEconomy';
import {
  claimDailyCache, collectMine, ensureMineState, getMineStatus, type MineMutationContext,
} from '../src/game/emission';
import { ensureBasePlotAssigned } from '../src/game/world';
import { buyItem, useItem } from '../src/game/items';
import { configureDeedMinter, mintDeedIfConfigured, type DeedMinter } from '../src/game/deed';
import {
  createDepositIntent, creditDeposit, nextLandPurchaseKind, type DepositStableAuthorityContext,
  type VerifiedPayment,
} from '../src/money/deposits';
import { verifyDepositNow, type DepositVerifier } from '../src/money/depositWatcher';
import { getPersonalWithdrawalLimit, requestWithdrawal } from '../src/money/withdrawals';
import { contributeToForge, forgeDayOf, type ForgeStableBaseContext } from '../src/game/forge';
import {
  connectTestDb, createTestPlayer, createTestValley, fundTestKeep, randomWallet, seedPlots, TEST_CONFIG,
} from './helpers';
import { isolateDeedTestFixtures } from './deed-fixtures';

let ctx: ReturnType<typeof connectTestDb>;
let db: Db;

const mockDeedMinter = (
  assetFor: (operationId: string) => string,
  onMint: () => Promise<void> | void = () => {},
): DeedMinter => ({
  assetFor,
  mint: async (_owner, _operationId, asset) => { await onMint(); return { asset }; },
});

const mineAuthority: MineMutationContext = {
  assertActiveAuthority: async (tx, wallet) => {
    await assertFreshLockedActiveBaseAuthorities(tx, wallet);
  },
};

async function starter() {
  const p = await onCurvePlayer();
  await db.insert(buildings).values({ playerWallet: p.wallet, type: 'keep', tx: 14, ty: 14 });
  const baseId = await ensureWalletBaseIdentity(db, p.wallet);
  expect(baseId).toBeTruthy();
  return { ...p, baseId: baseId! };
}

async function onCurvePlayer() {
  // Finalized Core ownership accepts only signable wallet owners. The generic
  // ledger fixture intentionally uses arbitrary 32-byte values, so deed tests
  // create a real keypair-backed identity instead.
  const wallet = Keypair.generate().publicKey.toBase58();
  await db.insert(players).values({ wallet });
  const account = await getOrCreatePlayerAccount(db, wallet, 'player_keep');
  return { wallet, keepAccountId: account.id };
}

async function smallObstacleFor(playerWallet: string, baseId: string) {
  const [obstacle] = await db.insert(obstacles).values({
    playerWallet, baseId,
    spriteKey: OBSTACLES.tiers.small.kinds[0], tx: 2, ty: 2,
  }).returning();
  return obstacle!;
}

/** Hold the canonical wallet root, then commit an authority change only after
 * the protected action has entered its transaction and is waiting behind it. */
async function holdWalletAuthorityChange(
  wallet: string, change: (tx: DbTx) => Promise<void>,
) {
  let markLocked!: () => void;
  let releaseChange!: () => void;
  const locked = new Promise<void>((resolve) => { markLocked = resolve; });
  const release = new Promise<void>((resolve) => { releaseChange = resolve; });
  const done = db.transaction(async (tx) => {
    await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    markLocked();
    await release;
    await change(tx);
  });
  await Promise.race([
    locked,
    done.then(() => { throw new Error('authority change completed before its barrier was released'); }),
  ]);
  return { release: releaseChange, done };
}

const depositPayment = (
  wallet: string, kind: 'builder' | 'expansion', lamports: bigint,
): VerifiedPayment => ({
  wallet, kind, lamports, finalized: true, txSignature: `stable-deposit-${randomWallet()}`,
});

async function primeWorldCaches(valleyIds: readonly string[]) {
  resetGlobeCache();
  resetMapCache();
  const nowMs = Date.now();
  let globeLoads = 0;
  const valleyLoads = new Map<string, number>();
  const readGlobe = () => getGlobeSnapshot(GLOBE.cacheSec, async () => {
    globeLoads++;
    return {
      at: nowMs, sectors: [], bySector: new Map(), legacyBySector: new Map(),
      byKeepLevel: new Map(), byValleyId: new Map(),
    };
  }, nowMs);
  const readValley = (valleyId: string) => getValleySnapshot(valleyId, false, async () => {
    valleyLoads.set(valleyId, (valleyLoads.get(valleyId) ?? 0) + 1);
    return { valleyId, valleyName: valleyId, players: [], camps: [] };
  }, nowMs);
  await readGlobe();
  await Promise.all(valleyIds.map(readValley));
  return {
    readGlobe, readValley,
    globeLoads: () => globeLoads,
    valleyLoads: (valleyId: string) => valleyLoads.get(valleyId) ?? 0,
  };
}

let restoreDeedFixtures = async () => {};
beforeAll(async () => {
  ctx = connectTestDb(); db = ctx.db;
  restoreDeedFixtures = await isolateDeedTestFixtures(db, { observerQueue: true });
});
afterAll(async () => {
  try { await restoreDeedFixtures(); } finally { await ctx.sql.end(); }
});

describe('stable multi-base ownership', () => {
  it('rechecks fresh deed evidence inside standard and instant withdrawal settlement', async () => {
    const prior = process.env['MULTI_BASE_ENABLED'];
    process.env['MULTI_BASE_ENABLED'] = 'true';
    try {
      const owner = await starter();
      const deed = Keypair.generate().publicKey.toBase58();
      await db.update(bases).set({ landPaidAt: new Date(), deedAssetId: deed })
        .where(eq(bases.id, owner.baseId));
      await db.insert(deedOwnershipObservations).values({
        baseId: owner.baseId,
        assetId: deed,
        owner: owner.wallet,
        slot: 800n,
        checkedAt: new Date(Date.now() - BASE_OWNERSHIP.mutationFreshnessMs - 1),
        source: 'test',
        status: 'owned',
        auditHash: createHash('sha256').update(`withdraw-stale:${owner.baseId}`).digest('hex'),
      });
      await fundTestKeep(db, owner.wallet, 10_000n, 'test.withdraw-stale', randomWallet());
      const destination = Keypair.generate().publicKey.toBase58();
      await expect(requestWithdrawal(db, owner.wallet, 1_000n, destination, randomWallet()))
        .rejects.toMatchObject({ code: 'DEED_AUTHORITY_UNAVAILABLE' });
      const authorize = vi.fn(async () => true);
      await expect(requestWithdrawal(
        db, owner.wallet, 1_000n, destination, randomWallet(), { instant: true, authorize },
      )).rejects.toMatchObject({ code: 'DEED_AUTHORITY_UNAVAILABLE' });
      expect(authorize).not.toHaveBeenCalled();
    } finally {
      if (prior === undefined) delete process.env['MULTI_BASE_ENABLED'];
      else process.env['MULTI_BASE_ENABLED'] = prior;
    }
  });

  it('derives the withdrawal cap from remaining active paid bases after a high-level deed sale', async () => {
    const prior = process.env['MULTI_BASE_ENABLED'];
    process.env['MULTI_BASE_ENABLED'] = 'true';
    try {
      const seller = await starter();
      const soldDeed = Keypair.generate().publicKey.toBase58();
      await db.update(players).set({ keepLevel: 20, entryPaidAt: new Date(), deedAssetId: soldDeed })
        .where(eq(players.wallet, seller.wallet));
      await db.update(bases).set({ keepLevel: 20, landPaidAt: new Date(), deedAssetId: soldDeed })
        .where(eq(bases.id, seller.baseId));
      const remainingDeeds = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
      const remaining = await db.insert(bases).values(remainingDeeds.map((deedAssetId) => ({
        ownerWallet: seller.wallet,
        keepLevel: 1,
        landPaidAt: new Date(),
        deedAssetId,
      }))).returning({ id: bases.id });
      await db.insert(baseSlots).values(remaining.map((base, index) => ({
        wallet: seller.wallet, slot: index + 2, baseId: base.id,
      })));
      await db.insert(deedOwnershipObservations).values(remaining.map((base, index) => ({
        baseId: base.id,
        assetId: remainingDeeds[index]!,
        owner: seller.wallet,
        slot: BigInt(700 + index),
        checkedAt: new Date(),
        source: 'test',
        status: 'owned' as const,
        auditHash: createHash('sha256').update(`withdraw-cap:${base.id}`).digest('hex'),
      })));
      await transferStableBase(
        db, seller.baseId, seller.wallet, Keypair.generate().publicKey.toBase58(), soldDeed,
      );
      await fundTestKeep(db, seller.wallet, 100_000n, 'test.stable-withdraw-cap', randomWallet());

      // The stale compatibility scalar is deliberately still L20 because two
      // bases remain. It must not preserve the sold base's L20 allowance.
      expect((await db.select({ level: players.keepLevel }).from(players)
        .where(eq(players.wallet, seller.wallet)))[0]!.level).toBe(20);
      await expect(getPersonalWithdrawalLimit(db, seller.wallet)).resolves.toMatchObject({
        personalDailyLimitKeep: '50000',
        personalDailyUsedKeep: '0',
        personalDailyRemainingKeep: '50000',
        governingKeepLevel: 1,
        nextAvailableAt: null,
      });
      await expect(requestWithdrawal(
        db, seller.wallet, 60_000n, Keypair.generate().publicKey.toBase58(), randomWallet(),
      )).rejects.toThrow(/daily withdrawal cap is 50000 KEEP at Keep level 1/);
    } finally {
      if (prior === undefined) delete process.env['MULTI_BASE_ENABLED'];
      else process.env['MULTI_BASE_ENABLED'] = prior;
    }
  });

  it('dual-writes flag-off scalar/deed changes for authoritative flag-on reads', async () => {
    const prior = process.env['MULTI_BASE_ENABLED'];
    const owner = await starter();
    const paidAt = new Date('2026-08-12T01:00:00.000Z');
    const deed = Keypair.generate().publicKey.toBase58();
    try {
      process.env['MULTI_BASE_ENABLED'] = 'false';
      await db.update(players).set({ entryPaidAt: paidAt, keepLevel: 20 })
        .where(eq(players.wallet, owner.wallet));
      await db.update(bases).set({ landPaidAt: paidAt, keepLevel: 20 })
        .where(eq(bases.id, owner.baseId));
      const builder = await createDepositIntent(db, owner.wallet, 'builder');
      const builderPrice = BigInt(Math.round(CAPS.builderPricesSol[0]! * 1_000_000_000));
      await creditDeposit(db, builder.id, depositPayment(owner.wallet, 'builder', builderPrice), paidAt);
      const expansion = await createDepositIntent(db, owner.wallet, 'expansion');
      const expansionPrice = BigInt(Math.round(CAPS.expansionPriceSolByIndex[0]! * 1_000_000_000));
      await creditDeposit(db, expansion.id, depositPayment(owner.wallet, 'expansion', expansionPrice), paidAt);
      configureDeedMinter(mockDeedMinter(() => deed));
      await mintDeedIfConfigured(db, owner.wallet, owner.baseId);

      process.env['MULTI_BASE_ENABLED'] = 'true';
      expect((await db.select().from(bases).where(eq(bases.id, owner.baseId)))[0])
        .toMatchObject({ builders: 2, expansions: 1, deedAssetId: deed, landPaidAt: paidAt });
      await expect(requireFreshBaseAuthority(db, owner.wallet, owner.baseId, async () => ({
        owner: owner.wallet, frozen: false, delegate: null, collection: 'collection', slot: 500,
      }), 'collection')).resolves.toMatchObject({ id: owner.baseId, deedAssetId: deed });
    } finally {
      configureDeedMinter(null);
      if (prior === undefined) delete process.env['MULTI_BASE_ENABLED'];
      else process.env['MULTI_BASE_ENABLED'] = prior;
    }
  });

  it('relocates the free base for the first deed, caps activation at five, and keeps extras inactive', async () => {
    const p = await starter();
    const firstId = (await registerOwnedDeed(db, p.wallet, `deed-${randomWallet()}`)).id;
    expect(firstId).toBe(p.baseId);
    for (let i = 1; i < 6; i++) await registerOwnedDeed(db, p.wallet, `deed-${randomWallet()}`);

    const all = await listWalletBases(db, p.wallet);
    expect(all).toHaveLength(6);
    expect(all.filter((b) => b.status === 'active')).toHaveLength(5);
    expect(all.filter((b) => b.status === 'inactive' && b.slot === null)).toHaveLength(1);

    await expect(db.transaction((tx) => lockActiveBase(tx, p.wallet))).rejects.toMatchObject({
      code: 'BASE_ID_REQUIRED',
    });
    const chosen = all.find((b) => b.slot === 2)!;
    await expect(db.transaction((tx) => lockActiveBase(tx, p.wallet, chosen.id)))
      .resolves.toMatchObject({ base: { id: chosen.id } });
    await expect(db.transaction((tx) => lockActiveBase(tx, randomWallet(), chosen.id)))
      .rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
  });

  it('serializes concurrent first reads into one stable base and one slot', async () => {
    const p = await createTestPlayer(db);
    await db.insert(buildings).values({ playerWallet: p.wallet, type: 'keep', tx: 14, ty: 14 });
    const ids = await Promise.all(Array.from({ length: 8 }, () => ensureWalletBaseIdentity(db, p.wallet)));
    expect(new Set(ids).size).toBe(1);
    expect(await db.select().from(bases).where(eq(bases.ownerWallet, p.wallet))).toHaveLength(1);
    expect(await db.select().from(baseSlots).where(eq(baseSlots.wallet, p.wallet))).toHaveLength(1);
  });

  it('registering one deed twice is idempotent and cannot consume another slot', async () => {
    const p = await starter();
    const deed = `deed-${randomWallet()}`;
    const a = await registerOwnedDeed(db, p.wallet, deed);
    const b = await registerOwnedDeed(db, p.wallet, deed);
    expect(b.id).toBe(a.id);
    expect(await listWalletBases(db, p.wallet)).toHaveLength(1);
  });

  it('recovers a transferred pending mint onto its exact paid base, never the buyer free base', async () => {
    // Send X landed, the RPC threw, and X moved wallets before the retry could
    // attach it. The reservation is the base identity: registering X for the
    // buyer must atomically attach+transfer the seller base, not stamp the
    // buyer's free base and make one land payment support two bases.
    const seller = await starter();
    const buyer = await starter();
    const deed = Keypair.generate().publicKey.toBase58();
    await db.update(players).set({
      entryPaidAt: new Date(), deedMintAssetId: deed,
    }).where(eq(players.wallet, seller.wallet));
    await db.update(bases).set({
      landPaidAt: new Date(), deedMintAssetId: deed, deedMintingAt: null,
    }).where(eq(bases.id, seller.baseId));

    const recovered = await registerOwnedDeed(db, buyer.wallet, deed, {
      expectedCollection: 'collection',
      ownerOf: async () => ({
        owner: buyer.wallet, frozen: false, delegate: null,
        collection: 'collection', slot: 900,
      }),
    });
    expect(recovered).toMatchObject({
      id: seller.baseId, ownerWallet: buyer.wallet,
      deedAssetId: deed, deedMintAssetId: deed,
    });
    const buyerBases = await db.select().from(bases).where(eq(bases.ownerWallet, buyer.wallet));
    expect(buyerBases).toHaveLength(2);
    expect(buyerBases.filter((base) => base.landPaidAt !== null)).toHaveLength(1);
    expect(buyerBases.find((base) => base.id === buyer.baseId)).toMatchObject({
      deedAssetId: null, deedMintAssetId: null, landPaidAt: null,
    });
    expect(await db.select().from(bases).where(eq(bases.ownerWallet, seller.wallet))).toHaveLength(0);
  });

  it('keeps an inactive reserved recovery inactive until the canonical activation gate', async () => {
    // Recovery first acquires the deed registry lock while attaching the exact
    // asset. It must not then acquire observer capacity in the reverse order;
    // explicit activation is the only path that may admit this inactive base.
    const seller = await starter();
    const buyer = await starter();
    const deed = Keypair.generate().publicKey.toBase58();
    await db.update(players).set({
      entryPaidAt: new Date(), deedMintAssetId: deed,
    }).where(eq(players.wallet, seller.wallet));
    await db.update(bases).set({
      status: 'inactive', landPaidAt: new Date(), deedMintAssetId: deed,
      deedMintingAt: null,
    }).where(eq(bases.id, seller.baseId));
    await db.delete(baseSlots).where(eq(baseSlots.baseId, seller.baseId));

    const recovered = await registerOwnedDeed(db, buyer.wallet, deed, {
      expectedCollection: 'collection',
      ownerOf: async () => ({
        owner: buyer.wallet, frozen: false, delegate: null,
        collection: 'collection', slot: 901,
      }),
    });

    expect(recovered).toMatchObject({
      id: seller.baseId, ownerWallet: buyer.wallet, status: 'inactive',
      deedAssetId: deed, deedMintAssetId: deed,
    });
    expect(await db.select().from(baseSlots).where(eq(baseSlots.baseId, seller.baseId)))
      .toHaveLength(0);
  });

  it('quarantines base mutation while a fixed mint is reserved but not attached', async () => {
    const owner = await starter();
    const deed = Keypair.generate().publicKey.toBase58();
    await db.update(bases).set({ landPaidAt: new Date(), deedMintAssetId: deed })
      .where(eq(bases.id, owner.baseId));
    await expect(db.transaction((tx) => assertFreshLockedBaseAuthority(
      tx, owner.wallet, owner.baseId,
    ))).rejects.toMatchObject({ code: 'DEED_AUTHORITY_UNAVAILABLE' });
    await expect(requireFreshBaseAuthority(
      db, owner.wallet, owner.baseId,
      async () => ({ owner: owner.wallet, frozen: false, delegate: null, collection: 'collection', slot: 1 }),
      'collection',
    )).rejects.toMatchObject({ code: 'DEED_AUTHORITY_UNAVAILABLE' });
  });

  it('enforces one database namespace across reserved and attached deed ids', async () => {
    const reserved = await starter();
    const other = await starter();
    const deed = Keypair.generate().publicKey.toBase58();
    await db.update(bases).set({ landPaidAt: new Date(), deedMintAssetId: deed })
      .where(eq(bases.id, reserved.baseId));
    await expect(db.update(bases).set({ deedAssetId: deed })
      .where(eq(bases.id, other.baseId))).rejects.toMatchObject({ cause: { code: '23514' } });
    expect((await db.select().from(bases).where(eq(bases.id, other.baseId)))[0])
      .toMatchObject({ deedAssetId: null, deedMintAssetId: null });
  });

  it('serializes concurrent deed arrivals so no race activates a sixth base', async () => {
    const p = await starter();
    await Promise.all(Array.from({ length: 8 }, () => registerOwnedDeed(db, p.wallet, `deed-${randomWallet()}`)));
    const all = await listWalletBases(db, p.wallet);
    expect(all).toHaveLength(8);
    expect(all.filter((b) => b.status === 'active')).toHaveLength(5);
    expect(new Set(all.filter((b) => b.slot !== null).map((b) => b.slot)).size).toBe(5);
  });

  it('evicts a newly activated plotted base from world caches only after commit', async () => {
    const owner = await starter();
    const [inactive] = await db.insert(bases).values({
      ownerWallet: owner.wallet, status: 'inactive', landPaidAt: new Date(),
    }).returning({ id: bases.id });
    const targetValley = await createTestValley(db, { name: `activation-target-${randomWallet()}` });
    const unrelatedValley = await createTestValley(db, { name: `activation-unrelated-${randomWallet()}` });
    await seedPlots(db, [{
      valleyId: targetValley.id, x: 1, y: 7,
      playerWallet: owner.wallet, baseId: inactive!.id,
    }]);
    const cache = await primeWorldCaches([targetValley.id, unrelatedValley.id]);
    let entered!: () => void;
    let release!: () => void;
    const insideTransaction = new Promise<void>((resolve) => { entered = resolve; });
    const mayCommit = new Promise<void>((resolve) => { release = resolve; });

    const activating = activateBase(
      db, owner.wallet, inactive!.id, undefined,
      async () => { entered(); await mayCommit; },
    );
    await insideTransaction;
    await cache.readGlobe();
    await cache.readValley(targetValley.id);
    expect(cache.globeLoads()).toBe(1);
    expect(cache.valleyLoads(targetValley.id)).toBe(1);

    release();
    await activating;
    await cache.readGlobe();
    await cache.readValley(targetValley.id);
    await cache.readValley(unrelatedValley.id);
    expect(cache.globeLoads()).toBe(2);
    expect(cache.valleyLoads(targetValley.id)).toBe(2);
    expect(cache.valleyLoads(unrelatedValley.id)).toBe(1);
    resetGlobeCache();
    resetMapCache();
  });

  it('replaces an explicit active slot without deleting the displaced base', async () => {
    const p = await starter();
    for (let i = 0; i < 6; i++) await registerOwnedDeed(db, p.wallet, `deed-${randomWallet()}`);
    const before = await listWalletBases(db, p.wallet);
    const inactive = before.find((b) => b.status === 'inactive')!;
    const displaced = before.find((b) => b.slot === 3)!;
    await activateBase(db, p.wallet, inactive.id, displaced.id);
    const after = await listWalletBases(db, p.wallet);
    expect(after.find((b) => b.id === inactive.id)?.slot).toBe(3);
    expect(after.find((b) => b.id === displaced.id)).toMatchObject({ status: 'inactive', slot: null });
    expect(after.filter((b) => b.status === 'active')).toHaveLength(5);
  });

  it('evicts both plotted valleys and the globe after an active-slot replacement', async () => {
    const owner = await starter();
    for (let i = 0; i < 6; i++) {
      await registerOwnedDeed(db, owner.wallet, `deed-${randomWallet()}`);
    }
    const before = await listWalletBases(db, owner.wallet);
    const target = before.find((base) => base.status === 'inactive')!;
    const displaced = before.find((base) => base.slot === 3)!;
    const targetValley = await createTestValley(db, { name: `replacement-target-${randomWallet()}` });
    const displacedValley = await createTestValley(db, { name: `replacement-displaced-${randomWallet()}` });
    const unrelatedValley = await createTestValley(db, { name: `replacement-unrelated-${randomWallet()}` });
    await seedPlots(db, [
      {
        valleyId: targetValley.id, x: 1, y: 7,
        playerWallet: owner.wallet, baseId: target.id,
      },
      {
        valleyId: displacedValley.id, x: 2, y: 7,
        playerWallet: owner.wallet, baseId: displaced.id,
      },
    ]);
    const cache = await primeWorldCaches([
      targetValley.id, displacedValley.id, unrelatedValley.id,
    ]);

    await activateBase(db, owner.wallet, target.id, displaced.id);
    await cache.readGlobe();
    await cache.readValley(targetValley.id);
    await cache.readValley(displacedValley.id);
    await cache.readValley(unrelatedValley.id);
    expect(cache.globeLoads()).toBe(2);
    expect(cache.valleyLoads(targetValley.id)).toBe(2);
    expect(cache.valleyLoads(displacedValley.id)).toBe(2);
    expect(cache.valleyLoads(unrelatedValley.id)).toBe(1);
    resetGlobeCache();
    resetMapCache();
  });

  it('cannot deactivate a deed while that exact base is being raided', async () => {
    const owner = await starter();
    const attacker = await starter();
    for (let i = 0; i < 6; i++) {
      await registerOwnedDeed(db, owner.wallet, `deed-${randomWallet()}`);
    }
    const before = await listWalletBases(db, owner.wallet);
    const inactive = before.find((base) => base.status === 'inactive')!;
    const displaced = before.find((base) => base.slot === 3)!;
    const [raid] = await db.insert(raids).values({
      idempotencyKey: `activation-lock-${randomWallet()}`,
      attackerWallet: attacker.wallet,
      attackerBaseId: attacker.baseId,
      defenderWallet: owner.wallet,
      defenderBaseId: displaced.id,
      seed: 1n,
      snapshot: { keepLevel: 1, buildings: [], surplusShards: 0 },
      armySnapshot: { counts: {}, levels: {}, attackerKeepLevel: 1 },
      ordersDeadlineAt: new Date(Date.now() + 60_000),
      simVersion: 9,
    }).returning({ id: raids.id });
    await db.insert(baseRaidLocks).values({
      baseId: displaced.id,
      raidId: raid!.id,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(activateBase(db, owner.wallet, inactive.id, displaced.id))
      .rejects.toMatchObject({ statusCode: 423, code: 'BASE_BEING_RAIDED' });
    const after = await listWalletBases(db, owner.wallet);
    expect(after.find((base) => base.id === displaced.id)?.slot).toBe(3);
    expect(after.find((base) => base.id === inactive.id)?.status).toBe('inactive');
  });

  it('does not activate a target base with an unresolved outgoing battle', async () => {
    const owner = await starter();
    const defender = await starter();
    const [target] = await db.insert(bases).values({
      ownerWallet: owner.wallet, status: 'inactive', landPaidAt: new Date(),
    }).returning({ id: bases.id });
    await db.insert(raids).values({
      idempotencyKey: `activation-target-outgoing-${randomWallet()}`,
      attackerWallet: owner.wallet,
      attackerBaseId: target!.id,
      defenderWallet: defender.wallet,
      defenderBaseId: defender.baseId,
      seed: 1n,
      snapshot: { keepLevel: 1, buildings: [], surplusShards: 0 },
      armySnapshot: { counts: {}, levels: {}, attackerKeepLevel: 1 },
      ordersDeadlineAt: new Date(Date.now() + 60_000),
      status: 'pending_orders',
      simVersion: 9,
    });
    const before = (await listWalletBases(db, owner.wallet))
      .map(({ id, status, slot }) => ({ id, status, slot }));

    await expect(activateBase(db, owner.wallet, target!.id))
      .rejects.toMatchObject({ statusCode: 409, code: 'BASE_BUSY_ATTACKING' });

    const after = (await listWalletBases(db, owner.wallet))
      .map(({ id, status, slot }) => ({ id, status, slot }));
    expect(after).toEqual(before);
    expect(after.find((base) => base.id === target!.id))
      .toMatchObject({ status: 'inactive', slot: null });
  });

  it('does not displace an active base with an unresolved outgoing battle', async () => {
    const owner = await starter();
    const defender = await starter();
    for (let i = 0; i < 6; i++) {
      await registerOwnedDeed(db, owner.wallet, `deed-${randomWallet()}`);
    }
    const before = await listWalletBases(db, owner.wallet);
    const target = before.find((base) => base.status === 'inactive')!;
    const displaced = before.find((base) => base.slot === 3)!;
    await db.insert(raids).values({
      idempotencyKey: `activation-displaced-outgoing-${randomWallet()}`,
      attackerWallet: owner.wallet,
      attackerBaseId: displaced.id,
      defenderWallet: defender.wallet,
      defenderBaseId: defender.baseId,
      seed: 1n,
      snapshot: { keepLevel: 1, buildings: [], surplusShards: 0 },
      armySnapshot: { counts: {}, levels: {}, attackerKeepLevel: 1 },
      ordersDeadlineAt: new Date(Date.now() + 60_000),
      status: 'resolving',
      simVersion: 9,
    });
    const beforeIdentity = before.map(({ id, status, slot }) => ({ id, status, slot }));

    await expect(activateBase(db, owner.wallet, target.id, displaced.id))
      .rejects.toMatchObject({ statusCode: 409, code: 'BASE_BUSY_ATTACKING' });

    const after = (await listWalletBases(db, owner.wallet))
      .map(({ id, status, slot }) => ({ id, status, slot }));
    expect(after).toEqual(beforeIdentity);
    expect(after.find((base) => base.id === displaced.id))
      .toMatchObject({ status: 'active', slot: 3 });
    expect(after.find((base) => base.id === target.id))
      .toMatchObject({ status: 'inactive', slot: null });
  });

  it('does not activate an inactive deed after its refreshed proof ages during the lock wait', async () => {
    const p = await starter();
    const deed = Keypair.generate().publicKey.toBase58();
    const [target] = await db.insert(bases).values({
      ownerWallet: p.wallet, deedAssetId: deed, status: 'inactive', landPaidAt: new Date(),
    }).returning();
    const [evidence] = await db.insert(deedOwnershipObservations).values({
      baseId: target!.id, assetId: deed, owner: p.wallet, slot: 800n,
      checkedAt: new Date(), source: 'test-activation-boundary', status: 'owned',
      auditHash: `activate-${randomWallet()}`,
    }).returning();
    const change = await holdWalletAuthorityChange(p.wallet, async (tx) => {
      await tx.update(deedOwnershipObservations).set({
        checkedAt: new Date(Date.now() - BASE_OWNERSHIP.mutationFreshnessMs - 1),
      }).where(eq(deedOwnershipObservations.id, evidence!.id));
    });
    const activating = activateBase(
      db, p.wallet, target!.id, undefined,
      async (tx, wallet, baseId) => {
        await assertFreshLockedBaseAuthority(
          tx, wallet, baseId, new Date(), { allowInactive: true },
        );
      },
    );
    const rejected = expect(activating).rejects.toMatchObject({ code: 'DEED_AUTHORITY_UNAVAILABLE' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    change.release();
    await change.done;
    await rejected;
    expect((await db.select().from(bases).where(eq(bases.id, target!.id)))[0]?.status).toBe('inactive');
    expect(await db.select().from(baseSlots).where(eq(baseSlots.baseId, target!.id))).toHaveLength(0);
  });

  it('a finalized transfer changes stable ownership and activation only; child wallet identity stays untouched', async () => {
    const seller = await starter();
    const buyer = Keypair.generate().publicKey.toBase58();
    const deed = Keypair.generate().publicKey.toBase58();
    await registerOwnedDeed(db, seller.wallet, deed);
    const status = await refreshBaseOwnership(db, seller.baseId, async () => ({
      owner: buyer, frozen: false, delegate: null, collection: 'collection', slot: 100,
    }), 'collection');
    expect(status).toBe('mismatch');
    expect((await db.select().from(bases).where(eq(bases.id, seller.baseId)))[0])
      .toMatchObject({ ownerWallet: buyer, status: 'inactive' });
    expect((await db.select().from(buildings).where(eq(buildings.baseId, seller.baseId)))[0]?.playerWallet)
      .toBe(seller.wallet);
    expect(await db.select().from(baseSlots).where(eq(baseSlots.baseId, seller.baseId))).toHaveLength(0);
    expect((await db.select().from(players).where(eq(players.wallet, seller.wallet)))[0]).toBeTruthy();
    await expect(ensureWalletBaseIdentity(db, seller.wallet))
      .rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
  });

  it('never lets lower-slot ownership evidence reverse or reactivate a transferred base', async () => {
    const seller = await starter();
    const buyer = Keypair.generate().publicKey.toBase58();
    const deed = Keypair.generate().publicKey.toBase58();
    await registerOwnedDeed(db, seller.wallet, deed);
    const checkedAt = new Date('2026-08-12T00:00:00.000Z');

    expect(await refreshBaseOwnership(db, seller.baseId, async (_assetId, minContextSlot) => {
      expect(minContextSlot).toBeUndefined();
      return { owner: buyer, frozen: false, delegate: null, collection: 'collection', slot: 200 };
    }, 'collection', checkedAt, 'test-slot-floor', () => checkedAt)).toBe('mismatch');
    const [accepted] = await db.select().from(deedOwnershipObservations)
      .where(eq(deedOwnershipObservations.baseId, seller.baseId));
    expect(accepted).toMatchObject({ owner: buyer, status: 'mismatch', slot: 200n });
    expect(accepted?.auditHash).toBe(createHash('sha256')
      .update(`${deed}\0${buyer}\0mismatch\0${200}\0${checkedAt.toISOString()}`).digest('hex'));

    const staleStatus = await refreshBaseOwnership(db, seller.baseId, async (_assetId, minContextSlot) => {
      expect(minContextSlot).toBe(200);
      return { owner: seller.wallet, frozen: false, delegate: null, collection: 'collection', slot: 199 };
    }, 'collection', new Date(checkedAt.getTime() + 1_000));
    expect(staleStatus).toBe('unavailable');
    expect((await db.select().from(bases).where(eq(bases.id, seller.baseId)))[0])
      .toMatchObject({ ownerWallet: buyer, status: 'inactive' });
    expect((await db.select().from(deedOwnershipObservations)
      .where(eq(deedOwnershipObservations.baseId, seller.baseId)))[0])
      .toMatchObject({ owner: buyer, status: 'mismatch', slot: 200n, auditHash: accepted?.auditHash });

    const staleOwnedStatus = await refreshBaseOwnership(db, seller.baseId, async () => ({
      owner: buyer, frozen: false, delegate: null, collection: 'collection', slot: 199,
    }), 'collection', new Date(checkedAt.getTime() + 2_000));
    expect(staleOwnedStatus).toBe('unavailable');
    // This is the same gate as the activation route. Accepting lower-slot B as
    // owned would make the inactive transferred base live again.
    if (staleOwnedStatus === 'owned') await activateBase(db, buyer, seller.baseId);
    expect((await db.select().from(bases).where(eq(bases.id, seller.baseId)))[0]?.status).toBe('inactive');
    expect(await db.select().from(baseSlots).where(eq(baseSlots.baseId, seller.baseId))).toHaveLength(0);
  });

  it('a traded base joins a buyer that already has a base without merging wallet state', async () => {
    const seller = await starter();
    const buyer = await starter();
    const sellerDeed = Keypair.generate().publicKey.toBase58();
    await registerOwnedDeed(db, seller.wallet, sellerDeed);
    await registerOwnedDeed(db, buyer.wallet, Keypair.generate().publicKey.toBase58());
    await db.update(players).set({ trophies: 777 }).where(eq(players.wallet, buyer.wallet));

    const moved = await transferStableBase(db, seller.baseId, seller.wallet, buyer.wallet, sellerDeed);
    expect(moved.active).toBe(true);
    expect(await listWalletBases(db, buyer.wallet)).toHaveLength(2);
    expect((await db.select().from(players).where(eq(players.wallet, buyer.wallet)))[0]?.trophies).toBe(777);
    expect((await db.select().from(buildings).where(eq(buildings.baseId, seller.baseId)))[0]?.playerWallet)
      .toBe(seller.wallet);
  });

  it('selling deed A repoints the legacy scalar so remaining base B can mint', async () => {
    const seller = await starter();
    const buyer = Keypair.generate().publicKey.toBase58();
    const deedA = Keypair.generate().publicKey.toBase58();
    const deedB = Keypair.generate().publicKey.toBase58();
    const paidAt = new Date('2026-08-12T01:30:00.000Z');
    await registerOwnedDeed(db, seller.wallet, deedA);
    await db.update(players).set({ entryPaidAt: paidAt, deedAssetId: deedA })
      .where(eq(players.wallet, seller.wallet));
    const [baseB] = await db.insert(bases).values({
      ownerWallet: seller.wallet, landPaidAt: paidAt, status: 'active',
    }).returning();
    await db.insert(baseSlots).values({
      wallet: seller.wallet, slot: 2, baseId: baseB!.id, active: true, selectedAt: paidAt,
    });

    await transferStableBase(db, seller.baseId, seller.wallet, buyer, deedA);
    expect((await db.select().from(players).where(eq(players.wallet, seller.wallet)))[0]?.deedAssetId)
      .toBeNull();
    configureDeedMinter(mockDeedMinter(() => deedB));
    try {
      await mintDeedIfConfigured(db, seller.wallet, baseB!.id);
    } finally {
      configureDeedMinter(null);
    }
    expect((await db.select().from(bases).where(eq(bases.id, baseB!.id)))[0]?.deedAssetId).toBe(deedB);
    expect((await db.select().from(players).where(eq(players.wallet, seller.wallet)))[0]?.deedAssetId).toBe(deedB);
  });

  it('mints the paid target base even when another owned base is free', async () => {
    const owner = await starter();
    const paidAt = new Date('2026-08-12T01:40:00.000Z');
    const deed = Keypair.generate().publicKey.toBase58();
    const [paid] = await db.insert(bases).values({
      ownerWallet: owner.wallet, landPaidAt: paidAt, status: 'active',
    }).returning();
    await db.insert(baseSlots).values({
      wallet: owner.wallet, slot: 2, baseId: paid!.id, active: true, selectedAt: paidAt,
    });
    let mints = 0;
    configureDeedMinter(mockDeedMinter(() => deed, () => { mints++; }));
    try {
      await mintDeedIfConfigured(db, owner.wallet, paid!.id);
    } finally {
      configureDeedMinter(null);
    }

    expect(mints).toBe(1);
    expect((await db.select().from(bases).where(eq(bases.id, owner.baseId)))[0]?.deedAssetId).toBeNull();
    expect((await db.select().from(bases).where(eq(bases.id, paid!.id)))[0]?.deedAssetId).toBe(deed);
    // With two bases the wallet scalar is ambiguous and never authorizes minting.
    expect((await db.select().from(players).where(eq(players.wallet, owner.wallet)))[0]?.deedAssetId).toBeNull();
  });

  it('mints two paid stable bases independently despite an unrelated legacy deed scalar', async () => {
    const owner = await starter();
    const paidAt = new Date('2026-08-12T01:50:00.000Z');
    const legacy = Keypair.generate().publicKey.toBase58();
    const deeds = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
    await db.update(bases).set({ landPaidAt: paidAt }).where(eq(bases.id, owner.baseId));
    const [second] = await db.insert(bases).values({
      ownerWallet: owner.wallet, landPaidAt: paidAt, status: 'active',
    }).returning();
    await db.insert(baseSlots).values({
      wallet: owner.wallet, slot: 2, baseId: second!.id, active: true, selectedAt: paidAt,
    });
    await db.update(players).set({ deedAssetId: legacy }).where(eq(players.wallet, owner.wallet));
    let cursor = 0;
    configureDeedMinter(mockDeedMinter(() => deeds[cursor++]!));
    try {
      await mintDeedIfConfigured(db, owner.wallet, owner.baseId);
      await mintDeedIfConfigured(db, owner.wallet, second!.id);
    } finally {
      configureDeedMinter(null);
    }

    expect(cursor).toBe(2);
    expect((await db.select().from(bases).where(eq(bases.id, owner.baseId)))[0]?.deedAssetId).toBe(deeds[0]);
    expect((await db.select().from(bases).where(eq(bases.id, second!.id)))[0]?.deedAssetId).toBe(deeds[1]);
    expect((await db.select().from(players).where(eq(players.wallet, owner.wallet)))[0]?.deedAssetId).toBe(legacy);
  });

  it('does not create or return a builder payment reference from aged deed evidence', async () => {
    const owner = await starter();
    const deed = Keypair.generate().publicKey.toBase58();
    await registerOwnedDeed(db, owner.wallet, deed);
    const now = new Date();
    await db.update(bases).set({ landPaidAt: now, builders: 1 }).where(eq(bases.id, owner.baseId));
    await db.insert(deedOwnershipObservations).values({
      baseId: owner.baseId, assetId: deed, owner: owner.wallet, slot: 1_100n,
      checkedAt: new Date(now.getTime() - BASE_OWNERSHIP.mutationFreshnessMs - 1),
      source: 'test-deposit-aged', status: 'owned', auditHash: `deposit-aged-${randomWallet()}`,
    });
    const authority: DepositStableAuthorityContext = {
      baseId: owner.baseId,
      assertAuthority: async (tx, wallet, baseId) => {
        await assertFreshLockedBaseAuthority(tx, wallet, baseId, now);
      },
    };

    await expect(createDepositIntent(
      db, owner.wallet, 'builder', { baseId: owner.baseId }, now, authority,
    )).rejects.toMatchObject({ code: 'DEED_AUTHORITY_UNAVAILABLE' });
    expect(await db.select().from(deposits).where(and(
      eq(deposits.playerWallet, owner.wallet), eq(deposits.kind, 'builder'),
      eq(deposits.status, 'pending'),
    ))).toHaveLength(0);
  });

  it('does not create a deposit reference when a deed transfer wins the quote player lock', async () => {
    const prior = process.env['MULTI_BASE_ENABLED'];
    process.env['MULTI_BASE_ENABLED'] = 'false';
    try {
      const seller = await starter();
      const buyer = await onCurvePlayer();
      const deed = Keypair.generate().publicKey.toBase58();
      await registerOwnedDeed(db, seller.wallet, deed);
      const now = new Date();
      await db.update(bases).set({ landPaidAt: now, builders: 1 }).where(eq(bases.id, seller.baseId));
      const [evidence] = await db.insert(deedOwnershipObservations).values({
        baseId: seller.baseId, assetId: deed, owner: seller.wallet, slot: 1_101n,
        checkedAt: now, source: 'test-deposit-transfer', status: 'owned',
        auditHash: `deposit-transfer-${randomWallet()}`,
      }).returning();
      const authority: DepositStableAuthorityContext = {
        baseId: seller.baseId,
        assertAuthority: async (tx, wallet, baseId) => {
          await assertFreshLockedBaseAuthority(tx, wallet, baseId, now);
        },
      };
      const loss = await holdWalletAuthorityChange(seller.wallet, async (tx) => {
        await tx.delete(baseSlots).where(eq(baseSlots.baseId, seller.baseId));
        await tx.update(bases).set({ ownerWallet: buyer.wallet, status: 'inactive' })
          .where(eq(bases.id, seller.baseId));
        await tx.update(deedOwnershipObservations).set({
          owner: buyer.wallet, status: 'mismatch', checkedAt: now,
        }).where(eq(deedOwnershipObservations.id, evidence!.id));
      });

      const creating = createDepositIntent(
        db, seller.wallet, 'builder', { baseId: seller.baseId }, now, authority,
      );
      const rejected = expect(creating).rejects.toMatchObject({ code: 'DEED_OWNERSHIP_CHANGED' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      loss.release();
      await loss.done;
      await rejected;
      expect(await db.select().from(deposits).where(and(
        eq(deposits.playerWallet, seller.wallet), eq(deposits.kind, 'builder'),
        eq(deposits.status, 'pending'),
      ))).toHaveLength(0);
    } finally {
      if (prior === undefined) delete process.env['MULTI_BASE_ENABLED'];
      else process.env['MULTI_BASE_ENABLED'] = prior;
    }
  });

  it('allows the same builder slot on two stable bases without sharing an intent', async () => {
    const owner = await starter();
    const first = await registerOwnedDeed(db, owner.wallet, Keypair.generate().publicKey.toBase58());
    const second = await registerOwnedDeed(db, owner.wallet, Keypair.generate().publicKey.toBase58());
    const paidAt = new Date('2026-08-12T02:00:00.000Z');
    await db.update(players).set({ entryPaidAt: paidAt }).where(eq(players.wallet, owner.wallet));
    await db.update(bases).set({ landPaidAt: paidAt, keepLevel: 20, builders: 1 })
      .where(eq(bases.ownerWallet, owner.wallet));

    const [a, b] = await Promise.all([
      createDepositIntent(db, owner.wallet, 'builder', { baseId: first.id }, paidAt),
      createDepositIntent(db, owner.wallet, 'builder', { baseId: second.id }, paidAt),
    ]);
    expect(a.id).not.toBe(b.id);
    expect((await db.select().from(deposits).where(eq(deposits.id, a.id)))[0]?.payload)
      .toMatchObject({ baseId: first.id, expectedBuilders: 1 });
    expect((await db.select().from(deposits).where(eq(deposits.id, b.id)))[0]?.payload)
      .toMatchObject({ baseId: second.id, expectedBuilders: 1 });

    const price = BigInt(Math.round(CAPS.builderPricesSol[0]! * 1_000_000_000));
    await Promise.all([
      creditDeposit(db, a.id, depositPayment(owner.wallet, 'builder', price), paidAt),
      creditDeposit(db, b.id, depositPayment(owner.wallet, 'builder', price), paidAt),
    ]);
    expect((await db.select().from(bases).where(eq(bases.id, first.id)))[0]?.builders).toBe(2);
    expect((await db.select().from(bases).where(eq(bases.id, second.id)))[0]?.builders).toBe(2);
    // Multiple bases make wallet scalars ambiguous, so the compatibility shadow
    // deliberately stops changing instead of inventing a global builder count.
    expect((await db.select().from(players).where(eq(players.wallet, owner.wallet)))[0]?.builders).toBe(1);

    const [expA, expB] = await Promise.all([
      createDepositIntent(db, owner.wallet, 'expansion', { baseId: first.id }, paidAt),
      createDepositIntent(db, owner.wallet, 'expansion', { baseId: second.id }, paidAt),
    ]);
    expect(expA.id).not.toBe(expB.id);
    const expansionPrice = BigInt(Math.round(CAPS.expansionPriceSolByIndex[0]! * 1_000_000_000));
    await Promise.all([
      creditDeposit(db, expA.id, depositPayment(owner.wallet, 'expansion', expansionPrice), paidAt),
      creditDeposit(db, expB.id, depositPayment(owner.wallet, 'expansion', expansionPrice), paidAt),
    ]);
    expect((await db.select().from(bases).where(eq(bases.id, first.id)))[0]?.expansions).toBe(1);
    expect((await db.select().from(bases).where(eq(bases.id, second.id)))[0]?.expansions).toBe(1);
    expect((await db.select().from(players).where(eq(players.wallet, owner.wallet)))[0]?.expansions).toBe(0);
  });

  it('applies a paid frozen builder improvement to the base after its deed sells', async () => {
    const seller = await starter();
    const buyer = Keypair.generate().publicKey.toBase58();
    const deed = Keypair.generate().publicKey.toBase58();
    const base = await registerOwnedDeed(db, seller.wallet, deed);
    const paidAt = new Date('2026-08-12T03:00:00.000Z');
    await db.update(players).set({ entryPaidAt: paidAt, builders: 1 })
      .where(eq(players.wallet, seller.wallet));
    await db.update(bases).set({ landPaidAt: paidAt, builders: 1 }).where(eq(bases.id, base.id));
    const intent = await createDepositIntent(db, seller.wallet, 'builder', { baseId: base.id }, paidAt);
    await transferStableBase(db, base.id, seller.wallet, buyer, deed);

    const price = BigInt(Math.round(CAPS.builderPricesSol[0]! * 1_000_000_000));
    await expect(creditDeposit(
      db, intent.id, depositPayment(seller.wallet, 'builder', price), paidAt,
    )).resolves.toMatchObject({ credited: true });
    expect((await db.select().from(bases).where(eq(bases.id, base.id)))[0])
      .toMatchObject({ ownerWallet: buyer, builders: 2 });
    expect((await db.select().from(players).where(eq(players.wallet, seller.wallet)))[0]?.builders).toBe(1);
  });

  it('never creates a new scalar quote from a sold seller legacy shadow', async () => {
    const seller = await starter();
    const buyer = Keypair.generate().publicKey.toBase58();
    const deed = Keypair.generate().publicKey.toBase58();
    const base = await registerOwnedDeed(db, seller.wallet, deed);
    const paidAt = new Date('2026-08-12T04:00:00.000Z');
    await db.update(players).set({ entryPaidAt: paidAt }).where(eq(players.wallet, seller.wallet));
    await db.update(bases).set({ landPaidAt: paidAt }).where(eq(bases.id, base.id));
    expect(await nextLandPurchaseKind(db, seller.wallet)).toBe('deed');
    await transferStableBase(db, base.id, seller.wallet, buyer, deed);

    // WHY: selling the last deed clears the compatibility `entryPaidAt`, but
    // the init-once Player PDA is still consumed. The globe must offer the
    // repeatable deed rail, not a payment that can never credit.
    expect(await nextLandPurchaseKind(db, seller.wallet)).toBe('deed');

    await expect(createDepositIntent(db, seller.wallet, 'builder'))
      .rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    await expect(createDepositIntent(db, seller.wallet, 'builder', { baseId: base.id }))
      .rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    await expect(createDepositIntent(db, seller.wallet, 'entry'))
      .rejects.toMatchObject({ code: 'ENTRY_PDA_CONSUMED' });

    // Even a legacy/stale pending row cannot turn the old init-once Player PDA
    // into a synthetic second purchase after the deed has left the wallet.
    const [stale] = await db.insert(deposits).values({
      playerWallet: seller.wallet, kind: 'entry', reference: randomWallet(), status: 'pending',
    }).returning();
    let verifierCalls = 0;
    const oldPdaFallback: DepositVerifier = async (dep) => {
      verifierCalls++;
      return {
        txSignature: `pda:${dep.playerWallet}`, wallet: dep.playerWallet,
        kind: 'entry', lamports: 200_000_000n, finalized: true,
      };
    };
    await expect(verifyDepositNow(db, oldPdaFallback, seller.wallet, stale!.id, paidAt))
      .resolves.toEqual({ action: 'redundant' });
    expect(verifierCalls).toBe(0);
    const [direct] = await db.insert(deposits).values({
      playerWallet: seller.wallet, kind: 'entry', reference: randomWallet(), status: 'pending',
    }).returning();
    await expect(creditDeposit(db, direct!.id, {
      txSignature: `pda:${seller.wallet}`, wallet: seller.wallet,
      kind: 'entry', lamports: 200_000_000n, finalized: true,
    }, paidAt)).rejects.toMatchObject({ code: 'ENTRY_PDA_CONSUMED' });
    expect(await db.select().from(bases).where(eq(bases.ownerWallet, seller.wallet))).toHaveLength(0);
  });

  it('never discloses a seller pending mine payment reference to the deed buyer', async () => {
    const prior = process.env['MULTI_BASE_ENABLED'];
    process.env['MULTI_BASE_ENABLED'] = 'true';
    try {
      const seller = await starter();
      const buyer = await onCurvePlayer();
      const deed = Keypair.generate().publicKey.toBase58();
      await registerOwnedDeed(db, seller.wallet, deed);
      const paidAt = new Date();
      await db.update(bases).set({ landPaidAt: paidAt, keepLevel: 5, builders: 3 })
        .where(eq(bases.id, seller.baseId));
      await db.delete(obstacles).where(eq(obstacles.baseId, seller.baseId));
      for (const wallet of [seller.wallet, buyer.wallet]) {
        await fundTestKeep(db, wallet, 100_000n, 'test.mine-owner-fence', randomWallet());
        await rewardShards(db, wallet, 100_000n, 'test.mine-owner-fence', randomWallet());
      }
      // Stable Mine pricing is deed-native; the compatibility wallet shadow is
      // deliberately irrelevant and must not make this reservation test pass.
      await rewardBaseShards(
        db, seller.baseId, 100_000n, 'test.mine-owner-fence-base', randomWallet(),
      );
      // D-057: paid mine upgrades start at target L5, so the reserved quote
      // needs an L4 mine (the fence property under test is unchanged).
      const [mine] = await db.insert(buildings).values({
        playerWallet: seller.wallet, baseId: seller.baseId, type: 'mine', level: 4, tx: 10, ty: 10,
      }).returning();
      const upgrade = await createDepositIntent(db, seller.wallet, 'mine', {
        baseId: seller.baseId, buildingId: mine!.id,
      });
      // Preserve the exact pre-0071 shape: the pending row identifies only the
      // building, so buyer lookup must be global and must not return its secret
      // payment reference merely because baseId is absent.
      await db.update(deposits).set({ payload: { buildingId: mine!.id } })
        .where(eq(deposits.id, upgrade.id));
      // D-057 retired mine_build CREATION, so a seller's in-flight pre-cutover
      // row is seeded directly — its reference must equally stay private.
      const [sellerBase] = await db.select().from(bases).where(eq(bases.id, seller.baseId));
      const [build] = await db.insert(deposits).values({
        playerWallet: seller.wallet, kind: 'mine_build', reference: randomWallet(), status: 'pending',
        payload: {
          baseId: seller.baseId, tx: 18, ty: 18, expectedMines: 1, amountLamports: 50_000_000,
          landPaidAt: sellerBase!.landPaidAt!.toISOString(), deedAssetId: sellerBase!.deedAssetId,
        },
      }).returning();
      await transferStableBase(db, seller.baseId, seller.wallet, buyer.wallet, deed);

      await expect(createDepositIntent(db, buyer.wallet, 'mine', {
        baseId: seller.baseId, buildingId: mine!.id,
      })).rejects.toMatchObject({ code: 'PAYMENT_TARGET_RESERVED' });
      // mine_build creation refuses for EVERYONE now — the buyer learns
      // nothing, and the seller's pending row is untouched.
      await expect(createDepositIntent(db, buyer.wallet, 'mine_build', {
        baseId: seller.baseId, tx: 18, ty: 18,
      })).rejects.toMatchObject({ code: 'MINE_BUILD_SOL_RETIRED' });
      expect((await db.select().from(deposits).where(eq(deposits.id, upgrade.id)))[0]?.playerWallet)
        .toBe(seller.wallet);
      expect((await db.select().from(deposits).where(eq(deposits.id, build!.id)))[0]?.playerWallet)
        .toBe(seller.wallet);
    } finally {
      if (prior === undefined) delete process.env['MULTI_BASE_ENABLED'];
      else process.env['MULTI_BASE_ENABLED'] = prior;
    }
  });

  it('a fresh buyer opening a transferred base cannot duplicate its Keep or terrain', async () => {
    const seller = await onCurvePlayer();
    await ensureStartingBase(db, seller.wallet);
    const baseId = await ensureWalletBaseIdentity(db, seller.wallet);
    expect(baseId).toBeTruthy();
    const deed = Keypair.generate().publicKey.toBase58();
    await registerOwnedDeed(db, seller.wallet, deed);
    const buyer = await createTestPlayer(db);
    await transferStableBase(db, baseId!, seller.wallet, buyer.wallet, deed);

    const beforeBuildings = await db.select().from(buildings).where(eq(buildings.baseId, baseId!));
    const beforeObstacles = await db.select().from(obstacles).where(eq(obstacles.baseId, baseId!));
    expect(beforeBuildings.filter((row) => row.type === 'keep')).toHaveLength(1);
    expect(beforeObstacles.length).toBeGreaterThan(0);

    await ensureStartingBase(db, buyer.wallet, baseId!);

    const afterBuildings = await db.select().from(buildings).where(eq(buildings.baseId, baseId!));
    const afterObstacles = await db.select().from(obstacles).where(eq(obstacles.baseId, baseId!));
    expect(afterBuildings).toEqual(beforeBuildings);
    expect(afterObstacles).toEqual(beforeObstacles);
    expect(afterBuildings.find((row) => row.type === 'keep')?.playerWallet).toBe(seller.wallet);
  });

  it.each(['direct', 'observer'] as const)(
    'settles a due obstacle clear into the deed before %s stable ownership moves',
    async (path) => {
      const seller = await starter();
      const buyer = await onCurvePlayer();
      const deed = Keypair.generate().publicKey.toBase58();
      await registerOwnedDeed(db, seller.wallet, deed);
      const obstacle = await smallObstacleFor(seller.wallet, seller.baseId);
      const [job] = await db.insert(builderJobs).values({
        playerWallet: seller.wallet, baseId: seller.baseId, kind: 'clear_obstacle',
        obstacleId: obstacle!.id, finishesAt: new Date(Date.now() - 1_000),
      }).returning();
      const sellerBefore = (await getOrCreatePlayerAccount(db, seller.wallet, 'player_shards')).balance;
      const buyerBefore = (await getOrCreatePlayerAccount(db, buyer.wallet, 'player_shards')).balance;
      const baseBefore = (await getOrCreateBaseAccount(db, seller.baseId, 'base_shards')).balance;

      if (path === 'direct') {
        await transferStableBase(db, seller.baseId, seller.wallet, buyer.wallet, deed);
      } else {
        await expect(refreshBaseOwnership(db, seller.baseId, async () => ({
          owner: buyer.wallet, frozen: false, delegate: null, collection: 'collection', slot: 500,
        }), 'collection')).resolves.toBe('mismatch');
      }

      expect((await db.select().from(builderJobs).where(eq(builderJobs.id, job!.id)))[0]?.completedAt)
        .not.toBeNull();
      expect((await db.select().from(obstacles).where(eq(obstacles.id, obstacle!.id)))[0]?.clearedAt)
        .not.toBeNull();
      expect((await getOrCreatePlayerAccount(db, seller.wallet, 'player_shards')).balance).toBe(sellerBefore);
      expect((await getOrCreatePlayerAccount(db, buyer.wallet, 'player_shards')).balance).toBe(buyerBefore);
      expect((await getOrCreateBaseAccount(db, seller.baseId, 'base_shards')).balance)
        .toBe(baseBefore + BigInt(OBSTACLES.clearRewardShards));
    },
  );

  it('settles due Keep/Mine upgrades and pre-upgrade mine accrual for the seller', async () => {
    const seller = await starter();
    const buyer = await starter();
    const deed = Keypair.generate().publicKey.toBase58();
    await registerOwnedDeed(db, seller.wallet, deed);
    const [keep] = await db.select().from(buildings).where(and(
      eq(buildings.baseId, seller.baseId), eq(buildings.type, 'keep'),
    ));
    const [mine] = await db.insert(buildings).values({
      playerWallet: seller.wallet, baseId: seller.baseId, type: 'mine', level: 1, tx: 10, ty: 10,
    }).returning();
    const now = new Date();
    await db.insert(builderJobs).values([
      {
        playerWallet: seller.wallet, baseId: seller.baseId, kind: 'upgrade',
        buildingId: keep!.id, finishesAt: new Date(now.getTime() - 1_000),
      },
      {
        playerWallet: seller.wallet, baseId: seller.baseId, kind: 'upgrade',
        buildingId: mine!.id, finishesAt: new Date(now.getTime() - 1_000),
      },
    ]);
    const dayAgo = new Date(now.getTime() - 86_400_000);
    await db.insert(mineState).values([
      { playerWallet: seller.wallet, accruedShards: 0n, lastAccrualAt: dayAgo },
      { playerWallet: buyer.wallet, accruedShards: 0n, lastAccrualAt: dayAgo },
    ]);

    await transferStableBase(db, seller.baseId, seller.wallet, buyer.wallet, deed);

    expect((await db.select().from(bases).where(eq(bases.id, seller.baseId)))[0]?.keepLevel).toBe(2);
    expect((await db.select().from(buildings).where(eq(buildings.id, mine!.id)))[0]?.level).toBe(2);
    expect((await db.select().from(baseTransfers).where(eq(baseTransfers.deedAssetId, deed)))[0]?.priorKeepLevel)
      .toBe(2);
    const sellerClock = (await db.select().from(mineState)
      .where(eq(mineState.playerWallet, seller.wallet)))[0]!;
    const buyerClock = (await db.select().from(mineState)
      .where(eq(mineState.playerWallet, buyer.wallet)))[0]!;
    expect(sellerClock.accruedShards).toBeGreaterThan(0n);
    expect(buyerClock.accruedShards).toBe(0n);
  });

  it('conveys a not-yet-due job and pays its later obstacle reward to the buyer', async () => {
    const seller = await starter();
    const buyer = await createTestPlayer(db);
    const deed = Keypair.generate().publicKey.toBase58();
    await registerOwnedDeed(db, seller.wallet, deed);
    const obstacle = await smallObstacleFor(seller.wallet, seller.baseId);
    const completesAt = new Date(Date.now() + 60_000);
    const [job] = await db.insert(builderJobs).values({
      playerWallet: seller.wallet, baseId: seller.baseId, kind: 'clear_obstacle',
      obstacleId: obstacle!.id, finishesAt: completesAt,
    }).returning();
    await transferStableBase(db, seller.baseId, seller.wallet, buyer.wallet, deed);
    expect((await db.select().from(builderJobs).where(eq(builderJobs.id, job!.id)))[0]?.completedAt).toBeNull();
    expect((await db.select().from(obstacles).where(eq(obstacles.id, obstacle!.id)))[0]?.clearedAt).toBeNull();
    const sellerBefore = (await getOrCreatePlayerAccount(db, seller.wallet, 'player_shards')).balance;
    const buyerBefore = (await getOrCreatePlayerAccount(db, buyer.wallet, 'player_shards')).balance;
    const baseBefore = (await getOrCreateBaseAccount(db, seller.baseId, 'base_shards')).balance;

    await completeDueJobs(db, buyer.wallet, new Date(completesAt.getTime() + 1_000), seller.baseId);

    expect((await getOrCreatePlayerAccount(db, seller.wallet, 'player_shards')).balance).toBe(sellerBefore);
    expect((await getOrCreatePlayerAccount(db, buyer.wallet, 'player_shards')).balance).toBe(buyerBefore);
    expect((await getOrCreateBaseAccount(db, seller.baseId, 'base_shards')).balance)
      .toBe(baseBefore + BigInt(OBSTACLES.clearRewardShards));
  });

  it('finish-job items follow the selected stable base after sale', async () => {
    const prior = process.env['MULTI_BASE_ENABLED'];
    process.env['MULTI_BASE_ENABLED'] = 'true';
    try {
      const seller = await starter();
      const buyer = await createTestPlayer(db);
      const deed = Keypair.generate().publicKey.toBase58();
      await registerOwnedDeed(db, seller.wallet, deed);
      await registerOwnedDeed(db, seller.wallet, Keypair.generate().publicKey.toBase58());
      await db.update(bases).set({ landPaidAt: new Date() }).where(eq(bases.id, seller.baseId));
      const obstacle = await smallObstacleFor(seller.wallet, seller.baseId);
      const [job] = await db.insert(builderJobs).values({
        playerWallet: seller.wallet, baseId: seller.baseId, kind: 'clear_obstacle',
        obstacleId: obstacle!.id, finishesAt: new Date(Date.now() + 60_000),
      }).returning();
      await db.insert(baseItems).values({
        baseId: seller.baseId, itemId: 'keg_of_haste', qty: 1,
      });
      await transferStableBase(db, seller.baseId, seller.wallet, buyer.wallet, deed);

      await expect(useItem(
        db, seller.wallet, 'keg_of_haste', `sold-finish-${randomWallet()}`,
        {
          baseId: seller.baseId, jobId: job!.id,
          authorizeBaseMutation: async () => {},
        },
      )).rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
      await expect(useItem(
        db, buyer.wallet, 'keg_of_haste', `buyer-finish-${randomWallet()}`,
        {
          baseId: seller.baseId, jobId: job!.id,
          authorizeBaseMutation: async () => {},
        },
      )).resolves.toMatchObject({ effect: { finishedJobId: job!.id } });
      expect((await db.select().from(builderJobs).where(eq(builderJobs.id, job!.id)))[0]?.completedAt)
        .not.toBeNull();
    } finally {
      if (prior === undefined) delete process.env['MULTI_BASE_ENABLED'];
      else process.env['MULTI_BASE_ENABLED'] = prior;
    }
  });

  it('rechecks selected-base deed evidence inside an item purchase before spending KEEP', async () => {
    const prior = process.env['MULTI_BASE_ENABLED'];
    process.env['MULTI_BASE_ENABLED'] = 'true';
    try {
      const owner = await starter();
      await db.update(bases).set({ keepLevel: 4, landPaidAt: new Date() })
        .where(eq(bases.id, owner.baseId));
      await fundTestKeep(db, owner.wallet, 20_000n, 'test.item-authority', randomWallet());
      const before = (await getOrCreatePlayerAccount(db, owner.wallet, 'player_keep')).balance;
      await expect(buyItem(
        db, owner.wallet, 'siege_gauntlets', `aged-item-${randomWallet()}`,
        {
          baseId: owner.baseId,
          authorizeBaseMutation: async () => {
            throw new HttpError(503, 'deed ownership unavailable or changed', 'DEED_AUTHORITY_UNAVAILABLE');
          },
        },
      )).rejects.toMatchObject({ code: 'DEED_AUTHORITY_UNAVAILABLE' });
      expect((await getOrCreatePlayerAccount(db, owner.wallet, 'player_keep')).balance).toBe(before);
      expect(await db.select().from(playerItems).where(and(
        eq(playerItems.playerWallet, owner.wallet), eq(playerItems.itemId, 'siege_gauntlets'),
      ))).toHaveLength(0);
    } finally {
      if (prior === undefined) delete process.env['MULTI_BASE_ENABLED'];
      else process.env['MULTI_BASE_ENABLED'] = prior;
    }
  });

  it('banks seller and buyer mine clocks before the active-base ownership change', async () => {
    const seller = await starter();
    const buyer = await starter();
    const deed = Keypair.generate().publicKey.toBase58();
    await registerOwnedDeed(db, seller.wallet, deed);
    await db.insert(buildings).values({
      playerWallet: seller.wallet, baseId: seller.baseId, type: 'mine', level: 4, tx: 10, ty: 10,
    });
    const old = new Date(Date.now() - 86_400_000);
    await db.insert(mineState).values([
      { playerWallet: seller.wallet, accruedShards: 0n, lastAccrualAt: old },
      { playerWallet: buyer.wallet, accruedShards: 0n, lastAccrualAt: old },
    ]);
    const before = Date.now();
    await transferStableBase(db, seller.baseId, seller.wallet, buyer.wallet, deed);
    const clocks = await db.select().from(mineState);
    const sellerClock = clocks.find((r) => r.playerWallet === seller.wallet)!;
    const buyerClock = clocks.find((r) => r.playerWallet === buyer.wallet)!;
    expect(sellerClock.accruedShards).toBeGreaterThan(0n);
    expect(buyerClock.accruedShards).toBe(0n);
    expect(sellerClock.lastAccrualAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(buyerClock.lastAccrualAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('stops sold-base production for the seller and starts it once for the buyer', async () => {
    const prior = process.env['MULTI_BASE_ENABLED'];
    process.env['MULTI_BASE_ENABLED'] = 'true';
    try {
      const seller = await starter();
      const buyer = await starter();
      const deed = Keypair.generate().publicKey.toBase58();
      await registerOwnedDeed(db, seller.wallet, deed);
      await db.insert(buildings).values({
        playerWallet: seller.wallet, baseId: seller.baseId, type: 'mine', level: 4, tx: 10, ty: 10,
      });
      const dayAgo = new Date(Date.now() - 86_400_000);
      await ensureMineState(db, seller.wallet, dayAgo);
      await ensureMineState(db, buyer.wallet, dayAgo);
      await transferStableBase(db, seller.baseId, seller.wallet, buyer.wallet, deed);
      await db.insert(deedOwnershipObservations).values({
        baseId: seller.baseId, assetId: deed, owner: buyer.wallet, slot: 901n,
        checkedAt: new Date(), source: 'test-buyer-mining-authority', status: 'owned',
        auditHash: `buyer-mine-${randomWallet()}`,
      });

      const [buyerClock] = await db.select().from(mineState).where(eq(mineState.playerWallet, buyer.wallet));
      const afterOneDay = new Date(buyerClock!.lastAccrualAt.getTime() + 86_400_000);
      const sellerStatus = await getMineStatus(db, seller.wallet, afterOneDay);
      expect(sellerStatus.mining).toMatchObject({ quotaPerDay: 0, accrued: 0, mineCount: 0 });
      await expect(collectMine(db, seller.wallet, afterOneDay, mineAuthority)).rejects.toThrow(/build a Mine/);

      const buyerStatus = await getMineStatus(db, buyer.wallet, afterOneDay);
      expect(buyerStatus.mining.quotaPerDay).toBeGreaterThan(0);
      expect(buyerStatus.mining.accrued).toBe(buyerStatus.mining.quotaPerDay);
      await expect(collectMine(db, buyer.wallet, afterOneDay, mineAuthority)).resolves.toEqual({
        amount: BigInt(buyerStatus.mining.quotaPerDay),
      });
    } finally {
      if (prior === undefined) delete process.env['MULTI_BASE_ENABLED'];
      else process.env['MULTI_BASE_ENABLED'] = prior;
    }
  });

  it('does not credit a Mine collect after a deed transfer wins the transaction lock race', async () => {
    const prior = process.env['MULTI_BASE_ENABLED'];
    process.env['MULTI_BASE_ENABLED'] = 'true';
    try {
      const seller = await starter();
      const recipient = await createTestPlayer(db);
      const deed = Keypair.generate().publicKey.toBase58();
      await registerOwnedDeed(db, seller.wallet, deed);
      await db.insert(buildings).values({
        playerWallet: seller.wallet, baseId: seller.baseId,
        type: 'mine', level: 1, tx: 10, ty: 10,
      });
      const collectedAt = new Date();
      await db.insert(mineState).values({
        playerWallet: seller.wallet, accruedShards: 400n, lastAccrualAt: collectedAt,
      });
      const [evidence] = await db.insert(deedOwnershipObservations).values({
        baseId: seller.baseId, assetId: deed, owner: seller.wallet, slot: 910n,
        checkedAt: new Date(), source: 'test-mine-transfer-boundary', status: 'owned',
        auditHash: `mine-transfer-${randomWallet()}`,
      }).returning();
      const beforeBalance = (await getOrCreatePlayerAccount(db, seller.wallet, 'player_shards')).balance;
      const beforeClock = (await db.select().from(mineState)
        .where(eq(mineState.playerWallet, seller.wallet)))[0]!;

      const loss = await holdWalletAuthorityChange(seller.wallet, async (tx) => {
        await tx.delete(baseSlots).where(eq(baseSlots.baseId, seller.baseId));
        await tx.update(bases).set({ ownerWallet: recipient.wallet, status: 'inactive' })
          .where(eq(bases.id, seller.baseId));
        await tx.update(deedOwnershipObservations).set({
          owner: recipient.wallet, status: 'mismatch', checkedAt: new Date(),
        }).where(eq(deedOwnershipObservations.id, evidence!.id));
      });
      const collecting = collectMine(db, seller.wallet, collectedAt, mineAuthority);
      const rejected = expect(collecting).rejects.toThrow(/build a Mine|ownership/);
      await new Promise<void>((resolve) => setImmediate(resolve));
      loss.release();
      await loss.done;
      await rejected;

      expect((await getOrCreatePlayerAccount(db, seller.wallet, 'player_shards')).balance)
        .toBe(beforeBalance);
      expect((await db.select().from(mineState)
        .where(eq(mineState.playerWallet, seller.wallet)))[0]).toMatchObject({
        accruedShards: beforeClock.accruedShards,
        lastAccrualAt: beforeClock.lastAccrualAt,
      });
    } finally {
      if (prior === undefined) delete process.env['MULTI_BASE_ENABLED'];
      else process.env['MULTI_BASE_ENABLED'] = prior;
    }
  });

  it('does not credit or advance a Daily Cache after finalized evidence ages during the lock wait', async () => {
    const prior = process.env['MULTI_BASE_ENABLED'];
    process.env['MULTI_BASE_ENABLED'] = 'true';
    try {
      const p = await starter();
      const deed = Keypair.generate().publicKey.toBase58();
      await registerOwnedDeed(db, p.wallet, deed);
      await db.insert(buildings).values({
        playerWallet: p.wallet, baseId: p.baseId,
        type: 'mine', level: 1, tx: 10, ty: 10,
      });
      const [evidence] = await db.insert(deedOwnershipObservations).values({
        baseId: p.baseId, assetId: deed, owner: p.wallet, slot: 920n,
        checkedAt: new Date(), source: 'test-cache-authority-boundary', status: 'owned',
        auditHash: `cache-proof-${randomWallet()}`,
      }).returning();
      const beforeBalance = (await getOrCreatePlayerAccount(db, p.wallet, 'player_shards')).balance;
      const aging = await holdWalletAuthorityChange(p.wallet, async (tx) => {
        await tx.update(deedOwnershipObservations).set({
          checkedAt: new Date(Date.now() - BASE_OWNERSHIP.mutationFreshnessMs - 1),
        }).where(eq(deedOwnershipObservations.id, evidence!.id));
      });
      const claiming = claimDailyCache(db, p.wallet, new Date(), mineAuthority);
      const rejected = expect(claiming).rejects.toMatchObject({ code: 'DEED_AUTHORITY_UNAVAILABLE' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      aging.release();
      await aging.done;
      await rejected;

      expect((await getOrCreatePlayerAccount(db, p.wallet, 'player_shards')).balance).toBe(beforeBalance);
      expect(await db.select().from(streaks).where(eq(streaks.playerWallet, p.wallet))).toHaveLength(0);
    } finally {
      if (prior === undefined) delete process.env['MULTI_BASE_ENABLED'];
      else process.env['MULTI_BASE_ENABLED'] = prior;
    }
  });

  it('refresh and explicit claim contend without reversing lock order or moving twice', async () => {
    const seller = await starter();
    const buyer = Keypair.generate().publicKey.toBase58();
    const deed = Keypair.generate().publicKey.toBase58();
    await registerOwnedDeed(db, seller.wallet, deed);
    const outcomes = await Promise.allSettled([
      refreshBaseOwnership(db, seller.baseId, async () => ({
        owner: buyer, frozen: false, delegate: null, collection: 'collection', slot: 100,
      }), 'collection'),
      transferStableBase(db, seller.baseId, seller.wallet, buyer, deed),
    ]);
    expect(outcomes.some((r) => r.status === 'fulfilled')).toBe(true);
    expect((await db.select().from(bases).where(eq(bases.id, seller.baseId)))[0]?.ownerWallet).toBe(buyer);
  });

  it('uses the maximum active base level for the wallet quota, never the sum', async () => {
    const p = await starter();
    const second = await registerOwnedDeed(db, p.wallet, `deed-${randomWallet()}`);
    await db.update(bases).set({ keepLevel: 7 }).where(eq(bases.id, p.baseId));
    await db.update(bases).set({ keepLevel: 12 }).where(eq(bases.id, second.id));
    expect(await maxActiveBaseKeepLevel(db, p.wallet)).toBe(12);
  });

  it('fails closed on unavailable ownership but reuses fresh finalized evidence', async () => {
    let p = await starter();
    while (!PublicKey.isOnCurve(new PublicKey(p.wallet).toBytes())) p = await starter();
    const deed = Keypair.generate().publicKey.toBase58();
    await registerOwnedDeed(db, p.wallet, deed);
    await expect(requireFreshBaseAuthority(db, p.wallet, p.baseId, null, null))
      .rejects.toMatchObject({ code: 'DEED_AUTHORITY_UNAVAILABLE' });
    expect((await listWalletBases(db, p.wallet))[0]).toMatchObject({ status: 'active', slot: 1 });

    let reads = 0;
    const reader = async () => {
      reads++;
      return { owner: p.wallet, frozen: false, delegate: null, collection: 'collection', slot: 100 };
    };
    await requireFreshBaseAuthority(db, p.wallet, p.baseId, reader, 'collection');
    await requireFreshBaseAuthority(db, p.wallet, p.baseId, async () => { throw new Error('must not read'); }, 'collection');
    expect(reads).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 2026-09-18 production incident. Two players who legitimately owned their
  // deeds were answered 503 DEED_AUTHORITY_UNAVAILABLE in steady state (POST
  // /raids 11:13:07Z, GET /base 11:17:14Z; 2 of ~1,900 requests, observation
  // `owned` before and after). These pin WHY each resilience rule exists and
  // that none of them relaxes the rule they sit beside: a privileged action
  // proceeds only on a finalized `owned` proof at most ten seconds old.
  // ---------------------------------------------------------------------------

  /** A deeded base whose accepted `owned` proof is exactly `ageMs` old at `now`. */
  async function deededWithProofAged(ageMs: number, now: Date) {
    const p = await starter();
    const deed = Keypair.generate().publicKey.toBase58();
    await registerOwnedDeed(db, p.wallet, deed);
    const checkedAt = new Date(now.getTime() - ageMs);
    expect(await refreshBaseOwnership(db, p.baseId, async () => ({
      owner: p.wallet, frozen: false, delegate: null, collection: 'collection', slot: 100,
    }), 'collection', checkedAt)).toBe('owned');
    return { ...p, deed, checkedAt };
  }
  const observation = async (baseId: string) => (await db.select().from(deedOwnershipObservations)
    .where(eq(deedOwnershipObservations.baseId, baseId)))[0]!;
  const lockedCheck = (wallet: string, baseId: string, at: Date) => db.transaction(
    (tx) => assertFreshLockedBaseAuthority(tx, wallet, baseId, at),
  );

  /** A finalized read the test answers by hand, so "the request did not wait
   * for the chain" is an ORDERING fact and never a timing guess. */
  function heldRead() {
    let markStarted!: () => void;
    let settle!: (outcome: { slot: number } | Error) => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const outcome = new Promise<{ slot: number } | Error>((resolve) => { settle = resolve; });
    let reads = 0;
    const readerFor = (owner: string) => async () => {
      reads++;
      markStarted();
      const settled = await outcome;
      if (settled instanceof Error) throw settled;
      return { owner, frozen: false, delegate: null, collection: 'collection', slot: settled.slot };
    };
    /** `served` only if the gate answered while the read was still unanswered. */
    const raceGate = (gate: Promise<unknown>) => Promise.race([
      gate.then(() => 'served' as const),
      started.then(() => new Promise((resolve) => { setTimeout(resolve, 500); }))
        .then(() => 'blocked on the chain read' as const),
    ]);
    return { readerFor, raceGate, started, settle, reads: () => reads };
  }
  /** The structured warn lines a block emitted (the only trace a renewal nobody
   * awaits leaves when it does not land). */
  function captureDeedWarnings() {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events = (): Record<string, unknown>[] => warn.mock.calls.flatMap(([line]) => {
      try { return [JSON.parse(String(line)) as Record<string, unknown>]; } catch { return []; }
    });
    return { events, restore: () => warn.mockRestore() };
  }

  // REWRITTEN 2026-09-18 (security review of 010a42d0). This test used to pin an
  // AWAITED early renewal (`reads === 1` the moment the gate returned). That
  // made a request wait on a read that can outlive the proof it renews, and a
  // slow failure then refused a request the cached proof was entitled to serve.
  // The rule it encodes now: the early renewal still happens and still lands
  // for the locked re-check, but the request is never held for it.
  it('renews a proof that is about to expire without holding the request, and the locked re-check finds the renewed proof', async () => {
    // The mechanism that needs NO RPC failure at all: the pre-transaction gate
    // accepted a 9.5 s proof without reading, and the locked re-check inside
    // the same request's transaction refused it at 10.1 s.
    const now = new Date();
    const p = await deededWithProofAged(BASE_OWNERSHIP.mutationFreshnessMs - 500, now);
    const chain = heldRead();
    expect(await chain.raceGate(
      requireFreshBaseAuthority(db, p.wallet, p.baseId, chain.readerFor(p.wallet), 'collection', now),
    )).toBe('served');
    // The renewal was started for this request even though nothing waited on it.
    await chain.started;
    expect(chain.reads()).toBe(1);
    expect(await observation(p.baseId)).toMatchObject({ slot: 100n, checkedAt: p.checkedAt });

    chain.settle({ slot: 101 });
    await vi.waitFor(async () => expect(await observation(p.baseId)).toMatchObject({
      status: 'owned', owner: p.wallet, slot: 101n, checkedAt: now, source: 'gate-renewal',
    }));
    // The locked re-check reads the LATEST row: past the old proof's expiry it
    // passes on the renewed one instead of answering the incident's 503.
    await expect(lockedCheck(p.wallet, p.baseId, new Date(now.getTime() + 1_000))).resolves.toBeTruthy();

    // A proof with more life left than the refresh-ahead margin is still reused:
    // the gate did not become "always read".
    const roomy = await deededWithProofAged(
      BASE_OWNERSHIP.mutationFreshnessMs - BASE_OWNERSHIP.gateRefreshAheadMs - 500, now,
    );
    const untouched = heldRead();
    await requireFreshBaseAuthority(
      db, roomy.wallet, roomy.baseId, untouched.readerFor(roomy.wallet), 'collection', now,
    );
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(untouched.reads()).toBe(0);
  });

  it('coalesces the early renewal: parallel gated requests for one base start ONE read', async () => {
    // A client opens /base, /army, /heroes and /mine/status together. Each runs
    // this gate; one renewal (one paced RPC start, one locked apply) serves all.
    const now = new Date();
    const p = await deededWithProofAged(8_000, now);
    const chain = heldRead();
    const reader = chain.readerFor(p.wallet);
    expect(await chain.raceGate(Promise.all(Array.from({ length: 4 }, () => (
      requireFreshBaseAuthority(db, p.wallet, p.baseId, reader, 'collection', now)
    ))))).toBe('served');
    await chain.started;
    chain.settle({ slot: 101 });
    await vi.waitFor(async () => expect(await observation(p.baseId)).toMatchObject({ slot: 101n }));
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(chain.reads()).toBe(1);
  });

  // REWRITTEN 2026-09-18 (same review). It used to assert only that a FAST
  // failed early renewal is forgiven. The reviewer's reproduction was the slow
  // one: proof 8 s old, reader failing after 2.5 s => the gate measured the
  // proof at 10.5 s and answered 503, although origin/main served that request
  // from the cached proof with no read at all.
  it('never holds a request on a read that outlives its still-valid proof; a failed renewal neither refuses nor extends it', async () => {
    const now = new Date();
    const p = await deededWithProofAged(8_000, now);
    const chain = heldRead();
    const warnings = captureDeedWarnings();
    try {
      // Decided while the 8 s proof is still inside the rule — not 2.5 s later.
      expect(await chain.raceGate(
        requireFreshBaseAuthority(db, p.wallet, p.baseId, chain.readerFor(p.wallet), 'collection', now),
      )).toBe('served');
      await chain.started;
      chain.settle(new DeedReadUnavailableError('rpc-error'));
      // Nobody awaits the renewal, so its failure must still be attributable.
      await vi.waitFor(() => expect(warnings.events()).toContainEqual({
        level: 40, event: 'deed_ownership_refresh_unavailable',
        baseId: p.baseId, source: 'gate-renewal', reason: 'rpc-error', preservedProof: true,
      }));
    } finally {
      warnings.restore();
    }
    // ...and the proof was NOT renewed: same instant, same slot, still `owned`.
    expect(await observation(p.baseId)).toMatchObject({ status: 'owned', slot: 100n, checkedAt: p.checkedAt });
    // So a MUTATION is still fenced at ten seconds from the real finalized read.
    await expect(lockedCheck(p.wallet, p.baseId, new Date(now.getTime() + 1_900))).resolves.toBeTruthy();
    await expect(lockedCheck(p.wallet, p.baseId, new Date(now.getTime() + 2_100)))
      .rejects.toMatchObject({ statusCode: 503, code: 'DEED_AUTHORITY_UNAVAILABLE' });
  });

  it('an abandoned renewal that throws is logged without the wallet and never becomes an unhandled rejection', async () => {
    // refreshBaseOwnership swallows READ failures itself; what can still throw
    // is the database. Nothing awaits this promise, so an uncaught rejection
    // here would be a process-level fault on a live game server.
    const now = new Date();
    const p = await deededWithProofAged(8_000, now);
    const dbGone = Object.assign(Object.create(db) as Db, {
      transaction: async () => { throw Object.assign(new Error(`connection lost for ${p.wallet}`), { code: '57P01' }); },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    const warnings = captureDeedWarnings();
    try {
      // The request itself is served from the still-valid proof.
      await expect(requireFreshBaseAuthority(dbGone, p.wallet, p.baseId, async () => ({
        owner: p.wallet, frozen: false, delegate: null, collection: 'collection', slot: 101,
      }), 'collection', now)).resolves.toMatchObject({ id: p.baseId });
      await vi.waitFor(() => expect(warnings.events()).toContainEqual({
        level: 40, event: 'deed_gate_renewal_failed', baseId: p.baseId, error: 'Error', code: '57P01',
      }));
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(unhandled).toEqual([]);
      expect(JSON.stringify(warnings.events())).not.toContain(p.wallet);
    } finally {
      warnings.restore();
      process.off('unhandledRejection', onUnhandled);
    }
    expect(await observation(p.baseId)).toMatchObject({ status: 'owned', slot: 100n, checkedAt: p.checkedAt });
  });

  it('still fails closed once the proof is past ten seconds and the chain cannot be read; never evicts', async () => {
    const now = new Date();
    const p = await deededWithProofAged(BASE_OWNERSHIP.mutationFreshnessMs + 1, now);
    const rpcDown = async () => { throw new DeedReadUnavailableError('rpc-error'); };
    await expect(requireFreshBaseAuthority(db, p.wallet, p.baseId, rpcDown, 'collection', now))
      .rejects.toMatchObject({ statusCode: 503, code: 'DEED_AUTHORITY_UNAVAILABLE' });
    // Auditability is unchanged for an expired proof: the outage is recorded on
    // the row, the monotonic slot floor survives, and the owner keeps the base.
    expect(await observation(p.baseId)).toMatchObject({ status: 'unavailable', owner: null, slot: 100n });
    expect((await db.select().from(bases).where(eq(bases.id, p.baseId)))[0])
      .toMatchObject({ ownerWallet: p.wallet, status: 'active' });
    expect(await db.select().from(baseSlots).where(eq(baseSlots.baseId, p.baseId))).toHaveLength(1);
    expect(await db.select().from(baseTransfers).where(eq(baseTransfers.deedAssetId, p.deed))).toHaveLength(0);
  });

  // REWRITTEN 2026-09-18 (security review of 010a42d0): with an AWAITED early
  // renewal the request that carried the 8 s proof was itself refused. The
  // early renewal is no longer awaited, so that request is decided on its
  // still-valid proof — exactly what the ten-second rule (and origin/main, which
  // did not read at all here) allows. What must NOT change: the answer the
  // renewal found lands on the row and fences the base from then on.
  it('an ANSWER of "no eligible asset" still revokes a live proof; only answer-less reads preserve it', async () => {
    // A burned or foreign asset reads as null AFTER a successful transport. That
    // is evidence, unlike an RPC error, and must fence the base as soon as it
    // is known — also when the read that found it was an un-awaited renewal.
    const now = new Date();
    const p = await deededWithProofAged(8_000, now);
    await expect(requireFreshBaseAuthority(db, p.wallet, p.baseId, async () => null, 'collection', now))
      .resolves.toMatchObject({ id: p.baseId });
    await vi.waitFor(async () => expect(await observation(p.baseId))
      .toMatchObject({ status: 'unavailable', owner: null, source: 'gate-renewal' }));
    await expect(lockedCheck(p.wallet, p.baseId, now)).rejects.toMatchObject({ statusCode: 503 });
    const rpcDown = async () => { throw new DeedReadUnavailableError('rpc-error'); };
    await expect(requireFreshBaseAuthority(db, p.wallet, p.baseId, rpcDown, 'collection', now))
      .rejects.toMatchObject({ statusCode: 503, code: 'DEED_AUTHORITY_UNAVAILABLE' });
  });

  // REWRITTEN 2026-09-18 for the same reason; the in-request refusal it used to
  // pin is kept below for the read the gate DOES await (no valid proof at entry).
  it('a finalized mismatch is never softened by a live proof: it transfers, deactivates and fences the seller', async () => {
    const now = new Date();
    const buyer = Keypair.generate().publicKey.toBase58();
    const sold = async (p: { wallet: string; baseId: string; deed: string }, slot: bigint) => {
      expect(await observation(p.baseId)).toMatchObject({ status: 'mismatch', owner: buyer, slot });
      expect((await db.select().from(bases).where(eq(bases.id, p.baseId)))[0])
        .toMatchObject({ ownerWallet: buyer, status: 'inactive' });
      expect(await db.select().from(baseSlots).where(eq(baseSlots.baseId, p.baseId))).toHaveLength(0);
      expect(await db.select().from(baseTransfers).where(eq(baseTransfers.deedAssetId, p.deed)))
        .toEqual([expect.objectContaining({ fromWallet: p.wallet, toWallet: buyer })]);
      // The seller's `owned` proof buys nothing after the sale is seen: every
      // mutation's locked re-check and the seller's next gated request refuse.
      await expect(lockedCheck(p.wallet, p.baseId, now))
        .rejects.toMatchObject({ code: 'DEED_OWNERSHIP_CHANGED' });
      await expect(requireFreshBaseAuthority(db, p.wallet, p.baseId, null, 'collection', now))
        .rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    };

    // Found by the un-awaited early renewal of an 8 s proof.
    const early = await deededWithProofAged(8_000, now);
    const chain = heldRead();
    try {
      await requireFreshBaseAuthority(db, early.wallet, early.baseId, chain.readerFor(buyer), 'collection', now);
      await chain.started;
      expect(chain.reads()).toBe(1);
    } finally { chain.settle({ slot: 101 }); }
    // Mismatch is journaled before the separate custody reconciliation commits.
    // Wait for the complete sale, not just its already-durable earning stop.
    // 2026-10-10 (CI cluster E): the default 1 s waitFor expired on a cold CI shard
    // (multi-base ran first in shard 7) before the un-awaited renewal's custody
    // reconciliation committed; the assertion is unchanged, only the patience.
    await vi.waitFor(() => sold(early, 101n), { timeout: 10_000, interval: 50 });

    // Found by the AWAITED read (proof expired at entry) while the row holds a
    // live `owned` proof the observer landed mid-read: refused in this request.
    const late = await deededWithProofAged(BASE_OWNERSHIP.mutationFreshnessMs + 5_000, now);
    await expect(requireFreshBaseAuthority(db, late.wallet, late.baseId, async () => {
      expect(await refreshBaseOwnership(db, late.baseId, async () => ({
        owner: late.wallet, frozen: false, delegate: null, collection: 'collection', slot: 300,
      }), 'collection', now, 'sweep')).toBe('owned');
      return { owner: buyer, frozen: false, delegate: null, collection: 'collection', slot: 301 };
    }, 'collection', now)).rejects.toMatchObject({ statusCode: 503, code: 'DEED_AUTHORITY_UNAVAILABLE' });
    await sold(late, 301n);
  });

  it('accepts the proof the observer renewed while the foreground read was queued', async () => {
    // The observer and a foreground read race on one deed. The observer lands a
    // NEWER finalized slot first, so the foreground answer is correctly rejected
    // as `stale-floor` — and the request used to be refused although the row now
    // held a seconds-old `owned` proof for this very wallet.
    const now = new Date();
    const p = await deededWithProofAged(BASE_OWNERSHIP.mutationFreshnessMs + 5_000, now);
    const racedReader = async () => {
      expect(await refreshBaseOwnership(db, p.baseId, async () => ({
        owner: p.wallet, frozen: false, delegate: null, collection: 'collection', slot: 300,
      }), 'collection', new Date(), 'sweep')).toBe('owned');
      return { owner: p.wallet, frozen: false, delegate: null, collection: 'collection', slot: 250 };
    };
    await expect(requireFreshBaseAuthority(db, p.wallet, p.baseId, racedReader, 'collection', now))
      .resolves.toMatchObject({ id: p.baseId });
    expect(await observation(p.baseId)).toMatchObject({ status: 'owned', slot: 300n, source: 'sweep' });

    // The same race never launders a sale: if the observer saw a BUYER, the
    // re-read row is a mismatch and the request is refused.
    const sold = await deededWithProofAged(BASE_OWNERSHIP.mutationFreshnessMs + 5_000, now);
    const buyer = Keypair.generate().publicKey.toBase58();
    await expect(requireFreshBaseAuthority(db, sold.wallet, sold.baseId, async () => {
      await refreshBaseOwnership(db, sold.baseId, async () => ({
        owner: buyer, frozen: false, delegate: null, collection: 'collection', slot: 300,
      }), 'collection', new Date(), 'sweep');
      return { owner: sold.wallet, frozen: false, delegate: null, collection: 'collection', slot: 250 };
    }, 'collection', now)).rejects.toMatchObject({ statusCode: 503 });
    expect((await db.select().from(bases).where(eq(bases.id, sold.baseId)))[0])
      .toMatchObject({ ownerWallet: buyer, status: 'inactive' });
  });

  it('ages the fallback proof at the REAL instant of the decision: a slow failed read cannot launder a proof that expired while it ran', async () => {
    // The observer lands an `owned` proof while this request's foreground read
    // is queued, then the read fails. The gate may fall back on that proof — but
    // a read can take ~16 s to fail (8 s paced queue + 8 s RPC), and the proof
    // ages the whole time. GET /army (completes due training/research), GET
    // /army/previous, GET /heroes and GET /mine/status have NO locked re-check:
    // this decision is their only fence. Aged at request entry instead of at
    // the decision, a seller could be served on a proof up to ~26 s old.
    for (const scenario of [
      { readFailsAfterMs: 2_500, served: false }, // 8 s at entry, 10.5 s at the decision
      { readFailsAfterMs: 1_500, served: true }, //  8 s at entry,  9.5 s at the decision
    ]) {
      const entered = new Date();
      const p = await deededWithProofAged(BASE_OWNERSHIP.mutationFreshnessMs + 5_000, entered);
      const observedAt = new Date(entered.getTime() - 8_000);
      vi.useFakeTimers({ now: entered, toFake: ['Date'] });
      try {
        const slowFailingRead = async () => {
          expect(await refreshBaseOwnership(db, p.baseId, async () => ({
            owner: p.wallet, frozen: false, delegate: null, collection: 'collection', slot: 300,
          }), 'collection', observedAt, 'sweep')).toBe('owned');
          vi.setSystemTime(entered.getTime() + scenario.readFailsAfterMs);
          throw new DeedReadUnavailableError('rpc-error');
        };
        const gate = requireFreshBaseAuthority(db, p.wallet, p.baseId, slowFailingRead, 'collection', entered);
        if (scenario.served) await expect(gate).resolves.toMatchObject({ id: p.baseId });
        else await expect(gate).rejects.toMatchObject({ statusCode: 503, code: 'DEED_AUTHORITY_UNAVAILABLE' });
      } finally {
        vi.useRealTimers();
      }
      // Either way the failed read is not evidence: the observer's proof keeps
      // its own instant and slot, and nobody is evicted.
      expect(await observation(p.baseId)).toMatchObject({
        status: 'owned', owner: p.wallet, slot: 300n, checkedAt: observedAt, source: 'sweep',
      });
      expect((await db.select().from(bases).where(eq(bases.id, p.baseId)))[0])
        .toMatchObject({ ownerWallet: p.wallet, status: 'active' });
    }
  });

  it('ages the cached proof at the REAL instant too: a gate that stalled past the proof\'s life reads the chain instead of serving it', async () => {
    // Not waiting for the chain does not mean deciding in the past. If the
    // gate's own queries stall (saturated pool) for longer than the proof has
    // left, the proof is expired when the decision is made and the ordinary
    // expired-proof path applies: read the chain, fail closed without an answer.
    const stallingDb = (stallMs: number) => {
      let stalled = false;
      return Object.assign(Object.create(db) as Db, {
        select: ((fields?: Parameters<Db['select']>[0]) => {
          if (!stalled) {
            stalled = true;
            vi.setSystemTime(Date.now() + stallMs);
          }
          return fields ? db.select(fields) : db.select();
        }) as Db['select'],
      });
    };
    const entered = new Date();
    const refused = await deededWithProofAged(8_000, entered);
    const renewed = await deededWithProofAged(8_000, entered);
    vi.useFakeTimers({ now: entered, toFake: ['Date'] });
    try {
      const rpcDown = async () => { throw new DeedReadUnavailableError('rpc-error'); };
      await expect(requireFreshBaseAuthority(
        stallingDb(2_500), refused.wallet, refused.baseId, rpcDown, 'collection', entered,
      )).rejects.toMatchObject({ statusCode: 503, code: 'DEED_AUTHORITY_UNAVAILABLE' });

      vi.setSystemTime(entered);
      let reads = 0;
      await expect(requireFreshBaseAuthority(stallingDb(2_500), renewed.wallet, renewed.baseId, async () => {
        reads++;
        return { owner: renewed.wallet, frozen: false, delegate: null, collection: 'collection', slot: 101 };
      }, 'collection', entered)).resolves.toMatchObject({ id: renewed.baseId });
      // AWAITED this time: the proof is on the row before the gate returns.
      expect(reads).toBe(1);
      expect(await observation(renewed.baseId)).toMatchObject({ status: 'owned', slot: 101n, checkedAt: entered });
    } finally {
      vi.useRealTimers();
    }
    expect(await observation(refused.baseId))
      .toMatchObject({ status: 'owned', slot: 100n, checkedAt: refused.checkedAt });
  });

  it('an unanswered observer wave does not destroy live proofs, but still records an outage on expired ones', async () => {
    // One failed getMultipleAccounts used to rewrite every deed in the wave as
    // `unavailable` — including proofs a foreground read had established seconds
    // earlier — so each of those owners then needed a foreground read against
    // the same sick RPC. A wave that answered nothing is not evidence.
    const now = new Date();
    const live = await deededWithProofAged(3_000, now);
    const expired = await deededWithProofAged(BASE_OWNERSHIP.mutationFreshnessMs + 5_000, now);
    const reader = (async () => {
      throw new Error('observer must not fall back to one RPC per asset');
    }) as import('../src/game/baseOwnership').FinalizedDeedReader;
    reader.readBatch = async (assets) => ({
      owners: new Map(assets.map(({ assetId }) => [assetId, null])),
      contextSlot: null, transportSucceeded: false,
    });
    // This file accumulates active deeds in one shared database. Park the rest
    // behind these two (least-recently-checked first) so ONE bounded wave holds
    // exactly this test's fixtures instead of a paced multi-wave full sweep.
    const others = await db.select({ id: bases.id, deed: bases.deedAssetId }).from(bases)
      .where(and(eq(bases.status, 'active'), isNotNull(bases.deedAssetId)));
    for (const base of others.filter((row) => row.id !== live.baseId && row.id !== expired.baseId)) {
      const parked = {
        checkedAt: new Date(Date.now() + 60_000), source: 'test-parked', status: 'unavailable' as const,
        owner: null, assetId: base.deed!, auditHash: `parked-${base.id}`,
      };
      const [prior] = await db.select({ id: deedOwnershipObservations.id }).from(deedOwnershipObservations)
        .where(eq(deedOwnershipObservations.baseId, base.id));
      if (prior) await db.update(deedOwnershipObservations).set(parked)
        .where(eq(deedOwnershipObservations.id, prior.id));
      else await db.insert(deedOwnershipObservations).values({ baseId: base.id, ...parked });
    }
    const swept = await sweepActiveBaseOwnership(db, reader, 'collection', new Date(), 2);
    expect(swept).toEqual(expect.arrayContaining([
      { baseId: live.baseId, status: 'unavailable' }, { baseId: expired.baseId, status: 'unavailable' },
    ]));
    expect(await observation(live.baseId)).toMatchObject({ status: 'owned', checkedAt: live.checkedAt });
    expect(await observation(expired.baseId)).toMatchObject({ status: 'unavailable', owner: null, slot: 100n });
    for (const p of [live, expired]) {
      expect((await db.select().from(bases).where(eq(bases.id, p.baseId)))[0])
        .toMatchObject({ ownerWallet: p.wallet, status: 'active' });
    }

    // A wave that DID answer "no eligible asset" for a deed is evidence and
    // revokes even a live proof (burned deed), exactly as before.
    reader.readBatch = async (assets) => ({
      owners: new Map(assets.map(({ assetId }) => [assetId, null])),
      contextSlot: 400, transportSucceeded: true,
    });
    await sweepActiveBaseOwnership(db, reader, 'collection', new Date(), 2);
    expect(await observation(live.baseId)).toMatchObject({ status: 'unavailable', owner: null });
  });

  it('parallel-checks five deeds and rejects when the first base transfers before the action boundary', async () => {
    const p = await starter();
    const deeds = Array.from({ length: 5 }, () => Keypair.generate().publicKey.toBase58());
    for (const deed of deeds) await registerOwnedDeed(db, p.wallet, deed);
    const active = (await listWalletBases(db, p.wallet)).filter((base) => base.slot !== null);
    expect(active).toHaveLength(5);
    const first = active.find((base) => base.deedAssetId === deeds[0])!;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let started = 0;
    const authorize = requireFreshActiveBaseAuthorities(db, p.wallet, async (assetId) => {
      started++;
      if (assetId !== deeds[0]) await blocked;
      return { owner: p.wallet, frozen: false, delegate: null, collection: 'collection', slot: 900_000 };
    }, 'collection');
    for (let i = 0; i < 100 && started < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(started).toBe(5);
    for (let i = 0; i < 100; i++) {
      const [seen] = await db.select({ status: deedOwnershipObservations.status })
        .from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, first.id));
      if (seen?.status === 'owned') break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const buyer = Keypair.generate().publicKey.toBase58();
    // The race is a genuine newer transfer after the first accepted proof,
    // not a trusted fixture call bypassing its established ownership floor.
    await transferStableBase(db, first.id, p.wallet, buyer, deeds[0]!, {
      owner: buyer, frozen: false, delegate: null, collection: 'collection', slot: 900_001, observedAtMs: Date.now(),
    });
    release();
    await expect(authorize).rejects.toMatchObject({ code: 'DEED_OWNERSHIP_CHANGED' });
  });

  it('rotates a bounded ownership sweep past the first page', async () => {
    const parked = await db.select({ id: bases.id, deed: bases.deedAssetId }).from(bases)
      .where(eq(bases.status, 'active'));
    for (const base of parked.filter((row) => row.deed !== null)) {
      const [prior] = await db.select({ id: deedOwnershipObservations.id }).from(deedOwnershipObservations)
        .where(eq(deedOwnershipObservations.baseId, base.id));
      const evidence = {
        checkedAt: new Date(Date.now() + 60_000), source: 'test-parked', status: 'unavailable' as const,
        owner: null, assetId: base.deed!, auditHash: `parked-${base.id}`,
      };
      if (prior) await db.update(deedOwnershipObservations).set(evidence)
        .where(eq(deedOwnershipObservations.id, prior.id));
      else await db.insert(deedOwnershipObservations).values({ baseId: base.id, ...evidence });
    }
    const wallet = Keypair.generate().publicKey.toBase58();
    await db.insert(players).values({ wallet });
    const created = await db.insert(bases).values(Array.from({ length: 5 }, () => ({
      ownerWallet: wallet, deedAssetId: Keypair.generate().publicKey.toBase58(), status: 'active' as const,
    }))).returning({ id: bases.id });
    const visited = new Set<string>();
    for (let pass = 0; pass < 3; pass++) {
      const result = await sweepActiveBaseOwnership(
        db,
        async (assetId) => {
          const base = await db.select({ id: bases.id }).from(bases).where(eq(bases.deedAssetId, assetId));
          if (base[0]) visited.add(base[0].id);
          return { owner: wallet, frozen: false, delegate: null, collection: 'collection', slot: 100 + pass };
        },
        'collection', new Date(Date.now() + pass), 2,
      );
      expect(result).toHaveLength(2);
    }
    expect(created.every((base) => visited.has(base.id))).toBe(true);
  });

  it('observes every active deed without a first-page ceiling while bounding RPC fan-out', async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    await db.insert(players).values({ wallet });
    const created = await db.insert(bases).values(Array.from(
      { length: BASE_OWNERSHIP.observationConcurrency + 3 },
      () => ({
        ownerWallet: wallet,
        deedAssetId: Keypair.generate().publicKey.toBase58(),
        status: 'active' as const,
      }),
    )).returning({ id: bases.id, deedAssetId: bases.deedAssetId });
    const all = await db.select({ deed: bases.deedAssetId, owner: bases.ownerWallet }).from(bases)
      .where(eq(bases.status, 'active'));
    const owners = new Map(all.flatMap((row) => row.deed ? [[row.deed, row.owner] as const] : []));
    const visited = new Set<string>();
    let active = 0;
    let peak = 0;
    const reader = async (assetId: string) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      if (created.some((base) => base.deedAssetId === assetId)) visited.add(assetId);
      return {
        owner: owners.get(assetId)!, frozen: false, delegate: null,
        collection: 'collection', slot: 1_000_000,
      };
    };
    const result = await sweepActiveBaseOwnership(
      db, reader, 'collection', new Date(), owners.size,
    );
    expect(result.length).toBe(owners.size);
    expect(visited.size).toBe(created.length);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(BASE_OWNERSHIP.observationConcurrency);
  }, BASE_OWNERSHIP.observationHealthFreshnessMs);

  it('uses one readMany call per observer wave and still applies every result', async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    await db.insert(players).values({ wallet });
    const created = await db.insert(bases).values(Array.from({ length: 3 }, () => ({
      ownerWallet: wallet,
      deedAssetId: Keypair.generate().publicKey.toBase58(),
      status: 'active' as const,
    }))).returning({ deedAssetId: bases.deedAssetId });
    const requested: string[][] = [];
    const reader = (async () => {
      throw new Error('observer must not fall back to one RPC per asset');
    }) as import('../src/game/baseOwnership').FinalizedDeedReader;
    reader.readMany = async (assets) => {
      requested.push(assets.map(({ assetId }) => assetId));
      return new Map(assets.map(({ assetId }) => [assetId, {
        owner: wallet, frozen: false, delegate: null,
        collection: 'collection', slot: 2_000_000,
      }]));
    };

    const result = await sweepActiveBaseOwnership(db, reader, 'collection', new Date(), 3);
    expect(requested).toHaveLength(1);
    expect(new Set(requested[0])).toEqual(new Set(created.map((row) => row.deedAssetId!)));
    expect(result).toHaveLength(3);
    expect(result.every(({ status }) => status === 'owned')).toBe(true);
  });

  it('scopes every target mutation to the selected base and writes new rows to that base', async () => {
    const prior = process.env['MULTI_BASE_ENABLED'];
    process.env['MULTI_BASE_ENABLED'] = 'true';
    try {
      const p = await starter();
      await registerOwnedDeed(db, p.wallet, `deed-${randomWallet()}`);
      const second = await registerOwnedDeed(db, p.wallet, `deed-${randomWallet()}`);
      const [foreignBuilding] = await db.insert(buildings).values({
        playerWallet: p.wallet, baseId: second.id, type: 'wall', tx: 9, ty: 9,
      }).returning();
      const [foreignObstacle] = await db.insert(obstacles).values({
        playerWallet: p.wallet, baseId: second.id,
        spriteKey: OBSTACLES.tiers.small.kinds[0], tx: 10, ty: 10,
      }).returning();
      const [foreignJob] = await db.insert(builderJobs).values({
        playerWallet: p.wallet, baseId: second.id, kind: 'upgrade', buildingId: foreignBuilding!.id,
        finishesAt: new Date(Date.now() + 60_000),
      }).returning();

      await expect(moveBuilding(db, p.wallet, foreignBuilding!.id, 11, 11, p.baseId))
        .rejects.toMatchObject({ statusCode: 404 });
      await expect(moveWallsBatch(db, p.wallet, [{ id: foreignBuilding!.id, tx: 11, ty: 11 }], p.baseId))
        .rejects.toBeInstanceOf(HttpError);
      await expect(upgradeBuilding(db, p.wallet, foreignBuilding!.id, 'cross-upgrade-0001', new Date(), {}, p.baseId))
        .rejects.toMatchObject({ statusCode: 404 });
      await expect(clearObstacle(db, p.wallet, foreignObstacle!.id, 'cross-obstacle-01', new Date(), p.baseId))
        .rejects.toMatchObject({ statusCode: 404 });
      await expect(speedupJob(db, p.wallet, foreignJob!.id, 'cross-speedup-001', new Date(), p.baseId))
        .rejects.toMatchObject({ statusCode: 404 });

      await rewardBaseShards(
        db, second.id, 10_000n, 'test.multibase', `test-multibase:${second.id}`,
      );
      const placed = await placeBuilding(
        db, p.wallet, BuildingType.Wall, 12, 12, 'place-on-second-0001', new Date(), second.id,
      );
      expect(placed.baseId).toBe(second.id);
      expect((await db.select().from(buildings).where(eq(buildings.id, foreignBuilding!.id)))[0])
        .toMatchObject({ tx: 9, ty: 9, baseId: second.id });
    } finally {
      if (prior === undefined) delete process.env['MULTI_BASE_ENABLED'];
      else process.env['MULTI_BASE_ENABLED'] = prior;
    }
  });

  it('rechecks stable deed authority inside the locked move transaction before writing', async () => {
    const p = await starter();
    const [wall] = await db.insert(buildings).values({
      playerWallet: p.wallet, baseId: p.baseId, type: 'wall', tx: 9, ty: 9,
    }).returning();
    let entered!: () => void;
    let release!: () => void;
    const authorityEntered = new Promise<void>((resolve) => { entered = resolve; });
    const authorityRelease = new Promise<void>((resolve) => { release = resolve; });
    const authority: StableBaseMutationContext = {
      baseId: p.baseId,
      assertAuthority: async (_tx, wallet, baseId) => {
        expect(wallet).toBe(p.wallet);
        expect(baseId).toBe(p.baseId);
        entered();
        await authorityRelease;
        throw new HttpError(503, 'stale deed proof', 'DEED_AUTHORITY_UNAVAILABLE');
      },
    };

    const moving = moveBuilding(db, p.wallet, wall!.id, 10, 9, p.baseId, authority);
    await authorityEntered;
    expect((await db.select().from(buildings).where(eq(buildings.id, wall!.id)))[0])
      .toMatchObject({ tx: 9, ty: 9 });
    release();
    await expect(moving).rejects.toMatchObject({ code: 'DEED_AUTHORITY_UNAVAILABLE' });
    expect((await db.select().from(buildings).where(eq(buildings.id, wall!.id)))[0])
      .toMatchObject({ tx: 9, ty: 9 });
  });

  it('rejects aged forge deed evidence before completing jobs or posting any contribution state', async () => {
    const owner = await starter();
    const deed = Keypair.generate().publicKey.toBase58();
    await registerOwnedDeed(db, owner.wallet, deed);
    await db.update(bases).set({ landPaidAt: new Date() }).where(eq(bases.id, owner.baseId));
    const [forge] = await db.insert(buildings).values({
      playerWallet: owner.wallet, baseId: owner.baseId, type: 'goldforge', level: 1, tx: 20, ty: 20,
    }).returning();
    const now = new Date();
    const [job] = await db.insert(builderJobs).values({
      playerWallet: owner.wallet, baseId: owner.baseId, kind: 'upgrade', buildingId: forge!.id,
      finishesAt: new Date(now.getTime() - 1_000),
    }).returning();
    await db.insert(deedOwnershipObservations).values({
      baseId: owner.baseId, assetId: deed, owner: owner.wallet, slot: 1_200n,
      checkedAt: new Date(now.getTime() - BASE_OWNERSHIP.mutationFreshnessMs - 1),
      source: 'test-forge-aged', status: 'owned', auditHash: `forge-aged-${randomWallet()}`,
    });
    await rewardShards(db, owner.wallet, 10_000n, 'test.forge-aged', randomWallet());
    const before = (await getOrCreatePlayerAccount(db, owner.wallet, 'player_shards')).balance;
    const idem = `forge-aged-${randomWallet()}`;
    const authority: ForgeStableBaseContext = {
      baseId: owner.baseId,
      assertActiveAuthority: async (tx, wallet) => assertFreshLockedActiveBaseAuthorities(tx, wallet, now),
    };

    await expect(contributeToForge(
      db, owner.wallet, 100n, idem, now, owner.baseId, authority,
    )).rejects.toMatchObject({ code: 'DEED_AUTHORITY_UNAVAILABLE' });

    expect((await getOrCreatePlayerAccount(db, owner.wallet, 'player_shards')).balance).toBe(before);
    expect(await db.select().from(forgeContributions).where(and(
      eq(forgeContributions.day, forgeDayOf(now)), eq(forgeContributions.playerWallet, owner.wallet),
    ))).toHaveLength(0);
    expect(await db.select().from(baseForgePositions).where(and(
      eq(baseForgePositions.day, forgeDayOf(now)), eq(baseForgePositions.baseId, owner.baseId),
    ))).toHaveLength(0);
    expect(await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `contrib:${owner.wallet}:${idem}`))).toHaveLength(0);
    expect((await db.select().from(builderJobs).where(eq(builderJobs.id, job!.id)))[0]!.completedAt)
      .toBeNull();
    expect((await db.select().from(buildings).where(eq(buildings.id, forge!.id)))[0]!.level).toBe(1);
  });

  it('does not reserve the buyer forge day or post shards when a deed transfer wins the player lock', async () => {
    const seller = await starter();
    const buyer = await createTestPlayer(db);
    const deed = Keypair.generate().publicKey.toBase58();
    await registerOwnedDeed(db, seller.wallet, deed);
    await db.update(bases).set({ landPaidAt: new Date() }).where(eq(bases.id, seller.baseId));
    const [forge] = await db.insert(buildings).values({
      playerWallet: seller.wallet, baseId: seller.baseId, type: 'goldforge', level: 1, tx: 20, ty: 20,
    }).returning();
    const now = new Date();
    const [job] = await db.insert(builderJobs).values({
      playerWallet: seller.wallet, baseId: seller.baseId, kind: 'upgrade', buildingId: forge!.id,
      finishesAt: new Date(now.getTime() - 1_000),
    }).returning();
    const [evidence] = await db.insert(deedOwnershipObservations).values({
      baseId: seller.baseId, assetId: deed, owner: seller.wallet, slot: 1_201n,
      checkedAt: now, source: 'test-forge-transfer', status: 'owned',
      auditHash: `forge-transfer-${randomWallet()}`,
    }).returning();
    await rewardShards(db, seller.wallet, 10_000n, 'test.forge-transfer', randomWallet());
    const before = (await getOrCreatePlayerAccount(db, seller.wallet, 'player_shards')).balance;
    const idem = `forge-transfer-${randomWallet()}`;
    const authority: ForgeStableBaseContext = {
      baseId: seller.baseId,
      assertActiveAuthority: async (tx, wallet) => assertFreshLockedActiveBaseAuthorities(tx, wallet, now),
    };
    const loss = await holdWalletAuthorityChange(seller.wallet, async (tx) => {
      await tx.delete(baseSlots).where(eq(baseSlots.baseId, seller.baseId));
      await tx.update(bases).set({ ownerWallet: buyer.wallet, status: 'inactive' })
        .where(eq(bases.id, seller.baseId));
      await tx.update(deedOwnershipObservations).set({
        owner: buyer.wallet, status: 'mismatch', checkedAt: now,
      }).where(eq(deedOwnershipObservations.id, evidence!.id));
    });

    const contributing = contributeToForge(
      db, seller.wallet, 100n, idem, now, seller.baseId, authority,
    );
    const rejected = expect(contributing).rejects.toMatchObject({ code: 'DEED_OWNERSHIP_CHANGED' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    loss.release();
    await loss.done;
    await rejected;

    expect((await getOrCreatePlayerAccount(db, seller.wallet, 'player_shards')).balance).toBe(before);
    expect(await db.select().from(baseForgePositions).where(and(
      eq(baseForgePositions.day, forgeDayOf(now)), eq(baseForgePositions.baseId, seller.baseId),
    ))).toHaveLength(0);
    expect(await db.select().from(forgeContributions).where(and(
      eq(forgeContributions.day, forgeDayOf(now)), eq(forgeContributions.playerWallet, seller.wallet),
    ))).toHaveLength(0);
    expect(await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `contrib:${seller.wallet}:${idem}`))).toHaveLength(0);
    expect((await db.select().from(builderJobs).where(eq(builderJobs.id, job!.id)))[0]!.completedAt)
      .toBeNull();
    expect((await db.select().from(buildings).where(eq(buildings.id, forge!.id)))[0]!.level).toBe(1);
  });

  it('cannot use a stale sold high Forge to raise contributions across two low bases', async () => {
    const seller = await starter();
    const buyer = await createTestPlayer(db);
    const highDeed = Keypair.generate().publicKey.toBase58();
    const lowDeeds = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
    const high = await registerOwnedDeed(db, seller.wallet, highDeed);
    const low = [
      await registerOwnedDeed(db, seller.wallet, lowDeeds[0]!),
      await registerOwnedDeed(db, seller.wallet, lowDeeds[1]!),
    ];
    await db.update(bases).set({ landPaidAt: new Date() }).where(eq(bases.ownerWallet, seller.wallet));
    await db.insert(buildings).values([
      { playerWallet: seller.wallet, baseId: high.id, type: 'goldforge', level: 20, tx: 20, ty: 20 },
      ...low.map((base, index) => ({
        playerWallet: seller.wallet, baseId: base.id, type: 'goldforge' as const,
        level: 1, tx: 20 + index, ty: 22,
      })),
    ]);
    const now = new Date();
    const [highEvidence] = await db.insert(deedOwnershipObservations).values([
      {
        baseId: high.id, assetId: highDeed, owner: seller.wallet, slot: 1_300n,
        checkedAt: new Date(now.getTime() - BASE_OWNERSHIP.mutationFreshnessMs - 1),
        source: 'test-forge-sold-high', status: 'owned' as const,
        auditHash: `forge-high-${randomWallet()}`,
      },
      ...low.map((base, index) => ({
        baseId: base.id, assetId: lowDeeds[index]!, owner: seller.wallet,
        slot: BigInt(1_301 + index), checkedAt: now, source: 'test-forge-low',
        status: 'owned' as const, auditHash: `forge-low-${randomWallet()}`,
      })),
    ]).returning();
    const lowCap = BigInt(FORGE.contributionCapByLevel[1]!);
    await rewardBaseShards(db, low[0]!.id, lowCap, 'test.forge-base-cap', randomWallet());
    await rewardBaseShards(db, low[1]!.id, lowCap, 'test.forge-base-cap', randomWallet());
    const authorityFor = (baseId: string): ForgeStableBaseContext => ({
      baseId,
      assertActiveAuthority: async (tx, wallet) => assertFreshLockedActiveBaseAuthorities(tx, wallet, now),
    });

    const staleKey = `forge-stale-high-${randomWallet()}`;
    await expect(contributeToForge(
      db, seller.wallet, 1n, staleKey, now, low[0]!.id, authorityFor(low[0]!.id),
    )).rejects.toMatchObject({ code: 'DEED_AUTHORITY_UNAVAILABLE' });
    expect(await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `contrib:${seller.wallet}:${staleKey}`)))
      .toHaveLength(0);

    // Apply the observed sale. The L20 building deliberately remains attached
    // to its stable base; only the frozen authorized active set may feed the cap.
    await db.transaction(async (tx) => {
      await tx.select().from(players).where(eq(players.wallet, seller.wallet)).for('update');
      await tx.select().from(bases).where(eq(bases.id, high.id)).for('update');
      await tx.delete(baseSlots).where(eq(baseSlots.baseId, high.id));
      await tx.update(bases).set({ ownerWallet: buyer.wallet, status: 'inactive' }).where(eq(bases.id, high.id));
      await tx.update(deedOwnershipObservations).set({ owner: buyer.wallet, status: 'mismatch', checkedAt: now })
        .where(eq(deedOwnershipObservations.id, highEvidence!.id));
    });

    const firstBefore = (await getOrCreateBaseAccount(db, low[0]!.id, 'base_shards')).balance;
    const secondBefore = (await getOrCreateBaseAccount(db, low[1]!.id, 'base_shards')).balance;
    const firstKey = `forge-low-first-${randomWallet()}`;
    await contributeToForge(
      db, seller.wallet, lowCap, firstKey, now, low[0]!.id, authorityFor(low[0]!.id),
    );
    const secondKey = `forge-low-second-${randomWallet()}`;
    await contributeToForge(
      db, seller.wallet, lowCap, secondKey, now, low[1]!.id, authorityFor(low[1]!.id),
    );

    expect((await getOrCreateBaseAccount(db, low[0]!.id, 'base_shards')).balance)
      .toBe(firstBefore - lowCap);
    expect((await getOrCreateBaseAccount(db, low[1]!.id, 'base_shards')).balance)
      .toBe(secondBefore - lowCap);
    const usage = await db.select().from(baseForgePositions).where(eq(baseForgePositions.day, forgeDayOf(now)));
    expect(usage.filter((row) => row.baseId === low[0]!.id)).toMatchObject([
      { contributedShards: lowCap },
    ]);
    expect(usage.filter((row) => row.baseId === low[1]!.id)).toMatchObject([
      { contributedShards: lowCap },
    ]);
    expect(await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `contrib:base:${low[1]!.id}:${secondKey}`)))
      .toHaveLength(1);
  });

  it('route authority fails closed when stale/unavailable and exits on a finalized mismatch', async () => {
    const priorMulti = process.env['MULTI_BASE_ENABLED'];
    const priorFree = process.env['FREE_ONBOARDING'];
    process.env['MULTI_BASE_ENABLED'] = 'true';
    process.env['FREE_ONBOARDING'] = 'true';
    // This file intentionally accumulates independent stable-base fixtures in
    // one shared database. Prime the boot-readiness boundary so this route test
    // depends only on its own target, not an earlier test's unobserved deed.
    const quarantined = await db.select({ id: bases.id }).from(baseSlots)
      .innerJoin(bases, eq(bases.id, baseSlots.baseId))
      .where(and(eq(baseSlots.active, true), isNull(bases.deedAssetId), isNotNull(bases.deedMintAssetId)));
    for (const base of quarantined) {
      await db.delete(baseSlots).where(eq(baseSlots.baseId, base.id));
      await db.update(bases).set({ status: 'inactive' }).where(eq(bases.id, base.id));
    }
    const deeded = await db.select({
      id: bases.id, owner: bases.ownerWallet, asset: bases.deedAssetId,
    }).from(baseSlots).innerJoin(bases, eq(bases.id, baseSlots.baseId)).where(and(
      eq(baseSlots.active, true), eq(bases.status, 'active'), isNotNull(bases.deedAssetId),
    ));
    const readinessAt = new Date();
    for (const base of deeded) {
      const [prior] = await db.select({ id: deedOwnershipObservations.id })
        .from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, base.id));
      const evidence = {
        assetId: base.asset!, owner: base.owner, slot: 1_000_001n,
        checkedAt: readinessAt, source: 'test-readiness', status: 'owned' as const,
        auditHash: createHash('sha256').update(`test-readiness:${base.id}`).digest('hex'),
      };
      if (prior) await db.update(deedOwnershipObservations).set(evidence)
        .where(eq(deedOwnershipObservations.id, prior.id));
      else await db.insert(deedOwnershipObservations).values({ baseId: base.id, ...evidence });
    }
    let observed: {
      owner: string; frozen: boolean; delegate: null; collection: string; slot: number;
    } | null = null;
    const collection = 'test-collection';
    const app = await buildApp(TEST_CONFIG, db, {
      market: { deedCollection: collection, finalizedDeedReader: async () => observed },
    });
    await app.ready();
    try {
      const secret = utils.randomSecretKey();
      const wallet = bs58.encode(await getPublicKeyAsync(secret));
      const challenge = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet } });
      const message = (challenge.json() as { message: string }).message;
      const signature = bs58.encode(await signAsync(new TextEncoder().encode(message), secret));
      const verified = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet, signature } });
      expect(verified.json()).toMatchObject({ wallet, entryPaid: false });
      const cookie = verified.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
      const deed = Keypair.generate().publicKey.toBase58();
      const [base] = await db.insert(bases).values({
        ownerWallet: wallet, deedAssetId: deed, landPaidAt: new Date(),
      }).returning();
      await db.insert(baseSlots).values({ wallet, slot: 1, baseId: base!.id });

      const directory = await app.inject({
        method: 'GET', url: '/bases', cookies: { [SESSION_COOKIE]: cookie },
      });
      expect(directory.statusCode).toBe(200);
      expect(directory.json()).toMatchObject({
        enabled: true,
        nextLandPurchaseKind: 'deed',
        capabilities: {
          baseScopedReads: true,
          baseScopedMutations: true,
          cellReservations: true,
        },
      });
      const abandon = await app.inject({
        method: 'POST', url: '/base/abandon',
        cookies: { [SESSION_COOKIE]: cookie }, payload: { confirm: 'ABANDON' },
      });
      expect(abandon.statusCode).toBe(409);
      expect(abandon.json()).toMatchObject({ error: { code: 'BASE_ABANDON_UNAVAILABLE' } });

      // players.entryPaidAt remains null: both auth responses must follow the
      // active paid stable base, not that compatibility shadow.
      const meWithLand = await app.inject({
        method: 'GET', url: '/me', cookies: { [SESSION_COOKIE]: cookie },
      });
      expect(meWithLand.json()).toMatchObject({ wallet, entryPaid: true });
      const reloginChallenge = await app.inject({
        method: 'GET', url: '/auth/challenge', query: { wallet },
      });
      const reloginSignature = bs58.encode(await signAsync(
        new TextEncoder().encode((reloginChallenge.json() as { message: string }).message), secret,
      ));
      const relogin = await app.inject({
        method: 'POST', url: '/auth/verify', payload: { wallet, signature: reloginSignature },
      });
      expect(relogin.json()).toMatchObject({ wallet, entryPaid: true });

      const [building] = await db.insert(buildings).values({
        playerWallet: wallet, baseId: base!.id, type: 'wall', tx: 9, ty: 9,
      }).returning();
      const move = (tx: number) => app.inject({
        method: 'PATCH', url: `/base/buildings/${building!.id}/move`,
        cookies: { [SESSION_COOKIE]: cookie }, payload: { baseId: base!.id, tx, ty: 9 },
      });

      const unavailable = await move(10);
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toMatchObject({ error: { code: 'DEED_AUTHORITY_UNAVAILABLE' } });
      expect((await db.select().from(buildings).where(eq(buildings.id, building!.id)))[0]?.tx).toBe(9);

      observed = { owner: wallet, frozen: false, delegate: null, collection, slot: 100 };
      expect((await move(10)).statusCode).toBe(200);
      await db.update(deedOwnershipObservations)
        .set({ checkedAt: new Date(Date.now() - 11_000) })
        .where(eq(deedOwnershipObservations.baseId, base!.id));
      const buyer = Keypair.generate().publicKey.toBase58();
      observed = { owner: buyer, frozen: false, delegate: null, collection, slot: 101 };
      const mismatch = await move(11);
      expect(mismatch.statusCode).toBe(503);
      expect((await db.select().from(buildings).where(eq(buildings.id, building!.id)))[0]?.tx).toBe(10);
      expect((await db.select().from(bases).where(eq(bases.id, base!.id)))[0])
        .toMatchObject({ ownerWallet: buyer, status: 'inactive' });

      // A stale positive compatibility scalar cannot keep land presentation
      // alive after the active stable slot has transferred away.
      await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, wallet));
      const meAfterSale = await app.inject({
        method: 'GET', url: '/me', cookies: { [SESSION_COOKIE]: cookie },
      });
      expect(meAfterSale.json()).toMatchObject({ wallet, entryPaid: false });
    } finally {
      await app.close();
      if (priorMulti === undefined) delete process.env['MULTI_BASE_ENABLED'];
      else process.env['MULTI_BASE_ENABLED'] = priorMulti;
      if (priorFree === undefined) delete process.env['FREE_ONBOARDING'];
      else process.env['FREE_ONBOARDING'] = priorFree;
    }
  });
});

describe('Earth-cell reservation identity', () => {
  it('resolves /map/me identity by the transferred base, never the stale plot wallet', async () => {
    const seller = await starter();
    const buyer = await createTestPlayer(db);
    const soldDeed = Keypair.generate().publicKey.toBase58();
    await registerOwnedDeed(db, seller.wallet, soldDeed);
    // Seller keeps another base so a wallet-keyed lookup would have an
    // especially dangerous plausible answer after the sale.
    await registerOwnedDeed(db, seller.wallet, Keypair.generate().publicKey.toBase58());
    const valley = await createTestValley(db, { name: `stable-map-${seller.wallet}` });
    await seedPlots(db, [{
      valleyId: valley.id, x: 7, y: 7,
      playerWallet: seller.wallet, baseId: seller.baseId,
    }]);
    const [plot] = await db.select().from(plots).where(and(
      eq(plots.valleyId, valley.id), eq(plots.x, 7), eq(plots.y, 7),
    ));
    await db.update(plots).set({ baseId: seller.baseId }).where(eq(plots.id, plot!.id));
    await transferStableBase(db, seller.baseId, seller.wallet, buyer.wallet, soldDeed);

    await expect(ensureBasePlotAssigned(db, buyer.wallet, seller.baseId)).resolves.toEqual({
      valleyId: valley.id, x: 7, y: 7,
    });
    await expect(ensureBasePlotAssigned(db, seller.wallet, seller.baseId))
      .rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    expect(await db.select().from(plots).where(eq(plots.baseId, seller.baseId))).toHaveLength(1);
  });

  it('keeps legacy base-less plot assignment unique under concurrent writes', async () => {
    const p = await createTestPlayer(db);
    const valley = await createTestValley(db, { name: `legacy-plot-${p.wallet}` });
    try {
      await seedPlots(db, [
        { valleyId: valley.id, x: 0, y: 0 },
        { valleyId: valley.id, x: 1, y: 0 },
      ]);
      const candidates = await db.select({ id: plots.id }).from(plots)
        .where(eq(plots.valleyId, valley.id));
      expect(candidates).toHaveLength(2);

      const attempts = await Promise.allSettled(candidates.map((candidate) => db.update(plots)
        .set({ playerWallet: p.wallet })
        .where(eq(plots.id, candidate.id))
        .returning({ id: plots.id })));
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
      expect(await db.select().from(plots).where(eq(plots.playerWallet, p.wallet)))
        .toEqual([expect.objectContaining({ baseId: null })]);
    } finally {
      await db.delete(plots).where(eq(plots.valleyId, valley.id));
      await db.delete(valleys).where(eq(valleys.id, valley.id));
    }
  });

  it('freezes chosen and random cells by deposit id and rejects identity changes', async () => {
    const p = await starter();
    const occupied = new Set((await db.select({ earthCell: plotReservations.earthCell }).from(plotReservations))
      .map((row) => row.earthCell));
    const cells: number[] = [];
    for (let candidate = 1_000_000; cells.length < 4; candidate++) {
      if (!occupied.has(candidate)) cells.push(candidate);
    }
    const [d] = await db.insert(deposits).values({ playerWallet: p.wallet, kind: 'entry', reference: randomWallet() }).returning();
    const parcel = (earthCell: number) => ({ earthCell, siteId: earthCell, x: 0, y: 0, countryA3: 'TST' });
    const first = await db.transaction((tx) => reserveEarthCell(tx, d!.id, p.baseId, parcel(cells[1]!)));
    const retry = await db.transaction((tx) => reserveEarthCell(tx, d!.id, p.baseId, parcel(cells[1]!)));
    expect(retry.id).toBe(first.id);
    await expect(db.transaction((tx) => reserveEarthCell(tx, d!.id, p.baseId, parcel(cells[0]!))))
      .rejects.toBeInstanceOf(HttpError);

    const [secondBase] = await db.insert(bases).values({
      ownerWallet: p.wallet, status: 'inactive',
    }).returning({ id: bases.id });
    const [d2] = await db.insert(deposits).values({ playerWallet: p.wallet, kind: 'entry', reference: randomWallet() }).returning();
    const random = await db.transaction((tx) => reserveEarthCell(
      tx, d2!.id, secondBase!.id, parcel(cells[2]!),
    ));
    expect(random.earthCell).toBe(cells[2]);
    expect(await db.select().from(plotReservations).where(eq(plotReservations.depositId, d2!.id))).toHaveLength(1);
  });
});
