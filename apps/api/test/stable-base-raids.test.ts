/**
 * Stable raid identity follows the deed/base, never stale child wallet columns.
 * The wallet is only the current authority. Playable economy, army, heroes,
 * progression and protection stay with the stable base across a deed sale.
 */
import {
  BASE_OWNERSHIP, BUFFS, BuildingType, COMBAT_TICK_MS, HEROES, RAID_ENERGY, RAID_RULES, pvpAttackShardCostForKeepLevel, pvpMinDefenderKeep, type BaseSnapshot,
} from '@shardkeep/shared';
import { SIM_VERSION, simulateRaid, type RaidOrders } from '@shardkeep/sim';
import { Keypair } from '@solana/web3.js';
import { randomUUID } from 'node:crypto';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SEAL_BOUND_SHARED_DB_CASE_MS } from './sealLatencyBudgets';
import {
  accounts, baseArmy, baseBattleRecords, baseHeroProgress, baseItems, baseProfiles, baseRaidLocks, bases, baseSlots, builderJobs, buildings,
  deedOwnershipObservations, heroLevels, heroRaidReservations, ledgerTransactions, players,
  pveCamps, raidLiveStates, raidLootReservations, raids, shields, raidReplayTimelines,
} from '../src/db/schema';
import { ensureStartingBase } from '../src/game/base';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { equipHeroItem } from '../src/game/items';
import {
  assertFreshLockedBaseAuthority, ensureWalletBaseIdentity, refreshBaseOwnership,
  transferStableBase,
} from '../src/game/baseOwnership';
import {
  assertNoIncompatibleStartedLiveRaids, compensatePendingRaid,
  createCampaignRaid, createPveRaid, createRaid, getRaidEnergy, recoverDueStartedLiveRaids,
  submitOrders, type RaidBaseAuthority,
} from '../src/game/raids';
import {
  acceptLiveRaidCommand, acceptLiveRaidCommandReceipt, closeLiveRaidStream,
  getRaidClock, retreatLiveRaid, setLiveRaidSpeed, startLiveRaid,
} from '../src/game/liveRaids';
import { decodeReplayTimeline } from '../src/game/raidReplayArchive';
import {
  getBaseBattleHistory, getBaseBattleReplay, getParticipantBattleReplay,
} from '../src/game/baseBattleHistory';
import { loadNativePresentation } from '../src/native/source';
import { makeCampSnapshot } from '../src/game/world';
import { bootstrapSystemAccounts, getOrCreateBaseAccount, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, createTestValley, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const priorMultiBase = process.env['MULTI_BASE_ENABLED'];
let seq = 0;
const key = () => `stable-raid-${++seq}-${randomUUID()}`;
const authority = async () => {};

function authorityBarrier() {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { reached, release, authorize: async () => { entered(); await wait; } };
}

async function stablePlayer(keepLevel = 1, expansions = 0) {
  process.env['MULTI_BASE_ENABLED'] = 'false';
  const player = await createTestPlayer(db);
  await ensureStartingBase(db, player.wallet);
  const paidAt = new Date('2026-08-12T00:00:00.000Z');
  await db.update(players).set({ keepLevel, expansions, entryPaidAt: paidAt })
    .where(eq(players.wallet, player.wallet));
  const baseId = await ensureWalletBaseIdentity(db, player.wallet);
  await db.update(bases).set({ keepLevel, expansions, landPaidAt: paidAt })
    .where(eq(bases.id, baseId!));
  process.env['MULTI_BASE_ENABLED'] = 'true';
  return { ...player, baseId: baseId! };
}

// Admission fixtures for protocol/identity tests: an empty novice campaign
// is now rejected, so these tests need one deployable unit.
async function readyForFirstCampaign(baseId: string) {
  await db.insert(baseArmy).values({ baseId, troop: 'plunderer', count: 1 });
}

beforeAll(async () => bootstrapSystemAccounts(db));
afterEach(() => { process.env['MULTI_BASE_ENABLED'] = 'true'; });
afterAll(async () => {
  if (priorMultiBase === undefined) delete process.env['MULTI_BASE_ENABLED'];
  else process.env['MULTI_BASE_ENABLED'] = priorMultiBase;
  await conn.sql.end();
});

describe.sequential('stable-base raid identity', () => {
  it.each(['bulk', 'worker', 'started-retreat'] as const)(
    'preserves the original campaign shield through %s settlement without losing acceptance', async (mode) => {
      const t0 = new Date();
      const attacker = await stablePlayer(5);
      await db.insert(baseArmy).values({ baseId: attacker.baseId, troop: 'highlander', count: 2 });
      const [originalShield] = await db.insert(shields).values({
        playerWallet: attacker.wallet, baseId: attacker.baseId, source: 'purchase',
        expiresAt: new Date(t0.getTime() + 3_600_000),
      }).returning();
      const raid = await createCampaignRaid(db, attacker.wallet, 1, key(), t0, {
        attackerBaseId: attacker.baseId, authorizeAttackerBase: authority,
        ...(mode === 'bulk' ? {} : { raidProtocolVersion: 2, allowRaidProtocolV2: true }),
      });
      const deploy = { troop: 'highlander' as const, tx: 6, ty: 10, tMs: 0 };
      if (mode === 'bulk') {
        await submitOrders(db, attacker.wallet, raid.id, { deploys: [deploy], idempotencyKey: key() });
      } else {
        await acceptLiveRaidCommand(db, attacker.wallet, raid.id, 'deploy', {
          kind: 'deploy', payload: { troop: deploy.troop, tx: deploy.tx, ty: deploy.ty },
        }, t0);
        await startLiveRaid(db, attacker.wallet, raid.id, 'start', 0, t0);
        if (mode === 'started-retreat') {
          await retreatLiveRaid(db, attacker.wallet, raid.id, 'retreat', new Date(t0.getTime() + 1_000));
        }
        // The real worker closes and settles the accepted journal, including
        // recovery after a started retreat lost its HTTP response.
        expect(await recoverDueStartedLiveRaids(db,
          new Date(t0.getTime() + RAID_RULES.battleDurationSec * 1_000 + 1), undefined, raid.id,
        )).toEqual({ resolved: 1, raced: 0 });
      }
      const [resolved] = await db.select().from(raids).where(eq(raids.id, raid.id));
      expect(resolved).toMatchObject({ status: 'resolved', orders: { deploys: [deploy] } });
      if (mode === 'bulk') expect(resolved!.bulkDeploymentAcceptedAt).toEqual(expect.any(Date));
      expect(await db.select().from(shields).where(eq(shields.baseId, attacker.baseId)))
        // The existing expiry is retained, not replaced with a fresh duration.
        .toEqual([originalShield]);
      expect(await db.select({ count: baseArmy.count }).from(baseArmy).where(and(
        eq(baseArmy.baseId, attacker.baseId), eq(baseArmy.troop, 'highlander'),
      ))).toEqual([{ count: 1 }]);
    },
  );

  it.each(['troop', 'hero', 'empty'] as const)(
    'retains truthful pre-start %s retreat history without inventing combat or another attack', async (staged) => {
      const t0 = new Date();
      const attacker = await stablePlayer(5);
      await db.insert(baseArmy).values({ baseId: attacker.baseId, troop: 'highlander', count: 2 });
      if (staged === 'hero') {
        await db.insert(baseHeroProgress).values({ baseId: attacker.baseId, hero: 'vex', level: 1 });
        await db.insert(buildings).values({
          playerWallet: attacker.wallet, baseId: attacker.baseId, type: HEROES.vex.altar,
          level: 1, tx: 18, ty: 18,
        });
      }
      const [originalShield] = await db.insert(shields).values({
        playerWallet: attacker.wallet, baseId: attacker.baseId, source: 'purchase',
        expiresAt: new Date(t0.getTime() + 3_600_000),
      }).returning();
      const raid = await createCampaignRaid(db, attacker.wallet, 1, key(), t0, {
        attackerBaseId: attacker.baseId, authorizeAttackerBase: authority,
        raidProtocolVersion: 2, allowRaidProtocolV2: true,
      });
      const energy = await getRaidEnergy(db, attacker.wallet, t0, attacker.baseId);
      if (staged !== 'empty') {
        await acceptLiveRaidCommand(db, attacker.wallet, raid.id, 'stage', staged === 'hero'
          ? { kind: 'hero', payload: { hero: 'vex', tx: 6, ty: 10 } }
          : { kind: 'deploy', payload: { troop: 'highlander', tx: 6, ty: 10 } }, t0);
      }
      const settledAt = new Date(t0.getTime() + 1_000);
      const receipt = await retreatLiveRaid(db, attacker.wallet, raid.id, 'retreat', settledAt);
      expect(receipt).toMatchObject({ terminal: true, result: {
        stars: 0, destructionPct: 0, lootShards: 0, retreated: true,
        attackerTrophyDelta: 0, defenderTrophyDelta: 0,
      } });
      expect(await retreatLiveRaid(db, attacker.wallet, raid.id, 'retreat', settledAt)).toEqual(receipt);
      expect(await getRaidEnergy(db, attacker.wallet, settledAt, attacker.baseId)).toEqual(energy);
      expect(await db.select().from(shields).where(eq(shields.baseId, attacker.baseId))).toEqual([originalShield]);
      expect(await db.select({ count: baseArmy.count }).from(baseArmy).where(and(
        eq(baseArmy.baseId, attacker.baseId), eq(baseArmy.troop, 'highlander'),
      ))).toEqual([{ count: staged === 'troop' ? 1 : 2 }]);
      const history = await getBaseBattleHistory(db, attacker.wallet, attacker.baseId);
      expect(history.battles).toHaveLength(staged === 'empty' ? 0 : 1);
      const timelines = await db.select().from(raidReplayTimelines).where(eq(raidReplayTimelines.raidId, raid.id));
      expect(timelines).toHaveLength(1);
      expect(timelines[0]).toMatchObject({ durationMs: 0, eventCount: 0 });
      expect(decodeReplayTimeline(timelines[0]!)).toMatchObject({
        simVersion: raid.simVersion, events: [], orders: { retreated: true }, result: receipt.result,
      });
      expect(decodeReplayTimeline(timelines[0]!)).not.toHaveProperty('buildingHealth');
      if (staged !== 'empty') {
        expect(history.battles[0]).toMatchObject({
          raidId: raid.id, role: 'attacker', mode: 'campaign', ownerWalletAtBattle: attacker.wallet,
          stars: 0, destructionPct: 0, settledAmount: '0', createdAt: settledAt,
        });
        const replay = await getBaseBattleReplay(db, attacker.wallet, attacker.baseId, raid.id);
        expect(replay).toMatchObject({ events: [], result: receipt.result, timeline: {
          eventCount: 0, durationMs: 0, integrityVerified: true,
        } });
        expect(await getParticipantBattleReplay(db, attacker.wallet, raid.id)).toEqual(replay);
      }
    },
  );

  it('excludes the previous target before matchmaking limits and binds retries without new charges', async () => {
    // Other suites share the DB. Restore their eligible slots after this case
    // so the exact no-alternative assertion is independent of fixture ordering.
    const otherSlots = await db.select({ id: baseSlots.baseId }).from(baseSlots)
      .innerJoin(bases, eq(bases.id, baseSlots.baseId))
      .where(and(eq(baseSlots.active, true), gte(bases.keepLevel, pvpMinDefenderKeep(20))));
    if (otherSlots.length) await db.update(baseSlots).set({ active: false })
      .where(inArray(baseSlots.baseId, otherSlots.map((slot) => slot.id)));
    const poolIds: string[] = [];
    try {
      const attacker = await stablePlayer(20);
      const previous = await stablePlayer(20);
      const next = await stablePlayer(20);
      poolIds.push(attacker.baseId, previous.baseId, next.baseId);
      // The excluded previous base would occupy the last SQL slot and hide
      // the sole unshielded alternative if exclusion happened after LIMIT.
      const shielded = Array.from({ length: RAID_RULES.autoMatchCandidatePool - 1 }, () => ({
        id: randomUUID(), wallet: Keypair.generate().publicKey.toBase58(),
      }));
      poolIds.push(...shielded.map((row) => row.id));
      await db.insert(players).values(shielded.map((row) => ({ wallet: row.wallet })));
      await db.insert(bases).values(shielded.map((row) => ({ id: row.id,
        ownerWallet: row.wallet, keepLevel: 20, landPaidAt: new Date() })));
      await db.insert(baseSlots).values(shielded.map((row) => ({ baseId: row.id,
        wallet: row.wallet, slot: 1 })));
      await db.insert(shields).values(shielded.map((row) => ({ baseId: row.id,
        playerWallet: row.wallet, source: 'purchase' as const, expiresAt: new Date(Date.now() + 3_600_000) })));
      await db.insert(baseProfiles).values([
        { baseId: previous.baseId, trophies: 1 }, { baseId: next.baseId, trophies: 1000 },
      ]).onConflictDoUpdate({ target: baseProfiles.baseId, set: { trophies: sql`excluded.trophies` } });
      await rewardBaseShards(db, attacker.baseId, 100_000n, 'test.next-target-budget', key());
      const opts = { attackerBaseId: attacker.baseId, excludeBaseId: previous.baseId,
        idempotencyKey: key(), authorizeAttackerBase: authority, authorizeDefenderBase: authority,
        raidProtocolVersion: 2 as const, allowRaidProtocolV2: true };
      const raid = await createRaid(db, attacker.wallet, opts);
      expect(raid.defenderBaseId).toBe(next.baseId);
      const before = await getRaidEnergy(db, attacker.wallet, new Date(), attacker.baseId);
      expect((await createRaid(db, attacker.wallet, opts)).id).toBe(raid.id);
      expect(await getRaidEnergy(db, attacker.wallet, new Date(), attacker.baseId)).toEqual(before);
      await expect(createRaid(db, attacker.wallet, { ...opts, excludeBaseId: next.baseId }))
        .rejects.toMatchObject({ code: 'RAID_IDEMPOTENCY_MISMATCH' });
      await expect(createRaid(db, attacker.wallet, { ...opts, excludeBaseId: undefined }))
        .rejects.toMatchObject({ code: 'RAID_IDEMPOTENCY_MISMATCH' });
      await expect(createRaid(db, attacker.wallet, { ...opts, defenderBaseId: next.baseId }))
        .rejects.toMatchObject({ statusCode: 400 });
      await retreatLiveRaid(db, attacker.wallet, raid.id, key());
      await db.update(baseSlots).set({ active: false }).where(eq(baseSlots.baseId, next.baseId));
      const account = await getOrCreateBaseAccount(db, attacker.baseId, 'base_shards');
      const balance = async () => (await db.select({ balance: accounts.balance }).from(accounts)
        .where(eq(accounts.id, account.id)))[0]!.balance;
      const balanceBefore = await balance();
      const energyBefore = await getRaidEnergy(db, attacker.wallet, new Date(), attacker.baseId);
      await expect(createRaid(db, attacker.wallet, { ...opts, idempotencyKey: key() }))
        .rejects.toMatchObject({ code: 'no_other_targets', message: 'No other target available' });
      expect(await balance()).toBe(balanceBefore);
      expect(await getRaidEnergy(db, attacker.wallet, new Date(), attacker.baseId)).toEqual(energyBefore);
      // This isolated pool must not become targets for later tests.
      await db.update(baseSlots).set({ active: false }).where(inArray(baseSlots.baseId,
        [attacker.baseId, previous.baseId]));
    } finally {
      if (poolIds.length) await db.update(baseSlots).set({ active: false }).where(inArray(baseSlots.baseId, poolIds));
      if (otherSlots.length) await db.update(baseSlots).set({ active: true })
        .where(inArray(baseSlots.baseId, otherSlots.map((slot) => slot.id)));
    }
  });

  it('keeps a healthy equipped Theodor available in a newly frozen combat roster', async () => {
    const now = new Date('2026-08-13T09:00:00.000Z');
    const attacker = await stablePlayer(5);
    await db.insert(buildings).values({
      playerWallet: attacker.wallet,
      baseId: attacker.baseId,
      type: BuildingType.SiegeStool,
      level: 1,
      tx: 11,
      ty: 11,
    });
    await db.insert(baseItems).values({
      baseId: attacker.baseId,
      itemId: 'banner_of_nine',
      qty: 1,
    });
    await equipHeroItem(
      db, attacker.wallet, 'theodor', 'banner', 'banner_of_nine', 0, now,
      { baseId: attacker.baseId, authorizeBaseMutation: async () => {} },
    );

    const raid = await createCampaignRaid(db, attacker.wallet, 1, key(), now, {
      attackerBaseId: attacker.baseId,
      authorizeAttackerBase: authority,
    });
    expect((raid.armySnapshot as { heroes?: string[] }).heroes).toContain('theodor');
  });

  it('freezes the post-settlement army after waiting for the attacker lock', async () => {
    // WHY: reading the army before the player/base transaction lets a parallel
    // settlement commit a decrement while raid creation waits, permanently
    // freezing troops the player no longer owns into the new raid.
    const now = new Date('2026-08-13T09:05:00.000Z');
    const attacker = await stablePlayer(5);
    await db.insert(baseArmy).values({
      baseId: attacker.baseId, troop: 'highlander', count: 2,
    }).onConflictDoUpdate({
      target: [baseArmy.baseId, baseArmy.troop], set: { count: 2 },
    });

    let releaseBlocker!: () => void;
    let blockerLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const locked = new Promise<void>((resolve) => { blockerLocked = resolve; });
    let blockerPid = 0;
    const settlement = db.transaction(async (tx) => {
      const pidRows = await tx.execute(sql<{ pid: number }>`SELECT pg_backend_pid()::int AS pid`);
      blockerPid = Number(pidRows[0]!.pid);
      await tx.select({ wallet: players.wallet }).from(players)
        .where(eq(players.wallet, attacker.wallet)).for('update');
      blockerLocked();
      await release;
      await tx.update(baseArmy).set({ count: 1 }).where(and(
        eq(baseArmy.baseId, attacker.baseId), eq(baseArmy.troop, 'highlander'),
      ));
    });
    await locked;

    const creating = createCampaignRaid(db, attacker.wallet, 1, key(), now, {
      attackerBaseId: attacker.baseId,
      authorizeAttackerBase: authority,
    });
    let observedWait = false;
    const waitDeadline = Date.now() + 5_000;
    while (!observedWait && Date.now() < waitDeadline) {
      const [row] = await conn.sql<{ blocked: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity a
          WHERE ${blockerPid} = ANY(pg_blocking_pids(a.pid))
        ) AS blocked
      `;
      observedWait = row?.blocked === true;
      if (!observedWait) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    releaseBlocker();
    await settlement;
    expect(observedWait).toBe(true);

    const raid = await creating;
    expect((raid.armySnapshot as { counts?: { highlander?: number } }).counts?.highlander)
      .toBe(1);
  });

  it('keeps a recovering defender out while the other ready hero still defends', async () => {
    const now = new Date('2026-08-13T09:00:00.000Z');
    const attacker = await stablePlayer(5);
    const defender = await stablePlayer(5);
    await rewardBaseShards(db, attacker.baseId, 100_000n, 'test.defender-hero-recovery', key());
    await db.insert(buildings).values([
      {
        playerWallet: defender.wallet, baseId: defender.baseId,
        type: BuildingType.HeroAltar, level: 1, tx: 10, ty: 10,
      },
      {
        playerWallet: defender.wallet, baseId: defender.baseId,
        type: BuildingType.SiegeStool, level: 1, tx: 12, ty: 10,
      },
    ]);
    await db.insert(baseHeroProgress).values({
      baseId: defender.baseId, hero: 'theodor',
      recoveryUntil: new Date(now.getTime() + 60_000),
    });

    const raid = await createRaid(db, attacker.wallet, {
      attackerBaseId: attacker.baseId,
      defenderBaseId: defender.baseId,
      defenderWallet: defender.wallet,
      idempotencyKey: key(),
      authorizeAttackerBase: authority,
      authorizeDefenderBase: authority,
    }, now);
    const defenders = (raid.snapshot as {
      defenderHeroes?: Array<{ hero: string }>;
    }).defenderHeroes ?? [];
    expect(defenders.map((hero) => hero.hero)).toContain('vex');
    expect(defenders.map((hero) => hero.hero)).not.toContain('theodor');
  });

  it.each(['named', 'random'] as const)('rechecks %s target Keep reach after an elapsed attacker upgrade, before spending', async (selection) => {
    // WHY: a K2 can choose K1, but its due K3 upgrade raises the legal minimum
    // to K2 inside the creation transaction. Both target paths must validate
    // that final authoritative level, not the stale pre-lock candidate read.
    const now = new Date();
    const attacker = await stablePlayer(2);
    const defender = await stablePlayer(1);
    // Keep this pair inside the rating-ordered candidate page even when prior
    // suites left more than one page of shielded bases in the shared test DB.
    await db.insert(baseProfiles).values([
      { baseId: attacker.baseId, trophies: 1_234_567 },
      { baseId: defender.baseId, trophies: 1_234_567 },
    ]).onConflictDoUpdate({ target: baseProfiles.baseId, set: { trophies: 1_234_567 } });
    await rewardBaseShards(db, attacker.baseId, 100_000n, 'test.keep-recheck', key());
    const [keep] = await db.update(buildings).set({ level: 2 }).where(and(
      eq(buildings.baseId, attacker.baseId), eq(buildings.type, BuildingType.Keep),
    )).returning();
    await db.insert(builderJobs).values({
      playerWallet: attacker.wallet, baseId: attacker.baseId,
      kind: 'upgrade', buildingId: keep!.id,
      startedAt: new Date(now.getTime() - 120_000),
      finishesAt: new Date(now.getTime() - 60_000),
    });
    // Park other stable candidates for this test only, using normal shields;
    // random selection must exercise this same target, not a higher Keep.
    const otherBases = await db.select().from(bases);
    const parked = await db.insert(shields).values(otherBases
      .filter((base) => base.id !== defender.baseId)
      .map((base) => ({ playerWallet: base.ownerWallet, baseId: base.id,
        source: 'loss' as const, expiresAt: new Date('2999-01-01T00:00:00Z') })))
      .returning({ id: shields.id });
    const before = await getOrCreateBaseAccount(db, attacker.baseId, 'base_shards');
    const beforeEnergy = await getRaidEnergy(db, attacker.wallet, now, attacker.baseId);
    try {
      await expect(createRaid(db, attacker.wallet, {
        attackerBaseId: attacker.baseId,
        ...(selection === 'named' ? { defenderBaseId: defender.baseId, defenderWallet: defender.wallet } : {}),
        idempotencyKey: key(), authorizeAttackerBase: authority, authorizeDefenderBase: authority,
      }, now)).rejects.toMatchObject({ code: 'keep_too_far_below' });
      expect((await getOrCreateBaseAccount(db, attacker.baseId, 'base_shards')).balance).toBe(before.balance);
      expect(await getRaidEnergy(db, attacker.wallet, now, attacker.baseId)).toEqual(beforeEnergy);
      expect(await db.select().from(raids).where(eq(raids.attackerBaseId, attacker.baseId))).toHaveLength(0);
    } finally {
      await db.delete(shields).where(inArray(shields.id, parked.map((row) => row.id)));
    }
  });

  it('materializes elapsed defender build and upgrade jobs before freezing the raid snapshot', async () => {
    const now = new Date('2026-08-12T13:00:00.000Z');
    const attacker = await stablePlayer(5);
    const defender = await stablePlayer(5);
    await rewardBaseShards(db, attacker.baseId, 100_000n, 'test.snapshot-due-jobs', key());
    const [newDefense, upgradingDefense] = await db.insert(buildings).values([
      {
        playerWallet: defender.wallet, baseId: defender.baseId,
        type: BuildingType.Cannon, level: 1, tx: 18, ty: 18,
      },
      {
        playerWallet: defender.wallet, baseId: defender.baseId,
        type: BuildingType.ArcherTower, level: 1, tx: 20, ty: 18,
      },
    ]).returning();
    await db.insert(builderJobs).values([
      {
        playerWallet: defender.wallet, baseId: defender.baseId,
        kind: 'build', buildingId: newDefense!.id,
        startedAt: new Date(now.getTime() - 120_000),
        finishesAt: new Date(now.getTime() - 60_000),
      },
      {
        playerWallet: defender.wallet, baseId: defender.baseId,
        kind: 'upgrade', buildingId: upgradingDefense!.id,
        startedAt: new Date(now.getTime() - 120_000),
        finishesAt: new Date(now.getTime() - 60_000),
      },
    ]);

    const raid = await createRaid(db, attacker.wallet, {
      attackerBaseId: attacker.baseId,
      defenderBaseId: defender.baseId,
      defenderWallet: defender.wallet,
      idempotencyKey: key(),
      authorizeAttackerBase: authority,
      authorizeDefenderBase: authority,
    }, now);
    const frozen = (raid.snapshot as { buildings: Array<{ id: string; level: number }> }).buildings;
    expect(frozen).toContainEqual(expect.objectContaining({ id: newDefense!.id, level: 1 }));
    expect(frozen).toContainEqual(expect.objectContaining({ id: upgradingDefense!.id, level: 2 }));
    expect(await db.select().from(builderJobs).where(and(
      eq(builderJobs.baseId, defender.baseId),
      inArray(builderJobs.buildingId, [newDefense!.id, upgradingDefense!.id]),
    ))).toEqual(expect.arrayContaining([
      expect.objectContaining({ completedAt: now }),
      expect.objectContaining({ completedAt: now }),
    ]));
  });

  it('never compensates a started raid across a simulator rollout and lets the compatible worker settle it once', async () => {
    const t0 = new Date('2026-08-12T14:00:00.000Z');
    const attacker = await stablePlayer(5);
    const defender = await stablePlayer(5);
    await fundTestKeep(db, attacker.wallet, 1_000n, 'test.live-rollout-keep', key());
    await rewardBaseShards(db, attacker.baseId, 100_000n, 'test.live-rollout-ante', key());
    await rewardBaseShards(db, defender.baseId, 100_000n, 'test.live-rollout-loot', key());
    await db.insert(baseArmy).values({
      baseId: attacker.baseId, troop: 'highlander', count: 1,
    }).onConflictDoUpdate({
      target: [baseArmy.baseId, baseArmy.troop], set: { count: 1 },
    });
    await db.insert(buildings).values({
      playerWallet: attacker.wallet,
      baseId: attacker.baseId,
      type: BuildingType.HeroAltar,
      level: 1,
      tx: 10,
      ty: 10,
    });
    await db.insert(baseProfiles).values({
      baseId: attacker.baseId, purchasedEnergy: 1,
    }).onConflictDoUpdate({
      target: baseProfiles.baseId, set: { purchasedEnergy: 1 },
    });
    // Exhaust this deed's free daily allowance so the new march consumes the
    // one purchased energy. Each terminal fixture names a distinct historical
    // target: the once-per-attacker/defender/day rule remains truthful for the
    // live target under test, while all six still count toward energy usage.
    const historicalTargets = await Promise.all(Array.from(
      { length: 6 }, () => stablePlayer(5),
    ));
    await db.insert(raids).values(historicalTargets.map((target, index) => ({
      idempotencyKey: `live-rollout-used-${index}-${randomUUID()}`,
      attackerWallet: attacker.wallet,
      attackerBaseId: attacker.baseId,
      defenderWallet: target.wallet,
      defenderBaseId: target.baseId,
      seed: BigInt(index + 1),
      snapshot: {},
      armySnapshot: {},
      simVersion: SIM_VERSION,
      status: 'resolved' as const,
      ordersDeadlineAt: new Date(t0.getTime() + 60_000),
      resolvedAt: t0,
      createdAt: new Date(t0.getTime() + index),
    })));

    const raid = await createRaid(db, attacker.wallet, {
      attackerBaseId: attacker.baseId,
      defenderBaseId: defender.baseId,
      defenderWallet: defender.wallet,
      idempotencyKey: key(),
      authorizeAttackerBase: authority,
      authorizeDefenderBase: authority,
    }, t0);
    const startedAt = new Date(t0.getTime() + 1_000);
    await acceptLiveRaidCommand(
      db, attacker.wallet, raid.id, 'rollout-buff',
      { kind: 'buff', payload: { buff: 'warhorn' } },
      startedAt,
    );
    const deployedAt = new Date(startedAt.getTime() + 500);
    await acceptLiveRaidCommand(
      db, attacker.wallet, raid.id, 'rollout-deploy',
      { kind: 'deploy', payload: { troop: 'highlander', tx: 1, ty: 1 } },
      deployedAt,
    );

    const keepAfterBuff = (await getOrCreatePlayerAccount(db, attacker.wallet, 'player_keep')).balance;
    const shardsAfterAnte = (await getOrCreateBaseAccount(db, attacker.baseId, 'base_shards')).balance;
    const [lootBefore] = await db.select().from(raidLootReservations)
      .where(eq(raidLootReservations.raidId, raid.id));
    expect((await db.select().from(heroRaidReservations)
      .where(eq(heroRaidReservations.raidId, raid.id))).length).toBeGreaterThan(0);
    expect((await db.select({ value: baseProfiles.purchasedEnergy }).from(baseProfiles)
      .where(eq(baseProfiles.baseId, attacker.baseId)))[0]!.value).toBe(0);

    // Model a target SIM rollout while this process is still the compatible
    // resolver. Readiness must fail and every compensating path must leave paid
    // buff, energy, ante, heroes, loot escrow and defender lock untouched.
    await expect(assertNoIncompatibleStartedLiveRaids(db, SIM_VERSION + 1))
      .rejects.toThrow(/started unresolved raid/);
    await expect(compensatePendingRaid(db, raid, false)).resolves.toBe(false);
    expect((await getOrCreatePlayerAccount(db, attacker.wallet, 'player_keep')).balance)
      .toBe(keepAfterBuff);
    expect((await getOrCreateBaseAccount(db, attacker.baseId, 'base_shards')).balance)
      .toBe(shardsAfterAnte);
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `raid-ante-refund:${raid.id}`,
    ))).toHaveLength(0);
    expect(await db.select().from(heroRaidReservations)
      .where(eq(heroRaidReservations.raidId, raid.id))).not.toHaveLength(0);
    expect(await db.select().from(baseRaidLocks)
      .where(eq(baseRaidLocks.raidId, raid.id))).toHaveLength(1);
    expect((await db.select().from(raidLootReservations)
      .where(eq(raidLootReservations.raidId, raid.id)))[0]).toEqual(lootBefore);
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `raid:${raid.id}:live-buff:warhorn`,
    ))).toHaveLength(1);
    expect(keepAfterBuff).toBe(1_000n - BigInt(BUFFS.warhorn.costKeep));

    await expect(recoverDueStartedLiveRaids(
      db, new Date(deployedAt.getTime() + 90_001), defender.baseId,
    )).resolves.toEqual({ resolved: 1, raced: 0 });
    await expect(recoverDueStartedLiveRaids(
      db, new Date(deployedAt.getTime() + 90_002), defender.baseId,
    )).resolves.toEqual({ resolved: 0, raced: 0 });
    expect((await db.select({ status: raids.status }).from(raids)
      .where(eq(raids.id, raid.id)))[0]!.status).toBe('resolved');
    expect((await getOrCreatePlayerAccount(db, attacker.wallet, 'player_keep')).balance)
      .toBe(keepAfterBuff);
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `raid:${raid.id}:live-buff:warhorn`,
    ))).toHaveLength(1);
    expect(await db.select().from(heroRaidReservations)
      .where(eq(heroRaidReservations.raidId, raid.id))).toHaveLength(0);
    expect(await db.select().from(baseRaidLocks)
      .where(eq(baseRaidLocks.raidId, raid.id))).toHaveLength(0);
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `raid-ante-refund:${raid.id}`,
    ))).toHaveLength(0);
  });

  it('rejects an inbound raid while the target deed has an unresolved outgoing battle', async () => {
    const busyDefender = await stablePlayer(5);
    const firstTarget = await stablePlayer(5);
    const secondAttacker = await stablePlayer(5);
    await rewardBaseShards(
      db, busyDefender.baseId, 10_000n, 'test.stable-busy-outgoing', key(),
    );
    await rewardBaseShards(
      db, secondAttacker.baseId, 10_000n, 'test.stable-busy-incoming', key(),
    );

    const outgoing = await createRaid(db, busyDefender.wallet, {
      attackerBaseId: busyDefender.baseId,
      defenderBaseId: firstTarget.baseId,
      defenderWallet: firstTarget.wallet,
      idempotencyKey: key(),
      authorizeAttackerBase: authority,
      authorizeDefenderBase: authority,
    });
    expect(outgoing.status).toBe('pending_orders');

    await expect(createRaid(db, secondAttacker.wallet, {
      attackerBaseId: secondAttacker.baseId,
      defenderBaseId: busyDefender.baseId,
      defenderWallet: busyDefender.wallet,
      idempotencyKey: key(),
      authorizeAttackerBase: authority,
      authorizeDefenderBase: authority,
    })).rejects.toMatchObject({ statusCode: 409, code: 'BASE_BUSY_ATTACKING' });
  });

  it('targets either base owned by one wallet without mixing geometry or cooldowns', async () => {
    const attacker = await stablePlayer(8);
    await readyForFirstCampaign(attacker.baseId);
    // The first deed sits exactly on the K8 attacker's D-099 bar (K4): this test
    // is about base identity, and the Keep gate must not be what refuses it.
    const defender = await stablePlayer(pvpMinDefenderKeep(8));
    await rewardBaseShards(db, attacker.baseId, 1_000_000n, 'test.stable-raid', key());

    const [attackerSecond] = await db.insert(bases).values({
      ownerWallet: attacker.wallet,
      status: 'active',
      keepLevel: 15,
      landPaidAt: new Date('2026-08-12T00:00:00.000Z'),
    }).returning();
    await db.insert(baseSlots).values({ wallet: attacker.wallet, slot: 2, baseId: attackerSecond!.id });
    // Legacy wallet Keep is deliberately different: the selected stable base is
    // the only legal source for the ante tier.
    await db.update(players).set({ keepLevel: 1 }).where(eq(players.wallet, attacker.wallet));
    await db.insert(shields).values([
      {
        playerWallet: attacker.wallet, baseId: attacker.baseId, source: 'loss' as const,
        expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      },
      {
        playerWallet: attacker.wallet, baseId: attackerSecond!.id, source: 'loss' as const,
        expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      },
    ]);

    const [second] = await db.insert(bases).values({
      ownerWallet: defender.wallet,
      status: 'active',
      keepLevel: 9,
      expansions: 2,
      landPaidAt: new Date('2026-08-12T00:00:00.000Z'),
    }).returning();
    await db.insert(baseSlots).values({ wallet: defender.wallet, slot: 2, baseId: second!.id });
    const [secondKeep] = await db.insert(buildings).values({
      playerWallet: defender.wallet,
      baseId: second!.id,
      type: BuildingType.Keep,
      level: 9,
      tx: 13,
      ty: 13,
    }).returning();
    await db.insert(buildings).values({
      playerWallet: defender.wallet,
      baseId: second!.id,
      type: BuildingType.Cannon,
      level: 4,
      tx: 18,
      ty: 18,
    });

    await expect(createRaid(db, attacker.wallet, {
      attackerBaseId: attacker.baseId,
      defenderWallet: defender.wallet,
      idempotencyKey: key(),
      authorizeAttackerBase: authority,
      authorizeDefenderBase: authority,
    })).rejects.toMatchObject({ code: 'BASE_ID_REQUIRED' });

    await db.insert(shields).values({
      playerWallet: defender.wallet,
      baseId: defender.baseId,
      source: 'loss',
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    });
    const shardsBefore = (await getOrCreateBaseAccount(db, attacker.baseId, 'base_shards')).balance;
    const secondRaidKey = key();
    const secondRaid = await createRaid(db, attacker.wallet, {
      attackerBaseId: attacker.baseId,
      defenderBaseId: second!.id,
      defenderWallet: defender.wallet,
      idempotencyKey: secondRaidKey,
      authorizeAttackerBase: authority,
      authorizeDefenderBase: authority,
    });
    expect(secondRaid).toMatchObject({
      attackerBaseId: attacker.baseId,
      defenderBaseId: second!.id,
      armySnapshot: { attackerKeepLevel: 8 },
    });
    expect((await getOrCreateBaseAccount(db, attacker.baseId, 'base_shards')).balance)
      .toBe(shardsBefore - BigInt(pvpAttackShardCostForKeepLevel(8)));
    expect(secondRaid.snapshot).toMatchObject({ keepLevel: 9 });
    expect((secondRaid.snapshot as { buildings: Array<{ id: string }> }).buildings.map((b) => b.id))
      .toContain(secondKeep!.id);
    // Merely scouting/creating a march does not break protection. The selected
    // deed shield breaks only when its first deploy command is accepted.
    expect(await db.select().from(shields).where(eq(shields.baseId, attacker.baseId))).toHaveLength(1);
    expect(await db.select().from(shields).where(eq(shields.baseId, attackerSecond!.id))).toHaveLength(1);
    await expect(createRaid(db, attacker.wallet, {
      attackerBaseId: attacker.baseId,
      defenderBaseId: defender.baseId,
      defenderWallet: defender.wallet,
      idempotencyKey: secondRaidKey,
      authorizeAttackerBase: authority,
      authorizeDefenderBase: authority,
    })).rejects.toMatchObject({ code: 'RAID_IDEMPOTENCY_MISMATCH' });
    await db.update(raids).set({ status: 'resolved' }).where(eq(raids.id, secondRaid.id));

    await db.delete(shields).where(eq(shields.baseId, defender.baseId));
    const firstRaid = await createRaid(db, attacker.wallet, {
      attackerBaseId: attacker.baseId,
      defenderBaseId: defender.baseId,
      defenderWallet: defender.wallet,
      idempotencyKey: key(),
      authorizeAttackerBase: authority,
      authorizeDefenderBase: authority,
    });
    expect(firstRaid.defenderBaseId).toBe(defender.baseId);
    expect((firstRaid.snapshot as { buildings: Array<{ id: string }> }).buildings.map((b) => b.id))
      .not.toContain(secondKeep!.id);
    await db.update(raids).set({ status: 'resolved' }).where(eq(raids.id, firstRaid.id));

    await expect(createCampaignRaid(db, attacker.wallet, 1, key()))
      .rejects.toMatchObject({ code: 'BASE_ID_REQUIRED' });
    const campaign = await createCampaignRaid(
      db, attacker.wallet, 1, key(), new Date(), {
        attackerBaseId: attacker.baseId, authorizeAttackerBase: authority,
      },
    );
    await db.update(raids).set({ status: 'resolved' }).where(eq(raids.id, campaign.id));
    const valley = await createTestValley(db, { name: `Stable raid ${key()}` });
    const [camp] = await db.insert(pveCamps).values({
      valleyId: valley.id, x: 19, y: 19, tier: 1,
      snapshot: makeCampSnapshot(1), lootKeep: 1n,
    }).returning();
    const pve = await createPveRaid(
      db, attacker.wallet, camp!.id, key(), new Date(), {
        attackerBaseId: attacker.baseId, authorizeAttackerBase: authority,
      },
    );
    expect([campaign.attackerBaseId, pve.attackerBaseId]).toEqual([
      attacker.baseId, attacker.baseId,
    ]);
  });

  it('journals stable PvE and campaign raids as batch rows without a defender lock', async () => {
    // WHY (D-099): a PvE or campaign raid has no defender deed to lock, but its
    // orders must survive the client, so it gets a batch journal row and tells
    // the client so through the frozen capability. Stable PvP keeps the live
    // stream — defender lock, server clock — untouched.
    const attacker = await stablePlayer(5);
    const defender = await stablePlayer(5);
    await rewardBaseShards(db, attacker.baseId, 100_000n, 'test.journal-mode', key());
    const live = await createRaid(db, attacker.wallet, {
      attackerBaseId: attacker.baseId,
      defenderBaseId: defender.baseId,
      defenderWallet: defender.wallet,
      idempotencyKey: key(),
      authorizeAttackerBase: authority,
      authorizeDefenderBase: authority,
    });
    const journalOf = async (raidId: string) => (await db.select().from(raidLiveStates)
      .where(eq(raidLiveStates.raidId, raidId)))[0];
    const lockOf = async (raidId: string) => db.select().from(baseRaidLocks)
      .where(eq(baseRaidLocks.raidId, raidId));
    const capability = (raid: { armySnapshot: unknown }) => (raid.armySnapshot as {
      features?: { batchCommandJournal?: boolean };
    }).features?.batchCommandJournal;
    expect(await journalOf(live.id)).toMatchObject({ mode: 'live', startedAt: null });
    expect(await lockOf(live.id)).toHaveLength(1);
    expect(capability(live)).toBeUndefined();

    const campaigner = await stablePlayer(5);
    await readyForFirstCampaign(campaigner.baseId);
    const campaign = await createCampaignRaid(db, campaigner.wallet, 1, key(), new Date(), {
      attackerBaseId: campaigner.baseId, authorizeAttackerBase: authority,
    });
    expect(await journalOf(campaign.id)).toMatchObject({ mode: 'batch', startedAt: null });
    expect(await lockOf(campaign.id)).toHaveLength(0);
    expect(capability(campaign)).toBe(true);

    const raider = await stablePlayer(5);
    const valley = await createTestValley(db, { name: `Journal mode ${key()}` });
    const [camp] = await db.insert(pveCamps).values({
      valleyId: valley.id, x: 23, y: 23, tier: 1,
      snapshot: makeCampSnapshot(1), lootKeep: 1n,
    }).returning();
    const pve = await createPveRaid(db, raider.wallet, camp!.id, key(), new Date(), {
      attackerBaseId: raider.baseId, authorizeAttackerBase: authority,
    });
    expect(await journalOf(pve.id)).toMatchObject({ mode: 'batch', startedAt: null });
    expect(await lockOf(pve.id)).toHaveLength(0);
    expect(capability(pve)).toBe(true);
  });

  it('defaults raid creation to V1 and gates only new V2 rows, never an exact retry', async () => {
    const legacyPlayer = await stablePlayer(5);
    await readyForFirstCampaign(legacyPlayer.baseId);
    const legacy = await createCampaignRaid(
      db, legacyPlayer.wallet, 1, key(), new Date(), {
        attackerBaseId: legacyPlayer.baseId,
        authorizeAttackerBase: authority,
      },
    );
    expect(legacy.raidProtocolVersion).toBe(1);
    expect(await db.select({ version: raidLiveStates.commandProtocolVersion })
      .from(raidLiveStates).where(eq(raidLiveStates.raidId, legacy.id)))
      .toEqual([{ version: 1 }]);

    const v2Player = await stablePlayer(5);
    await readyForFirstCampaign(v2Player.baseId);
    const createKey = key();
    await expect(createCampaignRaid(
      db, v2Player.wallet, 1, createKey, new Date(), {
        attackerBaseId: v2Player.baseId,
        authorizeAttackerBase: authority,
        raidProtocolVersion: 2,
        allowRaidProtocolV2: false,
      },
    )).rejects.toMatchObject({ code: 'LIVE_RAID_V2_DISABLED' });

    const v2 = await createCampaignRaid(
      db, v2Player.wallet, 1, createKey, new Date(), {
        attackerBaseId: v2Player.baseId,
        authorizeAttackerBase: authority,
        raidProtocolVersion: 2,
        allowRaidProtocolV2: true,
      },
    );
    expect(v2.raidProtocolVersion).toBe(2);
    // WHY: rollout may turn off after a response is lost. The already-created
    // raid must be returned before the new-creation gate or a retry could spend
    // energy/ante twice and strand the durable resume pointer.
    const retryWhileOff = await createCampaignRaid(
      db, v2Player.wallet, 1, createKey, new Date(), {
        attackerBaseId: v2Player.baseId,
        authorizeAttackerBase: authority,
        raidProtocolVersion: 2,
        allowRaidProtocolV2: false,
      },
    );
    expect(retryWhileOff.id).toBe(v2.id);
    expect(retryWhileOff.raidProtocolVersion).toBe(2);
  });

  it.each(['immediate', 'delayed-2x'] as const)('preserves both replay views after %s retreat', async (mode) => {
    const t0 = new Date();
    const attacker = await stablePlayer(5);
    const defender = await stablePlayer(5);
    await db.insert(baseArmy).values({
      baseId: attacker.baseId, troop: 'highlander', count: 2,
    }).onConflictDoUpdate({
      target: [baseArmy.baseId, baseArmy.troop], set: { count: 2 },
    });
    await rewardBaseShards(db, attacker.baseId, 100_000n, 'test.v2-retreat', key());
    await db.insert(baseProfiles).values([
      { baseId: attacker.baseId, trophies: 100 },
      { baseId: defender.baseId, trophies: 100 },
    ]).onConflictDoUpdate({
      target: baseProfiles.baseId,
      set: { trophies: 100 },
    });
    const beforeEnergy = await getRaidEnergy(db, attacker.wallet, t0, attacker.baseId);
    const beforeShards = (await getOrCreateBaseAccount(db, attacker.baseId, 'base_shards')).balance;
    const raid = await createRaid(db, attacker.wallet, {
      attackerBaseId: attacker.baseId,
      defenderBaseId: defender.baseId,
      defenderWallet: defender.wallet,
      idempotencyKey: key(),
      authorizeAttackerBase: authority,
      authorizeDefenderBase: authority,
      raidProtocolVersion: 2,
      allowRaidProtocolV2: true,
    }, t0);
    const afterCreateEnergy = await getRaidEnergy(
      db, attacker.wallet, new Date(t0.getTime() + 500), attacker.baseId,
    );
    const afterCreateShards = (await getOrCreateBaseAccount(
      db, attacker.baseId, 'base_shards',
    )).balance;
    expect(afterCreateEnergy.free).toBe(beforeEnergy.free - 1);
    expect(afterCreateShards).toBeLessThan(beforeShards);

    await acceptLiveRaidCommand(
      db, attacker.wallet, raid.id, 'retreat-deploy',
      { kind: 'deploy', payload: { troop: 'highlander', tx: 1, ty: 1 } },
      new Date(t0.getTime() + 1_000),
    );
    if (mode === 'delayed-2x') {
      await setLiveRaidSpeed(
        db, attacker.wallet, raid.id, 'retreat-speed', 1, 2, true,
        new Date(t0.getTime() + 2_000),
      );
    }
    const retreatAt = new Date(t0.getTime() + 3_050);
    const retreat = await retreatLiveRaid(db, attacker.wallet, raid.id, 'retreat-control', retreatAt);
    expect(retreat).toMatchObject({ retreated: true, terminal: false });
    const playedTicks = Math.floor(retreat.clock.simNowMs / COMBAT_TICK_MS);
    expect(retreat.clock.simNowMs).toBe(mode === 'delayed-2x' ? 3_100 : 2_050);
    if (mode === 'delayed-2x') {
      // Losing the original response must not advance the archive to the later
      // worker wall clock, nor reinterpret the accepted 2x clock as 1x.
      expect(await recoverDueStartedLiveRaids(
        db, new Date(t0.getTime() + 120_000), undefined, raid.id,
      )).toEqual({ resolved: 1, raced: 0 });
    } else {
      await submitOrders(db, attacker.wallet, raid.id, retreat.orders!, retreatAt, true, false, true);
    }
    const [settled] = await db.select().from(raids).where(eq(raids.id, raid.id));
    const result = settled!.result as {
      stars: number; destructionPct: number; lootShards: number; retreated: boolean;
      attackerTrophyDelta: number; defenderTrophyDelta: number;
    };
    expect(result).toMatchObject({
      stars: 0,
      destructionPct: 0,
      lootShards: 0,
      retreated: true,
    });
    expect(result.attackerTrophyDelta).toBeLessThan(0);
    expect(result.defenderTrophyDelta).toBeGreaterThan(0);
    const [timeline] = await db.select().from(raidReplayTimelines).where(eq(raidReplayTimelines.raidId, raid.id));
    const archive = decodeReplayTimeline(timeline!);
    const simulation = simulateRaid(raid.snapshot as BaseSnapshot, archive.orders as RaidOrders, Number(raid.seed));
    // A history row alone was insufficient: RETREAT had erased every deploy,
    // movement and attack event for both the attacker and live defender viewer.
    expect(archive.events.length).toBeGreaterThan(1);
    expect(archive.events).toEqual(simulation.events.filter((event) => event.t <= playedTicks));
    expect(simulation.events.some((event) => event.t > playedTicks)).toBe(true);
    expect(timeline).toMatchObject({ durationMs: playedTicks * COMBAT_TICK_MS, eventCount: archive.events.length });
    expect(settled!.events).toEqual(archive.events);
    // Starting HP now comes from actual simulation, never the settlement-only
    // retreat placeholders or a reconstruction using future stat tables.
    expect(archive.buildingHealth).toEqual(simulation.buildings.map((building) => ({
      id: building.id, initialHp: building.maxHp, maxHp: building.maxHp,
    })));
    for (const participant of [attacker, defender]) {
      const replay = await getBaseBattleReplay(db, participant.wallet, participant.baseId, raid.id);
      expect(replay).toMatchObject({ events: archive.events, result, timeline: {
        durationMs: playedTicks * COMBAT_TICK_MS, eventCount: archive.events.length, integrityVerified: true,
      } });
      expect(await getParticipantBattleReplay(db, participant.wallet, raid.id)).toEqual(replay);
      const native = await loadNativePresentation(db, participant.wallet, raid.id);
      expect(native.events).toEqual(archive.events);
      expect(native.envelope).toMatchObject({ buildingHealth: archive.buildingHealth });
    }

    expect(await db.select({ count: baseArmy.count }).from(baseArmy).where(and(
      eq(baseArmy.baseId, attacker.baseId), eq(baseArmy.troop, 'highlander'),
    ))).toEqual([{ count: 1 }]);
    const profiles = await db.select({
      baseId: baseProfiles.baseId, trophies: baseProfiles.trophies,
    }).from(baseProfiles).where(inArray(
      baseProfiles.baseId, [attacker.baseId, defender.baseId],
    ));
    expect(profiles.find((profile) => profile.baseId === attacker.baseId)?.trophies)
      .toBe(100 + result.attackerTrophyDelta);
    expect(profiles.find((profile) => profile.baseId === defender.baseId)?.trophies)
      .toBe(100 + result.defenderTrophyDelta);
    expect((await getOrCreateBaseAccount(db, attacker.baseId, 'base_shards')).balance)
      .toBe(afterCreateShards);
    expect(await getRaidEnergy(
      db, attacker.wallet, new Date(t0.getTime() + 3_000), attacker.baseId,
    )).toEqual(afterCreateEnergy);
    expect(await db.select({ state: raidLootReservations.state })
      .from(raidLootReservations).where(eq(raidLootReservations.raidId, raid.id)))
      // WHY: once combat started, retreat is a canonical zero-star settlement
      // (including trophies/history), not a refundable pre-battle release.
      .toEqual([{ state: 'settled' }]);
    expect(await db.select({
      role: baseBattleRecords.role,
      stars: baseBattleRecords.stars,
      destructionPct: baseBattleRecords.destructionPct,
    }).from(baseBattleRecords).where(eq(baseBattleRecords.raidId, raid.id)))
      .toEqual(expect.arrayContaining([
        { role: 'attacker', stars: 0, destructionPct: 0 },
        { role: 'defender', stars: 0, destructionPct: 0 },
      ]));
  });

  it('serializes one outgoing battle per deed across PvP, PvE and campaign', async () => {
    const attacker = await stablePlayer(5);
    await readyForFirstCampaign(attacker.baseId);
    const defender = await stablePlayer(5);
    await rewardBaseShards(db, attacker.baseId, 100_000n, 'test.one-outgoing', key());
    const valley = await createTestValley(db, { name: `One outgoing ${key()}` });
    const [camp] = await db.insert(pveCamps).values({
      valleyId: valley.id, x: 21, y: 21, tier: 1,
      snapshot: makeCampSnapshot(1), lootKeep: 1n,
    }).returning();

    // These transactions race from distinct modes. The shared attacker-base
    // row lock makes exactly one INSERT win, independently of hero overlap.
    const attempts = await Promise.allSettled([
      createRaid(db, attacker.wallet, {
        attackerBaseId: attacker.baseId,
        defenderBaseId: defender.baseId,
        defenderWallet: defender.wallet,
        idempotencyKey: key(),
        authorizeAttackerBase: authority,
        authorizeDefenderBase: authority,
      }),
      createPveRaid(db, attacker.wallet, camp!.id, key(), new Date(), {
        attackerBaseId: attacker.baseId, authorizeAttackerBase: authority,
      }),
      createCampaignRaid(db, attacker.wallet, 1, key(), new Date(), {
        attackerBaseId: attacker.baseId, authorizeAttackerBase: authority,
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
    expect(rejected).toHaveLength(2);
    expect(rejected.every((attempt) => (
      (attempt as PromiseRejectedResult).reason as { code?: string }
    ).code === 'BASE_BUSY_ATTACKING')).toBe(true);

    const [winner] = await db.select({ id: raids.id }).from(raids).where(and(
      eq(raids.attackerBaseId, attacker.baseId),
      inArray(raids.status, ['pending_orders', 'resolving']),
    ));
    expect(winner).toBeDefined();
    await db.update(raids).set({ status: 'resolved' }).where(eq(raids.id, winner!.id));

    const campaign = await createCampaignRaid(db, attacker.wallet, 1, key(), new Date(), {
      attackerBaseId: attacker.baseId, authorizeAttackerBase: authority,
    });
    await expect(createPveRaid(db, attacker.wallet, camp!.id, key(), new Date(), {
      attackerBaseId: attacker.baseId, authorizeAttackerBase: authority,
    })).rejects.toMatchObject({ code: 'BASE_BUSY_ATTACKING' });
    await db.update(raids).set({ status: 'resolved' }).where(eq(raids.id, campaign.id));
  });

  it('blocks a deed sale throughout an outgoing live raid, then conveys future play only', async () => {
    const seller = await stablePlayer(5);
    const defender = await stablePlayer(5);
    const buyer = await stablePlayer(2);
    const deed = `outgoing-sale-${randomUUID()}`;
    await db.update(bases).set({ deedAssetId: deed }).where(eq(bases.id, seller.baseId));
    await db.insert(baseArmy).values({
      baseId: seller.baseId, troop: 'highlander', count: 1,
    }).onConflictDoUpdate({
      target: [baseArmy.baseId, baseArmy.troop], set: { count: 1 },
    });
    await rewardBaseShards(db, seller.baseId, 100_000n, 'test.outgoing-sale', key());
    const raid = await createRaid(db, seller.wallet, {
      attackerBaseId: seller.baseId,
      defenderBaseId: defender.baseId,
      defenderWallet: defender.wallet,
      idempotencyKey: key(),
      authorizeAttackerBase: authority,
      authorizeDefenderBase: authority,
    });

    await expect(transferStableBase(
      db, seller.baseId, seller.wallet, buyer.wallet, deed,
    )).rejects.toMatchObject({ code: 'BASE_BUSY_ATTACKING' });
    await acceptLiveRaidCommand(
      db, seller.wallet, raid.id, 'sale-live-deploy',
      { kind: 'deploy', payload: { troop: 'highlander', tx: 1, ty: 1 } },
    );
    await expect(transferStableBase(
      db, seller.baseId, seller.wallet, buyer.wallet, deed,
    )).rejects.toMatchObject({ code: 'BASE_BUSY_ATTACKING' });

    // Settlement normally writes this transition atomically. This focused test
    // walks the resolving state, then terminalises without needing to run sim.
    await db.update(raids).set({ status: 'resolving' }).where(eq(raids.id, raid.id));
    await expect(transferStableBase(
      db, seller.baseId, seller.wallet, buyer.wallet, deed,
    )).rejects.toMatchObject({ code: 'BASE_BUSY_ATTACKING' });
    await db.update(raids).set({ status: 'resolved', resolvedAt: new Date() })
      .where(eq(raids.id, raid.id));
    await expect(transferStableBase(
      db, seller.baseId, seller.wallet, buyer.wallet, deed,
    )).resolves.toMatchObject({ baseId: seller.baseId });
    await expect(acceptLiveRaidCommand(
      db, seller.wallet, raid.id, 'seller-after-terminal-sale',
      { kind: 'deploy', payload: { troop: 'highlander', tx: 2, ty: 1 } },
    )).rejects.toMatchObject({ code: 'DEED_OWNERSHIP_CHANGED' });
    await expect(acceptLiveRaidCommand(
      db, buyer.wallet, raid.id, 'buyer-cannot-rewrite-history',
      { kind: 'deploy', payload: { troop: 'highlander', tx: 2, ty: 1 } },
    )).rejects.toMatchObject({ statusCode: 404 });
    await expect(submitOrders(db, seller.wallet, raid.id, {
      deploys: [{ troop: 'highlander', tx: 1, ty: 1, tMs: 0 }],
      idempotencyKey: key(),
    })).rejects.toMatchObject({ code: 'DEED_OWNERSHIP_CHANGED' });
    await expect(createCampaignRaid(db, seller.wallet, 1, key(), new Date(), {
      attackerBaseId: seller.baseId, authorizeAttackerBase: authority,
    })).rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    await expect(createCampaignRaid(db, buyer.wallet, 1, key(), new Date(), {
      attackerBaseId: seller.baseId, authorizeAttackerBase: authority,
    })).resolves.toMatchObject({ attackerBaseId: seller.baseId });
  });

  it('defers an externally observed sale until terminal and fences the former owner immediately', async () => {
    const seller = await stablePlayer(5);
    const defender = await stablePlayer(5);
    const buyerWallet = Keypair.generate().publicKey.toBase58();
    const deed = `external-outgoing-${randomUUID()}`;
    await db.update(bases).set({ deedAssetId: deed }).where(eq(bases.id, seller.baseId));
    await rewardBaseShards(db, seller.baseId, 100_000n, 'test.external-outgoing', key());
    const raid = await createRaid(db, seller.wallet, {
      attackerBaseId: seller.baseId,
      defenderBaseId: defender.baseId,
      defenderWallet: defender.wallet,
      idempotencyKey: key(),
      authorizeAttackerBase: authority,
      authorizeDefenderBase: authority,
    });
    const observeBuyer = async () => ({
      owner: buyerWallet,
      frozen: false,
      delegate: null,
      collection: 'collection',
      slot: 900,
    });

    expect(await refreshBaseOwnership(
      db, seller.baseId, observeBuyer, 'collection', new Date(), 'test-external-outgoing',
    )).toBe('mismatch');
    expect((await db.select().from(bases).where(eq(bases.id, seller.baseId)))[0]?.ownerWallet)
      .toBe(seller.wallet);
    await expect(acceptLiveRaidCommand(
      db, seller.wallet, raid.id, 'external-sale-command',
      { kind: 'deploy', payload: { troop: 'highlander', tx: 1, ty: 1 } },
    )).rejects.toMatchObject({ code: 'DEED_OWNERSHIP_CHANGED' });

    await db.update(raids).set({ status: 'resolved', resolvedAt: new Date() })
      .where(eq(raids.id, raid.id));
    expect(await refreshBaseOwnership(
      db, seller.baseId, observeBuyer, 'collection', new Date(), 'test-external-terminal',
    )).toBe('mismatch');
    expect((await db.select().from(bases).where(eq(bases.id, seller.baseId)))[0]?.ownerWallet)
      .toBe(buyerWallet);
  });

  it.each(['campaign', 'pve', 'pvp', 'pvp-purchased-energy'] as const)(
    'preserves %s SIM bytes and real economic settlement at v1, v2 1x, and v2 1x/2x/1x',
    async (scenario) => {
      const mode = scenario === 'pvp-purchased-energy' ? 'pvp' : scenario;
      const purchasedEnergy = scenario === 'pvp-purchased-energy';
      const t0 = new Date();
      const attacker = await stablePlayer(5);
      const defender = mode === 'pvp' ? await stablePlayer(5) : null;
      const unitCount = 40;
      await fundTestKeep(db, attacker.wallet, 1_000n, 'test.speed-parity.keep', key());
      await rewardBaseShards(db, attacker.baseId, 100_000n, 'test.speed-parity.ante', key());
      await db.insert(baseArmy).values({
        baseId: attacker.baseId, troop: 'highlander', count: unitCount,
      }).onConflictDoUpdate({
        target: [baseArmy.baseId, baseArmy.troop], set: { count: unitCount },
      });
      if (defender) {
        await rewardBaseShards(db, defender.baseId, 100_000n, 'test.speed-parity.loot', key());
        for (const baseId of [attacker.baseId, defender.baseId]) {
          await db.insert(baseProfiles).values({ baseId, trophies: 100 })
            .onConflictDoUpdate({ target: baseProfiles.baseId, set: { trophies: 100 } });
        }
      }
      if (purchasedEnergy) {
        await db.update(baseProfiles).set({ purchasedEnergy: 1 })
          .where(eq(baseProfiles.baseId, attacker.baseId));
        // Historical terminal marches are setup only. The attack under test
        // must consume the paid slot through the real create API, not a direct
        // mutation of its energySource or an assertion on free-energy only.
        const priorDefenders = await Promise.all(Array.from(
          { length: RAID_ENERGY.freePerDay }, () => createTestPlayer(db),
        ));
        await db.insert(raids).values(priorDefenders.map((target) => ({
          idempotencyKey: key(), attackerWallet: attacker.wallet,
          attackerBaseId: attacker.baseId, defenderWallet: target.wallet,
          seed: 7n, snapshot: {}, armySnapshot: {}, simVersion: SIM_VERSION,
          status: 'resolved' as const, createdAt: t0, resolvedAt: t0,
          ordersDeadlineAt: t0,
        })));
      }
      const attackerKeep = await getOrCreatePlayerAccount(db, attacker.wallet, 'player_keep');
      const attackerShards = await getOrCreateBaseAccount(db, attacker.baseId, 'base_shards');
      const defenderShards = defender
        ? await getOrCreateBaseAccount(db, defender.baseId, 'base_shards') : null;
      const valley = mode === 'pve' ? await createTestValley(db, { name: `parity ${key()}` }) : null;
      const [camp] = valley ? await db.insert(pveCamps).values({
        valleyId: valley.id, x: 22, y: 22, tier: 1,
        snapshot: makeCampSnapshot(1), lootKeep: 77n,
      }).returning() : [];

      // Reuse the SAME deed/building IDs and pre-raid economic state. Each
      // scenario runs normal create/command/control/settlement code in an outer
      // transaction that is rolled back only after observing its final result.
      // The sole deterministic-input fixture override is the generated seed,
      // before commands exist: no SIM, clock, result, reward, or balance is
      // overwritten. All clock progress comes from explicit API test instants.
      const run = async (protocol: 1 | 2, accelerate: boolean) => {
        const rollback = new Error('rollback observed parity scenario');
        let observed: {
          inputBytes: string; orderBytes: string; eventBytes: string; resultBytes: string;
          balanceDeltas: Array<{ id: string; delta: bigint }>;
          energyBefore: Awaited<ReturnType<typeof getRaidEnergy>>;
          energyAfter: Awaited<ReturnType<typeof getRaidEnergy>>;
          energySource: string | null;
          armyCount: number; trophies: Array<{ baseId: string; trophies: number }>;
          history: Array<{ role: string; stars: number; destructionPct: number; lootDeltaShards: bigint }>;
          result: { stars: number; lootShards: number; attackerTrophyDelta: number; defenderTrophyDelta: number };
        } | undefined;
        try {
          await db.transaction(async (tx) => {
            const scenarioDb = tx as unknown as typeof db;
            const before = await tx.select({ id: accounts.id, balance: accounts.balance }).from(accounts);
            const balancesBefore = new Map(before.map((row) => [row.id, row.balance]));
            const energyBefore = await getRaidEnergy(scenarioDb, attacker.wallet, t0, attacker.baseId);
            const context = {
              attackerBaseId: attacker.baseId, authorizeAttackerBase: authority,
              raidProtocolVersion: protocol, allowRaidProtocolV2: true,
            };
            const raid = mode === 'campaign'
              ? await createCampaignRaid(scenarioDb, attacker.wallet, 1, key(), t0, context)
              : mode === 'pve'
                ? await createPveRaid(scenarioDb, attacker.wallet, camp!.id, key(), t0, context)
                : await createRaid(scenarioDb, attacker.wallet, {
                  ...context, defenderWallet: defender!.wallet,
                  defenderBaseId: defender!.baseId, authorizeDefenderBase: authority,
                  idempotencyKey: key(),
                }, t0);
            expect(raid.raidProtocolVersion).toBe(protocol);
            await tx.update(raids).set({ seed: 7n }).where(eq(raids.id, raid.id));
            const battleT0 = raid.createdAt;
            await acceptLiveRaidCommandReceipt(
              scenarioDb, attacker.wallet, raid.id, 'buff',
              { kind: 'buff', payload: { buff: 'warhorn' } }, battleT0,
            );
            for (let i = 0; i < unitCount - 1; i++) {
              await acceptLiveRaidCommandReceipt(
                scenarioDb, attacker.wallet, raid.id, `unit-${i}`,
                { kind: 'deploy', payload: {
                  troop: 'highlander', tx: 6, ty: 10 + i % 10,
                  ...(protocol === 1 && mode !== 'pvp' ? { tMs: 0 } : {}),
                } }, battleT0,
              );
            }
            if (protocol === 2 && mode !== 'pvp') {
              await startLiveRaid(scenarioDb, attacker.wallet, raid.id, 'attack', 0, battleT0);
            }
            if (accelerate) {
              const fast = await setLiveRaidSpeed(
                scenarioDb, attacker.wallet, raid.id, 'fast', 1, 2, true,
                new Date(battleT0.getTime() + 10_000),
              );
              expect(fast.clock).toMatchObject({ revision: 2, rate: 2, simNowMs: 10_000 });
            }
            // Live attackers retain deployment at 2x. The late unit is at the
            // identical SIM instant (30s), reached after 20s wall at 2x or 30s
            // wall at 1x. Prebattle batches also retain their t=0 first wave.
            const lateAt = new Date(battleT0.getTime() + (accelerate ? 20_000 : 30_000));
            const late = await acceptLiveRaidCommandReceipt(
              scenarioDb, attacker.wallet, raid.id, 'late-unit',
              { kind: 'deploy', payload: {
                troop: 'highlander', tx: 6, ty: 19,
                ...(protocol === 1 && mode !== 'pvp' ? { tMs: 30_000 } : {}),
              } }, lateAt,
            );
            expect(late.command.serverOffsetMs).toBe(30_000);
            if (accelerate) {
              const normal = await setLiveRaidSpeed(
                scenarioDb, attacker.wallet, raid.id, 'normal', 2, 1, true, lateAt,
              );
              expect(normal.clock).toMatchObject({ revision: 3, rate: 1, simNowMs: 30_000 });
            }
            const clock = (await getRaidClock(scenarioDb, raid.id, lateAt)).clock;
            const endedAt = clock.battleEndsAt!;
            if (protocol === 2) expect(endedAt.getTime() - battleT0.getTime())
              .toBe(RAID_RULES.battleDurationSec * 1_000 - (accelerate ? 10_000 : 0));
            const orders = await closeLiveRaidStream(scenarioDb, attacker.wallet, raid.id, endedAt);
            const settled = await submitOrders(scenarioDb, attacker.wallet, raid.id, orders, endedAt, true);
            const [persisted] = await tx.select().from(raids).where(eq(raids.id, raid.id));
            expect(persisted!.status).toBe('resolved');
            const { idempotencyKey: _key, ...canonicalOrders } = persisted!.orders as Record<string, unknown>;
            const after = await tx.select({ id: accounts.id, balance: accounts.balance }).from(accounts);
            const balanceDeltas = after.map((row) => ({
              id: row.id, delta: row.balance - (balancesBefore.get(row.id) ?? 0n),
            })).filter((row) => row.delta !== 0n).sort((a, b) => a.id.localeCompare(b.id));
            expect(balanceDeltas.reduce((sum, row) => sum + row.delta, 0n)).toBe(0n);
            const energyAfter = await getRaidEnergy(scenarioDb, attacker.wallet, endedAt, attacker.baseId);
            const [troops] = await tx.select({ count: baseArmy.count }).from(baseArmy).where(and(
              eq(baseArmy.baseId, attacker.baseId), eq(baseArmy.troop, 'highlander'),
            ));
            const trophies = await tx.select({ baseId: baseProfiles.baseId, trophies: baseProfiles.trophies })
              .from(baseProfiles).where(inArray(baseProfiles.baseId,
                [attacker.baseId, ...(defender ? [defender.baseId] : [])])).orderBy(baseProfiles.baseId);
            const history = await tx.select({
              role: baseBattleRecords.role, stars: baseBattleRecords.stars,
              destructionPct: baseBattleRecords.destructionPct, lootDeltaShards: baseBattleRecords.lootDeltaShards,
            }).from(baseBattleRecords).where(eq(baseBattleRecords.raidId, raid.id)).orderBy(baseBattleRecords.role);
            expect(await tx.select().from(baseRaidLocks).where(eq(baseRaidLocks.raidId, raid.id))).toHaveLength(0);
            expect(await tx.select().from(heroRaidReservations).where(eq(heroRaidReservations.raidId, raid.id))).toHaveLength(0);
            observed = {
              inputBytes: JSON.stringify({ seed: 7, snapshot: persisted!.snapshot, armySnapshot: persisted!.armySnapshot }),
              orderBytes: JSON.stringify(canonicalOrders), eventBytes: JSON.stringify(persisted!.events),
              resultBytes: JSON.stringify(persisted!.result), balanceDeltas,
              energyBefore, energyAfter, energySource: persisted!.energySource,
              armyCount: troops!.count, trophies, history, result: settled.result,
            };
            throw rollback;
          });
        } catch (error) {
          if (error !== rollback) throw error;
        }
        expect(observed).toBeDefined();
        return observed!;
      };
      const legacy = await run(1, false);
      const normal = await run(2, false);
      const accelerated = await run(2, true);
      expect(normal).toEqual(legacy);
      expect(accelerated).toEqual(legacy);
      expect(legacy.armyCount).toBe(0);
      expect(legacy.result.stars).toBe(3);
      // D-152: a cleared camp pays nothing; PvP and campaign still pay SHARDS.
      if (mode === 'pve') expect(legacy.result.lootShards).toBe(0);
      else expect(legacy.result.lootShards).toBeGreaterThan(0);
      expect(legacy.energyAfter.used - legacy.energyBefore.used).toBe(mode === 'pvp' ? 1 : 0);
      expect(legacy.energyBefore.free - legacy.energyAfter.free).toBe(mode === 'pvp' ? 1 : 0);
      expect(legacy.energyAfter.purchased)
        .toBe(legacy.energyBefore.purchased - (purchasedEnergy ? 1 : 0));
      expect(legacy.energySource).toBe(mode === 'pvp'
        ? purchasedEnergy ? 'purchased' : 'free' : null);
      const deltaOf = (accountId: string) => legacy.balanceDeltas
        .find((row) => row.id === accountId)?.delta ?? 0n;
      // The buff is the only KEEP movement in every mode (legacy client, Gems
      // dark): the PvE bounty leg was deleted under D-152.
      expect(deltaOf(attackerKeep.id)).toBe(-BigInt(BUFFS.warhorn.costKeep));
      expect(deltaOf(attackerShards.id)).toBe(mode === 'pvp'
        ? BigInt(legacy.result.lootShards) - BigInt(pvpAttackShardCostForKeepLevel(5))
        : mode === 'campaign' ? BigInt(legacy.result.lootShards) : 0n);
      if (mode === 'pvp') {
        expect(deltaOf(defenderShards!.id)).toBe(-BigInt(legacy.result.lootShards));
        expect(legacy.result.attackerTrophyDelta).toBeGreaterThan(0);
        expect(legacy.result.defenderTrophyDelta).toBeLessThan(0);
      } else {
        expect(legacy.result.attackerTrophyDelta).toBe(0);
        expect(legacy.result.defenderTrophyDelta).toBe(0);
      }
    },
    SEAL_BOUND_SHARED_DB_CASE_MS,
  );

  it('records stable PvE and campaign settlements as attacker-only deed history', async () => {
    const deploys = Array.from({ length: 10 }, (_, index) => ({
      troop: 'highlander' as const,
      tx: 6,
      ty: 10 + index,
      tMs: index * 10,
    }));
    const campaignAttacker = await stablePlayer(5);
    await db.insert(baseArmy).values({
      baseId: campaignAttacker.baseId, troop: 'highlander', count: 10,
    }).onConflictDoUpdate({
      target: [baseArmy.baseId, baseArmy.troop], set: { count: 10 },
    });
    const campaign = await createCampaignRaid(
      db, campaignAttacker.wallet, 1, key(), new Date(), {
        attackerBaseId: campaignAttacker.baseId, authorizeAttackerBase: authority,
      },
    );
    const campaignResult = (await submitOrders(
      db, campaignAttacker.wallet, campaign.id, { deploys, idempotencyKey: key() },
    )).result;
    const [campaignRecord] = await db.select().from(baseBattleRecords).where(and(
      eq(baseBattleRecords.baseId, campaignAttacker.baseId),
      eq(baseBattleRecords.raidId, campaign.id),
    ));
    expect(campaignRecord).toMatchObject({
      role: 'attacker',
      ownerWalletAtBattle: campaignAttacker.wallet,
      counterpartyBaseId: null,
      lootDeltaShards: BigInt(campaignResult.lootShards),
    });
    expect(campaignRecord!.createdAt).toEqual(expect.any(Date));

    const pveAttacker = await stablePlayer(5);
    await db.insert(baseArmy).values({
      baseId: pveAttacker.baseId, troop: 'highlander', count: 10,
    }).onConflictDoUpdate({
      target: [baseArmy.baseId, baseArmy.troop], set: { count: 10 },
    });
    const valley = await createTestValley(db, { name: `PvE history ${key()}` });
    const [camp] = await db.insert(pveCamps).values({
      valleyId: valley.id, x: 22, y: 22, tier: 1,
      snapshot: makeCampSnapshot(1), lootKeep: 77n,
    }).returning();
    const pve = await createPveRaid(db, pveAttacker.wallet, camp!.id, key(), new Date(), {
      attackerBaseId: pveAttacker.baseId, authorizeAttackerBase: authority,
    });
    await submitOrders(db, pveAttacker.wallet, pve.id, { deploys, idempotencyKey: key() });
    const [pveRecord] = await db.select().from(baseBattleRecords).where(and(
      eq(baseBattleRecords.baseId, pveAttacker.baseId),
      eq(baseBattleRecords.raidId, pve.id),
    ));
    expect(pveRecord).toMatchObject({
      role: 'attacker',
      ownerWalletAtBattle: pveAttacker.wallet,
      counterpartyBaseId: null,
      // A camp pays nothing (D-152) and never a deed-SHARDS delta.
      lootDeltaShards: 0n,
    });
  });

  it('follows a sold base to the buyer while playable state remains with the deed', async () => {
    const attacker = await stablePlayer(8);
    const seller = await stablePlayer(6, 2);
    const buyer = await stablePlayer(2);
    await rewardBaseShards(db, attacker.baseId, 1_000_000n, 'test.stable-raid', key());
    await rewardBaseShards(db, seller.baseId, 12_345n, 'test.stable-raid', key());

    const deed = `stable-raid-deed-${randomUUID()}`;
    await db.update(bases).set({ deedAssetId: deed }).where(eq(bases.id, seller.baseId));
    const [cannon] = await db.insert(buildings).values({
      playerWallet: seller.wallet,
      baseId: seller.baseId,
      type: BuildingType.Cannon,
      level: 4,
      tx: 18,
      ty: 18,
    }).returning();
    await db.insert(buildings).values({
      playerWallet: seller.wallet,
      baseId: seller.baseId,
      type: BuildingType.HeroAltar,
      level: 1,
      tx: 10,
      ty: 10,
    });
    await db.insert(heroLevels).values({ playerWallet: buyer.wallet, hero: 'vex', level: 11 });
    await db.insert(baseHeroProgress).values({ baseId: seller.baseId, hero: 'vex', level: 11 })
      .onConflictDoUpdate({
        target: [baseHeroProgress.baseId, baseHeroProgress.hero],
        set: { level: 11 },
      });
    await transferStableBase(db, seller.baseId, seller.wallet, buyer.wallet, deed);

    const created = await createRaid(db, attacker.wallet, {
      attackerBaseId: attacker.baseId,
      defenderBaseId: seller.baseId,
      defenderWallet: buyer.wallet,
      idempotencyKey: key(),
      authorizeAttackerBase: authority,
      authorizeDefenderBase: authority,
    });
    const snapshot = created.snapshot as {
      keepLevel: number;
      surplusShards: number;
      buildings: Array<{ id: string }>;
      defenderHeroes?: Array<{ hero: string; level: number }>;
    };
    expect(created.defenderWallet).toBe(buyer.wallet);
    expect(snapshot.keepLevel).toBe(6);
    // Exact deed wealth is reserved server-side and deliberately never exposed
    // in the combat snapshot; transfer leaves that wealth on the sold deed.
    expect(snapshot.surplusShards).toBe(0);
    expect(snapshot.buildings.map((building) => building.id)).toContain(cannon!.id);
    expect(snapshot.defenderHeroes).toContainEqual(expect.objectContaining({ hero: 'vex', level: 11 }));

    await expect(createRaid(db, attacker.wallet, {
      attackerBaseId: attacker.baseId,
      defenderBaseId: seller.baseId,
      defenderWallet: seller.wallet,
      idempotencyKey: key(),
      authorizeAttackerBase: authority,
      authorizeDefenderBase: authority,
    })).rejects.toThrow(/defender not found/);
    await expect(createCampaignRaid(
      db, attacker.wallet, 1, key(), new Date(), {
        attackerBaseId: buyer.baseId, authorizeAttackerBase: authority,
      },
    )).rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });

    const [stored] = await db.select().from(raids).where(eq(raids.id, created.id));
    expect(stored).toMatchObject({ attackerBaseId: attacker.baseId, defenderBaseId: seller.baseId });
  });

  it('fails closed when a transfer lands after fresh authority but before each raid INSERT', async () => {
    const attacker = await stablePlayer(8);
    const defender = await stablePlayer(4);
    const defenderBuyer = await stablePlayer(2);
    await rewardBaseShards(db, attacker.baseId, 1_000_000n, 'test.stable-raid', key());
    const defenderDeed = `race-defender-${randomUUID()}`;
    await db.update(bases).set({ deedAssetId: defenderDeed }).where(eq(bases.id, defender.baseId));
    const pvpBarrier = authorityBarrier();
    const pendingPvp = createRaid(db, attacker.wallet, {
      attackerBaseId: attacker.baseId,
      defenderBaseId: defender.baseId,
      defenderWallet: defender.wallet,
      idempotencyKey: key(),
      authorizeAttackerBase: authority,
      authorizeDefenderBase: pvpBarrier.authorize,
    });
    await pvpBarrier.reached;
    await transferStableBase(db, defender.baseId, defender.wallet, defenderBuyer.wallet, defenderDeed);
    pvpBarrier.release();
    await expect(pendingPvp).rejects.toMatchObject({ code: 'DEED_OWNERSHIP_CHANGED' });

    const pveAttacker = await stablePlayer(5);
    const pveBuyer = await stablePlayer(1);
    const pveDeed = `race-pve-${randomUUID()}`;
    await db.update(bases).set({ deedAssetId: pveDeed }).where(eq(bases.id, pveAttacker.baseId));
    const valley = await createTestValley(db, { name: `Stable race ${key()}` });
    const [camp] = await db.insert(pveCamps).values({
      valleyId: valley.id, x: 20, y: 20, tier: 1,
      snapshot: makeCampSnapshot(1), lootKeep: 1n,
    }).returning();
    const pveBarrier = authorityBarrier();
    const pendingPve = createPveRaid(db, pveAttacker.wallet, camp!.id, key(), new Date(), {
      attackerBaseId: pveAttacker.baseId,
      authorizeAttackerBase: pveBarrier.authorize,
    });
    await pveBarrier.reached;
    await transferStableBase(db, pveAttacker.baseId, pveAttacker.wallet, pveBuyer.wallet, pveDeed);
    pveBarrier.release();
    await expect(pendingPve).rejects.toMatchObject({
      code: expect.stringMatching(/^(?:DEED_OWNERSHIP_CHANGED|BASE_NOT_OWNED)$/),
    });

    const campaignAttacker = await stablePlayer(5);
    const campaignBuyer = await stablePlayer(1);
    const campaignDeed = `race-campaign-${randomUUID()}`;
    await db.update(bases).set({ deedAssetId: campaignDeed })
      .where(eq(bases.id, campaignAttacker.baseId));
    const campaignBarrier = authorityBarrier();
    const pendingCampaign = createCampaignRaid(
      db, campaignAttacker.wallet, 1, key(), new Date(), {
        attackerBaseId: campaignAttacker.baseId,
        authorizeAttackerBase: campaignBarrier.authorize,
      },
    );
    await campaignBarrier.reached;
    await transferStableBase(
      db, campaignAttacker.baseId, campaignAttacker.wallet, campaignBuyer.wallet, campaignDeed,
    );
    campaignBarrier.release();
    await expect(pendingCampaign).rejects.toMatchObject({
      code: expect.stringMatching(/^(?:DEED_OWNERSHIP_CHANGED|BASE_NOT_OWNED)$/),
    });
  });

  it('rechecks exact positive deed evidence under the create lock before INSERT', async () => {
    for (const failure of ['owner-changed', 'proof-aged'] as const) {
      const attacker = await stablePlayer(8);
      const defender = await stablePlayer(4);
      const observedBuyer = await stablePlayer(1);
      await rewardBaseShards(db, attacker.baseId, 1_000_000n, 'test.stable-raid', key());
      const deed = `evidence-${failure}-${randomUUID()}`;
      await db.update(bases).set({ deedAssetId: deed }).where(eq(bases.id, defender.baseId));
      const [evidence] = await db.insert(deedOwnershipObservations).values({
        baseId: defender.baseId,
        assetId: deed,
        owner: defender.wallet,
        slot: 500n,
        checkedAt: new Date(),
        source: 'test-stable-raid',
        status: 'owned',
        auditHash: `evidence-${randomUUID()}`,
      }).returning();

      const barrier = authorityBarrier();
      const guarded: RaidBaseAuthority = async (wallet, baseId, lockedDb) => {
        await assertFreshLockedBaseAuthority(lockedDb ?? db, wallet, baseId);
        if (!lockedDb) await barrier.authorize();
      };
      const pending = createRaid(db, attacker.wallet, {
        attackerBaseId: attacker.baseId,
        defenderBaseId: defender.baseId,
        defenderWallet: defender.wallet,
        idempotencyKey: key(),
        authorizeAttackerBase: authority,
        authorizeDefenderBase: guarded,
      });
      await barrier.reached;
      await db.update(deedOwnershipObservations).set(failure === 'owner-changed' ? {
        owner: observedBuyer.wallet,
        status: 'mismatch',
        checkedAt: new Date(),
      } : {
        checkedAt: new Date(Date.now() - BASE_OWNERSHIP.mutationFreshnessMs - 1),
      }).where(eq(deedOwnershipObservations.id, evidence!.id));
      barrier.release();
      await expect(pending).rejects.toMatchObject({ code: 'DEED_AUTHORITY_UNAVAILABLE' });
    }
  });
});
