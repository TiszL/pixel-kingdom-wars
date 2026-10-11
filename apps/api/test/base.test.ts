/**
 * Base-state service tests (PLAN.md 4a/4b): geometry, gates, caps, builder
 * concurrency, lazy completion, sink-split spending, speedups.
 */
import { BUILD_COSTS, buildCountCapForKeep, BuildingType, ECONOMY, HEROES, MINING, OBSTACLES, speedupCostKeep, TRAP_REPAIR, TROOPS, UPGRADE_COSTS, upgradeSolLamports } from '@shardkeep/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { army, bases, buildings, builderJobs, deposits, heroLevels, ledgerEntries, ledgerTransactions, obstacles, playerItems, players, trainingQueue, troopResearch } from '../src/db/schema';
import {
  clearObstacle,
  completeDueJobs,
  ensureStartingBase,
  getBaseState,
  moveBuilding,
  moveWallsBatch,
  MAX_LEVEL,
  placeBuilding,
  placeWallsBatch,
  repairTrap,
  speedupJob,
  upgradeBuilding,
} from '../src/game/base';
import { footprintOf } from '../src/game/footprints';
import { rewardShards, spendShards } from '../src/game/spend';
import * as spending from '../src/game/spend';
import { InsufficientFundsError } from '../src/ledger/ledger';
import { getBaseShardBalance, rewardBaseShards, spendBaseShards } from '../src/game/baseEconomy';
import { ensureWalletBaseIdentity } from '../src/game/baseOwnership';
import { setShieldlessMode } from '../src/game/gameConfig';
import { createDepositIntent, creditDeposit, type VerifiedPayment } from '../src/money/deposits';
import { bootstrapSystemAccounts } from '../src/ledger';
import { getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let key = 0;
const k = (): string => `base-test-${++key}-${Math.random().toString(36).slice(2)}`;

/** Fund a player with test-only KEEP plus production-shaped SHARDS. */
async function fund(wallet: string, amount: bigint): Promise<void> {
  await fundTestKeep(db, wallet, amount, 'test.fund', k());
  await rewardShards(db, wallet, amount, 'test.fund.shards', k());
}

async function freshPlayer(keep = 100_000n) {
  const p = await createTestPlayer(db);
  await ensureStartingBase(db, p.wallet);
  await ensureWalletBaseIdentity(db, p.wallet);
  await fund(p.wallet, keep);
  return p;
}

async function fundStableBase(baseId: string, amount = 100_000n): Promise<void> {
  await rewardBaseShards(db, baseId, amount, 'test.fund.base-shards', k());
}

/** Raise the Keep level so buildings can be upgraded under the STRICT Keep-tallest
 *  law (a non-keep building's level must stay ≤ Keep level). */
const raiseKeep = async (wallet: string, level: number): Promise<void> => {
  await db.update(players).set({ keepLevel: level }).where(eq(players.wallet, wallet));
  await db.update(bases).set({ keepLevel: level }).where(eq(bases.ownerWallet, wallet));
};

beforeAll(async () => {
  await bootstrapSystemAccounts(db);
});
afterAll(async () => {
  await conn.sql.end();
});

describe('starting base', () => {
  it('creates the Keep at the claim center + deterministic obstacles, idempotently', async () => {
    const { wallet } = await freshPlayer();
    await ensureStartingBase(db, wallet); // second call: no duplicates
    const state = await getBaseState(db, wallet);
    const keeps = state.buildings.filter((b) => b.type === 'keep');
    expect(keeps).toHaveLength(1);
    expect(keeps[0]).toMatchObject({ tx: 14, ty: 14, level: 1 });
    expect(state.obstacles.length).toBeGreaterThan(10); // rings outside the claim
    expect(state.claim).toEqual({ min: 8, max: 22 });
    expect(state.freeBuilders).toBe(1);
  });

  it('publishes one authoritative base-wide readiness aggregate with exact queue deadlines', async () => {
    const { wallet } = await freshPlayer();
    await db.insert(buildings).values([
      { playerWallet: wallet, type: BuildingType.Barracks, level: 1, tx: 8, ty: 8 },
      { playerWallet: wallet, type: BuildingType.Camp, level: 1, tx: 18, ty: 8 },
    ]);
    await db.insert(army).values({ playerWallet: wallet, troop: 'giant', count: 2 });
    const now = new Date('2026-09-01T10:00:00.000Z');
    const firstReady = new Date('2026-09-01T10:01:00.000Z');
    const allReady = new Date('2026-09-01T10:03:00.000Z');
    await db.insert(trainingQueue).values([
      { playerWallet: wallet, troop: 'highlander', startedAt: now, finishesAt: firstReady },
      { playerWallet: wallet, troop: 'bowman', startedAt: now, finishesAt: allReady },
    ]);

    const state = await getBaseState(db, wallet, now);
    expect(state.armyStatus).toEqual({
      readyTroopCount: 2,
      readyPts: TROOPS.giant.pts * 2,
      campCapacityPts: 20,
      trainingTroopCount: 2,
      trainingPts: TROOPS.highlander.pts + TROOPS.bowman.pts,
      barracksQueuePts: 10,
      nextReadyAt: firstReady.toISOString(),
      allReadyAt: allReady.toISOString(),
    });
  });

  it('publishes the next scheduled warzone boundary for home shield refreshes', async () => {
    const { wallet } = await freshPlayer();
    await setShieldlessMode(db, 'scheduled');
    try {
      const before = await getBaseState(db, wallet, new Date('2026-08-14T23:00:00.000Z'));
      expect(before.warzone).toEqual({
        active: false,
        boundaryAt: '2026-08-15T00:00:00.000Z',
        remainingMs: 3_600_000,
      });

      const active = await getBaseState(db, wallet, new Date('2026-08-15T00:00:00.000Z'));
      expect(active.warzone).toEqual({
        active: true,
        boundaryAt: '2026-08-17T00:00:00.000Z',
        remainingMs: 48 * 3_600_000,
      });
    } finally {
      await setShieldlessMode(db, 'off');
    }
  });

  it('grants the configured starter SHARDS to new bases and tops up only historical deedless starters once', async () => {
    const posting = async (idempotencyKey: string) => {
      const [transaction] = await db.select().from(ledgerTransactions)
        .where(eq(ledgerTransactions.idempotencyKey, idempotencyKey));
      if (!transaction) throw new Error('missing original starter posting');
      const entries = await db.select().from(ledgerEntries)
        .where(eq(ledgerEntries.txnId, transaction.id)).orderBy(ledgerEntries.id);
      return { transaction, entries };
    };
    const fresh = await createTestPlayer(db);
    await Promise.all([
      ensureStartingBase(db, fresh.wallet),
      ensureStartingBase(db, fresh.wallet),
      ensureStartingBase(db, fresh.wallet),
    ]);
    expect((await db.select().from(buildings).where(and(
      eq(buildings.playerWallet, fresh.wallet), eq(buildings.type, BuildingType.Keep),
    )))).toHaveLength(1);
    expect((await getOrCreatePlayerAccount(db, fresh.wallet, 'player_shards')).balance)
      .toBe(BigInt(ECONOMY.starterShards));
    const freshGrant = await posting(`starter:${fresh.wallet}`);
    expect(freshGrant.entries.map(e => e.delta).sort((a, b) => a < b ? -1 : a > b ? 1 : 0))
      .toEqual([-BigInt(ECONOMY.starterShards), BigInt(ECONOMY.starterShards)]);
    await db.delete(buildings).where(and(
      eq(buildings.playerWallet, fresh.wallet), eq(buildings.type, BuildingType.Keep),
    ));
    await ensureStartingBase(db, fresh.wallet);
    expect((await getOrCreatePlayerAccount(db, fresh.wallet, 'player_shards')).balance)
      .toBe(BigInt(ECONOMY.starterShards)); // wallet-lifetime grant, not per-base
    expect(await posting(`starter:${fresh.wallet}`)).toEqual(freshGrant);

    const legacy = await createTestPlayer(db);
    await db.insert(buildings).values({
      playerWallet: legacy.wallet, type: BuildingType.Keep, level: 1, tx: 14, ty: 14,
    });
    await rewardShards(db, legacy.wallet, BigInt(ECONOMY.starterShardsV1),
      'base.starter_grant', `starter:${legacy.wallet}`);
    const originalGrant = await posting(`starter:${legacy.wallet}`);
    await ensureStartingBase(db, legacy.wallet);
    const correction = await posting(`starter:topup:v2:${legacy.wallet}`);
    expect(correction.transaction.type).toBe('base.starter_topup');
    expect(correction.entries.map(e => e.delta).sort((a, b) => a < b ? -1 : a > b ? 1 : 0))
      .toEqual([-BigInt(ECONOMY.starterShards - ECONOMY.starterShardsV1), BigInt(ECONOMY.starterShards - ECONOMY.starterShardsV1)]);
    await ensureStartingBase(db, legacy.wallet);
    expect((await getOrCreatePlayerAccount(db, legacy.wallet, 'player_shards')).balance)
      .toBe(BigInt(ECONOMY.starterShards));
    // The bootstrap correction is a separate full-value posting; a later read
    // must preserve both original receipt identities, amounts and audit entries.
    expect(await posting(`starter:${legacy.wallet}`)).toEqual(originalGrant);
    expect(await posting(`starter:topup:v2:${legacy.wallet}`)).toEqual(correction);

    const landed = await createTestPlayer(db);
    await db.insert(buildings).values({
      playerWallet: landed.wallet, type: BuildingType.Keep, level: 1, tx: 14, ty: 14,
    });
    await rewardShards(db, landed.wallet, BigInt(ECONOMY.starterShardsV1),
      'base.starter_grant', `starter:${landed.wallet}`);
    await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, landed.wallet));
    await ensureStartingBase(db, landed.wallet);
    expect((await getOrCreatePlayerAccount(db, landed.wallet, 'player_shards')).balance)
      .toBe(BigInt(ECONOMY.starterShardsV1));
    expect(await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `starter:topup:v2:${landed.wallet}`))).toEqual([]);
  });
});

describe('placement', () => {
  it('explains a first-mine SHARDS shortage without leaking ledger identifiers or starting construction', async () => {
    const { wallet } = await freshPlayer();
    const account = await getOrCreatePlayerAccount(db, wallet, 'player_shards');
    await spendShards(db, wallet, account.balance, 'test.empty.shards', k());
    await expect(placeBuilding(db, wallet, BuildingType.Mine, 11, 8, k())).rejects.toMatchObject({
      statusCode: 422, code: 'INSUFFICIENT_SHARDS',
      message: `Not enough SHARDS. This build costs ${MINING.MINE_BUILD_KEEP[0]!.toLocaleString('en-US')} SHARDS.`,
    });
    expect((await getOrCreatePlayerAccount(db, wallet, 'player_shards')).balance).toBe(0n);
    expect((await getBaseState(db, wallet)).buildings.filter(b => b.type === 'mine')).toHaveLength(0);
    expect((await getBaseState(db, wallet)).jobs).toHaveLength(0);
  });

  it('quotes the actual third-mine KEEP shortage and rolls back without taking SHARDS', async () => {
    const { wallet } = await freshPlayer(1n);
    await raiseKeep(wallet, 3);
    await db.insert(buildings).values([
      { playerWallet: wallet, type: BuildingType.Mine, level: 1, tx: 11, ty: 8 },
      { playerWallet: wallet, type: BuildingType.Mine, level: 1, tx: 13, ty: 8 },
    ]);
    const shardsBefore = (await getOrCreatePlayerAccount(db, wallet, 'player_shards')).balance;
    const keepBefore = (await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance;
    await expect(placeBuilding(db, wallet, BuildingType.Mine, 17, 14, k())).rejects.toMatchObject({
      statusCode: 422, code: 'INSUFFICIENT_KEEP',
      message: `Not enough KEEP. This build costs ${MINING.MINE_BUILD_KEEP[2]!.toLocaleString('en-US')} KEEP.`,
    });
    expect((await getOrCreatePlayerAccount(db, wallet, 'player_shards')).balance).toBe(shardsBefore);
    expect((await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance).toBe(keepBefore);
    const state = await getBaseState(db, wallet);
    expect(state.buildings.filter(b => b.type === 'mine')).toHaveLength(2);
    expect(state.jobs).toHaveLength(0);
  });

  it('recognizes a wrapped insufficient-funds cause but preserves unrelated payment failures', async () => {
    const { wallet } = await freshPlayer();
    await db.insert(buildings).values({ playerWallet: wallet, type: BuildingType.Mine, level: 1, tx: 11, ty: 8 });
    const account = await getOrCreatePlayerAccount(db, wallet, 'player_keep');
    // D-152: the mine price goes through the sink shim (spendGameCurrency).
    const spy = vi.spyOn(spending, 'spendGameCurrency');
    try {
      spy.mockRejectedValueOnce(new Error('payment failed', { cause: new InsufficientFundsError(account.id, 0n, -BigInt(MINING.MINE_BUILD_KEEP[1]!)) }));
      await expect(placeBuilding(db, wallet, BuildingType.Mine, 17, 14, k())).rejects.toMatchObject({ code: 'INSUFFICIENT_KEEP' });
      const unrelated = new Error('Rollback');
      spy.mockRejectedValueOnce(unrelated);
      await expect(placeBuilding(db, wallet, BuildingType.Mine, 17, 14, k())).rejects.toBe(unrelated);
      const cycle = new Error('unknown failure'); cycle.cause = cycle;
      spy.mockRejectedValueOnce(cycle);
      await expect(placeBuilding(db, wallet, BuildingType.Mine, 17, 14, k())).rejects.toBe(cycle);
      expect((await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance).toBe(account.balance);
      expect((await getBaseState(db, wallet)).buildings.filter(b => b.type === 'mine')).toHaveLength(1);
      expect((await getBaseState(db, wallet)).jobs).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });

  it('places a mine, charges the sink split, and occupies a builder', async () => {
    const { wallet } = await freshPlayer();
    const b = await placeBuilding(db, wallet, BuildingType.Mine, 11, 8, k());
    expect(b.type).toBe('mine');
    const state = await getBaseState(db, wallet);
    expect(state.freeBuilders).toBe(0);
    expect(state.jobs).toHaveLength(1);
    // second placement must fail: builder busy
    await expect(placeBuilding(db, wallet, BuildingType.Vault, 13, 8, k()))
      .rejects.toThrow(/builders are busy/);
  });

  it('concurrent first-mine builds cannot mint a 2nd mine at the 1st-mine price', async () => {
    // FINDING (security review 2026-07-19): placeBuilding read the mine count on an
    // unlocked snapshot, so racing first-mine requests all saw count=0, all took the
    // 1st-mine 400 price, and all inserted — a 2nd+ mine at the wrong (cheapest)
    // price, past the cap. The player-row FOR UPDATE lock must serialize them:
    // exactly one mine, one charge. D-057 note: the losers now fail on the busy
    // builder / progressive-KEEP charge rather than the retired SOL gate, but the
    // pinned property is unchanged — never two mines for one 1st-mine price.
    const { wallet } = await freshPlayer(100_000n);
    const before = await getKeepBalance(wallet);
    const attempts = await Promise.allSettled([
      placeBuilding(db, wallet, BuildingType.Mine, 11, 8, k()),
      placeBuilding(db, wallet, BuildingType.Mine, 13, 8, k()),
      placeBuilding(db, wallet, BuildingType.Mine, 11, 10, k()),
    ]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1); // one placed
    const mines = (await getBaseState(db, wallet)).buildings.filter((b) => b.type === 'mine');
    expect(mines).toHaveLength(1); // never 2 or 3
    // Charged EXACTLY the 1st-mine price once — no extra free/under-priced mines.
    expect(before - await getKeepBalance(wallet)).toBe(BigInt(MINING.MINE_BUILD_KEEP[0]!));
  });

  it('D-057: the 2nd mine builds through the free route, charging the progressive KEEP and no SOL', async () => {
    // Owner 2026-08-16 (verbatim): "we should not gate miners with sol at
    // start" — additional mines left the 'mine_build' SOL deposit flow and now
    // place directly, charging MINE_BUILD_KEEP[n] in KEEP (recycled to
    // emission_pool, the identical posting the paid flow used) and nothing else.
    const { wallet } = await freshPlayer(100_000n);
    await placeBuilding(db, wallet, BuildingType.Mine, 11, 8, k());
    await completeDueJobs(db, wallet, new Date(Date.now() + 120_000)); // free the builder
    const shardsBefore = (await getOrCreatePlayerAccount(db, wallet, 'player_shards')).balance;
    const keepBefore = (await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance;
    const second = await placeBuilding(db, wallet, BuildingType.Mine, 17, 14, k());
    expect(second.type).toBe('mine');
    expect(keepBefore - (await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance)
      .toBe(BigInt(MINING.MINE_BUILD_KEEP[1]!)); // progressive 2nd-mine KEEP
    expect((await getOrCreatePlayerAccount(db, wallet, 'player_shards')).balance)
      .toBe(shardsBefore); // and NOT the flat shard build price
    expect(MINING.MINE_BUILD_SOL_LAMPORTS.every((p) => p === 0)).toBe(true); // no SOL on any mine build
  });

  it('rejects out-of-claim, overlap, and obstacle collisions', async () => {
    const { wallet } = await freshPlayer();
    await expect(placeBuilding(db, wallet, BuildingType.Vault, 0, 0, k()))
      .rejects.toThrow(/outside the buildable claim/);
    await expect(placeBuilding(db, wallet, BuildingType.Vault, 14, 14, k()))
      .rejects.toThrow(/overlaps another building/);
    const state = await getBaseState(db, wallet);
    const inClaimObstacle = state.obstacles.find((o) => o.tx >= 9 && o.tx < 21 && o.ty >= 9 && o.ty < 21)
      ?? state.obstacles.find((o) => o.tx >= 8 && o.tx < 22 && o.ty >= 8 && o.ty < 22);
    if (inClaimObstacle) {
      await expect(placeBuilding(db, wallet, BuildingType.Vault, inClaimObstacle.tx, inClaimObstacle.ty, k()))
        .rejects.toThrow(/blocked by an obstacle/);
    }
  });

  it('enforces the Mortar Keep-L3 gate', async () => {
    const { wallet } = await freshPlayer();
    await expect(placeBuilding(db, wallet, BuildingType.Mortar, 11, 11, k()))
      .rejects.toThrow(/requires Keep level 3/);
  });

  it('Pixel Kingdom Wars epic defenses are LIVE, gated by their staggered Keep level', async () => {
    // WHY: the new roster is enabled for the balance playtest (NEW_ROSTER_ENABLED).
    // The dark gate is gone; the live gate is the staggered epic unlock — the Dragon
    // Nest needs Keep L14 (electric 8 / mage 10 / laser 12 / nest 14, master plan §3G).
    const { wallet } = await freshPlayer();
    await expect(placeBuilding(db, wallet, BuildingType.DragonNest, 11, 8, k()))
      .rejects.toThrow(/requires Keep level 14/);
  });

  it('enforces one aggregate trap-family cap (2 at Keep L1)', async () => {
    const { wallet } = await freshPlayer();
    // traps build in 60s but the builder frees only on completion; complete each via time travel
    const firstTrap = await placeBuilding(db, wallet, BuildingType.SpikeTrap, 11, 8, k());
    await completeDueJobs(db, wallet, new Date(Date.now() + 120_000));
    await placeBuilding(db, wallet, BuildingType.SpikeTrap, 12, 8, k());
    await completeDueJobs(db, wallet, new Date(Date.now() + 240_000));
    await expect(placeBuilding(db, wallet, BuildingType.SpikeTrap, 13, 8, k()))
      .rejects.toThrow(/trap cap/);

    // WHY: caps are for the tactical trap budget, not per art family. A player
    // cannot bypass the L1 limit by mixing spike + another trap enum.
    await db.update(buildings).set({ type: BuildingType.PowderMine })
      .where(eq(buildings.id, firstTrap.id));
    await expect(placeBuilding(db, wallet, BuildingType.SpikeTrap, 13, 8, k()))
      .rejects.toThrow(/trap cap/);
  });

  it('derives every M22 footprint from shared definitions', () => {
    expect(footprintOf(BuildingType.AirDefence)).toEqual({ fw: 2, fh: 2 });
    expect(footprintOf(BuildingType.PowderMine)).toEqual({ fw: 1, fh: 1 });
    expect(footprintOf(BuildingType.Pitfall)).toEqual({ fw: 1, fh: 1 });
    expect(footprintOf(BuildingType.AirMine)).toEqual({ fw: 1, fh: 1 });
    expect(footprintOf(BuildingType.ClanHall)).toEqual({ fw: 2, fh: 2 });
    expect(footprintOf(BuildingType.Mine)).toEqual({ fw: 1, fh: 1 });
  });

  it('constructs every M22 building family and upgrades a tiered trap', async () => {
    // WHY: accepting the enum at the wire is insufficient; all new types must
    // reach the authoritative cost/gate/job path, including trap leveling.
    const { wallet } = await freshPlayer();
    await raiseKeep(wallet, 8);
    await db.update(obstacles).set({ clearedAt: new Date() })
      .where(eq(obstacles.playerWallet, wallet));
    const placements = [
      [BuildingType.AirDefence, 11, 8],
      [BuildingType.ClanHall, 17, 8],
      [BuildingType.PowderMine, 13, 8],
      [BuildingType.Pitfall, 14, 8],
      [BuildingType.AirMine, 15, 8],
    ] as const;
    const placed = [];
    for (const [type, tx, ty] of placements) {
      placed.push(await placeBuilding(db, wallet, type, tx, ty, k()));
      await completeDueJobs(db, wallet, new Date(Date.now() + 8 * 3_600_000));
    }
    expect(placed.map((building) => building.type)).toEqual(placements.map(([type]) => type));
    const powder = placed.find((building) => building.type === BuildingType.PowderMine)!;
    const upgraded = await upgradeBuilding(db, wallet, powder.id, k());
    expect(upgraded.job).toMatchObject({ kind: 'upgrade', buildingId: powder.id, refundShards: expect.stringMatching(/^\d+$/) });
    // WHY: the route hands this object to Fastify's JSON serialiser. The D-104
    // receipt is a bigint on the row; the first live upgrade after it landed
    // committed the job and then answered 500 ("Do not know how to serialize
    // a BigInt"). The response must carry the receipt as a decimal string.
    expect(() => JSON.stringify(upgraded)).not.toThrow();
    expect('paidShardCost' in (upgraded.job as object)).toBe(false);
  });

  it('walls PLACE and UPGRADE instantly (no builder/job — cost is the only gate)', async () => {
    // WHY: owner 2026-07-20 — walls have NO build OR upgrade timer/builder; the high
    // SHARD cost is the only balance lever, so a wall levels up immediately without
    // ever occupying a builder (you can wall + reinforce fast, but it costs a lot).
    const { wallet } = await freshPlayer();
    await raiseKeep(wallet, 3); // so tier 1→2 clears the strict Keep-tallest law
    const w = await placeBuilding(db, wallet, BuildingType.Wall, 11, 11, k());
    const s1 = await getBaseState(db, wallet);
    expect(s1.jobs).toHaveLength(0); // no build job — placed live
    expect(s1.buildings.find((x) => x.id === w.id)?.underConstruction).toBe(false);
    expect(s1.freeBuilders).toBe(1);
    const wallKey = k();
    const { job } = await upgradeBuilding(db, wallet, w.id, wallKey);
    expect(job).toBeNull(); // upgrade is INSTANT — no timed builder job
    const retry = await upgradeBuilding(db, wallet, w.id, wallKey);
    expect(retry).toMatchObject({ duplicate: true, building: { level: 2 }, job: null });
    const s2 = await getBaseState(db, wallet);
    expect(s2.jobs).toHaveLength(0); // still no jobs
    expect(s2.buildings.find((x) => x.id === w.id)?.level).toBe(2); // bumped immediately
    expect(s2.freeBuilders).toBe(1); // builder stays free
  });

  it('places a whole run of walls in ONE batch (swipe), one charge, no jobs (#59)', async () => {
    const { wallet } = await freshPlayer();
    const before = await getKeepBalance(wallet);
    const tiles = [10, 11, 12, 13, 14].map((tx) => ({ tx, ty: 10 }));
    const res = await placeWallsBatch(db, wallet, tiles, k());
    expect(res.buildings).toHaveLength(5);
    const s = await getBaseState(db, wallet);
    expect(s.buildings.filter((b) => b.type === 'wall')).toHaveLength(5);
    expect(s.jobs).toHaveLength(0); // instant — no builder jobs
    // Exactly count × wall cost, in ONE charge.
    expect(before - (await getKeepBalance(wallet))).toBe(BigInt(BUILD_COSTS.wall.costShards) * 5n);
  });

  it('moves a whole LINE of walls together in one batch (#61)', async () => {
    const { wallet } = await freshPlayer();
    const res = await placeWallsBatch(db, wallet, [10, 11, 12].map((tx) => ({ tx, ty: 10 })), k());
    // Shift the whole row down by 1 tile (each wall onto the row below).
    const moves = res.buildings.map((b) => ({ id: b.id, tx: b.tx, ty: b.ty + 1 }));
    const mv = await moveWallsBatch(db, wallet, moves);
    expect(mv.moved).toBe(3);
    const walls = (await getBaseState(db, wallet)).buildings.filter((b) => b.type === 'wall');
    expect(walls.every((w) => w.ty === 11)).toBe(true); // whole line moved down
    expect(new Set(walls.map((w) => w.tx))).toEqual(new Set([10, 11, 12]));
  });

  it('per-building count caps scale with Keep level, walls to 250', () => {
    expect(buildCountCapForKeep('cannon', 1)).toBe(1);   // 1 cannon at Keep L1
    expect(buildCountCapForKeep('cannon', 20)).toBe(10); // 10 at max
    expect(buildCountCapForKeep('wall', 1)).toBe(40);
    expect(buildCountCapForKeep('wall', 20)).toBe(250);
    expect(buildCountCapForKeep('mine', 5)).toBeUndefined(); // mine uses its own Keep cap
  });

  it('charges exactly the build cost via the 60/25/15 sink split', async () => {
    const { wallet } = await freshPlayer(10_000n);
    const before = await getKeepBalance(wallet);
    await placeBuilding(db, wallet, BuildingType.Vault, 13, 12, k());
    const after = await getKeepBalance(wallet);
    expect(before - after).toBe(BigInt(BUILD_COSTS.vault.costShards));
  });
});

describe('move / upgrade / jobs', () => {
  it('move is free and validates geometry', async () => {
    const { wallet } = await freshPlayer();
    const b = await placeBuilding(db, wallet, BuildingType.Mine, 11, 8, k());
    const moved = await moveBuilding(db, wallet, b.id, 11, 10);
    expect(moved).toMatchObject({ tx: 11, ty: 10 });
    await expect(moveBuilding(db, wallet, b.id, 14, 14)).rejects.toThrow(/overlaps/);
  });

  it('upgrade spends, runs a timed job, and lazily completes', async () => {
    const { wallet } = await freshPlayer();
    await raiseKeep(wallet, 5); // strict Keep-tallest: a building can't out-level the Keep
    // A KEEP-upgraded building (Vault). Mines upgrade via the SOL deposit flow.
    const b = await placeBuilding(db, wallet, BuildingType.Vault, 11, 8, k());
    await completeDueJobs(db, wallet, new Date(Date.now() + 120_000)); // finish the build
    const { job } = await upgradeBuilding(db, wallet, b.id, k());
    expect(job).not.toBeNull();
    // not done yet
    let state = await getBaseState(db, wallet);
    expect(state.buildings.find((x) => x.id === b.id)?.level).toBe(1);
    // time-travel past the 2h vault upgrade
    await completeDueJobs(db, wallet, new Date(Date.now() + 3 * 3600 * 1000));
    state = await getBaseState(db, wallet);
    expect(state.buildings.find((x) => x.id === b.id)?.level).toBe(2);
  });

  it('repairs one exact spent-trap episode once and rearms only when its timer completes', async () => {
    // WHY: a retry must not double-charge, an old retry key must not repair a
    // later raid's activation, and paying must not make the trap instantly live.
    const { wallet } = await freshPlayer();
    await raiseKeep(wallet, 16);
    const trap = await placeBuilding(db, wallet, BuildingType.SpikeTrap, 11, 8, k());
    await completeDueJobs(db, wallet, new Date(Date.now() + 120_000));
    const spentAt = new Date('2026-08-15T10:00:00.000Z');
    await db.update(buildings).set({ level: 16, trapSpentAt: spentAt })
      .where(eq(buildings.id, trap.id));

    const before = await getKeepBalance(wallet);
    const repairKey = k();
    const startedAt = new Date('2026-08-15T11:00:00.000Z');
    const first = await repairTrap(db, wallet, trap.id, repairKey, startedAt);
    if (!first.job) throw new Error('new repair did not create a builder job');
    expect(first).toMatchObject({
      costShards: TRAP_REPAIR.spiketrap.costShardsByTier[3], duplicate: false,
    });
    expect(first.job.finishesAt).toEqual(new Date(
      startedAt.getTime() + TRAP_REPAIR.spiketrap.repairSec * 1_000,
    ));
    expect((await db.select().from(buildings).where(eq(buildings.id, trap.id)))[0]!.trapSpentAt)
      .toEqual(spentAt);

    const retry = await repairTrap(db, wallet, trap.id, repairKey, startedAt);
    expect(retry).toMatchObject({ duplicate: true, job: { id: first.job.id } });
    expect(before - await getKeepBalance(wallet))
      .toBe(BigInt(TRAP_REPAIR.spiketrap.costShardsByTier[3]));

    await completeDueJobs(db, wallet, first.job.finishesAt);
    expect((await db.select().from(buildings).where(eq(buildings.id, trap.id)))[0]!.trapSpentAt)
      .toBeNull();

    await db.update(buildings).set({ trapSpentAt: new Date('2026-08-15T12:00:00.000Z') })
      .where(eq(buildings.id, trap.id));
    await expect(repairTrap(db, wallet, trap.id, repairKey, new Date('2026-08-15T12:01:00.000Z')))
      .rejects.toThrow(/earlier trap activation/);
  });

  it('MAX_LEVEL covers every type with an upgrade table — a missing key silently caps it at L1', () => {
    // WHY: `MAX_LEVEL[type] ?? 1` FAILS OPEN to 1, so omitting a type raises no
    // error — it silently answers "already at max level" forever. That is exactly
    // how the Gold Forge shipped: 19 upgrade steps priced in UPGRADE_COSTS and
    // unreachable, pinning the shards→KEEP faucet at its L1 cap (owner report
    // 2026-07-26). Pinning the CONTRACT, not just goldforge, so the next type
    // added to the building_type enum cannot repeat it.
    for (const type of Object.keys(UPGRADE_COSTS)) {
      const max = MAX_LEVEL[type];
      expect(max, `'${type}' has an UPGRADE_COSTS table but no MAX_LEVEL entry`).toBeDefined();
      expect(max, `'${type}' MAX_LEVEL must exceed 1 or its cost table is dead`).toBeGreaterThan(1);
    }
  });

  it('a level-1 Gold Forge really upgrades (the reported symptom)', async () => {
    // REWRITTEN for D-057 (owner 2026-08-16: "we should gate gold forge from
    // level 2 … start with 0.2 sol + shards"): L1→2 now travels the PAID rail,
    // so the symptom pin — a forge must really be able to leave L1, the
    // MAX_LEVEL fail-open regression of 2026-07-26 — is proven through
    // applyPaidUpgrade instead of the (now refusing) free route.
    const { wallet } = await freshPlayer();
    // The Gold Forge needs LAND since free onboarding (2026-08-09): it is the only
    // shards→KEEP faucet, KEEP is the only withdrawable currency, and it is placed
    // through the now-FREE build route — so the gate lives on the building, not the
    // /forge/* routes. See test/land-gate.test.ts for the gate's own tests.
    await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, wallet));
    await raiseKeep(wallet, 5);
    const b = await placeBuilding(db, wallet, BuildingType.GoldForge, 11, 8, k());
    await completeDueJobs(db, wallet, new Date(Date.now() + 7 * 24 * 3600 * 1000));
    await expect(upgradeBuilding(db, wallet, b.id, k())).rejects.toThrow(/require SOL/); // D-057 gate
    const { applyPaidUpgrade } = await import('../src/game/base');
    await db.transaction((tx) => applyPaidUpgrade(tx, wallet, b.id, k(), new Date()));
    await completeDueJobs(db, wallet, new Date(Date.now() + 14 * 24 * 3600 * 1000));
    const state = await getBaseState(db, wallet);
    expect(state.buildings.find((x) => x.id === b.id)?.level).toBe(2);
  });

  it('strict Keep-tallest law: a building cannot out-level the Keep — raise the Keep first', async () => {
    // WHY: master plan §3G tightened the law to building level ≤ Keep level. A fresh
    // Keep-L1 base must upgrade its Keep before it can level a building past L1.
    const { wallet } = await freshPlayer();
    const b = await placeBuilding(db, wallet, BuildingType.Vault, 11, 8, k());
    await completeDueJobs(db, wallet, new Date(Date.now() + 120_000));
    await expect(upgradeBuilding(db, wallet, b.id, k())).rejects.toThrow(/gated by Keep level/); // Keep is L1
    await raiseKeep(wallet, 2);
    const { job } = await upgradeBuilding(db, wallet, b.id, k()); // now L1→L2 is allowed
    expect(job).not.toBeNull();
  });

  it('speedup charges the SUPER-LINEAR cost and completes immediately', async () => {
    const { wallet } = await freshPlayer();
    const b = await placeBuilding(db, wallet, BuildingType.Cannon, 11, 8, k());
    // Initial construction is now free; upgrades remain the premium KEEP sink.
    await speedupJob(db, wallet, (await getBaseState(db, wallet)).jobs[0]!.id, k());
    await raiseKeep(wallet, 2);
    await upgradeBuilding(db, wallet, b.id, k());
    const before = (await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance;
    const job = (await getBaseState(db, wallet)).jobs[0]!;
    // Pin the request clock and derive the paid upgrade quote from constants.
    const now = new Date();
    const remSec = Math.max(0, Math.ceil((new Date(job.finishesAt).getTime() - now.getTime()) / 1000));
    await speedupJob(db, wallet, job.id, k(), now);
    const after = (await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance;
    expect(before - after).toBe(BigInt(speedupCostKeep(remSec)));
    const state = await getBaseState(db, wallet);
    expect(state.jobs).toHaveLength(0);
    expect(state.buildings.find((x) => x.id === b.id)?.underConstruction).toBe(false);
  });

  it('speedup refuses a paid upgrade that already finished, without charging', async () => {
    // NOTE (E3): this pins the CHARGE-FREE refusal, not the transaction. The
    // crash-between-charge-and-update window that E3 closes needs fault injection
    // mid-transaction to observe, so the `db.transaction` wrapper in speedupJob is
    // a structural fix that no single-threaded test here can falsify. Don't read
    // this passing as evidence the atomicity holds.
    const { wallet } = await freshPlayer();
    const building = await placeBuilding(db, wallet, BuildingType.Cannon, 11, 8, k());
    await completeDueJobs(db, wallet, new Date(Date.now() + 120_000));
    await raiseKeep(wallet, 2);
    await upgradeBuilding(db, wallet, building.id, k());
    const job = (await getBaseState(db, wallet)).jobs[0]!;
    await completeDueJobs(db, wallet, new Date(new Date(job.finishesAt).getTime() + 1_000));
    const before = (await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance;

    await expect(speedupJob(db, wallet, job.id, k())).rejects.toThrow(/already done/);
    expect((await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance).toBe(before);
  });

  it('duplicate idempotency key cannot double-spend', async () => {
    const { wallet } = await freshPlayer();
    await raiseKeep(wallet, 2);
    const sharedKey = k();
    const b = await placeBuilding(db, wallet, BuildingType.Vault, 11, 8, k());
    await completeDueJobs(db, wallet, new Date(Date.now() + 120_000));
    const before = await getKeepBalance(wallet);
    const first = await upgradeBuilding(db, wallet, b.id, sharedKey);
    const retry = await upgradeBuilding(db, wallet, b.id, sharedKey);
    expect(retry).toMatchObject({ duplicate: true, job: { id: first.job!.id } });
    const after = await getKeepBalance(wallet);
    expect(before - after).toBe(49n); // exactly one vault L2 cost (post-revamp)
  });

  it('D-057 mine money path: L1→2 is shard-only, L4→5 needs the 0.5 SOL deposit, underpay rejected', async () => {
    // REWRITTEN for D-057 (owner 2026-08-16, verbatim: "we should not gate
    // miners with sol at start, mines should be paid to upgrade from level 5,
    // 6,7,8 levels start with 0.5 sol pricing"). The pre-D-057 pin — every
    // mine upgrade refused the direct route — encoded the OLD monetization;
    // the business rule is now that the START is free and the SOL wall begins
    // at target level 5, so this test proves both halves of that boundary.
    const { wallet } = await freshPlayer();
    await raiseKeep(wallet, 5);
    const paidAt = new Date();
    await db.update(players).set({ entryPaidAt: paidAt }).where(eq(players.wallet, wallet));
    await db.update(bases).set({ landPaidAt: paidAt }).where(eq(bases.ownerWallet, wallet));
    const [base] = await db.select({ id: bases.id }).from(bases).where(eq(bases.ownerWallet, wallet));
    await fundStableBase(base!.id);
    const b = await placeBuilding(db, wallet, BuildingType.Mine, 11, 8, k(), new Date(), base!.id);
    await completeDueJobs(db, wallet, new Date(Date.now() + 120_000)); // finish the build

    // No payable intent may even be minted for a free step (L1→2 charges 0 SOL).
    await expect(createDepositIntent(db, wallet, 'mine', { buildingId: b.id }))
      .rejects.toThrow(/costs no SOL/);

    // Ungated start: the plain shard route upgrades L1→2 with no SOL anywhere.
    const shardsAtStart = await getBaseShardBalance(db, base!.id);
    await upgradeBuilding(db, wallet, b.id, k(), new Date(), {}, base!.id);
    expect(shardsAtStart - await getBaseShardBalance(db, base!.id))
      .toBe(BigInt(UPGRADE_COSTS.mine[0]!));
    await completeDueJobs(db, wallet, new Date(Date.now() + 4 * 3600 * 1000)); // L2 lands
    await db.update(buildings).set({ level: 4 }).where(eq(buildings.id, b.id)); // fast-forward to the wall

    // The SOL wall: the direct route refuses L4→5.
    await expect(upgradeBuilding(db, wallet, b.id, k())).rejects.toThrow(/require SOL/);

    // Intent preflight quotes the owner-set 0.5 SOL entry price for target L5.
    const { assertPaidUpgradeable } = await import('../src/game/base');
    const { solLamports } = await assertPaidUpgradeable(db, wallet, b.id, new Date(), base!.id);
    expect(solLamports).toBe(upgradeSolLamports('mine', 5));
    expect(solLamports).toBe(500_000_000); // owner verbatim: "start with 0.5 sol pricing"

    const pay = (lamports: bigint): VerifiedPayment => ({
      txSignature: `sig-${k()}`, wallet, kind: 'mine', lamports, finalized: true,
    });
    // Underpaying the on-chain amount grants nothing (rolls back).
    const under = await createDepositIntent(db, wallet, 'mine', { buildingId: b.id });
    await expect(creditDeposit(db, under.id, pay(BigInt(solLamports) - 1n)))
      .rejects.toThrow(/frozen quote/);

    // Correct payment → SHARDS burned + the upgrade job starts; a
    // re-credit of the same deposit row is idempotent.
    const shardsBefore = await getBaseShardBalance(db, base!.id);
    const legacyWalletBefore = await getKeepBalance(wallet);
    const intent = await createDepositIntent(db, wallet, 'mine', { buildingId: b.id });
    const full = pay(BigInt(solLamports));
    expect((await creditDeposit(db, intent.id, full)).credited).toBe(true);
    expect((await creditDeposit(db, intent.id, full)).credited).toBe(false);
    expect(shardsBefore - await getBaseShardBalance(db, base!.id))
      .toBe(BigInt(UPGRADE_COSTS.mine[3]!)); // the L4→5 shard step
    expect(await getKeepBalance(wallet)).toBe(legacyWalletBefore);

    // Job running now; the level bumps only when it completes.
    let state = await getBaseState(db, wallet);
    expect(state.jobs.some((j) => j.buildingId === b.id)).toBe(true);
    expect(state.buildings.find((x) => x.id === b.id)?.level).toBe(4);
    await completeDueJobs(db, wallet, new Date(Date.now() + 10 * 24 * 3600 * 1000));
    state = await getBaseState(db, wallet);
    expect(state.buildings.find((x) => x.id === b.id)?.level).toBe(5);
  });

  it('D-057 gold forge: builds for shards only, L1→2 needs the 0.1 SOL deposit, mismatched amount rejected', async () => {
    // Owner 2026-08-16 addendum (verbatim): "gold forge lv1>2 should cost 0.1
    // sol next more 0.15 sol next more 0.2 sol and increase every level price
    // for 0.05." — supersedes the same-day 0.2 entry price this test first
    // pinned. The forge rides the same 'mine'-kind deposit rail (SOL 100% to
    // liquidity).
    const { wallet } = await freshPlayer();
    await raiseKeep(wallet, 3); // goldforge build gate is Keep L3
    const paidAt = new Date();
    await db.update(players).set({ entryPaidAt: paidAt }).where(eq(players.wallet, wallet));
    await db.update(bases).set({ landPaidAt: paidAt }).where(eq(bases.ownerWallet, wallet));
    const [base] = await db.select({ id: bases.id }).from(bases).where(eq(bases.ownerWallet, wallet));
    await fundStableBase(base!.id);

    // Level 1 is built for shards alone — no SOL anywhere near the build.
    const shardsAtBuild = await getBaseShardBalance(db, base!.id);
    const forge = await placeBuilding(db, wallet, BuildingType.GoldForge, 11, 8, k(), new Date(), base!.id);
    expect(shardsAtBuild - await getBaseShardBalance(db, base!.id))
      .toBe(BigInt(BUILD_COSTS.goldforge.costShards));
    await completeDueJobs(db, wallet, new Date(Date.now() + 120_000));

    // The direct shard route refuses L1→2 — the gate starts at level 2.
    await expect(upgradeBuilding(db, wallet, forge.id, k())).rejects.toThrow(/require SOL/);
    const { assertPaidUpgradeable } = await import('../src/game/base');
    const { solLamports } = await assertPaidUpgradeable(db, wallet, forge.id, new Date(), base!.id);
    expect(solLamports).toBe(upgradeSolLamports('goldforge', 2));
    expect(solLamports).toBe(100_000_000); // owner verbatim: "gold forge lv1>2 should cost 0.1 sol"

    const pay = (lamports: bigint): VerifiedPayment => ({
      txSignature: `sig-${k()}`, wallet, kind: 'mine', lamports, finalized: true,
    });
    const intent = await createDepositIntent(db, wallet, 'mine', { baseId: base!.id, buildingId: forge.id });
    // A payment whose amount mismatches the table/quote grants NOTHING — the
    // server is the price authority even when the player overpays.
    await expect(creditDeposit(db, intent.id, pay(BigInt(solLamports) + 1n)))
      .rejects.toThrow(/frozen quote/);
    // Exact 0.2 SOL → the shard step burns + the upgrade job starts.
    const shardsBefore = await getBaseShardBalance(db, base!.id);
    expect((await creditDeposit(db, intent.id, pay(BigInt(solLamports)))).credited).toBe(true);
    expect(shardsBefore - await getBaseShardBalance(db, base!.id))
      .toBe(BigInt(UPGRADE_COSTS.goldforge[0]!));
    let state = await getBaseState(db, wallet);
    expect(state.jobs.some((j) => j.buildingId === forge.id)).toBe(true);
    await completeDueJobs(db, wallet, new Date(Date.now() + 3 * 3600 * 1000));
    state = await getBaseState(db, wallet);
    expect(state.buildings.find((x) => x.id === forge.id)?.level).toBe(2);
  });

  it('honours an in-flight forge intent frozen at the superseded HIGHER price (no strand)', async () => {
    // D-057 retuning rule, exercised by the 2026-08-16 owner addendum that
    // HALVED the forge curve (0.2 → 0.1 SOL at L2): a player who signed the
    // old 0.2 SOL quote before the retune deployed must still get the upgrade.
    // The credit rule is "payment equals its frozen quote AND the quote covers
    // the CURRENT table price; greater is honoured" — so the old, higher quote
    // credits instead of stranding paid SOL.
    const { wallet } = await freshPlayer();
    await raiseKeep(wallet, 3);
    const paidAt = new Date();
    await db.update(players).set({ entryPaidAt: paidAt }).where(eq(players.wallet, wallet));
    await db.update(bases).set({ landPaidAt: paidAt }).where(eq(bases.ownerWallet, wallet));
    const [base] = await db.select({ id: bases.id }).from(bases).where(eq(bases.ownerWallet, wallet));
    await fundStableBase(base!.id);
    const forge = await placeBuilding(db, wallet, BuildingType.GoldForge, 11, 8, k(), new Date(), base!.id);
    await completeDueJobs(db, wallet, new Date(Date.now() + 120_000));

    const oldQuoteLamports = 200_000_000; // the pre-addendum published L1→2 price
    expect(oldQuoteLamports).toBeGreaterThan(upgradeSolLamports('goldforge', 2));
    const intent = await createDepositIntent(db, wallet, 'mine', { baseId: base!.id, buildingId: forge.id });
    // Rewind the frozen quote to the price the old server published, exactly
    // as a row created before the retune deploy would carry it.
    const [row] = await db.select({ payload: deposits.payload }).from(deposits)
      .where(eq(deposits.id, intent.id));
    await db.update(deposits)
      .set({ payload: { ...(row!.payload as Record<string, unknown>), amountLamports: oldQuoteLamports } })
      .where(eq(deposits.id, intent.id));

    const payment: VerifiedPayment = {
      txSignature: `sig-${k()}`, wallet, kind: 'mine',
      lamports: BigInt(oldQuoteLamports), finalized: true,
    };
    expect((await creditDeposit(db, intent.id, payment)).credited).toBe(true);
    const state = await getBaseState(db, wallet);
    expect(state.jobs.some((j) => j.buildingId === forge.id)).toBe(true);
  });

  it('keeps deedless Mine upgrades on the legacy wallet SHARDS ledger', async () => {
    // D-057 rewrite: the paid rail now starts at target L5 (L1→4 is
    // shard-only), so the legacy-ledger property is proven on the L4→5 step.
    const { wallet } = await createTestPlayer(db);
    await ensureStartingBase(db, wallet);
    await fund(wallet, 100_000n);
    await db.update(players).set({ keepLevel: 5 }).where(eq(players.wallet, wallet));
    const mine = await placeBuilding(db, wallet, BuildingType.Mine, 11, 8, k());
    await completeDueJobs(db, wallet, new Date(Date.now() + 120_000));
    await db.update(buildings).set({ level: 4 }).where(eq(buildings.id, mine.id));

    const { applyPaidUpgrade, assertPaidUpgradeable } = await import('../src/game/base');
    await expect(assertPaidUpgradeable(db, wallet, mine.id)).resolves.toMatchObject({
      solLamports: upgradeSolLamports('mine', 5),
    });
    const before = await getKeepBalance(wallet);
    await db.transaction((tx) => applyPaidUpgrade(tx, wallet, mine.id, k(), new Date()));
    expect(before - await getKeepBalance(wallet)).toBe(BigInt(UPGRADE_COSTS.mine[3]!));
  });

  it('concurrent mixed-case UUID mine quotes expose one canonical payable reference', async () => {
    const { wallet } = await freshPlayer();
    await raiseKeep(wallet, 5);
    const paidAt = new Date();
    await db.update(players).set({ entryPaidAt: paidAt }).where(eq(players.wallet, wallet));
    await db.update(bases).set({ landPaidAt: paidAt }).where(eq(bases.ownerWallet, wallet));
    const [base] = await db.select({ id: bases.id }).from(bases).where(eq(bases.ownerWallet, wallet));
    await fundStableBase(base!.id);
    const b = await placeBuilding(db, wallet, BuildingType.Mine, 11, 8, k(), new Date(), base!.id);
    await completeDueJobs(db, wallet, new Date(Date.now() + 120_000));
    await db.update(buildings).set({ level: 4 }).where(eq(buildings.id, b.id)); // D-057: paid rail starts at target L5
    const intents = await Promise.all(Array.from({ length: 30 }, (_, index) =>
      createDepositIntent(db, wallet, 'mine', {
        baseId: base!.id,
        buildingId: index % 2 === 0 ? b.id : b.id.toUpperCase(),
      })));
    expect(new Set(intents.map((intent) => intent.id))).toEqual(new Set([intents[0]!.id]));
    expect(new Set(intents.map((intent) => intent.reference))).toEqual(new Set([intents[0]!.reference]));
    const rows = await db.select().from(deposits).where(and(
      eq(deposits.playerWallet, wallet), eq(deposits.kind, 'mine'), eq(deposits.status, 'pending'),
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ buildingId: b.id });
  });

  it('reuses a fresh same-wallet legacy mine reference and rejects new legacy inserts', async () => {
    const { wallet } = await freshPlayer();
    await raiseKeep(wallet, 5);
    const paidAt = new Date();
    await db.update(players).set({ entryPaidAt: paidAt }).where(eq(players.wallet, wallet));
    await db.update(bases).set({ landPaidAt: paidAt }).where(eq(bases.ownerWallet, wallet));
    const [base] = await db.select({ id: bases.id }).from(bases).where(eq(bases.ownerWallet, wallet));
    await fundStableBase(base!.id);
    const b = await placeBuilding(db, wallet, BuildingType.Mine, 11, 8, k(), new Date(), base!.id);
    await completeDueJobs(db, wallet, new Date(Date.now() + 120_000));
    await db.update(buildings).set({ level: 4 }).where(eq(buildings.id, b.id)); // D-057: paid rail starts at target L5
    const legacy = await createDepositIntent(db, wallet, 'mine', {
      baseId: base!.id, buildingId: b.id,
    });
    // Simulate the row existing before 0071. The INSERT trigger blocks an old
    // pod from creating this shape after cutover, but retained rows stay mutable
    // so `/paid` and the watcher can terminalize them.
    await db.update(deposits).set({ payload: { buildingId: b.id } })
      .where(eq(deposits.id, legacy.id));

    await expect(createDepositIntent(db, wallet, 'mine', {
      baseId: base!.id, buildingId: b.id,
    })).resolves.toMatchObject({ id: legacy.id, reference: legacy.reference });
    await db.update(deposits).set({
      createdAt: new Date(Date.now()
        - (ECONOMY.depositPendingTtlMin - ECONOMY.depositReuseMinRemainingMin) * 60_000 - 1),
    }).where(eq(deposits.id, legacy.id));
    await expect(createDepositIntent(db, wallet, 'mine', {
      baseId: base!.id, buildingId: b.id,
    })).rejects.toThrow(/window is closing/);
    await expect(db.insert(deposits).values({
      playerWallet: wallet, kind: 'mine', reference: k(), status: 'pending',
      payload: { buildingId: b.id },
    })).rejects.toMatchObject({
      cause: {
        code: '23514',
        message: expect.stringMatching(/legacy pending mine intent shape/),
      },
    });
    await expect(db.insert(deposits).values({
      playerWallet: wallet, kind: 'mine', reference: k(), status: 'pending',
      payload: { baseId: base!.id, buildingId: 'not-a-uuid' },
    })).rejects.toMatchObject({
      cause: {
        code: '23514',
        message: expect.stringMatching(/pending mine target is not a UUID/),
      },
    });
  });

  it('does not grant the next mine level from a stale frozen-price payment', async () => {
    const { wallet } = await freshPlayer();
    await raiseKeep(wallet, 5);
    const paidAt = new Date();
    await db.update(players).set({ entryPaidAt: paidAt }).where(eq(players.wallet, wallet));
    await db.update(bases).set({ landPaidAt: paidAt }).where(eq(bases.ownerWallet, wallet));
    const [base] = await db.select({ id: bases.id }).from(bases).where(eq(bases.ownerWallet, wallet));
    await fundStableBase(base!.id);
    const mine = await placeBuilding(
      db, wallet, BuildingType.Mine, 11, 8, k(), new Date(), base!.id,
    );
    await completeDueJobs(db, wallet, new Date(Date.now() + 120_000));
    // D-057: the paid rail starts at target L5 — freeze a 0.5 SOL L4→5 quote,
    // then advance the mine so the quote no longer covers the L5→6 price.
    await db.update(buildings).set({ level: 4 }).where(eq(buildings.id, mine.id));
    const intent = await createDepositIntent(db, wallet, 'mine', {
      baseId: base!.id, buildingId: mine.id,
    });
    await db.update(buildings).set({ level: 5 }).where(eq(buildings.id, mine.id));

    await expect(creditDeposit(db, intent.id, {
      txSignature: `sig-${k()}`, wallet, kind: 'mine',
      lamports: BigInt(upgradeSolLamports('mine', 5)), finalized: true,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect((await db.select().from(buildings).where(eq(buildings.id, mine.id)))[0]?.level).toBe(5);
    expect((await db.select().from(deposits).where(eq(deposits.id, intent.id)))[0]?.status)
      .toBe('pending');
  });

  it('concurrent paid upgrades on different mines cannot exceed the wallet builder cap', async () => {
    const { wallet } = await freshPlayer();
    await raiseKeep(wallet, 5);
    const paidAt = new Date();
    await db.update(players).set({ entryPaidAt: paidAt }).where(eq(players.wallet, wallet));
    await db.update(bases).set({ landPaidAt: paidAt }).where(eq(bases.ownerWallet, wallet));
    const [base] = await db.select({ id: bases.id }).from(bases).where(eq(bases.ownerWallet, wallet));
    await fundStableBase(base!.id);
    // D-057: paid upgrades exist only from target L5, so both racing mines sit at L4.
    const mines = await db.insert(buildings).values([
      { playerWallet: wallet, baseId: base!.id, type: BuildingType.Mine, level: 4, tx: 9, ty: 9 },
      { playerWallet: wallet, baseId: base!.id, type: BuildingType.Mine, level: 4, tx: 11, ty: 9 },
    ]).returning();
    const intents = await Promise.all(mines.map((mine) => createDepositIntent(
      db, wallet, 'mine', { baseId: base!.id, buildingId: mine.id },
    )));
    const price = BigInt(upgradeSolLamports('mine', 5));
    const shardsBefore = await getBaseShardBalance(db, base!.id);
    const results = await Promise.allSettled(intents.map((intent) => creditDeposit(db, intent.id, {
      txSignature: `sig-${k()}`, wallet, kind: 'mine', lamports: price, finalized: true,
    })));
    expect(results.filter((r) => r.status === 'fulfilled' && r.value.credited)).toHaveLength(1);
    const state = await getBaseState(db, wallet);
    expect(state.jobs.filter((j) => mines.some((mine) => mine.id === j.buildingId))).toHaveLength(1);
    expect(shardsBefore - await getBaseShardBalance(db, base!.id))
      .toBe(BigInt(UPGRADE_COSTS.mine[3]!));
  });
});

describe('obstacles', () => {
  it('explains a clearing shortage without leaking accounts or spending the remaining deed balance', async () => {
    const { wallet } = await freshPlayer();
    const [base] = await db.select({ id: bases.id }).from(bases).where(eq(bases.ownerWallet, wallet));
    await fundStableBase(base!.id);
    const state = await getBaseState(db, wallet, new Date(), base!.id);
    const target = state.obstacles.find(o => o.tx >= 8 && o.tx < 22 && o.ty >= 8 && o.ty < 22)!;
    const tier = Object.values(OBSTACLES.tiers).find(t => (t.kinds as readonly string[]).includes(target.spriteKey))!;
    const before = await getBaseShardBalance(db, base!.id);
    await db.transaction(tx => spendBaseShards(tx, base!.id, before - 1n, 'test.empty.shards', k()));
    await expect(clearObstacle(db, wallet, target.id, k(), new Date(), base!.id)).rejects.toMatchObject({
      statusCode: 422, code: 'INSUFFICIENT_SHARDS',
      message: `Not enough SHARDS. This clearing costs ${tier.costKeep.toLocaleString('en-US')} SHARDS.`,
    });
    expect(await getBaseShardBalance(db, base!.id)).toBe(1n);
    const after = await getBaseState(db, wallet, new Date(), base!.id);
    expect(after.jobs).toHaveLength(0);
    expect(after.obstacles.some(o => o.id === target.id)).toBe(true);
  });

  it('clearing an in-claim obstacle costs SHARDS, takes time, then pays the find reward', async () => {
    const { wallet } = await freshPlayer();
    const [base] = await db.select({ id: bases.id }).from(bases)
      .where(eq(bases.ownerWallet, wallet));
    await fundStableBase(base!.id);
    let state = await getBaseState(db, wallet, new Date(), base!.id);
    const target = state.obstacles.find(
      (o) => o.tx >= 8 && o.tx < 22 && o.ty >= 8 && o.ty < 22,
    );
    expect(target, 'fringe starter obstacle expected inside the claim').toBeDefined();
    const before = await getBaseShardBalance(db, base!.id);
    const clearKey = k();
    const first = await clearObstacle(db, wallet, target!.id, clearKey, new Date(), base!.id);
    await completeDueJobs(db, wallet, new Date(Date.now() + 11 * 60_000), base!.id);
    const retry = await clearObstacle(db, wallet, target!.id, clearKey, new Date(), base!.id);
    expect(retry.id).toBe(first.id); // completed retry is an idempotent outcome, not a second charge/job
    state = await getBaseState(db, wallet, new Date(), base!.id);
    expect(state.obstacles.find((o) => o.id === target!.id)).toBeUndefined();
    const after = await getBaseShardBalance(db, base!.id);
    const tierCosts = [
      OBSTACLES.tiers.small.costKeep, OBSTACLES.tiers.medium.costKeep, OBSTACLES.tiers.large.costKeep,
    ].map(BigInt);
    const spent = before - after + BigInt(OBSTACLES.clearRewardShards);
    expect(tierCosts).toContain(spent);
  });

  it('refuses to clear outside the claim', async () => {
    const { wallet } = await freshPlayer();
    const state = await getBaseState(db, wallet);
    const outside = state.obstacles.find((o) => o.tx < 8 || o.ty < 8 || o.tx >= 22 || o.ty >= 22);
    expect(outside).toBeDefined();
    await expect(clearObstacle(db, wallet, outside!.id, k())).rejects.toThrow(/expand your land/);
  });

  // Tester report e7cab252 (2026-09-17): a building upgrade could be finished
  // with KEEP but a clearing could not. The API's speed-up is kind-agnostic; these
  // pin that contract so a later "only upgrades" guard cannot silently take the
  // control away from the web/native sheets that now offer it.
  const inClaimObstacles = async (wallet: string, baseId: string) =>
    (await getBaseState(db, wallet, new Date(), baseId)).obstacles
      .filter((o) => o.tx >= 8 && o.tx < 22 && o.ty >= 8 && o.ty < 22);

  it('FINISH on a clearing job charges the shared speed-up price, lands the clear and pays the find reward', async () => {
    const { wallet } = await freshPlayer();
    const [base] = await db.select({ id: bases.id }).from(bases).where(eq(bases.ownerWallet, wallet));
    await fundStableBase(base!.id);
    const [target] = await inClaimObstacles(wallet, base!.id);
    expect(target, 'fringe starter obstacle expected inside the claim').toBeDefined();
    const started = await clearObstacle(db, wallet, target!.id, k(), new Date(), base!.id);

    // The DTO quotes a PAID finish for clearing (only initial construction is
    // free, owner 2026-09-05) and no CANCEL — the sheet must not offer one.
    const quoted = (await getBaseState(db, wallet, new Date(), base!.id)).jobs.find((j) => j.id === started.id)!;
    expect(quoted).toMatchObject({ kind: 'clear_obstacle', obstacleId: target!.id, canCancel: false });
    expect(BigInt(quoted.finishCostKeep)).toBeGreaterThan(0n);

    const keepBefore = (await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance;
    const shardsBefore = await getBaseShardBalance(db, base!.id);
    const now = new Date();
    const remSec = Math.max(0, Math.ceil((new Date(started.finishesAt).getTime() - now.getTime()) / 1000));
    const { cost } = await speedupJob(db, wallet, started.id, k(), now, base!.id);
    expect(cost).toBe(BigInt(speedupCostKeep(remSec)));
    expect(keepBefore - (await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance).toBe(cost);

    // Completion is the ordinary path: job gone, obstacle gone, find reward paid to the deed.
    const after = await getBaseState(db, wallet, new Date(), base!.id);
    expect(after.jobs).toHaveLength(0);
    expect(after.obstacles.some((o) => o.id === target!.id)).toBe(false);
    expect((await getBaseShardBalance(db, base!.id)) - shardsBefore).toBe(BigInt(OBSTACLES.clearRewardShards));
  });

  it('a reused speed-up key cannot buy a second clearing (security review 2026-07-24 #5)', async () => {
    const { wallet } = await freshPlayer();
    const [base] = await db.select({ id: bases.id }).from(bases).where(eq(bases.ownerWallet, wallet));
    await fundStableBase(base!.id);
    const [first, second] = await inClaimObstacles(wallet, base!.id);
    expect(second, 'two fringe starter obstacles expected inside the claim').toBeDefined();
    const sharedKey = k();
    const jobA = await clearObstacle(db, wallet, first!.id, k(), new Date(), base!.id);
    await speedupJob(db, wallet, jobA.id, sharedKey, new Date(), base!.id);
    const jobB = await clearObstacle(db, wallet, second!.id, k(), new Date(), base!.id);
    const keepBefore = (await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance;

    await expect(speedupJob(db, wallet, jobB.id, sharedKey, new Date(), base!.id)).rejects.toThrow(/duplicate speedup/);
    expect((await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance).toBe(keepBefore);
    const state = await getBaseState(db, wallet, new Date(), base!.id);
    expect(state.jobs.map((j) => j.id)).toEqual([jobB.id]);
    expect(state.obstacles.some((o) => o.id === second!.id)).toBe(true);
  });
});

async function getKeepBalance(wallet: string): Promise<bigint> {
  const { getOrCreatePlayerAccount } = await import('../src/ledger');
  const acc = await getOrCreatePlayerAccount(db, wallet, 'player_shards'); // legacy base actions charge wallet shards
  return acc.balance;
}

// silence unused-import lint for tables referenced only in types
void buildings; void builderJobs; void obstacles;

describe('army garrison payload (#56 + levelled base-view art)', () => {
  it('army rows carry the researched troop level, defaulting to 1, excluding zero counts', async () => {
    const { wallet } = await freshPlayer();
    await db.insert(army).values([
      { playerWallet: wallet, troop: 'dragon', count: 2 },
      { playerWallet: wallet, troop: 'giant', count: 1 },
      { playerWallet: wallet, troop: 'troll', count: 0 }, // consumed to zero by a raid
    ]);
    await db.insert(troopResearch).values({ playerWallet: wallet, troop: 'dragon', level: 7 });
    const state = await getBaseState(db, wallet);
    // The level is the SERVER's game number (troop_research; default 1) — the
    // client renders levelled garrison art from it and may never invent one.
    expect(state.army.find((r) => r.troop === 'dragon')).toEqual({ troop: 'dragon', count: 2, level: 7 });
    expect(state.army.find((r) => r.troop === 'giant')).toEqual({ troop: 'giant', count: 1, level: 1 });
    expect(state.army.find((r) => r.troop === 'troll')).toBeUndefined();
  });

  it('pins the {troop, count, level} row shape — a client-breaking rename fails HERE', async () => {
    const { wallet } = await freshPlayer();
    await db.insert(army).values({ playerWallet: wallet, troop: 'bowman', count: 3 });
    const state = await getBaseState(db, wallet);
    // Exact keys, not a subset match: BaseStateDto.army on the web client is
    // typed off this shape, so an accidental rename/extra-field drift trips here.
    expect(state.army.map((r) => Object.keys(r).sort())).toEqual([['count', 'level', 'troop']]);
  });

  it('completes DUE research before reading levels — same lazy rule as raid snapshots', async () => {
    const { wallet } = await freshPlayer();
    await db.insert(army).values({ playerWallet: wallet, troop: 'giant', count: 1 });
    await db.insert(troopResearch).values({
      playerWallet: wallet, troop: 'giant', level: 1,
      researchingToLevel: 3, finishesAt: new Date(Date.now() - 1000),
    });
    // Levels must come from the SAME derivation raids freeze into armySnapshot
    // (getArmyState), which commits due research first — a raw troop_research
    // read here would lag until the player opened an army screen and the
    // garrison would disagree with the next raid's snapshot.
    const state = await getBaseState(db, wallet);
    expect(state.army.find((r) => r.troop === 'giant')?.level).toBe(3);
  });
});

describe('hero altars (D-058, owner 2026-08-16: Keep L5, KEEP-priced, contract items)', () => {
  it('includes the legacy hero-progress level in the /base hero DTO without a migration', async () => {
    // WHY: base-scoped deeds read base_hero_progress, while the rollout-safe
    // legacy endpoint still reads hero_levels. Both response shapes must carry
    // the authoritative portrait tier until legacy reads are retired.
    const { wallet } = await freshPlayer();
    await db.insert(buildings).values({
      playerWallet: wallet, type: 'heroaltar', level: 1, tx: 8, ty: 8,
    });
    await db.insert(heroLevels).values({ playerWallet: wallet, hero: 'vex', level: 16 });
    expect((await getBaseState(db, wallet)).heroes).toContainEqual({
      hero: 'vex', level: 16, recoveryUntil: null, available: true,
    });
  });

  it('recruiting = placing the altar: Keep L5 gate, then 3,000/10,000 KEEP charged as the recruit fee', async () => {
    // REWRITTEN 2026-08-16 — owner verbatim: "hero unlock start from keep
    // level 5. Vex hero cost is 3000 KEEP, Theodor 10,000 KEEP". The shard
    // price and the L3/L4 spec gates are retired; both altars now gate at L5
    // and charge KEEP (recycled to emission_pool) at placement.
    const { wallet } = await freshPlayer();
    // Below L5: both locked — the tray shows the badge, the server enforces it.
    await raiseKeep(wallet, 4);
    await expect(placeBuilding(db, wallet, 'heroaltar' as never, 8, 9, k())).rejects.toThrow(/Keep level 5/);
    await expect(placeBuilding(db, wallet, 'siegestool' as never, 11, 9, k())).rejects.toThrow(/Keep level 5/);
    await raiseKeep(wallet, 5);
    const keepBefore = (await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance;
    const altar = await placeBuilding(db, wallet, 'heroaltar' as never, 8, 9, k());
    expect(altar.type).toBe('heroaltar');
    expect((await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance)
      .toBe(keepBefore - BigInt(HEROES.vex.recruitCostKeep)); // 3,000 KEEP, not shards
    await completeDueJobs(db, wallet, new Date(Date.now() + 300_000)); // free the builder
    const stool = await placeBuilding(db, wallet, 'siegestool' as never, 11, 9, k());
    expect(stool.type).toBe('siegestool');
    expect((await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance)
      .toBe(keepBefore - BigInt(HEROES.vex.recruitCostKeep) - BigInt(HEROES.theodor.recruitCostKeep));
    await completeDueJobs(db, wallet, new Date(Date.now() + 600_000));
    // ONE of each hero ever — a second altar is a lore violation, not a farm.
    await expect(placeBuilding(db, wallet, 'heroaltar' as never, 14, 9, k())).rejects.toThrow();
  });

  it('an owned HERO CONTRACT item is consumed instead of the KEEP charge (market-bought recruits are prepaid)', async () => {
    const { wallet } = await freshPlayer();
    await raiseKeep(wallet, 5);
    await db.insert(playerItems).values({ playerWallet: wallet, itemId: HEROES.vex.recruitItemId, qty: 1 });
    const keepBefore = (await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance;
    const altar = await placeBuilding(db, wallet, 'heroaltar' as never, 8, 9, k());
    expect(altar.type).toBe('heroaltar');
    // The contract paid the fee: no KEEP moved, and the item is gone.
    expect((await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance).toBe(keepBefore);
    const [row] = await db.select({ qty: playerItems.qty }).from(playerItems)
      .where(and(eq(playerItems.playerWallet, wallet), eq(playerItems.itemId, HEROES.vex.recruitItemId)));
    expect(row?.qty).toBe(0);
  });

  it('a contract-only placement never falls back to an undisplayed KEEP purchase after stock disappears', async () => {
    const { wallet } = await freshPlayer(); await raiseKeep(wallet, 5);
    const keepBefore = (await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance;
    const key = k();
    await expect(placeBuilding(db, wallet, 'heroaltar' as never, 8, 9, key, new Date(), undefined, undefined, true))
      .rejects.toMatchObject({ code: 'HERO_CONTRACT_UNAVAILABLE' });
    expect((await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance).toBe(keepBefore);
    expect(await db.select().from(buildings).where(and(eq(buildings.playerWallet, wallet), eq(buildings.type, 'heroaltar')))).toHaveLength(0);
    await db.insert(playerItems).values({ playerWallet: wallet, itemId: HEROES.vex.recruitItemId, qty: 1 });
    expect((await placeBuilding(db, wallet, 'heroaltar' as never, 8, 9, key, new Date(), undefined, undefined, true)).type).toBe('heroaltar');
    expect((await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance).toBe(keepBefore);
  });

  it('a broke, contract-less wallet cannot recruit — refusal moves no KEEP and consumes nothing', async () => {
    const { wallet } = await freshPlayer(100n); // far below the 3,000 fee
    await raiseKeep(wallet, 5);
    await expect(placeBuilding(db, wallet, 'heroaltar' as never, 8, 9, k())).rejects.toThrow();
    expect((await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance).toBe(100n);
    const owned = await db.select().from(buildings).where(and(
      eq(buildings.playerWallet, wallet), eq(buildings.type, 'heroaltar'),
    ));
    expect(owned).toHaveLength(0);
  });
});
