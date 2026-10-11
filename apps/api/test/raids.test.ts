import type { BaseSnapshot } from '@shardkeep/shared';
import { trainTroop } from './training-consent';
/**
 * Raid flow tests (Economy v3, ECONOMY.md §4/§4a): training/capacity, raiding
 * costs ENERGY not KEEP (6 free/day, then SOL-bought energy, NO daily ceiling,
 * plus a Keep-scaled SHARD ante; NO KEEP ever charged), eligibility, order validation, deterministic resolution,
 * loot conservation + the ×1000 cap, 24h loss-shield, shield-break-on-attack,
 * troop consumption, replays, create idempotency.
 */
import {
  BuildingType, HEROES, HERO_SKILLS, PVE, pvpAttackShardCostForKeepLevel, pvpMinDefenderKeep,
  RAID_ENERGY, RAID_REPLAY_LIMITS, RAID_RULES, SHIELD, STRUCTURES,
} from '@shardkeep/shared';
import { SIM_VERSION } from '@shardkeep/sim';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accounts, army, baseProfiles, baseRaidLocks, bases, buildings, builderJobs, heroEquipment, heroLevels, heroLoadouts, heroRaidReservations,
  ledgerEntries, ledgerTransactions, playerItems, players, pveCamps, raids,
  shields, troopResearch, valleys, raidReplayTimelines,
} from '../src/db/schema';
import { completeDueJobs, ensureStartingBase, placeBuilding } from '../src/game/base';
import { completeDueTraining, getArmyState} from '../src/game/army';
import { acceptLiveRaidCommand } from '../src/game/liveRaids';
import { assertEnergyPurchasable, batchOrdersSubmitDeadlineAt, compensatePendingRaid, createCampaignRaid, createPveRaid, createRaid, getPendingHeroRaidResumes, getPendingRaidResume, getRaidEnergy, getRaidLog, getReplay, grantPurchasedEnergy, OrdersBodySchema, persistSpentDefenderTraps, raidOrdersWindowMs, recoverDueStartedLiveRaids, submitOrders } from '../src/game/raids';
import { decodeReplayTimeline } from '../src/game/raidReplayArchive';
import { makeCampSnapshot } from '../src/game/world';
import { claimRaidSimulationPermit } from '../src/game/raidSimulationRunner';
import { createDepositIntent, creditDeposit, type VerifiedPayment } from '../src/money/deposits';
import { rewardShards, spendShards } from '../src/game/spend';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, createTestValley, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let key = 0;
const k = (): string => `raid-${++key}-${Math.random().toString(36).slice(2)}`;
const future = (min: number): Date => new Date(Date.now() + min * 60_000);

/** Read a system account (owner NULL) balance by kind. */
async function sysBalance(kind: 'burn' | 'sol_treasury' | 'league_pool' | 'league_sol_pool'): Promise<bigint> {
  const [row] = await db.select({ b: accounts.balance }).from(accounts)
    .where(and(isNull(accounts.ownerWallet), eq(accounts.kind, kind)));
  return row?.b ?? 0n;
}
const burnBalance = (): Promise<bigint> => sysBalance('burn');
const balance = async (w: string): Promise<bigint> => (await getOrCreatePlayerAccount(db, w, 'player_keep')).balance;
/** SPLIT (owner 2026-07-24): loot moves SHARDS — mined wealth is raidable, KEEP never. */
const shardBalance = async (w: string): Promise<bigint> => (await getOrCreatePlayerAccount(db, w, 'player_shards')).balance;

/** Test-only retirement after assertions. Since 0280 every raid has immutable
 * visual history, so deleting a raid (or its referenced camp/valley) is refused.
 * Retain originals, stop unfinished fixture raids entering later global sweeps,
 * and tombstone private camps using the same far-future shape as removeMaxedCamp.
 * These fixture wallets have no charter/tournament obligations. No refund or
 * gameplay settlement is fabricated; already terminal rows remain unchanged. */
async function retireFixtureRaids(
  ids: string[], options: { valleyId?: string; clearPurchasedEnergyFor?: string } = {},
): Promise<void> {
  await db.transaction(async tx => {
    if (options.clearPurchasedEnergyFor) {
      await tx.update(players).set({ purchasedEnergy: 0 })
        .where(eq(players.wallet, options.clearPurchasedEnergyFor));
    }
    if (ids.length) {
      const retired = await tx.update(raids).set({
        status: 'expired', simulationLeaseToken: null, simulationLeaseUntil: null,
        simulationSystemAttemptedAt: null,
      }).where(and(inArray(raids.id, ids), eq(raids.status, 'pending_orders')))
        .returning({ id: raids.id });
      // Expiry releases this per-raid lock in production too. Keep immutable
      // raid history, and touch only locks for rows retired by this transaction.
      if (retired.length) {
        await tx.delete(baseRaidLocks).where(inArray(baseRaidLocks.raidId, retired.map(raid => raid.id)));
      }
    }
    if (options.valleyId) {
      await tx.update(pveCamps).set({ respawnsAt: new Date('9999-01-01T00:00:00Z') })
        .where(eq(pveCamps.valleyId, options.valleyId));
    }
  });
}
/**
 * What NAMED ledger transactions moved into shard_burn, summed from their own
 * entries. Never assert a shard_burn BALANCE delta: it is one global system
 * account in a shared test DB, so a before/after subtraction silently measures
 * every other suite's concurrent burns as well (the land-partition suite raids
 * for real, and each of those antes burns). The per-transaction form is also
 * strictly stronger — it proves WHICH postings hit the sink.
 */
async function burnedByTxns(...idempotencyKeys: string[]): Promise<bigint> {
  const burnAcc = (await bootstrapSystemAccounts(db)).shard_burn;
  const [row] = await db.select({ s: sql<string>`coalesce(sum(${ledgerEntries.delta}), 0)::text` })
    .from(ledgerEntries)
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.txnId))
    .where(and(
      eq(ledgerEntries.accountId, burnAcc),
      inArray(ledgerTransactions.idempotencyKey, idempotencyKeys),
    )) as [{ s: string }];
  return BigInt(row.s);
}

/**
 * These fixtures are LANDOWNERS (`players.entryPaidAt` stamped). Every test in
 * this file exercises the PAID PvP economy — trophies, world-map picks, shields,
 * warzone, loot — and matchmaking is partitioned by land ownership since
 * 2026-08-09 (see land-partition.test.ts), so a paid-tier raid must be set up
 * between paid-tier bases. The deedless pool has its own suite.
 */
async function stampLand(wallet: string): Promise<void> {
  const paidAt = new Date();
  await db.update(players).set({ entryPaidAt: paidAt }).where(eq(players.wallet, wallet));
  await db.update(bases).set({ landPaidAt: paidAt }).where(eq(bases.ownerWallet, wallet));
}

/** Player with base + barracks + camp + a trained army, all completed. */
async function warlord(troops: Array<[string, number]> = [['highlander', 4], ['kegrunner', 2]]) {
  const p = await createTestPlayer(db);
  await ensureStartingBase(db, p.wallet);
  await stampLand(p.wallet);
  await fundTestKeep(db, p.wallet, 1_000_000n, 'test.fund', k());
  await rewardShards(db, p.wallet, 1_000_000n, 'test.fund.shards', k());
  // Placed inside the CENTERED claim [8,22), clear of the re-centered keep (14,14).
  await placeBuilding(db, p.wallet, 'barracks' as never, 17, 17, k());
  await completeDueJobs(db, p.wallet, future(120));
  await placeBuilding(db, p.wallet, 'camp' as never, 19, 19, k());
  await completeDueJobs(db, p.wallet, future(240));
  let t = 300;
  for (const [troop, n] of troops) {
    for (let i = 0; i < n; i++) {
      await trainTroop(db, p.wallet, troop as never, k(), future(t));
      t += 10;
      await completeDueTraining(db, p.wallet, future(t));
    }
  }
  return p;
}

/** Defender with surplus loot above vault cap. */
async function victim(surplus = 5_000n) {
  const p = await createTestPlayer(db);
  await ensureStartingBase(db, p.wallet);
  await stampLand(p.wallet);
  await placeBuilding(db, p.wallet, 'vault' as never, 17, 14, `${k()}-v`).catch(() => null);
  await fundTestKeep(db, p.wallet, BigInt(STRUCTURES.vault.capacity[0]!) + surplus, 'test.fund', k());
  await rewardShards(db, p.wallet, BigInt(STRUCTURES.vault.capacity[0]!) + surplus, 'test.fund.shards', k());
  await completeDueJobs(db, p.wallet, future(120));
  return p;
}

/** Bare attacker with a Keep + a little KEEP (to prove no KEEP is charged to raid). */
async function raider(keep = 5_000n) {
  const p = await createTestPlayer(db);
  await ensureStartingBase(db, p.wallet);
  await stampLand(p.wallet);
  if (keep > 0n) await fundTestKeep(db, p.wallet, keep, 'test.fund', k());
  if (keep > 0n) await rewardShards(db, p.wallet, keep, 'test.fund.shards', k());
  return p;
}

beforeAll(async () => {
  await bootstrapSystemAccounts(db);
});
afterAll(async () => {
  await conn.sql.end();
});

describe('army training', () => {
  it('trains within queue/camp capacity and completes into the roster', async () => {
    const p = await warlord([['highlander', 4]]);
    const state = await getArmyState(db, p.wallet);
    expect(state.counts.highlander).toBe(4);
    expect(state.rosterPts).toBe(8);
    expect(state.campCapacityPts).toBe(STRUCTURES.camp.capacityPts[0]);
  });

  it('rejects training past camp capacity', async () => {
    const p = await warlord([['turrider', 4]]); // 20 pts = full L1 camp
    await expect(trainTroop(db, p.wallet, 'highlander' as never, k(), future(700)))
      .rejects.toThrow(/camps are full/);
  });
});

describe('one-use trap persistence (M22)', () => {
  it('omits spent traps from new immutable defender snapshots', async () => {
    // WHY: a triggered trap remains a placed home-base row for repair UX, but
    // cannot damage another attacker until its repair builder job finishes.
    const att = await warlord([['highlander', 1]]);
    const def = await victim(0n);
    const [defBase] = await db.select({ id: bases.id }).from(bases)
      .where(eq(bases.ownerWallet, def.wallet)).limit(1);
    const [armed, spent] = await db.insert(buildings).values([
      {
        playerWallet: def.wallet, baseId: defBase?.id, type: BuildingType.SpikeTrap,
        level: 1, tx: 8, ty: 12,
      },
      {
        playerWallet: def.wallet, baseId: defBase?.id, type: BuildingType.PowderMine,
        level: 1, tx: 8, ty: 13, trapSpentAt: new Date('2026-08-15T08:00:00.000Z'),
      },
    ]).returning();

    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    const snapshotIds = new Set((raid.snapshot as { buildings: Array<{ id: string }> }).buildings
      .map((building) => building.id));
    expect(snapshotIds.has(armed!.id)).toBe(true);
    expect(snapshotIds.has(spent!.id)).toBe(false);
    expect(raid.snapshot).toMatchObject({ battlefieldVersion: 3,
      deploymentBlockers: [{ tx: 8, ty: 13, fw: 1, fh: 1 }],
    });
  });

  it('reserves unfinished building footprints without adding a combat target', async () => {
    const att = await warlord([['highlander', 1]]);
    const def = await victim(0n);
    const [defBase] = await db.select({ id: bases.id }).from(bases)
      .where(eq(bases.ownerWallet, def.wallet)).limit(1);
    const [building] = await db.insert(buildings).values({ playerWallet: def.wallet,
      baseId: defBase?.id, type: BuildingType.Camp, level: 1, tx: 18, ty: 18 }).returning();
    await db.insert(builderJobs).values({ playerWallet: def.wallet, baseId: defBase?.id,
      kind: 'build', buildingId: building!.id, startedAt: new Date(), finishesAt: future(10) });
    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    const snapshot = raid.snapshot as BaseSnapshot;
    expect(snapshot.buildings.some(b => b.id === building!.id)).toBe(false);
    expect(snapshot.deploymentBlockers).toContainEqual({ tx: 18, ty: 18, fw: 2, fh: 2 });
    await expect(submitOrders(db, att.wallet, raid.id, {
      deploys: [{ troop: 'highlander', tx: 19, ty: 19, tMs: 0 }], idempotencyKey: k(),
    })).rejects.toThrow(/deploy outside the deploy zone/);
  });

  it('marks a trap spent through real raid settlement, atomically with the result', async () => {
    // The ground troop's shortest path from (6,14) to the Keep crosses (8,14),
    // deterministically triggering this spike trap in SIM10.
    const att = await warlord([['highlander', 1]]);
    const def = await victim(0n);
    const [defBase] = await db.select({ id: bases.id }).from(bases)
      .where(eq(bases.ownerWallet, def.wallet)).limit(1);
    const [trap] = await db.insert(buildings).values({
      playerWallet: def.wallet, baseId: defBase?.id, type: BuildingType.SpikeTrap,
      level: 1, tx: 8, ty: 14,
    }).returning();

    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    await submitOrders(db, att.wallet, raid.id, {
      deploys: [{ troop: 'highlander', tx: 6, ty: 14, tMs: 0 }],
      idempotencyKey: k(),
    });

    const [resolved] = await db.select({ status: raids.status }).from(raids).where(eq(raids.id, raid.id));
    const [spent] = await db.select({ trapSpentAt: buildings.trapSpentAt }).from(buildings)
      .where(eq(buildings.id, trap!.id));
    expect(resolved!.status).toBe('resolved');
    expect(spent!.trapSpentAt).not.toBeNull();
  });

  it('persists only destroyed traps belonging to the frozen defender base', async () => {
    // WHY: simulator outcomes also contain destroyed structures. Settlement must
    // not stamp those rows, nor accept a foreign building id from malformed data.
    const def = await victim(0n);
    const foreign = await victim(0n);
    const [defBase] = await db.select({ id: bases.id }).from(bases)
      .where(eq(bases.ownerWallet, def.wallet)).limit(1);
    const [foreignBase] = await db.select({ id: bases.id }).from(bases)
      .where(eq(bases.ownerWallet, foreign.wallet)).limit(1);
    const [trap, structure, foreignTrap] = await db.insert(buildings).values([
      { playerWallet: def.wallet, baseId: defBase?.id, type: BuildingType.Pitfall, level: 1, tx: 8, ty: 10 },
      { playerWallet: def.wallet, baseId: defBase?.id, type: BuildingType.Cannon, level: 1, tx: 9, ty: 10 },
      { playerWallet: foreign.wallet, baseId: foreignBase?.id, type: BuildingType.AirMine, level: 1, tx: 8, ty: 10 },
    ]).returning();
    const spentAt = new Date('2026-08-15T09:00:00.000Z');
    const count = await persistSpentDefenderTraps(db, def.wallet, defBase?.id ?? null, [
      { id: trap!.id, destroyed: true },
      { id: structure!.id, destroyed: true },
      { id: foreignTrap!.id, destroyed: true },
    ], spentAt);
    expect(count).toBe(1);
    const rows = await db.select({ id: buildings.id, trapSpentAt: buildings.trapSpentAt })
      .from(buildings).where(inArray(buildings.id, [trap!.id, structure!.id, foreignTrap!.id]));
    expect(rows.find((row) => row.id === trap!.id)?.trapSpentAt).toEqual(spentAt);
    expect(rows.find((row) => row.id === structure!.id)?.trapSpentAt).toBeNull();
    expect(rows.find((row) => row.id === foreignTrap!.id)?.trapSpentAt).toBeNull();
  });
});

describe('raid energy (ECONOMY.md §4)', () => {
  it('auto-match has NO trophy band — trophies only ORDER candidates — and picks among the nearest-rated ten survivors', async () => {
    // WHY (D-099): the old ±15 % band, even widened ×3, left a rated player with
    // zero legal opponents once they out-climbed their cohort (the live 78-vs-16
    // trap, audit A2; the KEEP-11 "no eligible targets" report). Trophies now
    // ORDER the candidate page and nothing more: defenders 400,000 trophies away
    // are matched. The pick is uniform among the NEAREST-RATED survivors, capped
    // at autoMatchNearestPick, so exactly that many legal defenders stand at the
    // anchor with the single nearest of all SHIELDED — the pick must land on one
    // of the legal ten and never on the shielded one, whatever else the shared
    // DB holds further away.
    //
    // Isolation, stated: the attacker is K18 (bar: defender ≥ K9) and every
    // defender here is K9 — UNDER land-partition.test.ts's bar (its attackers
    // are K20 → ≥ K10), so that suite never sees these rows; its own transient
    // K10+ fixtures can reach this page, but only ~950,000 trophies away, far
    // outside the nearest ten. The attacker is shielded from birth: a shield
    // never stops its owner attacking, and it keeps a K18 landowner off every
    // other suite's candidate page. No empty-pool 404 is asserted here on
    // purpose — it cannot be proven from this file in a shared DB;
    // land-partition.test.ts owns that proof and the message it names.
    const attackerKeep = 18;
    const bar = pvpMinDefenderKeep(attackerKeep);
    expect(bar).toBeLessThan(pvpMinDefenderKeep(20));
    const att = await raider(5_000n);
    await db.update(players).set({ trophies: 1_000_000, keepLevel: attackerKeep })
      .where(eq(players.wallet, att.wallet));
    await db.insert(shields).values({
      playerWallet: att.wallet, source: 'loss', expiresAt: new Date('2999-01-01T00:00:00Z'),
    });
    const shielded = await victim(0n);
    await db.update(players).set({ trophies: 600_000, keepLevel: bar }).where(eq(players.wallet, shielded.wallet));
    await db.insert(shields).values({
      playerWallet: shielded.wallet, source: 'loss', expiresAt: new Date(Date.now() + 3_600_000),
    });
    const legal: string[] = [];
    for (let i = 0; i < RAID_RULES.autoMatchNearestPick; i++) {
      const v = await victim(0n);
      // One trophy further each, so the page's ORDER is exactly this list.
      await db.update(players).set({ trophies: 600_000 - 1 - i, keepLevel: bar }).where(eq(players.wallet, v.wallet));
      legal.push(v.wallet);
    }

    const raid = await createRaid(db, att.wallet, { idempotencyKey: k() }); // NO defenderWallet = auto-match
    expect(legal).toContain(raid.defenderWallet);
    expect(raid.defenderWallet).not.toBe(shielded.wallet);

    // Cleanup: the extreme trophies would otherwise leak into the GLOBAL players
    // table and skew the league-reset pool-split test (top-league membership is
    // derived from trophies; the suite shares one DB), and the K9 defenders go
    // back to K1 so no later Keep-gated test anywhere inherits them.
    await db.update(players).set({ trophies: 0, keepLevel: 1 })
      .where(inArray(players.wallet, [att.wallet, shielded.wallet, ...legal]));
  });

  it('the orders deadline covers the FIGHT, not just the pre-battle window', () => {
    // WHY: troops can now be committed mid-raid (COMBAT-UX-PLAN A3b), so the client
    // submits the completed order list AFTER the battle. If the deadline were still
    // deployWindowSec alone, every raid that actually used reserves would 422 with
    // 'deploy window expired' — the player would fight, then lose the result.
    const storedDeadlineSec = RAID_RULES.deployWindowSec + RAID_RULES.battleDurationSec;
    expect(storedDeadlineSec).toBe(120);
    expect(raidOrdersWindowMs()).toBe(120_000);
    const storedDeadline = new Date('2026-08-13T12:02:00.000Z');
    expect(batchOrdersSubmitDeadlineAt(storedDeadline).getTime() - storedDeadline.getTime())
      .toBe(RAID_RULES.batchOrdersGraceSec * 1_000);
    expect(batchOrdersSubmitDeadlineAt(storedDeadline).getTime()
      - Date.parse('2026-08-13T12:00:00.000Z')).toBe(130_000);
    // The legal 6s SIM9 drain plus BattleScene done/transport tail cannot hit
    // the expiry when a player uses the final millisecond of all 30 deploy seconds.
    expect(RAID_RULES.batchOrdersGraceSec * 10)
      .toBeGreaterThanOrEqual(RAID_REPLAY_LIMITS.postBattleDrainTicks);
  });

  it('resolves a batch order list whose later deploy lands after every earlier attacker is dead (D-106 reserve-after-wipe)', async () => {
    // WHY (ferdblabla 2026-09-04, "after i put some troops and start, when
    // those troops died it immediate end the raid"): the client now keeps a
    // batch fight open while reserves sit in the tray and releases them later,
    // so the list it finally posts has a gap during which no attacker was
    // alive. The simulator must idle through that gap and resume at the
    // reserve's tick, and this route must accept the list like any other —
    // nothing here may read "everyone died" as "the raid ended". Stage 1's
    // cannon kills a lone L1 highlander from (6,14) at tick 251.
    const att = await warlord([['highlander', 2]]);
    const raid = await createCampaignRaid(db, att.wallet, 1, k());
    await submitOrders(db, att.wallet, raid.id, {
      deploys: [
        { troop: 'highlander', tx: 6, ty: 14, tMs: 0 },
        { troop: 'highlander', tx: 6, ty: 14, tMs: 60_000 },
      ],
      idempotencyKey: k(),
    });
    const [resolved] = await db.select({ status: raids.status }).from(raids).where(eq(raids.id, raid.id));
    expect(resolved!.status).toBe('resolved');
    const replay = await getReplay(db, att.wallet, raid.id);
    const events = replay.events as Array<{ t: number; e: string; id?: number }>;
    const deploys = events.filter((ev) => ev.e === 'deploy');
    expect(deploys.map((ev) => ev.t)).toEqual([0, 600]);
    const firstDeath = events.find((ev) => ev.e === 'troopDeath' && ev.id === deploys[0]!.id);
    expect(firstDeath, 'the first wave died before the reserve landed').toBeDefined();
    expect(firstDeath!.t).toBeLessThan(600);
    expect(events.at(-1)!.t, 'the fight went on after the reserve').toBeGreaterThan(600);
    // The window: a client holding the field open posts at the TRUE clock end
    // (ATTACK at the last deploy second + 90 s + the 1 s verdict tail); the
    // batch tail still covers that with room for the round trip.
    expect(RAID_RULES.deployWindowSec + RAID_RULES.battleDurationSec + 1)
      .toBeLessThan(RAID_RULES.deployWindowSec + RAID_RULES.battleDurationSec + RAID_RULES.batchOrdersGraceSec);
  });

  it('accepts a pre-rollout batch row during the internal tail without changing its deadline', async () => {
    // WHY: production can already hold pending deploy+fight rows with no new
    // wire capability. A rolling API deploy must fix their final POST too, while
    // preserving `ordersDeadlineAt` so old web still derives the same cutoff.
    const att = await warlord([['highlander', 1]]);
    const raid = await createCampaignRaid(db, att.wallet, 1, k());
    const expectedCreatedAt = raid.ordersDeadlineAt.getTime() - raidOrdersWindowMs();
    expect(Math.abs(raid.createdAt.getTime() - expectedCreatedAt))
      // `createdAt` is the transaction clock while the deadline uses the
      // caller's timestamp immediately before it; only the window is invariant.
      .toBeLessThan(100);
    const frozen = raid.armySnapshot as {
      counts: Record<string, number>;
      levels: Record<string, number>;
      features?: Record<string, unknown>;
    };
    expect(frozen.features?.batchOrdersGraceSec).toBe(RAID_RULES.batchOrdersGraceSec);
    const { batchOrdersGraceSec: _newCapability, ...legacyFeatures } = frozen.features ?? {};
    await db.update(raids).set({
      armySnapshot: { ...frozen, features: legacyFeatures },
    }).where(eq(raids.id, raid.id));

    const duringTail = new Date(batchOrdersSubmitDeadlineAt(raid.ordersDeadlineAt).getTime() - 1);
    await expect(submitOrders(db, att.wallet, raid.id, {
      deploys: [{ troop: 'highlander', tx: 6, ty: 14, tMs: 0 }],
      idempotencyKey: k(),
    }, duringTail)).resolves.toBeDefined();
  });

  it('the /base HUD heals abandoned raids: only a march with nothing journaled expires', async () => {
    // WHY: base.ts used to run its own energy count with NO status filter while
    // the authoritative pvpRaidsToday excludes 'expired' (#58) — so a RETREATed
    // raid showed 1/6 spent in the HUD all day even though createRaid would
    // happily accept the next attack. The HUD must go through getRaidEnergy,
    // which expires stale raids first (verification 2026-07-26, critic major).
    // WHY (D-099): a batch raid journals each order as it is placed, and a
    // journaled march is the worker's to finish — never the HUD sweep's to
    // refund, or a closed tab would erase a fight that already threw troops.
    // Abandonment is a march with NOTHING journaled.
    const att = await warlord();
    const v = await victim(0n);
    const shardsBefore = await shardBalance(att.wallet);
    const raid = await createRaid(db, att.wallet, { defenderWallet: v.wallet, idempotencyKey: k() });
    const shardsAfterCreate = await shardBalance(att.wallet);
    expect(shardsAfterCreate).toBeLessThan(shardsBefore);
    await db.execute(sql`UPDATE raids SET orders_deadline_at = NOW() - INTERVAL '1 minute' WHERE id = ${raid.id}`);
    const { getBaseState } = await import('../src/game/base');
    const state = await getBaseState(db, att.wallet);
    expect(state.energy.used).toBe(0); // the abandoned raid expired + reclaimed
    expect(state.energy.free).toBe(RAID_ENERGY.freePerDay);
    // Current-version abandonment keeps the ante as the existing scouting
    // deterrent. Only a system-caused simulator mismatch earns reversal — a
    // batch journal is not a live reservation, so its ante is not returned.
    expect(await shardBalance(att.wallet)).toBe(shardsAfterCreate);
    expect(await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `raid-ante-refund:${raid.id}`)))
      .toHaveLength(0);

    const journaled = await createRaid(db, att.wallet, {
      defenderWallet: (await victim(0n)).wallet, idempotencyKey: k(),
    });
    await acceptLiveRaidCommand(db, att.wallet, journaled.id, 'journal-1', {
      kind: 'deploy', payload: { troop: 'highlander', tx: 6, ty: 14, tMs: 0 },
    });
    await db.execute(sql`UPDATE raids SET orders_deadline_at = NOW() - INTERVAL '1 minute' WHERE id = ${journaled.id}`);
    const healed = await getBaseState(db, att.wallet);
    expect(healed.energy.used).toBe(1); // the journaled march is still a fight
    expect((await db.select({ status: raids.status }).from(raids)
      .where(eq(raids.id, journaled.id)))[0]!.status).toBe('pending_orders');
  });

  it('a journaled PvE raid whose client never finishes is settled by the sweep at the deadline with the orders received', async () => {
    // WHY (D-099, owner: "raid should continue and finish and can be replayed
    // even if player got disconnected mid raid or crashed or closed game"):
    // the orders already journaled are the fight. No sweep may expire or refund
    // them; the worker settles them once, through the same path an online
    // client's FINISH takes — result, events, replay (no bounty: D-152).
    const att = await warlord([['highlander', 6], ['kegrunner', 2]]);
    const valley = await createTestValley(db, {
      name: `JOURNAL SWEEP ${k()}`, createdAt: new Date('2000-01-04T00:00:00Z'),
    });
    let raidId: string | null = null;
    try {
      const [camp] = await db.insert(pveCamps).values({
        valleyId: valley.id, x: 0, y: 0, tier: 1,
        snapshot: makeCampSnapshot(1), lootKeep: BigInt(PVE.bountyByTier[0]!),
      }).returning();
      const t0 = new Date();
      const raid = await createPveRaid(db, att.wallet, camp!.id, k(), t0);
      raidId = raid.id;
      const frozen = raid.armySnapshot as { features?: { batchCommandJournal?: boolean } };
      expect(frozen.features?.batchCommandJournal).toBe(true);
      // Five highlanders at t=0, a late reserve, two kegrunners: a decisive
      // win over the tier-1 camp (keep L1 + one cannon), so the no-bounty
      // assertion below covers a REAL victory and not a coin toss.
      const drops = [
        ...Array.from({ length: 6 }, (_, index) => ({
          troop: 'highlander' as const, tx: 6, ty: 12 + index, tMs: index < 5 ? 0 : 4_000,
        })),
        { troop: 'kegrunner' as const, tx: 6, ty: 18, tMs: 0 },
        { troop: 'kegrunner' as const, tx: 6, ty: 19, tMs: 0 },
      ];
      for (const [index, order] of drops.entries()) {
        await acceptLiveRaidCommand(db, att.wallet, raid.id, `sweep-${index}`, {
          kind: 'deploy', payload: order,
        }, new Date(t0.getTime() + 20_000 + index * 1_000));
      }
      const deadline = batchOrdersSubmitDeadlineAt(raid.ordersDeadlineAt);

      // The client is gone. The attacker's own sweeps past the deadline leave
      // the journaled march alone...
      await getRaidLog(db, att.wallet, new Date(deadline.getTime() + 1));
      expect((await db.select({ status: raids.status }).from(raids)
        .where(eq(raids.id, raid.id)))[0]!.status).toBe('pending_orders');
      // ...and the whole-list POST is refused: the journal is the only input now.
      await expect(submitOrders(db, att.wallet, raid.id, {
        deploys: [{ troop: 'highlander', tx: 6, ty: 14, tMs: 0 }], idempotencyKey: k(),
      }, new Date(t0.getTime() + 60_000))).rejects.toMatchObject({ code: 'RAID_LIVE_STREAM_REQUIRED' });

      // The worker settles it, once, with exactly what was journaled.
      await expect(recoverDueStartedLiveRaids(db, new Date(deadline.getTime() + 1), undefined, raid.id))
        .resolves.toEqual({ resolved: 1, raced: 0 });
      expect((await db.select({ status: raids.status }).from(raids)
        .where(eq(raids.id, raid.id)))[0]!.status).toBe('resolved');
      const replay = await getReplay(db, att.wallet, raid.id);
      expect((replay.orders as { deploys: unknown[] }).deploys).toEqual(drops);
      expect((replay.events as unknown[]).length).toBeGreaterThan(0);
      const result = replay.result as { stars: number; destructionPct: number };
      expect(result.stars).toBeGreaterThan(0);
      // D-152 (owner 2026-09-20): a cleared camp pays NOTHING. The old KEEP
      // bounty was the largest custodial KEEP faucet; no settlement path — online
      // FINISH or the worker — may post it, and a late second settlement is a no-op.
      const bounty = () => db.select().from(ledgerTransactions)
        .where(eq(ledgerTransactions.idempotencyKey, `raid:${raid.id}:bounty`));
      expect(await bounty()).toHaveLength(0);
      await expect(recoverDueStartedLiveRaids(db, new Date(deadline.getTime() + 5_001), undefined, raid.id))
        .resolves.toEqual({ resolved: 0, raced: 0 });
      expect(await bounty()).toHaveLength(0);
      // No refund of the PvE attempt: the fight happened.
      expect(await db.select().from(ledgerTransactions)
        .where(eq(ledgerTransactions.idempotencyKey, `raid-ante-refund:${raid.id}`)))
        .toHaveLength(0);
    } finally {
      // The old delete removed this sweep fixture and its one-camp valley.
      // Keep its immutable replay; retire a partial run and tombstone the camp
      // so later workers cannot resume it or expose this private PvE target.
      // The retained 2000-dated valley never replaces a newer playable cohort.
      await retireFixtureRaids(raidId ? [raidId] : [], { valleyId: valley.id });
    }
  });

  it('6 free raids/day then SOL-bought energy, NO daily ceiling, NO KEEP charged', async () => {
    const att = await raider(50_000n);
    const keepBefore = await balance(att.wallet);
    const burnBefore = await burnBalance();
    const free = RAID_ENERGY.freePerDay;
    const victims = [];
    for (let i = 0; i < free + 3; i++) victims.push(await victim(0n));

    for (let i = 0; i < free; i++) {
      await createRaid(db, att.wallet, { defenderWallet: victims[i]!.wallet, idempotencyKey: k() });
    }
    // One past the free allowance needs energy the player doesn't have.
    await expect(createRaid(db, att.wallet, { defenderWallet: victims[free]!.wallet, idempotencyKey: k() }))
      .rejects.toThrow(/out of raid energy/);

    // Energy is pay-per-action on-chain (v3): the +1 lands after a real SOL
    // payment is verified at finalized (deposit flow). Simulated here; the
    // on-chain leg is covered by the deposit-watcher + anchor tests.
    await assertEnergyPurchasable(db, att.wallet);
    expect(await grantPurchasedEnergy(db, att.wallet)).toBe(1);
    await createRaid(db, att.wallet, { defenderWallet: victims[free]!.wallet, idempotencyKey: k() });

    // THE POINT (owner 2026-07-26): past the old 6/day ceiling there is no
    // ceiling. Buying stays allowed and every bought energy is spendable, so a
    // player who keeps paying keeps raiding — this is what a surviving cap
    // constant would silently break.
    await assertEnergyPurchasable(db, att.wallet);
    await grantPurchasedEnergy(db, att.wallet);
    await grantPurchasedEnergy(db, att.wallet);
    await createRaid(db, att.wallet, { defenderWallet: victims[free + 1]!.wallet, idempotencyKey: k() });
    await createRaid(db, att.wallet, { defenderWallet: victims[free + 2]!.wallet, idempotencyKey: k() });
    const status = await getRaidEnergy(db, att.wallet);
    expect(status.used).toBe(free + 3); // more raids today than the old cap allowed
    expect(status.max).toBe(free);      // `max` is the free allowance, not a ceiling

    // NOT ONE KEEP was charged for raiding, and no KEEP was burned — the ante is
    // shards (asserted separately), never the deposited currency.
    expect(await balance(att.wallet)).toBe(keepBefore);
    expect(await burnBalance()).toBe(burnBefore);
  });

  it('burns a Keep-level-scaled SHARD ante per PvP raid', async () => {
    const att = await raider(50_000n);
    await db.update(players).set({ keepLevel: 7 }).where(eq(players.wallet, att.wallet));
    const ante = BigInt(pvpAttackShardCostForKeepLevel(7));
    expect(ante).toBeGreaterThan(0n);

    const shardsBefore = await shardBalance(att.wallet);
    const anteKey = k();
    // D-099: a K7 attacker may only attack K≥4, so the victim is lifted to exactly
    // the bar — this test is about the ante, not the gate.
    const def = await victim(0n);
    await db.update(players).set({ keepLevel: pvpMinDefenderKeep(7) }).where(eq(players.wallet, def.wallet));
    const created = await createRaid(db, att.wallet, {
      defenderWallet: def.wallet, idempotencyKey: anteKey,
    });
    // Debited from the attacker and burned — the ante is a SINK, not a transfer
    // to the defender, so it can't be farmed back by raiding a friend.
    expect(await shardBalance(att.wallet)).toBe(shardsBefore - ante);
    // Asserted on THIS ante's own ledger entries, not on the shard_burn BALANCE:
    // shard_burn is a global system account in a shared test DB, so a balance
    // delta silently measures every other suite's concurrent burns too. The
    // per-transaction form is both parallel-safe and strictly stronger — it proves
    // where this ante went, not merely that the total moved by the right amount.
    const burnAcc = (await bootstrapSystemAccounts(db)).shard_burn;
    const [txn] = await db.select({ id: ledgerTransactions.id, type: ledgerTransactions.type })
      .from(ledgerTransactions).where(eq(
        ledgerTransactions.idempotencyKey, `raid-ante:${created.idempotencyKey}`,
      ));
    expect(txn?.type).toBe('raid.ante');
    const legs = await db.select({ accountId: ledgerEntries.accountId, delta: ledgerEntries.delta })
      .from(ledgerEntries).where(eq(ledgerEntries.txnId, txn!.id));
    const attAcc = await getOrCreatePlayerAccount(db, att.wallet, 'player_shards');
    expect(legs.find((l) => l.accountId === attAcc.id)?.delta).toBe(-ante);
    expect(legs.find((l) => l.accountId === burnAcc)?.delta).toBe(ante);

    // A higher Keep pays more: the ante has to keep scaling or it stops being a
    // throttle exactly where attack volume matters most.
    expect(pvpAttackShardCostForKeepLevel(15)).toBeGreaterThan(pvpAttackShardCostForKeepLevel(7));
  });

  it('refuses the raid when the attacker cannot afford the shard ante', async () => {
    // Energy alone must not authorise an attack: without this the ante would be
    // advisory and a broke player could raid free, which is the whole throttle.
    const att = await raider(0n);
    await db.update(players).set({ keepLevel: 10 }).where(eq(players.wallet, att.wallet));
    // Shielded from birth (D-099 shared-DB courtesy): a shield never stops its
    // owner attacking, and it keeps this K10 landowner off every other suite's
    // Keep-gated auto-match page — land-partition.test.ts proves empty pools
    // against exactly that promise.
    await db.insert(shields).values({
      playerWallet: att.wallet, source: 'loss', expiresAt: new Date('2999-01-01T00:00:00Z'),
    });
    // New bases now receive 2,000 starter SHARDS. Empty the account explicitly;
    // this test is about insufficient ante handling, not the onboarding amount.
    const starter = await shardBalance(att.wallet);
    await spendShards(db, att.wallet, starter, 'test.empty_shards', k());
    const v = await victim(0n);
    // D-099: the K10 attacker may only attack K≥5; without this lift the Keep gate
    // would refuse the raid before the ante was ever checked.
    await db.update(players).set({ keepLevel: pvpMinDefenderKeep(10) }).where(eq(players.wallet, v.wallet));
    // Must be a readable 422, not a raw ledger error: the RaidUI branches on the
    // message to decide what to offer the player.
    await expect(createRaid(db, att.wallet, { defenderWallet: v.wallet, idempotencyKey: k() }))
      .rejects.toThrow(/not enough shards to attack/);
    // …and nothing was half-created: no raid row, energy untouched.
    expect((await getRaidEnergy(db, att.wallet)).used).toBe(0);
  });

  it('refunds energy for an ABANDONED raid — no attack, no energy lost (#58)', async () => {
    const att = await raider(50_000n);
    const free = RAID_ENERGY.freePerDay;
    // Spend every free raid, then NEVER submit orders (the attack never happens).
    let lastDeadline = new Date(0);
    for (let i = 0; i < free; i++) {
      const created = await createRaid(db, att.wallet, {
        defenderWallet: (await victim(0n)).wallet, idempotencyKey: k(),
      });
      lastDeadline = created.ordersDeadlineAt;
    }
    expect((await getRaidEnergy(db, att.wallet)).used).toBe(free); // all spent while pending
    await expect(createRaid(db, att.wallet, { defenderWallet: (await victim(0n)).wallet, idempotencyKey: k() }))
      .rejects.toThrow(/out of raid energy/);

    // Cross the authoritative stored expiry — deploy + battle + bounded tail.
    // Using the row boundary keeps this abandonment test independent of timing changes.
    const later = new Date(batchOrdersSubmitDeadlineAt(lastDeadline).getTime() + 1);
    const e = await getRaidEnergy(db, att.wallet, later); // runs expireStaleRaids
    expect(e.used).toBe(0);      // energy is GIVEN BACK — the attacks never happened
    expect(e.free).toBe(free);   // the whole free allowance is available again
    // And a fresh raid works now.
    await createRaid(db, att.wallet, { defenderWallet: (await victim(0n)).wallet, idempotencyKey: k() }, later);
    expect((await getRaidEnergy(db, att.wallet, later)).used).toBe(1);
  });

  it('energy deposit credit grants exactly once (idempotent) and enforces the on-chain price', async () => {
    const att = await raider(0n);
    // Minting the stable quote materializes/selects the deed that owns the
    // purchased energy; the wallet is payment authority only.
    const under = await createDepositIntent(db, att.wallet, 'energy');
    const [attackerBase] = await db.select({ id: bases.id }).from(bases)
      .where(eq(bases.ownerWallet, att.wallet)).limit(1);
    const energyOf = async (): Promise<number> => (await db.select({ e: baseProfiles.purchasedEnergy })
      .from(baseProfiles).where(eq(baseProfiles.baseId, attackerBase!.id)))[0]?.e ?? 0;
    const before = await energyOf();
    const pay = (lamports: bigint): VerifiedPayment => ({
      txSignature: `sig-${k()}`, wallet: att.wallet, kind: 'energy', lamports, finalized: true,
    });

    // Underpaying the on-chain amount grants nothing (the tx rolls back).
    await expect(creditDeposit(db, under.id, pay(BigInt(RAID_ENERGY.solLamportsPerEnergy) - 1n)))
      .rejects.toThrow(/underpaid/);
    expect(await energyOf()).toBe(before);

    // A verified full-price payment grants +1; re-crediting the same deposit row
    // (the idempotency anchor) grants nothing more.
    const intent = await createDepositIntent(db, att.wallet, 'energy');
    const full = pay(BigInt(RAID_ENERGY.solLamportsPerEnergy));
    expect((await creditDeposit(db, intent.id, full)).credited).toBe(true);
    expect((await creditDeposit(db, intent.id, full)).credited).toBe(false);
    expect(await energyOf()).toBe(before + 1);
  });

  it('an energy PACK credit grants all 6 at the per-unit discount, never partially', async () => {
    const att = await raider(0n);
    const under = await createDepositIntent(db, att.wallet, 'energy_pack');
    const [attackerBase] = await db.select({ id: bases.id }).from(bases)
      .where(eq(bases.ownerWallet, att.wallet)).limit(1);
    const energyOf = async (): Promise<number> => (await db.select({ e: baseProfiles.purchasedEnergy })
      .from(baseProfiles).where(eq(baseProfiles.baseId, attackerBase!.id)))[0]?.e ?? 0;
    const before = await energyOf();
    const pay = (lamports: bigint): VerifiedPayment => ({
      txSignature: `sig-${k()}`, wallet: att.wallet, kind: 'energy_pack', lamports, finalized: true,
    });

    // The pack has its OWN price: paying the single-energy 0.03 against a pack
    // intent must grant NOTHING (not 1 of 6) — the grant loop lives inside the
    // credit transaction, so underpayment rolls the whole thing back.
    await expect(creditDeposit(db, under.id, pay(BigInt(RAID_ENERGY.solLamportsPerEnergy))))
      .rejects.toThrow(/underpaid/);
    expect(await energyOf()).toBe(before);

    // Full pack price → all packSize at once; the deposit row stays the
    // idempotency anchor, so a re-credit grants nothing more.
    const intent = await createDepositIntent(db, att.wallet, 'energy_pack');
    const full = pay(BigInt(RAID_ENERGY.packLamports));
    expect((await creditDeposit(db, intent.id, full)).credited).toBe(true);
    expect((await creditDeposit(db, intent.id, full)).credited).toBe(false);
    expect(await energyOf()).toBe(before + RAID_ENERGY.packSize);
  });

  it('createRaid is idempotent: a retried key returns the same raid, no double energy', async () => {
    const att = await raider(0n);
    const def = await victim(0n);
    const key = k();
    const r1 = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: key });
    const r2 = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: key });
    expect(r2.id).toBe(r1.id); // same raid, not a second one (no second energy spent)
  });

  it('namespaces create keys by actor and raid kind instead of returning a foreign row', async () => {
    const a = await raider(5_000n);
    const b = await raider(5_000n);
    const da = await victim(0n);
    const dbb = await victim(0n);
    const shared = k();
    const [aRaid, bRaid] = await Promise.all([
      createRaid(db, a.wallet, { defenderWallet: da.wallet, idempotencyKey: shared }),
      createRaid(db, b.wallet, { defenderWallet: dbb.wallet, idempotencyKey: shared }),
    ]);
    expect(bRaid.id).not.toBe(aRaid.id);
    expect([aRaid.attackerWallet, bRaid.attackerWallet]).toEqual([a.wallet, b.wallet]);

    // Key isolation still needs a playable first-campaign roster. Empty
    // novice campaigns now fail admission before they can create a row.
    await db.insert(army).values({ playerWallet: a.wallet, troop: 'plunderer', count: 1 });
    const campaign = await createCampaignRaid(db, a.wallet, 1, shared);
    expect(campaign.id).not.toBe(aRaid.id);
    expect(campaign.campaignStage).toBe(1);
  });

  it('rejects reuse of one actor/kind key with a different payload', async () => {
    const attacker = await raider(5_000n);
    const first = await victim(0n);
    const second = await victim(0n);
    const shared = k();
    await createRaid(db, attacker.wallet, { defenderWallet: first.wallet, idempotencyKey: shared });
    await expect(createRaid(db, attacker.wallet, {
      defenderWallet: second.wallet, idempotencyKey: shared,
    })).rejects.toMatchObject({ code: 'RAID_IDEMPOTENCY_MISMATCH' });
  });
});

describe('raid lifecycle', () => {
  it('keeps the HTTP order envelope aligned with the legal 720-Bowman camp ceiling', () => {
    const deploys = Array.from({ length: RAID_REPLAY_LIMITS.maxDirectDeploys }, () => ({
      troop: 'bowman' as const, tx: -4, ty: 0, tMs: 0,
    }));
    expect(RAID_REPLAY_LIMITS.maxDirectDeploys).toBe(720);
    expect(OrdersBodySchema.safeParse({ deploys, idempotencyKey: k() }).success).toBe(true);
    expect(OrdersBodySchema.safeParse({
      deploys: [...deploys, deploys[0]], idempotencyKey: k(),
    }).success).toBe(false);
  });

  it('rejects a forged spawn-only Barrowling order before simulation or army consumption', async () => {
    const att = await warlord([['highlander', 1]]);
    const def = await victim();
    await db.insert(army).values({ playerWallet: att.wallet, troop: 'barrowling', count: 1 });
    const created = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    await expect(submitOrders(db, att.wallet, created.id, {
      deploys: [{ troop: 'barrowling', tx: 6, ty: 14, tMs: 0 }],
      idempotencyKey: k(),
    })).rejects.toThrow(/cannot be deployed directly/);
    const [pending] = await db.select().from(raids).where(eq(raids.id, created.id));
    expect(pending).toMatchObject({ status: 'pending_orders', events: null });
    const [summon] = await db.select().from(army).where(and(
      eq(army.playerWallet, att.wallet), eq(army.troop, 'barrowling'),
    ));
    expect(summon?.count).toBe(1);
  });

  it('refuses a former base owner before creating a bulk deployment receipt', async () => {
    const att = await warlord([['highlander',1]]);
    const def = await victim();
    const buyer = await createTestPlayer(db);
    const raid = await createRaid(db,att.wallet,{defenderWallet:def.wallet,idempotencyKey:k()});
    const [base] = await db.insert(bases).values({ownerWallet:buyer.wallet,status:'active'}).returning();
    await db.update(raids).set({attackerBaseId:base!.id}).where(eq(raids.id,raid.id));
    await expect(submitOrders(db,att.wallet,raid.id,{
      deploys:[{troop:'highlander',tx:6,ty:14,tMs:0}],idempotencyKey:k(),
    })).rejects.toMatchObject({code:'DEED_OWNERSHIP_CHANGED'});
    const [pending] = await db.select().from(raids).where(eq(raids.id,raid.id));
    expect(pending?.bulkDeploymentAcceptedAt).toBeNull();
    const activity = await db.execute(sql`select id from player_action_events where source_table='raids' and source_id=${raid.id} and source_key='battle_fought'`);
    expect(activity).toHaveLength(0);
  });

  it('fails a reciprocal second simulation fast, leaves it retryable, then resolves after permit release', async () => {
    // WHY: a legal max roster is seconds of synchronous CPU. Distinct raids may
    // not queue on the event loop, and reciprocal A→B/B→A also probes canonical
    // participant lock order once the loser retries.
    const a = await warlord([['highlander', 2]]);
    const bPlayer = await warlord([['highlander', 2]]);
    const ab = await createRaid(db, a.wallet, { defenderWallet: bPlayer.wallet, idempotencyKey: k() });
    const ba = await createRaid(db, bPlayer.wallet, { defenderWallet: a.wallet, idempotencyKey: k() });
    const shortDeadline = new Date(Date.now() + 5_000);
    await db.update(raids).set({ ordersDeadlineAt: shortDeadline })
      .where(inArray(raids.id, [ab.id, ba.id]));
    const submit = (wallet: string, id: string) => submitOrders(db, wallet, id, {
      deploys: [{ troop: 'highlander', tx: 6, ty: 14, tMs: 0 }],
      idempotencyKey: k(),
    });
    const raced = await Promise.allSettled([
      submit(a.wallet, ab.id),
      submit(bPlayer.wallet, ba.id),
    ]);
    expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = raced.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
    expect(rejected.reason).toMatchObject({ statusCode: 503, code: 'RAID_SIMULATION_BUSY' });
    const rows = await db.select().from(raids).where(inArray(raids.id, [ab.id, ba.id]));
    const pending = rows.find((r) => r.status === 'pending_orders')!;
    const resolved = rows.find((r) => r.status === 'resolved')!;
    expect(pending.simulationLeaseToken).toBeNull();
    expect(pending.simulationSystemAttemptedAt).toBeNull();
    expect(pending.ordersDeadlineAt.getTime())
      .toBeGreaterThanOrEqual(shortDeadline.getTime() + 100_000);
    expect(pending.ordersDeadlineAt.getTime()).toBeLessThanOrEqual(
      pending.createdAt.getTime()
        + raidOrdersWindowMs() * 2,
    );
    expect(resolved.simulationLeaseToken).toBeNull();
    expect(pending.bulkDeploymentAcceptedAt).toBeInstanceOf(Date);
    await expect(submit(pending.attackerWallet, pending.id)).resolves.toBeDefined();
    const retried = (await db.select().from(raids).where(eq(raids.id,pending.id)))[0]!;
    expect(retried.bulkDeploymentAcceptedAt).toEqual(pending.bulkDeploymentAcceptedAt);
    const activity = await db.execute(sql`select id from player_action_events where source_table='raids' and source_id=${pending.id} and source_key='battle_fought'`);
    expect(activity).toHaveLength(1);
  }, 20_000);

  it('rejects invalid deployments before BUSY or an activity receipt without refunding the scouting ante', async () => {
    // WHY: invalid deploys must fail before the durable acceptance boundary,
    // even when a different player occupies the CPU slot. Neither activity
    // credit nor a refundable server-failure receipt is earned by invalid input.
    const att = await warlord([['highlander', 1]]);
    const def = await victim(5_000n);
    const shardsBefore = await shardBalance(att.wallet);
    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    const afterCreate = await shardBalance(att.wallet);
    expect(afterCreate).toBeLessThan(shardsBefore);
    const otherRaidPermit = claimRaidSimulationPermit();
    try {
      await expect(submitOrders(db, att.wallet, raid.id, {
        // Inside the claim: schema-valid, but authoritative validation rejects it.
        deploys: [{ troop: 'highlander', tx: 15, ty: 15, tMs: 0 }],
        idempotencyKey: k(),
      })).rejects.toMatchObject({ statusCode: 422 });
    } finally {
      await otherRaidPermit.release();
    }
    const [refused] = await db.select().from(raids).where(eq(raids.id, raid.id));
    expect(refused).toMatchObject({
      status: 'pending_orders', simulationSystemAttemptedAt: null, bulkDeploymentAcceptedAt: null,
    });
    expect(refused!.ordersDeadlineAt.getTime()).toBeLessThanOrEqual(
      refused!.createdAt.getTime()
        + raidOrdersWindowMs() * 2,
    );

    const activity = await db.execute(sql`select id from player_action_events where source_table='raids' and source_id=${raid.id} and source_key='battle_fought'`);
    expect(activity).toHaveLength(0);

    const sweepAt = new Date();
    await db.update(raids).set({
      ordersDeadlineAt: new Date(
        sweepAt.getTime() - RAID_RULES.batchOrdersGraceSec * 1_000 - 1_000,
      ),
    })
      .where(eq(raids.id, raid.id));
    await getRaidEnergy(db, att.wallet, sweepAt);
    const [expired] = await db.select().from(raids).where(eq(raids.id, raid.id));
    expect(expired).toMatchObject({ status: 'expired', simulationSystemAttemptedAt: null });
    expect(await shardBalance(att.wallet)).toBe(afterCreate);
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `raid-ante-refund:${raid.id}`,
    ))).toHaveLength(0);
  });

  it('keeps stale-worker compensation fenced to the exact simulation lease token', async () => {
    const att = await warlord([['highlander', 1]]);
    const def = await victim(5_000n);
    const shardsBefore = await shardBalance(att.wallet);
    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    const shardsAfter = await shardBalance(att.wallet);
    const staleToken = '00000000-0000-4000-8000-000000000001';
    const ownerToken = '00000000-0000-4000-8000-000000000002';
    await db.update(raids).set({
      simulationLeaseToken: ownerToken,
      simulationLeaseUntil: future(1),
    }).where(eq(raids.id, raid.id));

    expect(await compensatePendingRaid(db, raid, false, staleToken)).toBe(false);
    expect((await db.select().from(raids).where(eq(raids.id, raid.id)))[0])
      .toMatchObject({ status: 'pending_orders', simulationLeaseToken: ownerToken });
    expect(await shardBalance(att.wallet)).toBe(shardsAfter);
    expect(await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `raid-ante-refund:${raid.id}`)))
      .toHaveLength(0);

    expect(await compensatePendingRaid(db, raid, false, ownerToken)).toBe(true);
    expect(await shardBalance(att.wallet)).toBe(shardsBefore);
    expect(await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `raid-ante-refund:${raid.id}`)))
      .toHaveLength(1);
  });

  it('pins the current replay protocol when every raid kind is created', async () => {
    // WHY: a schema default only represents the simulator that existed when the
    // migration landed. PvP, camp PvE, and campaign all have independent INSERTs;
    // missing any one lets a deploy straddle the next rollout unnoticed.
    const att = await warlord();
    const def = await victim();
    const pvpKey = k();
    const pvp = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: pvpKey });

    // This suite shares a DB with world.test. Keep the fixture deliberately old
    // so ensurePlotAssigned never mistakes this one-camp test valley for the
    // newest playable valley while files run concurrently.
    const valley = await createTestValley(db, {
      name: `SIM PIN ${k()}`,
      createdAt: new Date('2000-01-01T00:00:00Z'),
    });
    const fixtureRaidIds = [pvp.id];
    try {
      const [camp] = await db.insert(pveCamps).values({
        valleyId: valley.id,
        x: 0,
        y: 0,
        tier: 1,
        snapshot: makeCampSnapshot(1),
        lootKeep: BigInt(PVE.bountyByTier[0]!),
      }).returning();
      const pveKey = k();
      const campaignKey = k();
      const pve = await createPveRaid(db, att.wallet, camp!.id, pveKey);
      fixtureRaidIds.push(pve.id);
      const campaign = await createCampaignRaid(db, att.wallet, 1, campaignKey);
      fixtureRaidIds.push(campaign.id);

      expect([pvp.simVersion, pve.simVersion, campaign.simVersion])
        .toEqual([SIM_VERSION, SIM_VERSION, SIM_VERSION]);
      expect([pvp.snapshot, pve.snapshot, campaign.snapshot]).toEqual([
        expect.objectContaining({ battlefieldVersion: 3 }),
        expect.objectContaining({ battlefieldVersion: 3 }),
        expect.objectContaining({ battlefieldVersion: 3 }),
      ]);
      const ids = [pvp.id, pve.id, campaign.id];
      const stored = await db.select({ id: raids.id, simVersion: raids.simVersion }).from(raids)
        .where(inArray(raids.id, ids));
      expect(stored).toHaveLength(3);
      expect(stored.every((r) => r.simVersion === SIM_VERSION)).toBe(true);

      // A lost create response retried after a rollout must fail BEFORE the
      // player deploys; returning the old idempotent row would defer the conflict
      // until submit, after they had watched a current-sim battle. All three
      // independent create paths share this invariant.
      await db.update(raids).set({ simVersion: SIM_VERSION + 1 }).where(inArray(raids.id, ids));
      for (const retry of [
        () => createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: pvpKey }),
        () => createPveRaid(db, att.wallet, camp!.id, pveKey),
        () => createCampaignRaid(db, att.wallet, 1, campaignKey),
      ]) {
        await expect(retry()).rejects.toMatchObject({
          statusCode: 409,
          code: 'RAID_SIM_VERSION_MISMATCH',
        });
      }
    } finally {
      // The old delete isolated the private PvE camp/valley from world suites.
      // Retain their FK history, tombstone that camp and keep the valley old.
      // Retire all three owned future-SIM fixtures too, so a later recovery
      // sweep cannot process intentionally incompatible inputs from this test.
      await retireFixtureRaids(fixtureRaidIds, { valleyId: valley.id });
    }
  });

  it('compatibility-cancelled PvE restores its daily slot without creating a refund posting', async () => {
    const att = await warlord();
    const valley = await createTestValley(db, {
      name: `SIM PVE REFUND ${k()}`, createdAt: new Date('2000-01-02T00:00:00Z'),
    });
    const ids: string[] = [];
    try {
      const [camp] = await db.insert(pveCamps).values({
        valleyId: valley.id, x: 0, y: 0, tier: 1,
        snapshot: makeCampSnapshot(1), lootKeep: BigInt(PVE.bountyByTier[0]!),
      }).returning();
      const keys = Array.from({ length: PVE.maxCampsPerDay }, () => k());
      for (const key of keys) ids.push((await createPveRaid(db, att.wallet, camp!.id, key)).id);
      await expect(createPveRaid(db, att.wallet, camp!.id, k())).rejects.toThrow(/max .* camps/);

      await db.update(raids).set({ simVersion: 5 }).where(eq(raids.id, ids[0]!));
      await expect(createPveRaid(db, att.wallet, camp!.id, keys[0]!)).rejects
        .toMatchObject({ statusCode: 409, code: 'RAID_SIM_VERSION_MISMATCH' });
      expect((await db.select().from(raids).where(eq(raids.id, ids[0]!)))[0]!.status).toBe('expired');
      expect(await db.select().from(ledgerTransactions)
        .where(eq(ledgerTransactions.idempotencyKey, `raid-ante-refund:${ids[0]}`)))
        .toHaveLength(0);

      ids.push((await createPveRaid(db, att.wallet, camp!.id, k())).id);
    } finally {
      // The old delete removed this wallet's unused cap-probing attempts and
      // private camp. Retire remaining attempts without a refund posting;
      // retain the cancelled original, tombstone the camp and keep its old
      // valley outside the newest playable cohort selected by world suites.
      await retireFixtureRaids(ids, { valleyId: valley.id });
    }
  });

  it('rejects a dark-only army before every raid kind can consume value while the gate is OFF', async () => {
    const previous = process.env['DARK_ATTACKER_ROSTER_ENABLED'];
    process.env['DARK_ATTACKER_ROSTER_ENABLED'] = 'false';
    const att = await warlord([]);
    const def = await victim(5_000n);
    await db.insert(army).values({ playerWallet: att.wallet, troop: 'hexbarrow', count: 1 });
    const shardsBefore = await shardBalance(att.wallet);
    const valley = await createTestValley(db, {
      name: `DARK OFF ${k()}`, createdAt: new Date('2000-01-03T00:00:00Z'),
    });
    try {
      const [camp] = await db.insert(pveCamps).values({
        valleyId: valley.id, x: 0, y: 0, tier: 1,
        snapshot: makeCampSnapshot(1), lootKeep: BigInt(PVE.bountyByTier[0]!),
      }).returning();
      for (const create of [
        () => createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() }),
        () => createPveRaid(db, att.wallet, camp!.id, k()),
        () => createCampaignRaid(db, att.wallet, 1, k()),
      ]) {
        await expect(create()).rejects
          .toMatchObject({ statusCode: 409, code: 'TROOP_ROSTER_INACTIVE' });
      }
      expect(await shardBalance(att.wallet)).toBe(shardsBefore);
      expect((await getRaidEnergy(db, att.wallet)).used).toBe(0);
    } finally {
      if (previous === undefined) delete process.env['DARK_ATTACKER_ROSTER_ENABLED'];
      else process.env['DARK_ATTACKER_ROSTER_ENABLED'] = previous;
      await db.delete(pveCamps).where(eq(pveCamps.valleyId, valley.id));
      await db.delete(valleys).where(eq(valleys.id, valley.id));
    }
  });

  it('ON→OFF cancels a frozen dark raid with exact compensation; OFF→ON cannot widen it', async () => {
    const previous = process.env['DARK_ATTACKER_ROSTER_ENABLED'];
    try {
      process.env['DARK_ATTACKER_ROSTER_ENABLED'] = 'true';
      const onAtt = await warlord([]);
      const onDef = await victim(5_000n);
      await db.insert(army).values({ playerWallet: onAtt.wallet, troop: 'hexbarrow', count: 1 });
      const onBefore = await shardBalance(onAtt.wallet);
      const enabledRaid = await createRaid(db, onAtt.wallet, {
        defenderWallet: onDef.wallet, idempotencyKey: k(),
      });
      process.env['DARK_ATTACKER_ROSTER_ENABLED'] = 'false';
      await expect(submitOrders(db, onAtt.wallet, enabledRaid.id, {
        deploys: [{ troop: 'hexbarrow', tx: 6, ty: 14, tMs: 0 }], idempotencyKey: k(),
      })).rejects.toMatchObject({ statusCode: 409, code: 'TROOP_ROSTER_INACTIVE' });
      expect(await shardBalance(onAtt.wallet)).toBe(onBefore);
      expect((await db.select().from(raids).where(eq(raids.id, enabledRaid.id)))[0]!.status)
        .toBe('expired');

      const offAtt = await warlord([['highlander', 1]]);
      const offDef = await victim(5_000n);
      await db.insert(army).values({ playerWallet: offAtt.wallet, troop: 'hexbarrow', count: 1 });
      const frozenOff = await createRaid(db, offAtt.wallet, {
        defenderWallet: offDef.wallet, idempotencyKey: k(),
      });
      const offAfterCreate = await shardBalance(offAtt.wallet);
      process.env['DARK_ATTACKER_ROSTER_ENABLED'] = 'true';
      await expect(submitOrders(db, offAtt.wallet, frozenOff.id, {
        deploys: [{ troop: 'hexbarrow', tx: 6, ty: 14, tMs: 0 }], idempotencyKey: k(),
      })).rejects.toMatchObject({ statusCode: 409, code: 'TROOP_ROSTER_INACTIVE' });
      expect(await shardBalance(offAtt.wallet)).toBe(offAfterCreate);
      expect((await db.select().from(raids).where(eq(raids.id, frozenOff.id)))[0]!.status)
        .toBe('pending_orders');
    } finally {
      if (previous === undefined) delete process.env['DARK_ATTACKER_ROSTER_ENABLED'];
      else process.env['DARK_ATTACKER_ROSTER_ENABLED'] = previous;
    }
  });

  // WHY: this exhaustive compatibility matrix provisions and compensates fourteen
  // complete raid fixtures; the normal 30 s unit budget is too short on CI-class
  // hardware even though each individual transaction remains bounded.
  it('atomically cancels every pre-v18 FREE raid and refunds its exact SHARD ante', async () => {
    // WHY: refusing an incompatible replay is correct only if the rollout
    // cannot strand the energy and ante already consumed at raid creation.
    // SIM13 and SIM14 each add a replay event without changing the result, and
    // SIM16 (D-139) changes the giant's targeting without a new event, but the
    // immutable event protocol still fences pending raids. The compensation
    // path is version-agnostic, so every older stamped row must be
    // cancelled/refunded. The literal pin moves with each deliberate bump.
    expect(SIM_VERSION).toBe(18);
    for (const pinnedVersion of [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]) {
      const att = await warlord([['kegrunner', 1], ['troll', 1]]);
      const def = await victim(5_000n);
      const idempotencyKey = k();
      const shardsBeforeCreate = await shardBalance(att.wallet);
      const created = await createRaid(db, att.wallet, {
        defenderWallet: def.wallet,
        idempotencyKey,
      });
      expect(await shardBalance(att.wallet)).toBeLessThan(shardsBeforeCreate);
      await db.update(raids).set({ simVersion: pinnedVersion }).where(eq(raids.id, created.id));

      await expect(createRaid(db, att.wallet, {
        defenderWallet: def.wallet,
        idempotencyKey,
      })).rejects.toMatchObject({ statusCode: 409, code: 'RAID_SIM_VERSION_MISMATCH' });
      expect(await shardBalance(att.wallet)).toBe(shardsBeforeCreate);
      expect((await getRaidEnergy(db, att.wallet)).used).toBe(0);

      const [cancelled] = await db.select().from(raids).where(eq(raids.id, created.id));
      expect(cancelled).toMatchObject({ status: 'expired', simVersion: pinnedVersion, events: null });
      const refunds = await db.select().from(ledgerTransactions)
        .where(eq(ledgerTransactions.idempotencyKey, `raid-ante-refund:${created.id}`));
      expect(refunds).toHaveLength(1);

      // Terminal row + ledger idempotency key make further retries exact no-ops.
      await expect(createRaid(db, att.wallet, {
        defenderWallet: def.wallet, idempotencyKey,
      })).rejects.toMatchObject({ statusCode: 409, code: 'RAID_SIM_VERSION_MISMATCH' });
      expect(await shardBalance(att.wallet)).toBe(shardsBeforeCreate);
      expect(await db.select().from(ledgerTransactions)
        .where(eq(ledgerTransactions.idempotencyKey, `raid-ante-refund:${created.id}`)))
        .toHaveLength(1);
    }
  }, 120_000);

  it('the energy HUD sweeps an incompatible stale raid and refunds energy + ante exactly once', async () => {
    // WHY: production can contain paid, pending raids from a simulator version
    // that the new server correctly refuses to run. Once their deploy window has
    // passed, compatibility is irrelevant because the attack never happened:
    // expiry must still restore the consumed energy or the rollout strands it.
    const att = await warlord([['highlander', 1]]);
    const def = await victim(5_000n);
    const createKey = k();
    const shardsBeforeCreate = await shardBalance(att.wallet);
    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: createKey });
    expect(await shardBalance(att.wallet)).toBeLessThan(shardsBeforeCreate);
    const beforeExpiry = new Date();
    const deadline = new Date(beforeExpiry.getTime() + 1_000);
    const afterExpiry = new Date(
      deadline.getTime() + RAID_RULES.batchOrdersGraceSec * 1_000 + 1,
    );

    // Model the authoritative post-consumption state of a paid legacy march.
    // The invalid snapshot is a tripwire: reaching combat would throw before the
    // expected expiry response and could never populate a replay event log.
    await db.update(players).set({ purchasedEnergy: 0 }).where(eq(players.wallet, att.wallet));
    await db.update(raids).set({
      simVersion: 1,
      snapshot: {},
      energySource: 'purchased',
      ordersDeadlineAt: deadline,
    }).where(eq(raids.id, raid.id));

    // This is the production race that motivated the sweeper fix: /base reads
    // energy before the client retries its old idempotency key. Two concurrent
    // HUD reads may both discover the stale row, but only one status claim can
    // carry the compensating ledger post and purchased-energy credit.
    const raced = await Promise.all([
      getRaidEnergy(db, att.wallet, afterExpiry),
      getRaidEnergy(db, att.wallet, afterExpiry),
    ]);
    expect(raced.every((energy) => energy.used === 0)).toBe(true);
    const [expired] = await db.select().from(raids).where(eq(raids.id, raid.id));
    expect(expired).toMatchObject({
      status: 'expired',
      simVersion: 1,
      energySource: 'purchased',
      orders: null,
      result: null,
      events: null,
      resolvedAt: null,
    });
    expect((await db.select({ e: players.purchasedEnergy }).from(players)
      .where(eq(players.wallet, att.wallet)))[0]!.e).toBe(1);
    expect(await shardBalance(att.wallet)).toBe(shardsBeforeCreate);
    expect(await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `raid-ante-refund:${raid.id}`)))
      .toHaveLength(1);

    // The lost create response is retried only AFTER the HUD sweep. The terminal
    // mismatch remains explicit but cannot post a second refund.
    await expect(createRaid(db, att.wallet, {
      defenderWallet: def.wallet,
      idempotencyKey: createKey,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'RAID_SIM_VERSION_MISMATCH',
    });
    expect((await db.select({ e: players.purchasedEnergy }).from(players)
      .where(eq(players.wallet, att.wallet)))[0]!.e).toBe(1);
    expect((await db.select().from(raids).where(eq(raids.id, raid.id)))[0])
      .toEqual(expired);
    expect(await shardBalance(att.wallet)).toBe(shardsBeforeCreate);
    expect(await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `raid-ante-refund:${raid.id}`)))
      .toHaveLength(1);
  });

  it('a stale current-SIM resolver lease is a system failure and restores energy + ante exactly once', async () => {
    const att = await warlord([['highlander', 1]]);
    const def = await victim(5_000n);
    const shardsBefore = await shardBalance(att.wallet);
    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    const sweepAt = new Date();
    await db.update(players).set({ purchasedEnergy: 0 }).where(eq(players.wallet, att.wallet));
    await db.update(raids).set({
      simVersion: SIM_VERSION,
      energySource: 'purchased',
      ordersDeadlineAt: new Date(
        sweepAt.getTime() - RAID_RULES.batchOrdersGraceSec * 1_000 - 2_000,
      ),
      simulationLeaseToken: '00000000-0000-4000-8000-000000000003',
      simulationLeaseUntil: new Date(sweepAt.getTime() - 1_000),
    }).where(eq(raids.id, raid.id));

    await Promise.all([
      getRaidEnergy(db, att.wallet, sweepAt),
      getRaidEnergy(db, att.wallet, sweepAt),
    ]);
    expect((await db.select().from(raids).where(eq(raids.id, raid.id)))[0])
      .toMatchObject({ status: 'expired', simulationLeaseToken: null, simulationLeaseUntil: null });
    expect((await db.select({ e: players.purchasedEnergy }).from(players)
      .where(eq(players.wallet, att.wallet)))[0]!.e).toBe(1);
    expect(await shardBalance(att.wallet)).toBe(shardsBefore);
    expect(await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `raid-ante-refund:${raid.id}`)))
      .toHaveLength(1);
  });

  it('rolls expiry back when the purchased-energy refund cannot commit', async () => {
    // WHY: status='expired' without its paired credit permanently destroys paid
    // energy. Force the second statement to fail at the database boundary; the
    // first statement must roll back with it, leaving the raid retryable.
    const att = await warlord([['highlander', 1]]);
    const def = await victim(5_000n);
    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    const deadline = new Date(Date.now() - 2_000);
    const submissionTime = new Date(deadline.getTime() + 1_000);
    const maxPgInteger = 2_147_483_647;

    await db.update(players).set({ purchasedEnergy: maxPgInteger }).where(eq(players.wallet, att.wallet));
    await db.update(raids).set({
      simVersion: 1,
      snapshot: {},
      energySource: 'purchased',
      ordersDeadlineAt: deadline,
    }).where(eq(raids.id, raid.id));

    try {
      await expect(submitOrders(db, att.wallet, raid.id, {
        deploys: [{ troop: 'highlander', tx: 6, ty: 14, tMs: 0 }],
        idempotencyKey: k(),
      }, submissionTime)).rejects.toThrow(/update "players" set "purchased_energy"/i);

      const [stillPending] = await db.select().from(raids).where(eq(raids.id, raid.id));
      expect(stillPending).toMatchObject({
        status: 'pending_orders',
        simVersion: 1,
        energySource: 'purchased',
        orders: null,
        result: null,
        events: null,
        resolvedAt: null,
      });
      expect((await db.select({ e: players.purchasedEnergy }).from(players)
        .where(eq(players.wallet, att.wallet)))[0]!.e).toBe(maxPgInteger);
    } finally {
      // The old delete prevented later sweeps from retrying this deliberate
      // overflow. Retain its immutable history, retire the pending fixture and
      // reset only its purchased-energy scalar together, even on assertion failure.
      await retireFixtureRaids([raid.id], { clearPurchasedEnergyFor: att.wallet });
    }
  });

  it('concurrent mismatch submissions refund PURCHASED energy and ante exactly once without simulating', async () => {
    const att = await warlord([['highlander', 1]]);
    const def = await victim(5_000n);
    const shardsBeforeCreate = await shardBalance(att.wallet);
    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    const submissionTime = new Date();
    const deadline = new Date(submissionTime.getTime() + 60_000);
    const armyBefore = (await getArmyState(db, att.wallet)).counts;
    await db.update(players).set({ purchasedEnergy: 0 }).where(eq(players.wallet, att.wallet));
    await db.update(raids).set({
      simVersion: 5, snapshot: {}, energySource: 'purchased', ordersDeadlineAt: deadline,
    })
      .where(eq(raids.id, raid.id));

    const submit = () => submitOrders(db, att.wallet, raid.id, {
      deploys: [{ troop: 'highlander', tx: 6, ty: 14, tMs: 0 }], idempotencyKey: k(),
    }, submissionTime);
    const raced = await Promise.allSettled([submit(), submit()]);
    expect(raced.every((result) => result.status === 'rejected')).toBe(true);
    expect(raced.some((result) => result.status === 'rejected'
      && result.reason?.code === 'RAID_SIM_VERSION_MISMATCH')).toBe(true);

    const [cancelled] = await db.select().from(raids).where(eq(raids.id, raid.id));
    expect(cancelled).toMatchObject({ status: 'expired', simVersion: 5, events: null, result: null });
    expect((await db.select({ e: players.purchasedEnergy }).from(players)
      .where(eq(players.wallet, att.wallet)))[0]!.e).toBe(1);
    expect(await shardBalance(att.wallet)).toBe(shardsBeforeCreate);
    expect((await getArmyState(db, att.wallet)).counts).toEqual(armyBefore);
    expect(await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `raid-ante-refund:${raid.id}`)))
      .toHaveLength(1);
  });

  it('rolls mismatch cancellation back completely when compensation cannot commit, then retries safely', async () => {
    const att = await warlord([['highlander', 1]]);
    const def = await victim(5_000n);
    const shardsBeforeCreate = await shardBalance(att.wallet);
    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    const shardsAfterCreate = await shardBalance(att.wallet);
    const maxPgInteger = 2_147_483_647;
    await db.update(players).set({ purchasedEnergy: maxPgInteger }).where(eq(players.wallet, att.wallet));
    await db.update(raids).set({ simVersion: 5, energySource: 'purchased' })
      .where(eq(raids.id, raid.id));

    const submit = () => submitOrders(db, att.wallet, raid.id, {
      deploys: [{ troop: 'highlander', tx: 6, ty: 14, tMs: 0 }], idempotencyKey: k(),
    });
    await expect(submit()).rejects.toThrow(/update "players" set "purchased_energy"/i);
    expect((await db.select().from(raids).where(eq(raids.id, raid.id)))[0])
      .toMatchObject({ status: 'pending_orders', simVersion: 5 });
    expect(await shardBalance(att.wallet)).toBe(shardsAfterCreate);
    expect(await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `raid-ante-refund:${raid.id}`)))
      .toHaveLength(0);

    await db.update(players).set({ purchasedEnergy: 0 }).where(eq(players.wallet, att.wallet));
    await expect(submit()).rejects.toMatchObject({
      statusCode: 409, code: 'RAID_SIM_VERSION_MISMATCH',
    });
    expect((await db.select().from(raids).where(eq(raids.id, raid.id)))[0])
      .toMatchObject({ status: 'expired', simVersion: 5 });
    expect(await shardBalance(att.wallet)).toBe(shardsBeforeCreate);
    expect((await db.select({ e: players.purchasedEnergy }).from(players)
      .where(eq(players.wallet, att.wallet)))[0]!.e).toBe(1);
  });

  it('current-version happy path: create -> orders -> resolve -> loot conserved -> 24h shield -> event-log replay', async () => {
    const att = await warlord([['highlander', 6], ['kegrunner', 2]]);
    const def = await victim(5_000n);

    const attBefore = await shardBalance(att.wallet);
    const defBefore = await shardBalance(def.wallet);
    const attKeepBefore = await balance(att.wallet);
    const defKeepBefore = await balance(def.wallet);

    const createKey = k();
    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: createKey });
    expect(raid.status).toBe('pending_orders');
    expect(raid.simVersion).toBe(SIM_VERSION);

    const { result } = await submitOrders(db, att.wallet, raid.id, {
      deploys: [
        { troop: 'highlander', tx: 6, ty: 14, tMs: 0 },
        { troop: 'highlander', tx: 6, ty: 15, tMs: 0 },
        { troop: 'highlander', tx: 6, ty: 13, tMs: 200 },
        { troop: 'highlander', tx: 23, ty: 14, tMs: 0 },
        { troop: 'highlander', tx: 23, ty: 15, tMs: 0 },
        { troop: 'highlander', tx: 14, ty: 6, tMs: 500 },
      ],
      idempotencyKey: k(),
    });

    expect(result.stars).toBeGreaterThanOrEqual(1);
    expect(result.lootShards).toBeGreaterThan(0);
    // Real settlement must freeze HP separately from its public economic summary.
    const [timeline] = await db.select().from(raidReplayTimelines).where(eq(raidReplayTimelines.raidId, raid.id));
    const archived = decodeReplayTimeline(timeline!);
    expect(archived.buildingHealth?.length).toBeGreaterThan(0);
    expect(archived.buildingHealth?.map((row) => row.id).sort())
      .toEqual((raid.snapshot as { buildings: Array<{ id: string }> }).buildings.map((row) => row.id).sort());
    for (const row of archived.buildingHealth!) expect(row.initialHp).toBe(row.maxHp);
    expect(archived.result).toEqual(result);
    expect(archived.result).not.toHaveProperty('buildings');
    expect((await getReplay(db, att.wallet, raid.id))).not.toHaveProperty('buildingHealth');
    expect((await getReplay(db, att.wallet, raid.id, true)).buildingHealth).toEqual(archived.buildingHealth);


    // D-118: a bulk request's validated acceptance, not eventual worker time,
    // is the evidence of play; result points alone cannot create another day.
    const activity = await db.execute(sql`select e.occurred_at,r.bulk_deployment_accepted_at,e.metadata from player_action_events e
      join raids r on r.id::text=e.source_id where e.source_key='battle_fought' and e.source_table='raids' and r.id=${raid.id}`);
    expect(activity).toHaveLength(1);
    expect(new Date(String(activity[0]?.['occurred_at'])).getTime()).toBeGreaterThanOrEqual(new Date(String(activity[0]?.['bulk_deployment_accepted_at'])).getTime());
    expect(new Date(String((activity[0]?.['metadata'] as Record<string,unknown>)['sourceOccurredAt']))).toEqual(new Date(String(activity[0]?.['bulk_deployment_accepted_at'])));

    // Raiding costs ENERGY + a Keep-scaled SHARD ante — never KEEP. Loot is
    // zero-sum against the defender IN SHARDS (dual-split: mined wealth is
    // raidable). Ranked leagues take no tithe: the displayed loot is the exact
    // attacker credit. The attack ante remains the only burn in this fixture.
    const attAfter = await shardBalance(att.wallet);
    const defAfter = await shardBalance(def.wallet);
    const gross = defBefore - defAfter;
    const ante = BigInt(pvpAttackShardCostForKeepLevel(1)); // warlord() keeps L1
    expect(attAfter - attBefore).toBe(gross - ante);
    expect(BigInt(result.lootShards)).toBe(gross);
    // Nothing leaks: the defender's loss plus the attacker's ante land entirely
    // in the attacker's pocket and the burn sink.
    expect(await burnedByTxns(`raid-ante:${raid.idempotencyKey}`, `raid:${raid.id}:loot`)).toBe(ante);
    // WHY: KEEP (forge payouts, quest rewards, DEPOSITED tokens) is NEVER
    // raidable — if these move, deposited money just got stolen.
    expect(await balance(att.wallet)).toBe(attKeepBefore);
    expect(await balance(def.wallet)).toBe(defKeepBefore);

    // trophies moved, defender shielded for 24h (ECONOMY.md §4a), troops consumed
    const [a] = await db.select().from(players).where(eq(players.wallet, att.wallet));
    expect(a!.trophies).toBe(result.attackerTrophyDelta);
    const sh = await db.select().from(shields).where(eq(shields.playerWallet, def.wallet));
    expect(sh.length).toBe(1);
    const hoursLeft = (sh[0]!.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hoursLeft).toBeGreaterThan(SHIELD.hoursOnLoss - 1); // ~24h, up from 12h
    expect(hoursLeft).toBeLessThanOrEqual(SHIELD.hoursOnLoss + 0.1);
    const army = await getArmyState(db, att.wallet);
    expect(army.counts.highlander).toBe(0);
    expect(army.counts.kegrunner).toBe(2); // undeployed troops stay home

    // replay is the full deterministic bundle
    const replay = await getReplay(db, att.wallet, raid.id);
    expect(replay.seed).toBe(Number(raid.seed));
    expect(replay.simVersion).toBe(SIM_VERSION);
    expect(Array.isArray(replay.events)).toBe(true);
    expect(replay.events).not.toHaveLength(0);
    const [resolved] = await db.select().from(raids).where(eq(raids.id, raid.id));
    expect(resolved!.simVersion).toBe(SIM_VERSION);
    expect(replay.events).toEqual(resolved!.events); // resolved replay remains event-log authoritative
    await expect(getReplay(db, def.wallet, raid.id)).resolves.toBeDefined();
    const stranger = await createTestPlayer(db);
    await expect(getReplay(db, stranger.wallet, raid.id)).rejects.toThrow(/not found/);
  });

  it('M1: two racing order submissions resolve EXACTLY once (no trophy/army double-apply)', async () => {
    const att = await warlord([['highlander', 6], ['kegrunner', 2]]);
    const def = await victim(5_000n);
    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    const deploys = [
      { troop: 'highlander' as const, tx: 6, ty: 14, tMs: 0 },
      { troop: 'highlander' as const, tx: 23, ty: 14, tMs: 0 },
      { troop: 'highlander' as const, tx: 14, ty: 6, tMs: 0 },
    ];
    // Fire two identical submissions concurrently — the atomic status claim must
    // let exactly one through; the other is rejected (would double-apply trophies
    // + consume army twice on unlocked code).
    const outcomes = await Promise.allSettled([
      submitOrders(db, att.wallet, raid.id, { deploys, idempotencyKey: k() }),
      submitOrders(db, att.wallet, raid.id, { deploys, idempotencyKey: k() }),
    ]);
    const ok = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // trophies applied once (== the single resolution's delta, not doubled)
    const won = (ok[0] as PromiseFulfilledResult<{ result: { attackerTrophyDelta: number } }>).value.result;
    const [a] = await db.select().from(players).where(eq(players.wallet, att.wallet));
    expect(a!.trophies).toBe(won.attackerTrophyDelta);
    // army consumed once — the 3 deployed highlanders left, not 6
    const army = await getArmyState(db, att.wallet);
    expect(army.counts.highlander).toBe(3);
    const activity = await db.execute(sql`select id from player_action_events where source_table='raids' and source_id=${raid.id} and source_key='battle_fought'`);
    expect(activity).toHaveLength(1);
  });

  it('rejects shielded targets and same-target-twice-per-day', async () => {
    const att = await warlord();
    const def = await victim();
    await db.insert(shields).values({ playerWallet: def.wallet, source: 'loss', expiresAt: future(60) });
    await expect(createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() }))
      .rejects.toThrow(/shielded/);

    await db.delete(shields).where(eq(shields.playerWallet, def.wallet));
    await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    await expect(createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() }))
      .rejects.toThrow(/already attacked today/);
  });

  it('a raid that never happened does not spend the day on that target (tester Suga, 2026-09-04)', async () => {
    // WHY: opening a revenge target, deploying nothing and leaving used to say
    // "already attacked today" because the rule counted raid ROWS, not
    // attacks. An expired never-ordered raid and a retreat with zero
    // deployments leave the day's attack available; a raid with a deployment
    // counts whatever its stars.
    const att = await warlord();
    const def = await victim();
    const first = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    // The deploy window lapsed with no orders (#58): the attack never happened.
    await db.update(raids).set({ status: 'expired' }).where(eq(raids.id, first.id));
    const second = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    // Left before committing a single unit: resolved by retreat, nothing deployed.
    await db.update(raids).set({
      status: 'resolved', resolvedAt: new Date(),
      orders: { deploys: [], heroDeploys: [] }, result: { stars: 0, destructionPct: 0, retreated: true },
    }).where(eq(raids.id, second.id));
    const third = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    // One real deployment, even at zero stars, is the day's attack on this target.
    await db.update(raids).set({
      status: 'resolved', resolvedAt: new Date(),
      orders: { deploys: [{ troop: 'highlander', tx: 0, ty: 0, tMs: 0 }] }, result: { stars: 0, destructionPct: 3 },
    }).where(eq(raids.id, third.id));
    await expect(createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() }))
      .rejects.toThrow(/already attacked today/);
  });

  it('loot is capped at keepLevel × 1000 (ECONOMY.md §4)', async () => {
    const att = await warlord([['highlander', 6], ['kegrunner', 2]]); // Keep L1 → cap 1000
    const def = await victim(50_000n); // 10% = 5,000 raw, clamped to 1,000
    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    const { result } = await submitOrders(db, att.wallet, raid.id, {
      deploys: [
        { troop: 'highlander', tx: 6, ty: 14, tMs: 0 },
        { troop: 'highlander', tx: 6, ty: 15, tMs: 0 },
        { troop: 'highlander', tx: 6, ty: 13, tMs: 200 },
        { troop: 'highlander', tx: 23, ty: 14, tMs: 0 },
        { troop: 'highlander', tx: 23, ty: 15, tMs: 0 },
        { troop: 'highlander', tx: 14, ty: 6, tMs: 500 },
      ],
      idempotencyKey: k(),
    });
    expect(result.stars).toBeGreaterThanOrEqual(1);
    // Gross take and exact attacker credit are capped at Keep level × 1000.
    const cap = 1_000n * 1n;
    expect(BigInt(result.lootShards)).toBe(cap);
  });

  it('a failing submit does NOT brick the raid — it stays retryable (atomicity)', async () => {
    // Regression for the security-review P0: a validation error AFTER the old
    // 'resolving' claim left the raid stuck forever and ate the energy.
    const att = await warlord([['highlander', 6], ['kegrunner', 2]]);
    const def = await victim(5_000n);

    // Drain the attacker's KEEP so a buffed submit fails the affordability check.
    const { postTransaction } = await import('../src/ledger/ledger');
    const sys = await bootstrapSystemAccounts(db);
    const acc = await getOrCreatePlayerAccount(db, att.wallet, 'player_keep');
    if (acc.balance > 0n) {
      await postTransaction(db, {
        idempotencyKey: k(), type: 'test.drain',
        entries: [{ account: acc.id, delta: -acc.balance }, { account: sys.emission_pool, delta: acc.balance }],
      });
    }

    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    const deploys = [
      { troop: 'highlander' as const, tx: 6, ty: 14, tMs: 0 },
      { troop: 'highlander' as const, tx: 6, ty: 15, tMs: 0 },
      { troop: 'highlander' as const, tx: 14, ty: 6, tMs: 200 },
    ];

    // Buffed submit is rejected (can't afford warhorn) …
    await expect(submitOrders(db, att.wallet, raid.id, {
      deploys, buffs: { warhorn: true }, idempotencyKey: k(),
    })).rejects.toThrow(/KEEP/i);

    // … and the raid is NOT bricked — still pending, no partial writes.
    const [after] = await db.select().from(raids).where(eq(raids.id, raid.id));
    expect(after!.status).toBe('pending_orders');

    // A clean retry (no buffs) resolves normally — the energy wasn't wasted.
    const { result } = await submitOrders(db, att.wallet, raid.id, { deploys, idempotencyKey: k() });
    expect(result.stars).toBeGreaterThanOrEqual(0);
    const [resolved] = await db.select().from(raids).where(eq(raids.id, raid.id));
    expect(resolved!.status).toBe('resolved');
  });

  it('a stale frozen army is terminally compensated before combat, leaving the defender untouched', async () => {
    // Two raids snapshot the same full army; the first consumes it, so the
    // second can no longer field its frozen order. This must be caught before
    // expensive combat and terminally compensated so retry spam cannot rerun
    // the simulator; no loot, trophies, or shield may touch the defender.
    const att = await warlord([['highlander', 6], ['kegrunner', 2]]);
    const spent = await victim(0n);       // R1's target
    const def = await victim(5_000n);     // R2's target (must stay untouched)
    const deploys6 = [
      { troop: 'highlander' as const, tx: 6, ty: 14, tMs: 0 },
      { troop: 'highlander' as const, tx: 6, ty: 15, tMs: 0 },
      { troop: 'highlander' as const, tx: 6, ty: 13, tMs: 200 },
      { troop: 'highlander' as const, tx: 23, ty: 14, tMs: 0 },
      { troop: 'highlander' as const, tx: 23, ty: 15, tMs: 0 },
      { troop: 'highlander' as const, tx: 14, ty: 6, tMs: 500 },
    ];
    // Both raids created BEFORE any resolution → both snapshot the full army.
    const r1 = await createRaid(db, att.wallet, { defenderWallet: spent.wallet, idempotencyKey: k() });
    const r2 = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });

    await submitOrders(db, att.wallet, r1.id, { deploys: deploys6, idempotencyKey: k() }); // consumes the army

    const defBefore = await balance(def.wallet);
    const [dBefore] = await db.select().from(players).where(eq(players.wallet, def.wallet));

    // R2 passes frozen validation (its snapshot had 6), then the live coverage
    // guard cancels it without entering combat.
    await expect(submitOrders(db, att.wallet, r2.id, { deploys: deploys6, idempotencyKey: k() }))
      .rejects.toMatchObject({ statusCode: 409, code: 'RAID_ARMY_CHANGED' });

    // Player-caused cancellation is terminal and restores the energy slot, but
    // the scouting ante remains burned; defender state stays intact.
    const [r2row] = await db.select().from(raids).where(eq(raids.id, r2.id));
    expect(r2row!.status).toBe('expired');
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `raid-ante-refund:${r2.id}`,
    ))).toHaveLength(0);
    expect(await balance(def.wallet)).toBe(defBefore);
    const [dAfter] = await db.select().from(players).where(eq(players.wallet, def.wallet));
    expect(dAfter!.trophies).toBe(dBefore!.trophies);
    expect(await db.select().from(shields).where(eq(shields.playerWallet, def.wallet))).toHaveLength(0);
  });

  it('rejects orders for troops the army does not hold', async () => {
    const att = await warlord([['highlander', 1]]);
    const def = await victim();
    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    await expect(submitOrders(db, att.wallet, raid.id, {
      deploys: [{ troop: 'turrider', tx: 0, ty: 8, tMs: 0 }],
      idempotencyKey: k(),
    })).rejects.toThrow(/not enough turrider/);
  });

  it('opens empty claim interiors only on newly stamped version-3 raids', async () => {
    const att = await warlord();
    const def = await victim();
    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    expect(raid.snapshot).toMatchObject({ battlefieldVersion: 3 });
    // D-136 deliberately supersedes the former claim-core exclusion: this is
    // inside [8,22) but outside every frozen building footprint.
    await expect(submitOrders(db, att.wallet, raid.id, {
      deploys: [{ troop: 'highlander', tx: 18, ty: 18, tMs: 0 }],
      idempotencyKey: k(),
    })).resolves.toBeDefined();
  });

  it('retains the claim-core exclusion on a legacy snapshot without rewriting it', async () => {
    const att = await warlord();
    const def = await victim();
    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    const legacy = { ...(raid.snapshot as BaseSnapshot) };
    delete legacy.battlefieldVersion;
    await db.update(raids).set({ snapshot: legacy }).where(eq(raids.id, raid.id));
    await expect(submitOrders(db, att.wallet, raid.id, {
      deploys: [{ troop: 'highlander', tx: 18, ty: 18, tMs: 0 }],
      idempotencyKey: k(),
    })).rejects.toThrow(/deploy outside the deploy zone/);
    const [retained] = await db.select({ snapshot: raids.snapshot }).from(raids).where(eq(raids.id, raid.id));
    expect(retained!.snapshot).toEqual(legacy);
  });

  it('the first accepted deploy breaks the attacker own shield, not scouting', async () => {
    const att = await warlord();
    await db.insert(shields).values({ playerWallet: att.wallet, source: 'purchase', expiresAt: future(60) });
    const def = await victim();
    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    expect(await db.select().from(shields).where(eq(shields.playerWallet, att.wallet))).toHaveLength(1);
    await submitOrders(db, att.wallet, raid.id, {
      deploys: [{ troop: 'highlander', tx: 0, ty: 8, tMs: 0 }], idempotencyKey: k(),
    });
    expect(await db.select().from(shields).where(eq(shields.playerWallet, att.wallet))).toHaveLength(0);
  });
});

// reference to silence unused warnings in editors
void buildings;

describe('hero deploys (D4a)', () => {
  /**
   * Route the body through the WIRE SCHEMA exactly as routes.ts does
   * (`parse(OrdersBodySchema, req.body)`) before calling the service. The
   * false-DEFEAT bug of 2026-07-28 lived ONLY in that gap: the schema capped
   * heroDeploys at 1 and required >=1 troop, while the deploy tray offered one
   * drop per recruited hero and heroes as first-class deploys. A legal client
   * raid therefore 400'd at the HTTP boundary and never reached submitOrders —
   * so every test calling submitOrders directly was structurally blind to it.
   */
  const submitWire = (
    wallet: string, raidId: string, body: unknown,
  ): ReturnType<typeof submitOrders> => submitOrders(db, wallet, raidId, OrdersBodySchema.parse(body));

  /** A defender a K5 attacker may legally attack: D-099 bars a K5 from anything
   *  below K3, and `victim()` starts at K1 — so every hero test lifts its
   *  defender to the bar. The lift is the gate's own number, not a guess. */
  async function heroVictim(surplus?: bigint) {
    const def = await victim(surplus);
    await db.update(players).set({ keepLevel: pvpMinDefenderKeep(5) }).where(eq(players.wallet, def.wallet));
    return def;
  }

  /** Attacker with Vex (heroaltar) and Theodor (siegestool) both recruited. */
  async function heroLord(troops: Array<[string, number]> = [['highlander', 2]]) {
    const att = await warlord(troops);
    await db.update(players).set({ keepLevel: 5 }).where(eq(players.wallet, att.wallet)); // D-058: altars gate at Keep L5
    // One builder: the altars go up one at a time.
    await placeBuilding(db, att.wallet, 'heroaltar' as never, 9, 9, k());
    await completeDueJobs(db, att.wallet, future(600));
    await placeBuilding(db, att.wallet, 'siegestool' as never, 9, 12, k());
    await completeDueJobs(db, att.wallet, future(1_200));
    return att;
  }

  async function equipHelm(wallet: string, hero: 'vex' | 'theodor', version: number): Promise<void> {
    await db.insert(playerItems).values({ playerWallet: wallet, itemId: 'wardens_helm', qty: 1 });
    await db.insert(heroLoadouts).values({ playerWallet: wallet, hero, version });
    await db.insert(heroEquipment).values({
      playerWallet: wallet, hero, slot: 'helm', itemId: 'wardens_helm',
    });
  }

  it('lets only the attacker resume the exact pending raid that owns its heroes', async () => {
    // WHY: losing a create response used to strand both heroes behind the
    // HERO_ALREADY_COMMITTED fence, while the only read surface exposed no way
    // back into that unresolved raid. The defender must not receive the frozen
    // attacker army/snapshot while it is still pending.
    const att = await heroLord();
    const def = await heroVictim();
    const pending = await createRaid(db, att.wallet, {
      defenderWallet: def.wallet, idempotencyKey: k(),
    });

    const attackerRow = (await getRaidLog(db, att.wallet))
      .find((row) => row.id === pending.id);
    expect(attackerRow).toMatchObject({
      role: 'attacker', status: 'pending_orders',
      resumable: true,
    });
    expect(attackerRow).not.toHaveProperty('snapshot');
    const resume = (await getPendingHeroRaidResumes(db, att.wallet))
      .find((row) => row.id === pending.id);
    expect(resume).toMatchObject({
      id: pending.id,
      defenderWallet: def.wallet,
      ordersDeadlineAt: pending.ordersDeadlineAt,
      simVersion: SIM_VERSION,
      heroReserved: true,
    });
    expect(resume?.armySnapshot).toBeTruthy();

    const defenderRow = (await getRaidLog(db, def.wallet))
      .find((row) => row.id === pending.id);
    expect(defenderRow).toMatchObject({ role: 'defender', status: 'pending_orders', resumable: false });
    expect(await getPendingHeroRaidResumes(db, def.wallet)).toHaveLength(0);
    expect(await getPendingRaidResume(db, att.wallet, pending.id)).toMatchObject({
      id: pending.id,
      heroReserved: true,
    });
    expect(await getPendingRaidResume(db, def.wallet, pending.id)).toBeNull();

    // Crossing the deadline through the same log read must terminalize first,
    // release both heroes, and return no stale recovery payload.
    const afterDeadline = new Date(
      batchOrdersSubmitDeadlineAt(pending.ordersDeadlineAt).getTime() + 1,
    );
    const expiredRow = (await getRaidLog(db, att.wallet, afterDeadline))
      .find((row) => row.id === pending.id);
    expect(expiredRow).toMatchObject({ status: 'expired', resumable: false });
    expect(await getPendingHeroRaidResumes(db, att.wallet, afterDeadline)).toHaveLength(0);
    expect(await getPendingRaidResume(db, att.wallet, pending.id, afterDeadline)).toBeNull();
    expect(await db.select().from(heroRaidReservations).where(
      eq(heroRaidReservations.raidId, pending.id),
    )).toHaveLength(0);
  });

  it('atomically reserves each hero to one unresolved raid and releases every terminal path', async () => {
    // WHY: two raid snapshots created while Vex is healthy must not both retain
    // authority to deploy him after one battle knocks him out. The database key,
    // not a timing-sensitive read, decides the concurrent race.
    const att = await heroLord();
    const raced = await Promise.allSettled([
      createCampaignRaid(db, att.wallet, 1, k()),
      createCampaignRaid(db, att.wallet, 1, k()),
    ]);
    const winner = raced.find((result) => result.status === 'fulfilled');
    const loser = raced.find((result) => result.status === 'rejected');
    expect(winner?.status).toBe('fulfilled');
    expect(loser?.status === 'rejected' ? loser.reason : null).toMatchObject({
      statusCode: 409, code: 'HERO_ALREADY_COMMITTED',
    });
    const first = winner!.status === 'fulfilled' ? winner!.value : null;
    expect(await db.select().from(heroRaidReservations).where(
      eq(heroRaidReservations.raidId, first!.id),
    )).toHaveLength(2);

    // A sequential attempt is fenced by the same invariant. Compatibility /
    // system compensation releases atomically, so the next raid can reserve.
    await expect(createCampaignRaid(db, att.wallet, 1, k())).rejects.toMatchObject({
      statusCode: 409, code: 'HERO_ALREADY_COMMITTED',
    });
    expect(await compensatePendingRaid(db, first!, false)).toBe(true);
    expect(await db.select().from(heroRaidReservations).where(
      eq(heroRaidReservations.playerWallet, att.wallet),
    )).toHaveLength(0);

    // Ordinary deadline expiry is a distinct terminal path and must release too.
    const expiring = await createCampaignRaid(db, att.wallet, 1, k());
    const expiredAt = new Date();
    await db.update(raids).set({
      ordersDeadlineAt: new Date(
        expiredAt.getTime() - RAID_RULES.batchOrdersGraceSec * 1_000 - 1,
      ),
    })
      .where(eq(raids.id, expiring.id));
    await getRaidEnergy(db, att.wallet, expiredAt);
    expect((await db.select().from(raids).where(eq(raids.id, expiring.id)))[0]!.status)
      .toBe('expired');
    expect(await db.select().from(heroRaidReservations).where(
      eq(heroRaidReservations.playerWallet, att.wallet),
    )).toHaveLength(0);

    const afterExpiry = await createCampaignRaid(db, att.wallet, 1, k());
    expect((afterExpiry.armySnapshot as { heroes?: string[] }).heroes)
      .toEqual(expect.arrayContaining(['vex', 'theodor']));
    await submitWire(att.wallet, afterExpiry.id, {
      deploys: [{ troop: 'highlander', tx: 6, ty: 14, tMs: 0 }],
      idempotencyKey: k(),
    });
    expect(await db.select().from(heroRaidReservations).where(
      eq(heroRaidReservations.playerWallet, att.wallet),
    )).toHaveLength(0);
  });

  it('fails a legacy unreserved hero snapshot closed and terminally compensates it', async () => {
    // WHY: duplicate pre-0069 rows intentionally lose the deterministic
    // backfill race. They must never regain authority merely because the old
    // JSON snapshot still names Vex.
    const att = await heroLord();
    const legacy = await createCampaignRaid(db, att.wallet, 1, k());
    await db.delete(heroRaidReservations).where(eq(heroRaidReservations.raidId, legacy.id));
    await expect(submitWire(att.wallet, legacy.id, {
      deploys: [],
      heroDeploys: [{ hero: 'vex', tx: 6, ty: 14, tMs: 0 }],
      idempotencyKey: k(),
    })).rejects.toMatchObject({
      statusCode: 409, code: 'HERO_RESERVATION_MISSING',
    });
    expect((await db.select().from(raids).where(eq(raids.id, legacy.id)))[0]!.status)
      .toBe('expired');

    // A rollout-era raid may have won the backfill reservation just before a
    // different in-flight settlement wrote recovery. Reservation alone is not
    // authority: the current deadline is a second fail-closed fence.
    const reservedLegacy = await createCampaignRaid(db, att.wallet, 1, k());
    const recoveryUntil = future(60);
    await db.insert(heroLevels).values({
      playerWallet: att.wallet, hero: 'vex', level: 1, recoveryUntil,
    }).onConflictDoUpdate({
      target: [heroLevels.playerWallet, heroLevels.hero], set: { recoveryUntil },
    });
    await expect(submitWire(att.wallet, reservedLegacy.id, {
      deploys: [],
      heroDeploys: [{ hero: 'vex', tx: 6, ty: 14, tMs: 0 }],
      idempotencyKey: k(),
    })).rejects.toMatchObject({ statusCode: 409, code: 'HERO_RECOVERING' });
    expect((await db.select().from(raids).where(eq(raids.id, reservedLegacy.id)))[0]!.status)
      .toBe('expired');
  });

  it('a HERO-ONLY raid is accepted at the wire and really fights (no troops deployed)', async () => {
    // The owner's tray now arms ATTACK on a hero alone. If the wire schema still
    // demanded >=1 troop the client would fight the raid locally, fail to post
    // it, and render DEFEAT over a battle it won — with the energy burned.
    const att = await heroLord();
    const def = await heroVictim(10_000n);
    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });

    const { result } = await submitWire(att.wallet, raid.id, {
      deploys: [],
      heroDeploys: [{ hero: 'theodor', tx: 6, ty: 14, tMs: 0 }],
      idempotencyKey: k(),
    });
    // A real assault: the hero broke things. (Not just "resolved" — a no-show
    // hero would also resolve, at 0%.)
    expect(result.destructionPct).toBeGreaterThan(0);
    const [row] = await db.select({ o: raids.orders, st: raids.status }).from(raids).where(eq(raids.id, raid.id));
    expect(row!.st).toBe('resolved');
    expect(JSON.stringify(row!.o)).toContain('"theodor"');
    const fought = await db.execute(sql`select id from player_action_events where source_table='raids' and source_id=${raid.id} and source_key='battle_fought'`);
    expect(fought).toHaveLength(1); // Heroes alone are real activity too.
    const [survivor] = await db.select().from(heroLevels).where(and(
      eq(heroLevels.playerWallet, att.wallet), eq(heroLevels.hero, 'theodor'),
    ));
    expect(survivor?.recoveryUntil ?? null).toBeNull();
  });

  it('both heroes may attack together, but the SAME hero twice is rejected at the wire', async () => {
    const att = await heroLord();
    const def = await heroVictim(10_000n);

    // Duplicate = the triple-Theodor client bug. The server must never accept it.
    expect(() => OrdersBodySchema.parse({
      deploys: [{ troop: 'highlander', tx: 6, ty: 14, tMs: 0 }],
      heroDeploys: [
        { hero: 'theodor', tx: 6, ty: 15, tMs: 0 },
        { hero: 'theodor', tx: 6, ty: 16, tMs: 120 },
      ],
      idempotencyKey: k(),
    })).toThrow(/one drop per hero/);

    // An empty attack is still refused — heroes made the count, not the rule.
    expect(() => OrdersBodySchema.parse({ deploys: [], idempotencyKey: k() }))
      .toThrow(/deploy at least one unit/);

    // Vex + Theodor together is a legal two-altar raid and resolves.
    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    const { result } = await submitWire(att.wallet, raid.id, {
      deploys: [{ troop: 'highlander', tx: 6, ty: 14, tMs: 0 }],
      heroDeploys: [
        { hero: 'vex', tx: 6, ty: 15, tMs: 0 },
        { hero: 'theodor', tx: 6, ty: 16, tMs: 0 },
      ],
      idempotencyKey: k(),
    });
    expect(result.stars).toBeGreaterThanOrEqual(1);
  });

  it('a recruited hero deploys and swings the fight; an unrecruited one 422s', async () => {
    const att = await warlord([['highlander', 2]]);
    // Recruit Vex: place + complete his altar (the recruitment record).
    await db.update(players).set({ keepLevel: 5 }).where(eq(players.wallet, att.wallet)); // D-058: altars gate at Keep L5
    await placeBuilding(db, att.wallet, 'heroaltar' as never, 9, 9, k());
    await completeDueJobs(db, att.wallet, future(600));
    const def = await heroVictim(10_000n);

    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    expect((raid.armySnapshot as { heroes?: string[] }).heroes).toContain('vex');

    // Theodor is NOT recruited — deploying him must 422 before any resolution.
    await expect(submitOrders(db, att.wallet, raid.id, {
      deploys: [{ troop: 'highlander', tx: 6, ty: 14, tMs: 0 }],
      heroDeploys: [{ hero: 'theodor', tx: 6, ty: 15, tMs: 0 }],
      idempotencyKey: k(),
    })).rejects.toThrow(/have not recruited theodor/);

    // Vex deploys fine and the raid resolves (2 highlanders alone against this
    // base struggle; the hero makes it a real assault — stars prove he fought).
    const { result } = await submitOrders(db, att.wallet, raid.id, {
      deploys: [{ troop: 'highlander', tx: 6, ty: 14, tMs: 0 }, { troop: 'highlander', tx: 6, ty: 15, tMs: 0 }],
      heroDeploys: [{ hero: 'vex', tx: 6, ty: 16, tMs: 0 }],
      idempotencyKey: k(),
    });
    expect(result.stars).toBeGreaterThanOrEqual(1);
    // The stored orders carry the hero — the replay input is complete.
    const [row] = await db.select({ o: raids.orders }).from(raids).where(eq(raids.id, raid.id));
    expect(JSON.stringify(row!.o)).toContain('"vex"');
  });

  it('freezes server-resolved attacker/defender loadouts only while the gear gate is on', async () => {
    const previous = process.env.HERO_GEAR_COMBAT_ENABLED;
    try {
      const att = await heroLord();
      const def = await victim(10_000n);
      await db.update(players).set({ keepLevel: 5 }).where(eq(players.wallet, def.wallet)); // D-058: altars gate at Keep L5
      await placeBuilding(db, def.wallet, 'heroaltar' as never, 9, 9, k());
      await completeDueJobs(db, def.wallet, future(600));
      await equipHelm(att.wallet, 'vex', 3);
      await equipHelm(def.wallet, 'vex', 7);

      process.env.HERO_GEAR_COMBAT_ENABLED = 'false';
      const dark = await createRaid(db, att.wallet, {
        defenderWallet: def.wallet, idempotencyKey: k(),
      });
      expect((dark.armySnapshot as { heroLoadouts?: unknown }).heroLoadouts).toBeUndefined();
      expect((dark.snapshot as { defenderHeroes?: Array<{ loadout?: unknown }> })
        .defenderHeroes?.[0]?.loadout).toBeUndefined();
      await compensatePendingRaid(db, dark, false);

      process.env.HERO_GEAR_COMBAT_ENABLED = 'true';
      const litDef = await victim(10_000n);
      await db.update(players).set({ keepLevel: 5 }).where(eq(players.wallet, litDef.wallet)); // D-058: altars gate at Keep L5
      await placeBuilding(db, litDef.wallet, 'heroaltar' as never, 9, 9, k());
      await completeDueJobs(db, litDef.wallet, future(600));
      await equipHelm(litDef.wallet, 'vex', 11);
      const lit = await createRaid(db, att.wallet, {
        defenderWallet: litDef.wallet, idempotencyKey: k(),
      });
      const armyLoadout = (lit.armySnapshot as {
        heroLoadouts?: { vex?: { version: number; hash: string } };
      }).heroLoadouts?.vex;
      expect(armyLoadout?.version).toBe(3);
      expect(armyLoadout?.hash).toMatch(/^[a-f0-9]{64}$/);
      expect((lit.snapshot as {
        defenderHeroes?: Array<{ guardTx: number; guardTy: number; loadout?: { version: number } }>;
      }).defenderHeroes).toContainEqual(expect.objectContaining({
        guardTx: 10, guardTy: 10, loadout: expect.objectContaining({ version: 11 }),
      }));

      const parsed = OrdersBodySchema.parse({
        deploys: [],
        heroDeploys: [{ hero: 'vex', tx: 8, ty: 14, tMs: 0,
          level: 20, loadout: { version: 999, hash: 'client' } }],
        idempotencyKey: k(),
      });
      expect(parsed.heroDeploys?.[0]).toEqual({ hero: 'vex', tx: 8, ty: 14, tMs: 0 });
    } finally {
      if (previous === undefined) delete process.env.HERO_GEAR_COMBAT_ENABLED;
      else process.env.HERO_GEAR_COMBAT_ENABLED = previous;
    }
  });

  it('persists attacker recovery from authoritative death and exact Double tails refund', async () => {
    const now = new Date();
    const att = await heroLord([]);
    await db.insert(heroLevels).values({ playerWallet: att.wallet, hero: 'vex', level: 16 });
    const def = await heroVictim(10_000n);
    await db.insert(buildings).values(Array.from({ length: 8 }, (_, i) => ({
      playerWallet: def.wallet,
      type: 'lasertower' as const,
      level: 20,
      tx: 10 + (i % 4) * 2,
      ty: 9 + Math.floor(i / 4) * 10,
    })));
    const raid = await createRaid(db, att.wallet, {
      defenderWallet: def.wallet, idempotencyKey: k(),
    }, now);
    // Seed 42 is the pinned SIM7 tails case; the server still authors the seed,
    // this fixture merely makes the authoritative outcome deterministic.
    await db.update(raids).set({ seed: 42n }).where(eq(raids.id, raid.id));
    const settlementStartedAt = Date.now();
    await submitWire(att.wallet, raid.id, {
      deploys: [], heroDeploys: [{ hero: 'vex', tx: 8, ty: 14, tMs: 0 }], idempotencyKey: k(),
    });
    const settlementFinishedAt = Date.now();
    const [state] = await db.select().from(heroLevels).where(and(
      eq(heroLevels.playerWallet, att.wallet), eq(heroLevels.hero, 'vex'),
    ));
    const refund = HERO_SKILLS.vex.doubleOrNothing.tailsRegenRefundPct[3]!;
    const fullMs = HEROES.vex.regenMinAt(16) * 60_000;
    const durationMs = Math.floor((fullMs * (100 - refund)) / 100);
    expect(state!.recoveryUntil?.getTime()).toBeGreaterThanOrEqual(settlementStartedAt + durationMs);
    expect(state!.recoveryUntil?.getTime()).toBeLessThanOrEqual(settlementFinishedAt + durationMs);
    expect(await db.select().from(heroRaidReservations).where(
      eq(heroRaidReservations.raidId, raid.id),
    )).toHaveLength(0);

    const nextDef = await heroVictim(10_000n);
    const next = await createRaid(db, att.wallet, {
      defenderWallet: nextDef.wallet, idempotencyKey: k(),
    }, new Date(now.getTime() + 1_000));
    expect((next.armySnapshot as { heroes?: string[] }).heroes).not.toContain('vex');
  });

  it('never persists a defender knockout as recovery', async () => {
    const att = await heroLord(Array.from({ length: 10 }, () => ['highlander', 1] as [string, number]));
    await db.insert(troopResearch).values({
      playerWallet: att.wallet, troop: 'highlander', level: 20,
    }).onConflictDoUpdate({
      target: [troopResearch.playerWallet, troopResearch.troop], set: { level: 20 },
    });
    const def = await victim(10_000n);
    await db.update(players).set({ keepLevel: 5 }).where(eq(players.wallet, def.wallet)); // D-058: altars gate at Keep L5
    await placeBuilding(db, def.wallet, 'heroaltar' as never, 9, 9, k());
    await completeDueJobs(db, def.wallet, future(600));
    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    await submitWire(att.wallet, raid.id, {
      deploys: Array.from({ length: 10 }, (_, i) => ({
        troop: 'highlander', tx: 8, ty: 9 + i, tMs: i * 10,
      })),
      heroDeploys: [{ hero: 'vex', tx: 8, ty: 20, tMs: 0 }],
      idempotencyKey: k(),
    });
    const [row] = await db.select({ events: raids.events }).from(raids).where(eq(raids.id, raid.id));
    const events = row!.events as Array<{ e: string; id?: number; hero?: string; side?: string }>;
    const defender = events.find((event) => event.e === 'deploy'
      && event.hero === 'vex' && event.side === 'defender')!;
    expect(events).toContainEqual(expect.objectContaining({ e: 'troopDeath', id: defender.id }));
    const [state] = await db.select().from(heroLevels).where(and(
      eq(heroLevels.playerWallet, def.wallet), eq(heroLevels.hero, 'vex'),
    ));
    expect(state?.recoveryUntil ?? null).toBeNull();
  });
});
