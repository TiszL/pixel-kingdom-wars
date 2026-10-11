/**
 * Settlement truth for the protocol-V2 command journal: whatever the journal
 * contains, the settled result IS the deterministic simulation of it — a horn
 * finish, an early full-destruction finish, a journal with buffs/hero/rally/
 * reserves, and (2026-09-17) a started RETREAT, which is scored at its accepted
 * tick instead of a 0 % placeholder.
 *
 * Tester Suga, report f7c978e8 (prod raid e743bf01, 2026-09-16 12:52Z): live
 * HUD showed 13 % / 1★ with the keep down; RETREAT settled 0 % / 0★ / -5
 * trophies and the replay ended at 0 %. The journal held four deploys, a 2x
 * speed change and a retreat at 67.9 s; the archived prefix itself carried
 * seven `destroyed` events and `star n=1` at tick 176. The owner hit the same
 * wall on native campaign stage 1 ("press RETREAT → DEFEAT" after progress).
 */
import { randomUUID } from 'node:crypto';
import {
  BuildingType, COMBAT_TICK_MS, HEROES, RAID_RULES, type BaseSnapshot,
} from '@shardkeep/shared';
import { simulateRaid, type RaidOrders, type SimEvent } from '@shardkeep/sim';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  baseArmy, baseCampaignProgress, baseHeroProgress, baseProfiles, bases, buildings, players,
  raidReplayTimelines, raids,
} from '../src/db/schema';
import { ensureStartingBase } from '../src/game/base';
import { getBaseBattleHistory } from '../src/game/baseBattleHistory';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { ensureWalletBaseIdentity } from '../src/game/baseOwnership';
import {
  acceptLiveRaidCommandReceipt, closeLiveRaidStream, getRaidClock, retreatLiveRaid,
  setLiveRaidSpeed, startLiveRaid, type LiveRaidCommand,
} from '../src/game/liveRaids';
import { decodeReplayTimeline } from '../src/game/raidReplayArchive';
import {
  createCampaignRaid, createRaid, recoverDueStartedLiveRaids, submitOrders,
} from '../src/game/raids';
import { bootstrapSystemAccounts } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const priorMultiBase = process.env['MULTI_BASE_ENABLED'];
let seq = 0;
const key = () => `settlement-truth-${++seq}-${randomUUID()}`;
const authority = async () => {};
const TICK = COMBAT_TICK_MS;
const HORN_MS = RAID_RULES.battleDurationSec * 1_000;

type TroopLevels = Partial<Record<'highlander', number>>;
type Army = { levels: TroopLevels; heroLevels?: Record<string, number> };

async function stablePlayer(keepLevel = 5) {
  process.env['MULTI_BASE_ENABLED'] = 'false';
  const player = await createTestPlayer(db);
  await ensureStartingBase(db, player.wallet);
  const paidAt = new Date('2026-08-12T00:00:00.000Z');
  await db.update(players).set({ keepLevel, entryPaidAt: paidAt })
    .where(eq(players.wallet, player.wallet));
  const baseId = await ensureWalletBaseIdentity(db, player.wallet);
  await db.update(bases).set({ keepLevel, landPaidAt: paidAt }).where(eq(bases.id, baseId!));
  process.env['MULTI_BASE_ENABLED'] = 'true';
  return { ...player, baseId: baseId! };
}

/** A real deed-vs-deed V2 raid: deed loot escrow, base trophies, shields —
 * the exact production path of the reported raid. The starter base is a lone
 * Keep, so `farVault` adds a sturdy building in the far corner that outlives
 * the Keep: the reported state was "keep down, base still standing". */
async function pvpRaid(t0: Date, highlanders: number, opts: { recruitVex?: boolean; farVault?: boolean } = {}) {
  const attacker = await stablePlayer(5);
  const defender = await stablePlayer(5);
  await db.insert(baseArmy).values({ baseId: attacker.baseId, troop: 'highlander', count: highlanders });
  if (opts.farVault) {
    await db.insert(buildings).values({
      playerWallet: defender.wallet, baseId: defender.baseId, type: BuildingType.Vault, level: 20, tx: 20, ty: 20,
    });
  }
  await rewardBaseShards(db, attacker.baseId, 100_000n, 'test.settlement-truth.ante', key());
  await rewardBaseShards(db, defender.baseId, 50_000n, 'test.settlement-truth.loot', key());
  await db.insert(baseProfiles).values([
    { baseId: attacker.baseId, trophies: 100 }, { baseId: defender.baseId, trophies: 100 },
  ]).onConflictDoUpdate({ target: baseProfiles.baseId, set: { trophies: 100 } });
  if (opts.recruitVex) {
    await db.insert(baseHeroProgress).values({ baseId: attacker.baseId, hero: 'vex', level: 1 });
    await db.insert(buildings).values({
      playerWallet: attacker.wallet, baseId: attacker.baseId, type: HEROES.vex.altar,
      level: 1, tx: 18, ty: 18,
    });
    await fundTestKeep(db, attacker.wallet, 10_000n, 'test.settlement-truth.keep', key());
  }
  const raid = await createRaid(db, attacker.wallet, {
    attackerBaseId: attacker.baseId, defenderBaseId: defender.baseId, defenderWallet: defender.wallet,
    idempotencyKey: key(), authorizeAttackerBase: authority, authorizeDefenderBase: authority,
    raidProtocolVersion: 2, allowRaidProtocolV2: true,
  }, t0);
  return { attacker, defender, raid };
}

const deployAt = (tx: number, ty: number): LiveRaidCommand => (
  { kind: 'deploy', payload: { troop: 'highlander', tx, ty } }
);

/** Every journaled unit the simulator will see, stamped exactly as accepted. */
function expectedOrders(
  accepted: Array<{ command: { kind: string; payload: unknown; serverOffsetMs: number } }>,
  army: Army,
): RaidOrders {
  const orders: RaidOrders = { deploys: [] };
  for (const { command } of accepted) {
    const payload = command.payload as Record<string, unknown>;
    if (command.kind === 'deploy') {
      orders.deploys.push({ troop: 'highlander', tx: payload['tx'] as number, ty: payload['ty'] as number, tMs: command.serverOffsetMs });
    } else if (command.kind === 'hero') {
      (orders.heroDeploys ??= []).push({
        hero: payload['hero'] as 'vex', tx: payload['tx'] as number, ty: payload['ty'] as number,
        tMs: command.serverOffsetMs, level: army.heroLevels?.[payload['hero'] as string] ?? 1,
      });
    } else if (command.kind === 'rally') {
      orders.rally = { tx: payload['tx'] as number, ty: payload['ty'] as number, tMs: command.serverOffsetMs };
    } else if (command.kind === 'buff') {
      orders.buffs = { ...orders.buffs, [payload['buff'] as string]: true };
    }
  }
  return orders;
}

const keepFallTick = (events: ReadonlyArray<SimEvent>, snapshot: BaseSnapshot): number => {
  const keep = snapshot.buildings.find((building) => building.type === BuildingType.Keep)!;
  const fell = events.find((event) => event.e === 'destroyed' && event.id === keep.id);
  expect(fell, 'fixture must actually fell the keep before the horn').toBeDefined();
  return fell!.t;
};

beforeAll(async () => bootstrapSystemAccounts(db));
afterEach(() => { process.env['MULTI_BASE_ENABLED'] = 'true'; });
afterAll(async () => {
  if (priorMultiBase === undefined) delete process.env['MULTI_BASE_ENABLED'];
  else process.env['MULTI_BASE_ENABLED'] = priorMultiBase;
  await conn.sql.end();
});

describe.sequential('V2 journal settlement equals the simulation of the complete journal', () => {
  it('settles a horn finish at 2x as the exact simulation of the server-stamped deploys', async () => {
    const t0 = new Date();
    const { attacker, raid } = await pvpRaid(t0, 3);
    const startAt = new Date(t0.getTime() + 1_000);
    const accepted = [
      await acceptLiveRaidCommandReceipt(db, attacker.wallet, raid.id, 'u0', deployAt(1, 1), startAt),
      await acceptLiveRaidCommandReceipt(db, attacker.wallet, raid.id, 'u1', deployAt(1, 2), new Date(startAt.getTime() + 500)),
      await acceptLiveRaidCommandReceipt(db, attacker.wallet, raid.id, 'u2', deployAt(2, 1), new Date(startAt.getTime() + 1_000)),
    ];
    expect(accepted.map((receipt) => receipt.command.serverOffsetMs)).toEqual([0, 500, 1_000]);
    const fast = await setLiveRaidSpeed(db, attacker.wallet, raid.id, 'fast', 1, 2, true, new Date(startAt.getTime() + 10_000));
    expect(fast.clock).toMatchObject({ rate: 2, simNowMs: 10_000 });
    const { clock } = await getRaidClock(db, raid.id, fast.clock.serverNow);
    const hornAt = clock.battleEndsAt!;
    expect(hornAt.getTime() - startAt.getTime()).toBe(10_000 + (HORN_MS - 10_000) / 2);

    const orders = await closeLiveRaidStream(db, attacker.wallet, raid.id, hornAt);
    const settled = await submitOrders(db, attacker.wallet, raid.id, orders, hornAt, true);
    const army = raid.armySnapshot as Army;
    const truth = simulateRaid(raid.snapshot as BaseSnapshot, expectedOrders(accepted, army), Number(raid.seed), { troopLevels: army.levels });
    // WHY: the reporter's -5 came from a result that was NOT the journal's
    // simulation. The settled numbers must be the sim's, byte for byte.
    expect(settled.result).toMatchObject({
      stars: truth.stars, destructionPct: truth.destructionPct, keepDestroyed: truth.keepDestroyed,
    });
    expect(settled.result).not.toHaveProperty('retreated');
    const [persisted] = await db.select().from(raids).where(eq(raids.id, raid.id));
    expect(persisted!.events).toEqual(truth.events);
    const [timeline] = await db.select().from(raidReplayTimelines).where(eq(raidReplayTimelines.raidId, raid.id));
    expect(timeline).toMatchObject({ durationMs: truth.ticks * TICK, eventCount: truth.events.length });
  });

  it.each(['finish', 'worker'] as const)(
    'scores a started RETREAT (via %s) by the battle state at the accepted retreat tick, not a placeholder', async (mode) => {
      const t0 = new Date();
      const { attacker, defender, raid } = await pvpRaid(t0, 8, { farVault: true });
      const snapshot = raid.snapshot as BaseSnapshot;
      const army = raid.armySnapshot as Army;
      const startAt = new Date(t0.getTime() + 1_000);
      const accepted = [];
      for (let i = 0; i < 8; i++) {
        accepted.push(await acceptLiveRaidCommandReceipt(
          db, attacker.wallet, raid.id, `u${i}`, deployAt(1 + (i % 4), 1 + Math.floor(i / 4)), startAt,
        ));
      }
      const journal = expectedOrders(accepted, army);
      const full = simulateRaid(snapshot, journal, Number(raid.seed), { troopLevels: army.levels });
      // Mirror the reported raid: 2x at 10 s, then RETREAT a moment after the
      // keep falls, while the base still stands in part.
      await setLiveRaidSpeed(db, attacker.wallet, raid.id, 'fast', 1, 2, true, new Date(startAt.getTime() + 10_000));
      const boundary = keepFallTick(full.events, snapshot) + 5;
      const retreatSimMs = boundary * TICK;
      expect(retreatSimMs).toBeGreaterThan(10_000);
      expect(retreatSimMs).toBeLessThan(HORN_MS);
      const retreatAt = new Date(startAt.getTime() + 10_000 + (retreatSimMs - 10_000) / 2);
      const retreat = await retreatLiveRaid(db, attacker.wallet, raid.id, 'retreat', retreatAt);
      expect(retreat).toMatchObject({ retreated: true, terminal: false, clock: { simNowMs: retreatSimMs } });

      if (mode === 'finish') {
        await submitOrders(db, attacker.wallet, raid.id, retreat.orders!, retreatAt, true, false, true);
      } else {
        // The client lost the response; the worker settles the same journal
        // from the durable retreat row and must reach the identical score.
        expect(await recoverDueStartedLiveRaids(db, new Date(t0.getTime() + 180_000), undefined, raid.id))
          .toEqual({ resolved: 1, raced: 0 });
      }

      const truth = simulateRaid(snapshot, journal, Number(raid.seed), { troopLevels: army.levels, stopAfterTick: boundary });
      expect(truth.keepDestroyed).toBe(true);
      expect(truth.destructionPct, 'fixture must retreat while the base still partly stands').toBeLessThan(100);
      const [settled] = await db.select().from(raids).where(eq(raids.id, raid.id));
      const result = settled!.result as {
        stars: number; destructionPct: number; keepDestroyed: boolean; lootShards: number;
        retreated?: boolean; attackerTrophyDelta: number; defenderTrophyDelta: number;
      };
      // WHY: this is the reported bug. Keep down + partial destruction at the
      // retreat tick must settle as exactly that, with a win's trophies and
      // loot, never as 0 % / 0★ with a zero-star loss.
      expect(result).toMatchObject({
        stars: truth.stars, destructionPct: truth.destructionPct, keepDestroyed: true, retreated: true,
      });
      expect(result.stars).toBeGreaterThanOrEqual(1);
      expect(result.destructionPct).toBeGreaterThan(0);
      expect(result.attackerTrophyDelta).toBeGreaterThan(0);
      expect(result.defenderTrophyDelta).toBe(-result.attackerTrophyDelta);
      expect(result.lootShards).toBeGreaterThan(0);
      const profiles = await db.select({ baseId: baseProfiles.baseId, trophies: baseProfiles.trophies })
        .from(baseProfiles).where(eq(baseProfiles.baseId, attacker.baseId));
      expect(profiles[0]!.trophies).toBe(100 + result.attackerTrophyDelta);
      // The archive is the same truth: the full run's prefix up to the retreat
      // tick, playing to the retreat clock, with the sim's own HP maxima.
      const [timeline] = await db.select().from(raidReplayTimelines).where(eq(raidReplayTimelines.raidId, raid.id));
      const archive = decodeReplayTimeline(timeline!);
      expect(archive.events).toEqual(full.events.filter((event) => event.t <= boundary));
      expect(archive.events).toEqual(truth.events);
      expect(full.events.some((event) => event.t > boundary)).toBe(true);
      expect(archive.result).toEqual(result);
      expect(timeline).toMatchObject({ durationMs: boundary * TICK, eventCount: truth.events.length });
      expect(archive.buildingHealth).toEqual(truth.buildings.map((building) => ({
        id: building.id, initialHp: building.maxHp, maxHp: building.maxHp,
      })));
      // Both deeds' history rows carry the scored retreat, not a defeat.
      for (const participant of [attacker, defender]) {
        const history = await getBaseBattleHistory(db, participant.wallet, participant.baseId);
        expect(history.battles.find((battle) => battle.raidId === raid.id)).toMatchObject({
          stars: result.stars, destructionPct: result.destructionPct,
        });
      }
      expect(await db.select({ count: baseArmy.count }).from(baseArmy).where(and(
        eq(baseArmy.baseId, attacker.baseId), eq(baseArmy.troop, 'highlander'),
      ))).toEqual([{ count: 0 }]);
    },
  );

  it('accepts a finish at proven full destruction before the horn and settles it as the simulation', async () => {
    const t0 = new Date();
    const { attacker, raid } = await pvpRaid(t0, 2);
    // A lone keep so two highlanders can raze the base well before the horn.
    // Production ids are building uuids (settlement spends traps by id). The
    // starter defender already IS that lone Level 1 Keep, so assert it on the
    // ORIGINAL snapshot: since D153.235 (0284, 2026-10-01) the starter capture
    // freezes the snapshot sha at insertion and a rewritten raid row is
    // refused on every read as RAID_STARTER_ORIGINAL_SOURCE.
    const snapshot = raid.snapshot as BaseSnapshot;
    expect(snapshot.buildings).toEqual([expect.objectContaining({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      type: BuildingType.Keep, level: 1, tx: 14, ty: 14,
    })]);
    const startAt = new Date(t0.getTime() + 1_000);
    const accepted = [
      await acceptLiveRaidCommandReceipt(db, attacker.wallet, raid.id, 'u0', deployAt(7, 14), startAt),
      await acceptLiveRaidCommandReceipt(db, attacker.wallet, raid.id, 'u1', deployAt(7, 15), startAt),
    ];
    const army = raid.armySnapshot as Army;
    const truth = simulateRaid(snapshot, expectedOrders(accepted, army), Number(raid.seed), { troopLevels: army.levels });
    expect(truth.destructionPct).toBe(100);
    const endMs = truth.ticks * TICK;
    expect(endMs).toBeLessThan(HORN_MS);
    await expect(closeLiveRaidStream(db, attacker.wallet, raid.id, new Date(startAt.getTime() + endMs - 1)))
      .rejects.toMatchObject({ code: 'RAID_CLOCK_NOT_DUE' });
    const doneAt = new Date(startAt.getTime() + endMs);
    const orders = await closeLiveRaidStream(db, attacker.wallet, raid.id, doneAt);
    const settled = await submitOrders(db, attacker.wallet, raid.id, orders, doneAt, true);
    expect(settled.result).toMatchObject({ stars: 3, destructionPct: 100, keepDestroyed: true });
    expect(settled.result.attackerTrophyDelta).toBeGreaterThan(0);
    const [persisted] = await db.select().from(raids).where(eq(raids.id, raid.id));
    expect(persisted!.events).toEqual(truth.events);
  });

  it('settles a journal with a staged buff, a hero, a rally and a late reserve exactly as simulated', async () => {
    const t0 = new Date();
    const { attacker, raid } = await pvpRaid(t0, 2, { recruitVex: true });
    const army = raid.armySnapshot as Army & { heroes?: string[] };
    expect(army.heroes).toContain('vex');
    const startAt = new Date(t0.getTime() + 1_000);
    const accepted = [
      await acceptLiveRaidCommandReceipt(db, attacker.wallet, raid.id, 'buff',
        { kind: 'buff', payload: { buff: 'warhorn' } }, new Date(t0.getTime() + 500)),
      await acceptLiveRaidCommandReceipt(db, attacker.wallet, raid.id, 'u0', deployAt(1, 1), startAt),
      await acceptLiveRaidCommandReceipt(db, attacker.wallet, raid.id, 'hero',
        { kind: 'hero', payload: { hero: 'vex', tx: 1, ty: 2 } }, new Date(startAt.getTime() + 1_000)),
      await acceptLiveRaidCommandReceipt(db, attacker.wallet, raid.id, 'rally',
        { kind: 'rally', payload: { tx: 14, ty: 14 } }, new Date(startAt.getTime() + 2_000)),
    ];
    await setLiveRaidSpeed(db, attacker.wallet, raid.id, 'fast', 1, 2, true, new Date(startAt.getTime() + 10_000));
    // 30 s of battle reached after 10 s at 1x plus 10 s at 2x.
    accepted.push(await acceptLiveRaidCommandReceipt(
      db, attacker.wallet, raid.id, 'reserve', deployAt(2, 1), new Date(startAt.getTime() + 20_000),
    ));
    expect(accepted.map((receipt) => receipt.command.serverOffsetMs)).toEqual([0, 0, 1_000, 2_000, 30_000]);
    const { clock } = await getRaidClock(db, raid.id, new Date(startAt.getTime() + 20_000));
    const hornAt = clock.battleEndsAt!;
    const orders = await closeLiveRaidStream(db, attacker.wallet, raid.id, hornAt);
    expect(orders).toMatchObject({
      buffs: { warhorn: true }, rally: { tx: 14, ty: 14, tMs: 2_000 },
      heroDeploys: [{ hero: 'vex', tx: 1, ty: 2, tMs: 1_000 }],
    });
    expect(orders.deploys.map((deploy) => deploy.tMs)).toEqual([0, 30_000]);
    const settled = await submitOrders(db, attacker.wallet, raid.id, orders, hornAt, true);
    const journal = expectedOrders(accepted, army);
    const truth = simulateRaid(raid.snapshot as BaseSnapshot, journal, Number(raid.seed), { troopLevels: army.levels });
    // WHY: hero-only/buffed/rallied journals were candidate causes of the 0 %;
    // every control must reach the simulator and its result must be the sim's.
    expect(settled.result).toMatchObject({
      stars: truth.stars, destructionPct: truth.destructionPct, keepDestroyed: truth.keepDestroyed,
    });
    const [persisted] = await db.select().from(raids).where(eq(raids.id, raid.id));
    expect(persisted!.orders).toMatchObject({
      deploys: journal.deploys, buffs: { warhorn: true }, rally: journal.rally,
      heroDeploys: [expect.objectContaining({ hero: 'vex', tMs: 1_000 })],
    });
    expect(persisted!.events).toEqual(truth.events);
    expect(truth.events.some((event) => event.e === 'deploy' && (event as { hero?: string }).hero === 'vex')).toBe(true);
    expect(truth.events.some((event) => event.e === 'rally')).toBe(true);
  });

  it('scores a started campaign RETREAT after progress and ratchets the stage, instead of a 0 % defeat', async () => {
    // Owner on native, 2026-09-16: stage 1 showed two DEFEATs at 0 % before a
    // 3★ win — each was a RETREAT after real progress.
    const t0 = new Date();
    const attacker = await stablePlayer(5);
    await db.insert(baseArmy).values({ baseId: attacker.baseId, troop: 'highlander', count: 8 });
    const raid = await createCampaignRaid(db, attacker.wallet, 1, key(), t0, {
      attackerBaseId: attacker.baseId, authorizeAttackerBase: authority,
      raidProtocolVersion: 2, allowRaidProtocolV2: true,
    });
    const snapshot = raid.snapshot as BaseSnapshot;
    const army = raid.armySnapshot as Army;
    const accepted = [];
    for (let i = 0; i < 8; i++) {
      accepted.push(await acceptLiveRaidCommandReceipt(
        db, attacker.wallet, raid.id, `u${i}`, deployAt(1 + (i % 4), 1 + Math.floor(i / 4)), t0,
      ));
    }
    expect(accepted.every((receipt) => receipt.command.serverOffsetMs === 0)).toBe(true);
    const startAt = new Date(t0.getTime() + 1_000);
    await startLiveRaid(db, attacker.wallet, raid.id, 'attack', 0, startAt);
    const journal = expectedOrders(accepted, army);
    const full = simulateRaid(snapshot, journal, Number(raid.seed), { troopLevels: army.levels });
    const boundary = keepFallTick(full.events, snapshot) + 2;
    expect(boundary * TICK).toBeLessThan(HORN_MS);
    const retreatAt = new Date(startAt.getTime() + boundary * TICK);
    const retreat = await retreatLiveRaid(db, attacker.wallet, raid.id, 'retreat', retreatAt);
    expect(retreat.clock.simNowMs).toBe(boundary * TICK);
    const { result } = await submitOrders(db, attacker.wallet, raid.id, retreat.orders!, retreatAt, true, false, true);
    const truth = simulateRaid(snapshot, journal, Number(raid.seed), { troopLevels: army.levels, stopAfterTick: boundary });
    expect(truth.keepDestroyed).toBe(true);
    expect(result).toMatchObject({
      stars: truth.stars, destructionPct: truth.destructionPct, keepDestroyed: true, retreated: true,
      attackerTrophyDelta: 0, defenderTrophyDelta: 0,
    });
    expect(result.stars).toBeGreaterThanOrEqual(1);
    expect(await db.select({ bestStars: baseCampaignProgress.bestStars }).from(baseCampaignProgress)
      .where(and(eq(baseCampaignProgress.baseId, attacker.baseId), eq(baseCampaignProgress.stage, 1))))
      .toEqual([{ bestStars: result.stars }]);
    const history = await getBaseBattleHistory(db, attacker.wallet, attacker.baseId);
    expect(history.battles.find((battle) => battle.raidId === raid.id)).toMatchObject({
      mode: 'campaign', stars: result.stars, destructionPct: result.destructionPct,
    });
  });
});
