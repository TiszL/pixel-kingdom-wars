/**
 * Cross-table invariants. These encode the WHY behind the numbers — relations
 * the GDD asserts in prose (splits validated on-chain, caps per keep level,
 * the 4.0 power-cap fairness promise). If a retune breaks one of these, it
 * broke a design promise, not just a number.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  ART_V2,
  BASE_OWNERSHIP,
  BUFFS,
  BUILD_COSTS,
  BUILD_COUNT_CAP_BY_KEEP,
  buildCountCapForKeep,
  BUILDING_GEOMETRY,
  CAPS,
  DAILY_CACHE,
  DEFENSE_LEVELING,
  DEFENSES,
  DEVNET_FAUCET,
  SKR_FAUCET,
  PHASE_E_DEVNET_TEST,
  WALLET_HUB,
  ECONOMY,
  ELITE_TROOP_UNLOCKS,
  FORGE,
  FORGE_DROPS,
  FORGE_INGOT,
  GEAR_SLOTS,
  GEMS_REWARD_BUDGET,
  GEMS_TASKS,
  GLOBE,
  GRID,
  HERO_COMBAT,
  HERO_KEYS,
  HERO_LEVELING,
  HEROES,
  INVENTORY,
  isEliteTroop,
  isTrainableTroop,
  ITEMS,
  KEEP_BATTERIES,
  L1_BUILD_SEC,
  LEAGUES,
  MATERIAL_ITEMS,
  LOOT,
  magicEdenCollectionUrl,
  magicEdenItemUrl,
  MAIL,
  MARKETPLACE,
  MINING,
  OBSTACLES,
  PVE,
  pvpAttackAllowed,
  pvpAttackShardCostForKeepLevel,
  pvpMinDefenderKeep,
  PLOT_GEOMETRY,
  QUESTS,
  RAID_ENERGY,
  RAID_BATTLEFIELD,
  RAID_PLAYBACK,
  RAID_REPLAY_LIMITS,
  RAID_RULES,
  resolveBuildingGeometryVersion,
  REMOVED_SKIN_REFUNDS,
  SHIELD,
  STRUCTURE_DEPTH,
  STRUCTURES,
  structureDepth,
  tensorCollectionUrl,
  tensorItemUrl,
  TOKEN,
  TRAINING_CANCELLATION,
  TRAP_REPAIR,
  TROOP_LEVELING,
  TROOPS,
  TROPHIES,
  UNLOCK_ITEMS,
  UPGRADE_COSTS,
  PHASE_E_BUILDINGS,
  PHASE_E_POLICY,
  UPGRADE_TIMES_SEC,
  upgradeSolLamports,
  WORLD_DEPTH,
  type GemsTaskSpec,
} from './constants';
import { BuildingType, TROOP_TYPES } from './types';

describe('shared structure painter order', () => {
  it('puts equal-edge walls behind buildings but a one-pixel-southern wall ahead', () => {
    const y = 12 * 64;
    expect(structureDepth('wall', y)).toBeLessThan(structureDepth('building', y));
    expect(structureDepth('wall', y + 1)).toBeGreaterThan(structureDepth('building', y));
    expect(STRUCTURE_DEPTH.groundYScale).toBeGreaterThan(STRUCTURE_DEPTH.buildingTie);
    expect(structureDepth('building', 10_000)).toBeLessThan(WORLD_DEPTH.actor);
  });
});

describe('training cancellation churn budgets', () => {
  it('derives fixed UTC-day ceilings from the largest legal queue and base count', () => {
    const maxQueuePts = STRUCTURES.barracks.queuePts.at(-1)!;
    const maxBarracks = BUILD_COUNT_CAP_BY_KEEP['barracks']!.at(-1)!;
    const minTroopPts = Math.min(
      ...TROOP_TYPES.filter(isTrainableTroop).map((type) => TROOPS[type].pts),
    );
    const perBase = (maxQueuePts * maxBarracks) / minTroopPts;
    expect(TRAINING_CANCELLATION).toMatchObject({
      maxQueuePtsPerBarracks: maxQueuePts,
      maxBarracksPerBase: maxBarracks,
      minTrainableTroopPts: minTroopPts,
      maxBasesPerWallet: BASE_OWNERSHIP.maxActive,
      maxRefundsPerBaseUtcDay: perBase,
      maxRefundsPerWalletUtcDay: perBase * BASE_OWNERSHIP.maxActive,
    });
    expect(perBase).toBe(420);
    expect(TRAINING_CANCELLATION.maxRefundsPerWalletUtcDay).toBe(2_100);
  });

  it('per-IP shield is cadence-derived, not a confirmation-flow budget (D-096)', () => {
    // Cancellation is tap-tap-tap with no dialog: one serialized POST per tap,
    // so a single device tops out at the client hold floor (~5.5/s ≈ 330/min)
    // and never gets there through real round-trips. The shield sits at that
    // whole-minute cadence — only a script meets it — and is not tighter
    // because carrier-NAT phones share one IP. The old 30/min was justified by
    // the dialog D-096 removed; restoring it would 429 a legitimate burst.
    expect(TRAINING_CANCELLATION.ipRateLimitPerMin).toBe(300);
    expect(TRAINING_CANCELLATION.ipRateLimitWindowMs).toBe(60_000);
  });
});

describe('on-chain splits', () => {
  it('SOL split sums to 10000 bps — shardkeep-core initialize() rejects anything else', () => {
    const { liquidity, dev, ops } = ECONOMY.solSplitBps;
    expect(liquidity + dev + ops).toBe(10_000);
  });

  it('KEEP never burns — every in-game sink RECYCLES to the emission pool (ECONOMY.md §4b)', () => {
    // v3: the old 60/25/15 burn/league/treasury sink split is GONE. spendKeep
    // returns 100% of every sink to emission_pool so the play supply is circular
    // (mines never dry). Only the 2% withdrawal fee still burns KEEP.
    expect(ECONOMY.keepSinkRecycles).toBe(true);
    expect(ECONOMY).not.toHaveProperty('sinkSplit');
    expect(ECONOMY.withdrawFeeBps).toBe(200);
  });

  it('starts new bases with 5,000 SHARDS (owner 2026-08-16) and keeps the v1 amount only for migration math', () => {
    expect(ECONOMY.starterShards).toBe(5_000);
    expect(ECONOMY.starterShardsV1).toBe(500);
    expect(ECONOMY.starterShards).toBeGreaterThan(ECONOMY.starterShardsV1);
  });
});

describe('M22 Keep batteries', () => {
  it('unlocks the long-range ground battery before its close-range dead-zone cover', () => {
    expect(KEEP_BATTERIES.highRangeUnlockLevel).toBe(15);
    expect(KEEP_BATTERIES.lowRangeUnlockLevel).toBe(17);
    expect(KEEP_BATTERIES.lowRangeUnlockLevel).toBeGreaterThan(KEEP_BATTERIES.highRangeUnlockLevel);
  });
});

describe('inventory and fixed Warden gear', () => {
  const gear = Object.values(ITEMS).filter((item) => item.kind === 'gear');

  it('ships exactly one fixed item for every gear slot, all forge-drop-exclusive and never KEEP-priced', () => {
    // Owner 2026-08-16 (verbatim): "gear also should be gathered exclusively
    // from drops." The retired 1.17m-KEEP set price is gone: costKeep 0 means
    // "never sold for KEEP" (the writ convention), and every piece must be in
    // the forge drop table or it is unobtainable. Gear must stay tradeable
    // (no dropOnly flag — the market listing fence), unlike the Aegis.
    expect(gear).toHaveLength(GEAR_SLOTS.length);
    expect(new Set(gear.map((item) => item.slot))).toEqual(new Set(GEAR_SLOTS));
    for (const item of gear) {
      expect(item.acquisition).toEqual({ type: 'drop' });
      expect(item.costKeep).toBe(0);
      expect((item as { dropOnly?: boolean }).dropOnly).toBeUndefined();
    }
    for (const [id, spec] of Object.entries(ITEMS)) {
      if (spec.kind !== 'gear') continue;
      expect(FORGE_DROPS.independentDropBps, id).toHaveProperty(id);
    }
    expect(gear.every((item) => item.modifiers.length > 0)).toBe(true);
  });

  it('pins the full-set buckets before hard caps and the nine-piece army bonus', () => {
    const totals = Object.fromEntries(Object.keys(INVENTORY.modifierCapsBps).map((stat) => [stat, 0])) as Record<string, number>;
    for (const item of gear) {
      for (const modifier of item.modifiers) totals[modifier.stat] = (totals[modifier.stat] ?? 0) + modifier.value;
    }
    for (const modifier of INVENTORY.wardenSet.modifiers) totals[modifier.stat] = (totals[modifier.stat] ?? 0) + modifier.value;
    expect(totals).toMatchObject({
      hero_hp_bps: 3_600,
      hero_damage_bps: 2_400,
      ability_damage_bps: 1_400,
      cooldown_reduction_bps: 1_400,
      move_speed_bps: 0,
      incoming_damage_reduction_bps: 800,
      first_hit_reduction_bps: 2_500,
      wall_damage_bps: 5_000,
      allied_troop_hp_bps: 1_400,
      allied_troop_damage_bps: 600,
    });
    for (const [stat, value] of Object.entries(totals)) {
      expect(Math.abs(value), stat).toBeLessThanOrEqual(INVENTORY.modifierCapsBps[stat as keyof typeof INVENTORY.modifierCapsBps]);
    }
  });

  it('keeps the backpack cap shared and leaves NO gear behind a purchase gate', () => {
    // Rewritten 2026-08-16: this test used to pin the Keep-level/campaign
    // PURCHASE gates on gear. The owner made gear forge-drop-exclusive
    // ("gear also should be gathered exclusively from drops"), so the rule to
    // pin is the opposite one — no gear item may ever carry a purchasable
    // acquisition type again, or the shop quietly starts selling it.
    expect(INVENTORY.capacity).toBe(160);
    for (const [id, spec] of Object.entries(ITEMS)) {
      if (spec.kind !== 'gear') continue;
      expect(spec.acquisition.type, id).toBe('drop');
    }
  });

  it('retires the keep skins from the catalog and pins their D-009 refund prices', () => {
    // WHY: the refund table IS the money contract for the removal (owner
    // 2026-08-15, M23 a8). Amounts must stay the ORIGINAL purchase prices —
    // a retune would over/under-refund a mid-sale copy settling later — and
    // no cosmetic may quietly re-enter the catalog under a skin id.
    expect(REMOVED_SKIN_REFUNDS).toEqual({
      skin_keep_gilded: 1_200,
      skin_keep_frost: 900,
      skin_keep_voidstone: 5_000,
    });
    expect(new Set<string>(Object.values(ITEMS).map((item) => item.kind)).has('cosmetic')).toBe(false);
    expect(Object.keys(ITEMS).some((id) => id.startsWith('skin_'))).toBe(false);
  });
});

describe('structures', () => {
  it('versions the KEEP footprint without changing the live/archive default', () => {
    // Owner 2026-08-26 wants a 4x4 flagship KEEP, but old raids and current base
    // rows must continue to mean 2x2 until the separately-gated layout rollout.
    expect(BUILDING_GEOMETRY.keepFootprintByVersion).toEqual({ 1: [2, 2], 2: [4, 4] });
    expect(STRUCTURES.keep.footprint).toEqual([2, 2]);
    expect(resolveBuildingGeometryVersion(undefined)).toBe(1);
    expect(resolveBuildingGeometryVersion(1)).toBe(1);
    expect(resolveBuildingGeometryVersion(2)).toBe(2);
    expect(() => resolveBuildingGeometryVersion(3)).toThrow(/unsupported building geometry version/);
  });

  it('vault has one capacity per level and capacity strictly grows (hoard-vs-spend tension)', () => {
    expect(STRUCTURES.vault.capacity).toHaveLength(STRUCTURES.vault.maxLevel);
    for (let i = 1; i < STRUCTURES.vault.capacity.length; i++) {
      expect(STRUCTURES.vault.capacity[i]!).toBeGreaterThan(STRUCTURES.vault.capacity[i - 1]!);
    }
  });

  it('barracks queue and camp capacity have one entry per level', () => {
    expect(STRUCTURES.barracks.queuePts).toHaveLength(STRUCTURES.barracks.maxLevel);
    expect(STRUCTURES.camp.capacityPts).toHaveLength(STRUCTURES.camp.maxLevel);
  });

  it('wall HP has one entry per tier (T1-20) with T1-3 frozen; keg kills t1/t2, t3 takes two', () => {
    expect(STRUCTURES.wall.hpByTier).toHaveLength(STRUCTURES.wall.maxTier);
    expect(STRUCTURES.wall.hpByTier.slice(0, 3)).toEqual([300, 600, 1200]); // T1-3 frozen (fixture-safe)
    for (let i = 1; i < STRUCTURES.wall.hpByTier.length; i++) {
      expect(STRUCTURES.wall.hpByTier[i]!).toBeGreaterThan(STRUCTURES.wall.hpByTier[i - 1]!); // strictly grows to T20
    }
    const keg = TROOPS.kegrunner.wallBurst;
    expect(keg).toBeGreaterThanOrEqual(STRUCTURES.wall.hpByTier[1]!); // one keg ≥ t2
    expect(keg).toBeLessThan(STRUCTURES.wall.hpByTier[2]!); // t3 survives one keg
  });

  it('M22 traps share four reachable tiers and one bounded aggregate cap', () => {
    expect(CAPS.trapsByKeepLevel).toHaveLength(STRUCTURES.keep.maxLevel);
    for (const type of ['spiketrap', 'powdermine', 'pitfall', 'airmine'] as const) {
      expect(DEFENSES[type].burstDamageByTier).toHaveLength(4);
      expect(TRAP_REPAIR[type].costShardsByTier).toHaveLength(4);
      expect(TRAP_REPAIR[type].repairSec).toBeGreaterThan(0);
    }
    expect(DEFENSES.pitfall.stunTicksByTier.every((ticks) => ticks > 0 && ticks <= 15)).toBe(true);
  });

  it('Air Defence is 2×2 and air-only while Mine preserves its 1×1 gameplay claim', () => {
    expect(DEFENSES.airdefence).toMatchObject({ footprint: [2, 2], targetsAir: true, targetsGround: false });
    expect(STRUCTURES.mine.footprint).toEqual([1, 1]);
  });
});

describe('mail bounds (owner 2026-08-15/M22)', () => {
  it('allows only stackable legacy consumables and keeps every reward bounded', () => {
    expect(MAIL.rewardExpiryDays).toBe(30);
    expect(MAIL.expiryBatchSize).toBe(100);
    expect(MAIL.approvedStackableConsumableIds).toEqual([
      'keg_of_haste', 'finishers_seal', 'powder_charge', 'warzone_aegis',
    ]);
    expect(MAIL.maxAttachments).toBeLessThanOrEqual(3);
    expect(MAIL.listLimitDefault).toBeLessThanOrEqual(MAIL.listLimitMax);
    expect(MAIL.rewardKeepMax).toBeGreaterThan(0);
    expect(MAIL.rewardShardsMax).toBeGreaterThan(0);
    expect(MAIL.rewardConsumableQtyMax).toBeGreaterThan(0);
  });
});

describe('build & upgrade tables', () => {
  it('every building except the Keep is purchasable (Keep L1 is free with the base)', () => {
    const buildable = new Set(Object.keys(BUILD_COSTS));
    for (const type of Object.values(BuildingType)) {
      if (type === BuildingType.Keep) {
        expect(buildable.has(type)).toBe(false);
      } else {
        expect(buildable.has(type)).toBe(true);
      }
    }
  });

  it('upgrade rows cover exactly L2..maxLevel for every leveled building', () => {
    expect(UPGRADE_COSTS.keep).toHaveLength(STRUCTURES.keep.maxLevel - 1);
    expect(UPGRADE_COSTS.mine).toHaveLength(STRUCTURES.mine.maxLevel - 1);
    expect(UPGRADE_COSTS.vault).toHaveLength(STRUCTURES.vault.maxLevel - 1);
    expect(UPGRADE_COSTS.barracks).toHaveLength(STRUCTURES.barracks.maxLevel - 1);
    expect(UPGRADE_COSTS.cannon).toHaveLength(DEFENSE_LEVELING.maxLevel - 1);
    expect(UPGRADE_COSTS.archertower).toHaveLength(DEFENSE_LEVELING.maxLevel - 1);
    expect(UPGRADE_COSTS.mortar).toHaveLength(DEFENSE_LEVELING.maxLevel - 1);
    expect(UPGRADE_COSTS.wall).toHaveLength(STRUCTURES.wall.maxTier - 1);
  });

  it('every timed upgrade row has a matching duration row (server timers need both)', () => {
    for (const key of Object.keys(UPGRADE_TIMES_SEC) as (keyof typeof UPGRADE_TIMES_SEC)[]) {
      expect(UPGRADE_COSTS[key]).toHaveLength(UPGRADE_TIMES_SEC[key].length);
    }
  });

  it('keeps wall upgrades outside the duration table because they complete instantly', () => {
    expect(UPGRADE_TIMES_SEC).not.toHaveProperty('wall');
    expect(UPGRADE_COSTS.wall).toHaveLength(STRUCTURES.wall.maxTier - 1);
  });

  it('upgrade costs strictly increase per level — the sink must deepen with progress', () => {
    for (const costs of Object.values(UPGRADE_COSTS)) {
      for (let i = 1; i < costs.length; i++) {
        expect(costs[i]!).toBeGreaterThan(costs[i - 1]!);
      }
    }
  });

  it('gates match the GDD: Mortar at Keep L3, Forge at Keep L2', () => {
    expect(BUILD_COSTS.mortar.requiresKeepLevel).toBe(3);
    expect(BUILD_COSTS.forge.requiresKeepLevel).toBe(2);
  });

  it('EVERY building finishes its L1 build in one minute — walls alone stay instant', () => {
    // WHY: owner 2026-08-29, verbatim — "first level building should not need
    // hour to build it should be all 1 minute builds, to speed up player
    // onboarding and let them instantly have fun". The GDD §14 first durations
    // (cannon 1h, mortar/air defence 2h, dragon nest 5h) are deliberately
    // overridden: a brand-new player must never wait an hour to see the
    // building they just paid for. This iterates the WHOLE table rather than
    // spot-checking, so re-pricing one building back to 3_600 fails here
    // instead of silently reinstating the hour that drove players off.
    expect(L1_BUILD_SEC).toBe(60);
    for (const [type, spec] of Object.entries(BUILD_COSTS)) {
      // Walls place with no builder job at all (owner 2026-07-20), so 0 is
      // already faster than the minute — the exception must stay 0, never 60.
      expect([type, spec.buildSec]).toEqual([type, type === 'wall' ? 0 : L1_BUILD_SEC]);
    }
  });

  it('the time-gate sink starts at L1→L2, not at placement', () => {
    // WHY: the pair above and this one are what keep the 1-minute L1 decision
    // from being read as "building is free of time". Shortening L1 moved the
    // progression brake onto the upgrade curve, so that curve must stay long —
    // if a future edit flattened UPGRADE_TIMES_SEC too, the whole base would
    // become instant and the KEEP speed-up sink would have nothing to price.
    for (const [type, times] of Object.entries(UPGRADE_TIMES_SEC)) {
      expect([type, times[0]! > L1_BUILD_SEC]).toEqual([type, true]);
    }
  });
});

describe('troops', () => {
  it('the expanded v2 art roster covers every live troop except the deliberately-unshipped Wyrmling', () => {
    const live = TROOP_TYPES.filter((t) => t !== 'wyrmling');
    expect(ART_V2.troops.filter((t) => live.includes(t as (typeof live)[number])).sort())
      .toEqual([...live].sort());
    expect(ART_V2.troops).not.toContain('wyrmling');
    // The protected M14 roots remain present; source precedence, not a renamed
    // key, is what keeps their reviewed art unchanged.
    expect(ART_V2.units).toEqual(expect.arrayContaining(['giant', 'dragon', 'cannon', 'mortar']));
  });

  it('every troop is statted; trainable troops have positive cost/pts, all have combat stats', () => {
    expect(Object.keys(TROOPS).sort()).toEqual([...TROOP_TYPES].sort());
    for (const t of Object.values(TROOPS)) {
      // Combat stats positive for EVERY unit, incl. the Nest-spawned Wyrmling.
      expect(t.hp).toBeGreaterThan(0);
      expect(t.dps).toBeGreaterThan(0);
      expect(t.speedTilesPerSec).toBeGreaterThan(0);
      // The barracks economy applies only to TRAINABLE troops — defender-side
      // and attacker-side spawn products carry no train cost/points.
      const type = Object.entries(TROOPS).find(([, stats]) => stats === t)![0] as keyof typeof TROOPS;
      if (isTrainableTroop(type)) {
        expect(t.pts).toBeGreaterThan(0);
        expect(t.costKeep).toBeGreaterThan(0);
        expect(t.trainSec).toBeGreaterThan(0);
      }
    }
  });

  it('every trainable troop fits a barracks queue, with Direwyvern first fitting at Barracks L4', () => {
    const maxPts = Math.max(
      ...TROOP_TYPES.filter(isTrainableTroop).map((t) => TROOPS[t].pts),
    );
    expect(TROOPS.direwyvern.pts).toBe(25);
    expect(STRUCTURES.barracks.queuePts[2]).toBeLessThan(TROOPS.direwyvern.pts);
    expect(STRUCTURES.barracks.queuePts[3]).toBe(TROOPS.direwyvern.pts);
    expect(maxPts).toBeLessThanOrEqual(STRUCTURES.barracks.queuePts.at(-1)!);
  });

  it('trains each purchased unit tenfold faster, retaining fractional seconds', () => {
    expect(Object.fromEntries(TROOP_TYPES.filter(isTrainableTroop).map((t) => [t, TROOPS[t].trainSec])))
      .toEqual({ highlander: 12, bowman: 9, kegrunner: 7.5, tunneler: 18, turrider: 30,
        plunderer: 6, giant: 30, troll: 27, dragon: 36, mage: 15, bilgewraith: 15,
        gloamfang: 48, direwyvern: 90, hexbarrow: 72 });
  });

  it('pins the owner-authorized dark roster balance and spawn-only boundary', () => {
    // REWRITTEN 2026-08-16 (D-058): the dark troops' requiresKeepLevel gates are
    // RETIRED — the owner item-gated them ("dragon only can be dropped from gold
    // forge, same for wyvern and rest of other way unlocked troops"). The gate
    // numbers live on in ELITE_TROOP_UNLOCKS.grandfather.legacyKeepGates (pinned
    // in the elite-unlock test below). Owner 2026-09-06 changed only training
    // duration to exactly one tenth; combat stats/costs remain unchanged.
    expect(TROOPS.gloamfang).toMatchObject({
      pts: 10, costKeep: 80, trainSec: 48,
      hp: 1500, dps: 100, speedTilesPerSec: 1.5,
    });
    expect(TROOPS.direwyvern).toMatchObject({
      pts: 25, costKeep: 190, trainSec: 90,
      hp: 3200, dps: 220, speedTilesPerSec: 0.65, range: 4.5,
    });
    expect(TROOPS.hexbarrow).toMatchObject({
      pts: 18, costKeep: 140, trainSec: 72,
      hp: 2200, dps: 90, speedTilesPerSec: 0.55, range: 5,
      buildingDamageMult: 3,
    });
    for (const troop of ['gloamfang', 'direwyvern', 'hexbarrow'] as const) {
      expect((TROOPS[troop] as { requiresKeepLevel?: number }).requiresKeepLevel).toBeUndefined();
    }
    expect(TROOPS.barrowling).toMatchObject({
      pts: 0, costKeep: 0, trainSec: 0, spawnOnly: true,
      hp: 40, dps: 8, speedTilesPerSec: 2,
    });
    expect(isTrainableTroop('barrowling')).toBe(false);
    expect(isTrainableTroop('wyrmling')).toBe(false);
    expect((['gloamfang', 'direwyvern', 'hexbarrow'] as const)
      .every((troop) => isTrainableTroop(troop))).toBe(true);
    expect(RAID_REPLAY_LIMITS.simulationWorkerTimeoutSec)
      .toBeLessThan(RAID_REPLAY_LIMITS.simulationLeaseSec);
    expect(RAID_REPLAY_LIMITS.submitRateLimitPerMin).toBe(6);
  });

  it('research follows level × 400 (all L1-20 steps) with one cost+time pair per upgrade step', () => {
    // Cost of the step reaching level i+2 is (i+1) × 400 KEEP — the WHY (Addendum B1),
    // now spanning all 19 steps to L20.
    TROOP_LEVELING.researchCostKeep.forEach((c, i) => expect(c).toBe(400 * (i + 1)));
    expect(TROOP_LEVELING.researchCostKeep).toHaveLength(TROOP_LEVELING.maxLevel - 1);
    expect(TROOP_LEVELING.researchTimeSec).toHaveLength(TROOP_LEVELING.maxLevel - 1);
    for (let i = 1; i < TROOP_LEVELING.researchTimeSec.length; i++) {
      expect(TROOP_LEVELING.researchTimeSec[i]!).toBeGreaterThan(TROOP_LEVELING.researchTimeSec[i - 1]!);
    }
  });
});

describe('hero leveling — the snapshotted integer tables (D-Q1, owner 2026-07-28)', () => {
  // WHY these tests: HERO_LEVELING is a SNAPSHOT of the HEROES spec formulas.
  // If someone retunes a formula without regenerating the table (or vice-versa)
  // the server would charge/stat one thing while the spec page promises another.
  it('every table equals the HEROES spec formula at that level', () => {
    for (const hero of HERO_KEYS) {
      const spec = HEROES[hero];
      for (let n = 1; n <= HERO_LEVELING.maxLevel; n++) {
        expect(HERO_LEVELING.hp[hero][n - 1]).toBe(spec.hpAt(n));
        expect(HERO_LEVELING.dps[hero][n - 1]).toBe(spec.dpsAt(n));
      }
      for (let n = 1; n < HERO_LEVELING.maxLevel; n++) {
        expect(HERO_LEVELING.upgradeCostKeep[hero][n - 1]).toBe(spec.upgradeCostAt(n));
      }
    }
  });

  it('index 0 IS the live L1 combat row — leveling cannot regress existing replays', () => {
    // Every hero in a stored replay is L1; if index 0 ever drifted from
    // HERO_COMBAT the golden fixtures would silently change meaning.
    for (const hero of HERO_KEYS) {
      expect(HERO_LEVELING.hp[hero][0]).toBe(HERO_COMBAT[hero].hp);
      // NO x10. `dpsDeci` is deci-damage per 100ms TICK, so it is numerically the
      // dps figure — the same contract every troop is built on (sim stats.ts).
      // This assertion carried the x10 too, which is why the sim spawning heroes
      // at ten times their stat went unnoticed until 2026-07-29.
      expect(HERO_LEVELING.dps[hero][0]!).toBe(HERO_COMBAT[hero].dpsDeci);
    }
  });

  it('one cost per upgrade STEP, monotonically rising stats and prices', () => {
    for (const hero of HERO_KEYS) {
      expect(HERO_LEVELING.hp[hero]).toHaveLength(HERO_LEVELING.maxLevel);
      expect(HERO_LEVELING.dps[hero]).toHaveLength(HERO_LEVELING.maxLevel);
      // maxLevel-1 steps: buying L20 from L19 is the last purchase there is.
      expect(HERO_LEVELING.upgradeCostKeep[hero]).toHaveLength(HERO_LEVELING.maxLevel - 1);
      for (let i = 1; i < HERO_LEVELING.maxLevel; i++) {
        expect(HERO_LEVELING.hp[hero][i]!).toBeGreaterThan(HERO_LEVELING.hp[hero][i - 1]!);
        expect(HERO_LEVELING.dps[hero][i]!).toBeGreaterThanOrEqual(HERO_LEVELING.dps[hero][i - 1]!);
        expect(HERO_LEVELING.upgradeCostKeep[hero][i - 1]!).toBeGreaterThan(0);
      }
      for (let i = 1; i < HERO_LEVELING.maxLevel - 1; i++) {
        expect(HERO_LEVELING.upgradeCostKeep[hero][i]!)
          .toBeGreaterThan(HERO_LEVELING.upgradeCostKeep[hero][i - 1]!);
      }
    }
  });

  it('hero levels share the troop maxLevel ceiling and each hero has a tier name per tier', () => {
    expect(HERO_LEVELING.maxLevel).toBe(TROOP_LEVELING.maxLevel);
    for (const hero of HERO_KEYS) {
      expect(HEROES[hero].maxLevel).toBe(HERO_LEVELING.maxLevel);
      expect(HEROES[hero].tiers).toHaveLength(4);
    }
  });
});

describe('mining quota — the fixed per-player promise (ECONOMY.md §2)', () => {
  // The v2 quota is fixed per player (never diluted by player count); these
  // encode the WHY: the anchor 500/day, the ~40× endgame spread the owner
  // locked, and that the cache streak is what flips the 1.4× consistency bonus.
  // Pure INTEGER basis-point quota (mirrors emission.ts getMiningQuota): no
  // float touches a balance (CLAUDE.md hard rule) — multiply-before-divide in
  // bigint, / BPS_ONE^4.
  const quota = (mineLv: number, keepLv: number, streak: number): number => {
    const one = BigInt(MINING.BPS_ONE);
    const q =
      (BigInt(MINING.MINE_QUOTA_BASE) *
        BigInt(MINING.MINE_MULT_BPS[mineLv - 1]!) *
        BigInt(MINING.KEEP_MULT_BPS[keepLv - 1]!) *
        BigInt(streak >= MINING.CONSISTENCY_STREAK_DAYS ? MINING.CONSISTENCY_BPS : MINING.BPS_ONE) *
        BigInt(MINING.EPOCH_RATE_BPS)) /
      (one * one * one * one);
    return Number(q);
  };

  it('anchor: L1 Keep + L1 Mine, no streak = exactly 500/day', () => {
    expect(MINING.MINE_QUOTA_BASE).toBe(500);
    expect(quota(1, 1, 0)).toBe(500);
  });

  it('mine & keep multipliers have one entry per level (bps) and strictly grow', () => {
    expect(MINING.MINE_MULT_BPS).toHaveLength(STRUCTURES.mine.maxLevel);
    expect(MINING.KEEP_MULT_BPS).toHaveLength(STRUCTURES.keep.maxLevel);
    expect(MINING.MINE_MULT_BPS[0]).toBe(MINING.BPS_ONE); // 1.0×
    expect(MINING.KEEP_MULT_BPS[0]).toBe(MINING.BPS_ONE);
    for (const tbl of [MINING.MINE_MULT_BPS, MINING.KEEP_MULT_BPS]) {
      for (let i = 1; i < tbl.length; i++) expect(tbl[i]!).toBeGreaterThan(tbl[i - 1]!);
    }
  });

  it('max-mines cap has one entry per Keep level, non-decreasing, plateauing at 8', () => {
    // Silent-tripwire guard: getMiningQuota/base.ts index this by Keep level, so a
    // short array would read `undefined` (→ fewer mines allowed) past its length.
    expect(MINING.MAX_MINES_BY_KEEP).toHaveLength(STRUCTURES.keep.maxLevel);
    expect(MINING.MAX_MINES_BY_KEEP[0]).toBe(2); // Keep L1 → 2 mines
    expect(MINING.MAX_MINES_BY_KEEP[MINING.MAX_MINES_BY_KEEP.length - 1]).toBe(8); // economy-tuned ceiling
    for (let i = 1; i < MINING.MAX_MINES_BY_KEEP.length; i++) {
      expect(MINING.MAX_MINES_BY_KEEP[i]!).toBeGreaterThanOrEqual(MINING.MAX_MINES_BY_KEEP[i - 1]!);
    }
  });

  it('maxed consistent veteran (single L5 mine, L5 keep, streak) = 7,485/day (post-retune)', () => {
    // Owner 2026-07-20: L20 multiplier lowered ×12→×6.68 so a FULLY maxed base
    // (8×L20 mines, L20 keep, streak) tops out at ~250k/day. This single-L5-mine
    // veteran is 500 × 3.27 × 3.27 × 1.4, exact in bps integer math.
    const maxed = quota(5, 5, 7);
    expect(maxed).toBe(7_485);
    expect(maxed / quota(1, 1, 0)).toBeCloseTo(15.0, 1);
  });

  it('a 7-day streak applies the 1.4× (14000 bps) consistency bonus, nothing below', () => {
    expect(MINING.CONSISTENCY_BPS).toBe(14_000);
    expect(MINING.CONSISTENCY_STREAK_DAYS).toBe(7);
    expect(quota(5, 5, 6)).toBe(5_346); // streak<7: no bonus
    expect(quota(5, 5, 7)).toBe(7_485); // streak≥7: ×1.4
  });

  it('the lifetime mint is seeded by the 500M play allocation; EPOCH_RATE_BPS is the mainnet knob', () => {
    // v3: the 500M play bucket BOOTSTRAPS emission_pool (the cap is now the
    // ledger's non-negative invariant on that pool). EPOCH_RATE_BPS = 10000 (=1.0)
    // on devnet bends the long-run rate (§6); storage holds exactly one day.
    expect(TOKEN.allocation.playPool).toBe(500_000_000);
    expect(MINING.EPOCH_RATE_BPS).toBe(10_000);
    expect(MINING.MINE_STORAGE_DAYS).toBe(1);
  });
});

describe('daily cache — the streak ladder (ECONOMY.md §3)', () => {
  // Encodes the WHY: a small flat reward (NOT emission-split), the first-week
  // onboarding ladder 100..700, and the 500/100 lifetime split by consistency.
  it('first week ever ladders D1 100 → D7 700 in 100-step increments', () => {
    expect(DAILY_CACHE.firstWeekStepShards).toBe(100);
    for (let day = 1; day <= 7; day++) {
      expect(day * DAILY_CACHE.firstWeekStepShards).toBe(day * 100);
    }
    expect(7 * DAILY_CACHE.firstWeekStepShards).toBe(700);
  });

  it('lifetime cache is 500 when consistent (streak≥7), else 100 — small & predictable', () => {
    expect(DAILY_CACHE.consistentShards).toBe(500);
    expect(DAILY_CACHE.baseShards).toBe(100);
    expect(DAILY_CACHE.consistencyStreakDays).toBe(MINING.CONSISTENCY_STREAK_DAYS);
    // The cache must stay small vs the mining quota so it cannot become the
    // main income (the v1 mistake) — even the consistent reward is < a Mine-L2 quota.
    const mineL2Quota = (MINING.MINE_QUOTA_BASE * MINING.MINE_MULT_BPS[1]!) / MINING.BPS_ONE; // 680 (post-retune)
    expect(DAILY_CACHE.consistentShards).toBeLessThan(mineL2Quota);
  });
});

describe('caps & grid', () => {
  it('the supported deed observer set fits inside the one-minute ownership-loss SLA', () => {
    const worstCasePassMs = Math.ceil(
      BASE_OWNERSHIP.observationMaxActiveDeeds / BASE_OWNERSHIP.observationConcurrency,
    ) * BASE_OWNERSHIP.observationReadTimeoutMs;
    expect(worstCasePassMs).toBeLessThan(60_000);
    expect(BASE_OWNERSHIP.mutationFreshnessMs).toBeLessThan(
      BASE_OWNERSHIP.observationReadTimeoutMs + BASE_OWNERSHIP.observationPollMs,
    );
  });

  it('trap cap has one entry per Keep level', () => {
    expect(CAPS.trapsByKeepLevel).toHaveLength(STRUCTURES.keep.maxLevel);
  });

  it('wall segment bands ascend 20/40/60', () => {
    expect(CAPS.wallSegments).toEqual([20, 40, 60]);
  });

  it('builder prices cover exactly builders 2–6 at the owner-approved curve', () => {
    expect(CAPS.buildersMax).toBe(6);
    expect(CAPS.builderPricesSol).toEqual([0.5, 0.75, 1, 1.5, 3]);
    expect(CAPS.builderPricesSol).toHaveLength(CAPS.buildersMax - 1);
  });

  it('preserves the original six purchases and appends exactly the approved 50×50 curve', () => {
    expect(CAPS.expansionsMax).toBe(12);
    expect(CAPS.expansionPriceSolByIndex).toEqual([0.15, 0.25, 0.40, 0.65, 1.00, 1.50, 1.75, 2.00, 2.25, 2.50, 2.75, 3.00]);
    expect(CAPS.expansionReqKeepLevel).toEqual([3, 6, 9, 12, 15, 18, 19, 20, 20, 20, 20, 20]);
    expect(CAPS.claimTilesByExpansion).toEqual([14, 16, 18, 20, 22, 24, 26, 30, 34, 38, 42, 46, 50]);
    expect(CAPS.expansionPriceSolByIndex).toHaveLength(CAPS.expansionsMax);
    expect(CAPS.expansionReqKeepLevel).toHaveLength(CAPS.expansionsMax);
  });

  it('expansions fill the current home plot without changing the legacy frame', () => {
    expect(CAPS.claimTilesByExpansion).toHaveLength(CAPS.expansionsMax + 1);
    expect(CAPS.claimTilesByExpansion[0]).toBe(GRID.claimTiles);
    const bounds = PLOT_GEOMETRY.boundsByVersion[PLOT_GEOMETRY.currentVersion];
    expect(CAPS.claimTilesByExpansion[CAPS.expansionsMax]).toBe(bounds.max - bounds.min);
    expect(GRID.plotTiles).toBe(30);
  });

  it('retains the historical drop ring and fits the largest claim inside the current battlefield', () => {
    // Archived replays retain the original plot; new home space does not consume
    // the independent SIM15 battlefield or shrink its deployment margin.
    expect(CAPS.claimTilesByExpansion[6] + 2 * GRID.deployRingTiles).toBe(GRID.plotTiles);
    const maxClaim = Math.max(...CAPS.claimTilesByExpansion);
    const margin = RAID_BATTLEFIELD.marginTilesByVersion[RAID_BATTLEFIELD.currentVersion];
    expect(maxClaim + 2 * GRID.deployRingTiles).toBeLessThanOrEqual(GRID.plotTiles + 2 * margin);
  });
});

describe('raid energy, shield, raids (ECONOMY.md §4/§4a)', () => {
  it('unlocks one additional deed-local Vault every four Keep levels', () => {
    expect(BUILD_COUNT_CAP_BY_KEEP.vault).toEqual([
      1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5,
    ]);
  });

  it('publishes independent Forge drop odds bounded by the owner daily per-item cap', () => {
    // Extended 2026-08-16 (D-058): the four elite TRAINING WRITS are
    // forge-drop-only (owner: "dragon only can be dropped from gold forge,
    // same for wyvern and rest of other way unlocked troops"). ⚠ writ odds are
    // agent assumptions for owner tuning — power-ranked, all rarer than every
    // consumable, all well above the one-a-day-scale Aegis.
    // Extended again 2026-08-16 (D-058 addendum): the ten Warden gear pieces
    // are forge-drop-EXCLUSIVE (owner: "gear also should be gathered
    // exclusively from drops"). ⚠ gear odds are agent assumptions for owner
    // tuning — ranked by the pieces' retired KEEP prices.
    expect(FORGE_DROPS.independentDropBps).toEqual({
      keg_of_haste: 800, finishers_seal: 400, powder_charge: 200, warzone_aegis: 25,
      item_troop_dragon: 120, item_troop_gloamfang: 80,
      item_troop_hexbarrow: 50, item_troop_direwyvern: 30,
      marchers_greaves: 250, siege_gauntlets: 180,
      wardens_helm: 100, keepward_signet: 100,
      shardplate_cuirass: 60, voidweave_cloak: 60, bulwark_deep_keep: 60,
      first_shard_amulet: 40, breaker_of_gates: 40, banner_of_nine: 15,
    });
  });

  it('caps any one item at 2 units per deed per UTC day (owner: "drop 1-2 per item daily not more")', () => {
    // WHY: the cap is the owner's scarcity contract on forge drops. The v2
    // roll design yields at most ONE unit per item per deed/day (one
    // deterministic roll per item id per unique(day, baseId) position, re-runs
    // gated by settledAt), so the structural maximum of 1 must never exceed
    // the published cap — if a future change adds extra rolls, this pin forces
    // it to respect dailyPerItemCap explicitly.
    expect(FORGE_DROPS.dailyPerItemCap).toBe(2);
    const structuralMaxPerItemPerDeedDay = 1;
    expect(structuralMaxPerItemPerDeedDay).toBeLessThanOrEqual(FORGE_DROPS.dailyPerItemCap);
  });
  it('raiding costs ENERGY not KEEP: 6 free/day and NO ceiling on attacks', () => {
    expect(RAID_ENERGY.freePerDay).toBe(6);
    // Owner 2026-07-26 removed the daily raid ceiling outright ("there should
    // not be limit how many times you will attack") — bought energy is now
    // stockpileable, so a surviving cap constant would silently re-throttle it.
    expect((RAID_ENERGY as Record<string, unknown>).maxRaidsPerDay).toBeUndefined();
    // The v3 model removed the KEEP raid ante entirely — no such constant exists.
    expect((ECONOMY as Record<string, unknown>).raidAnteKeep).toBeUndefined();
  });

  it('extra energy is bought with SOL routed through the standard split, never burned', () => {
    expect(RAID_ENERGY.solLamportsPerEnergy).toBe(30_000_000); // 0.03 SOL at 9 decimals
    expect(RAID_ENERGY.packSize).toBe(6);
    // Pack pricing is PER-UNIT (0.015 × 6): a bulk discount, not an undercut.
    expect(RAID_ENERGY.packLamports).toBe(6 * 15_000_000);
    // The pack must stay cheaper per unit than singles (or it is pointless) but
    // never so cheap it kills the single SKU — the total must exceed one single.
    expect(RAID_ENERGY.packLamports / RAID_ENERGY.packSize).toBeLessThan(RAID_ENERGY.solLamportsPerEnergy);
    expect(RAID_ENERGY.packLamports).toBeGreaterThan(RAID_ENERGY.solLamportsPerEnergy);
    const { liquidity, dev, ops } = ECONOMY.solSplitBps;
    expect(liquidity + dev + ops).toBe(10_000); // split, not burn
  });

  it('a PvP attack burns shards scaled by Keep level, at 10% of that level\'s loot ceiling', () => {
    // The shard ante replaced the daily cap as the throttle on attack volume, so
    // it must stay well under what a raid can win or raiding goes -EV and the
    // whole loop dies. Tie it to the loot CEILING rather than a bare number.
    for (const level of [1, 7, 15, 20]) {
      const cost = pvpAttackShardCostForKeepLevel(level);
      expect(cost).toBe(level * LOOT.capPerAttackerKeepLevel * 0.1);
      expect(cost).toBeLessThan(level * LOOT.capPerAttackerKeepLevel);
    }
    // Clamped at both ends — a level past the table must not read undefined.
    expect(pvpAttackShardCostForKeepLevel(0)).toBe(pvpAttackShardCostForKeepLevel(1));
    expect(pvpAttackShardCostForKeepLevel(99)).toBe(pvpAttackShardCostForKeepLevel(20));
  });

  it('shields are SOL-only: a successful raid protects the defender for 48h', () => {
    expect(SHIELD.hoursOnLoss).toBe(48);
    expect(SHIELD.extendCostSolLamports).toBeGreaterThan(0);
    expect(SHIELD).not.toHaveProperty('extendCostKeep'); // KEEP shield path removed
  });

  it('the automatic loss shield reaches the protection ceiling', () => {
    expect(SHIELD.hoursOnLoss).toBe(SHIELD.maxHours);
    expect(SHIELD.extendPurchaseMaxRemainingHours).toBe(36);
    expect(SHIELD.requiresAttackerVictory).toBe(true);
  });

  it('trophies ascend by stars and a 0★ fail costs trophies', () => {
    expect(TROPHIES.winByStars).toEqual([8, 12, 16]);
    expect(TROPHIES.zeroStarLoss).toBeLessThan(0);
  });

  it('pins the conservative cumulative league ladder and deterministic rewards', () => {
    // WHY: this table is a weekly SHARDS/item faucet. A silent threshold or
    // multiplier drift changes who receives convertible value every Monday.
    expect(LEAGUES.thresholds).toEqual([0, 10, 50, 150]);
    expect(LEAGUES.closeCron).toBe('0 0 * * 1');
    expect(LEAGUES.closeAuthoritySweepAttempts).toBe(3);
    expect(LEAGUES.closeAuthorityMaxConcurrentWaves).toBe(5);
    expect(LEAGUES.closeAuthoritySweepRetryMs).toBeGreaterThan(0);
    expect(LEAGUES.closeRecoveryCron).toBe('*/5 * * * *');
    expect(LEAGUES.settlementCron).toBe('15 0 * * 1');
    expect(LEAGUES.settlementDelayMs).toBe(15 * 60 * 1_000);
    expect(LEAGUES.rewardMinAttackerRaids).toBe(3);
    expect(LEAGUES.rewardsPerWalletMax).toBe(1);
    expect(LEAGUES.weeklyCacheShardsByKeepLevel).toEqual([
      150, 200, 350, 1_000, 2_000, 3_000, 5_000, 5_500, 6_500, 7_000,
      8_000, 9_000, 10_000, 11_000, 12_000, 13_000, 14_000, 15_000, 16_000, 17_000,
    ]);
    expect(LEAGUES.cacheTierMultBps).toEqual({
      bronze: 10_000, silver: 20_000, gold: 40_000, sol: 60_000,
    });
    expect(LEAGUES.weeklyItemsByTier).toEqual({
      bronze: [{ itemId: 'keg_of_haste', qty: 1 }],
      silver: [{ itemId: 'keg_of_haste', qty: 2 }],
      gold: [{ itemId: 'finishers_seal', qty: 1 }],
      sol: [{ itemId: 'finishers_seal', qty: 1 }, { itemId: 'keg_of_haste', qty: 2 }],
    });
    for (const items of Object.values(LEAGUES.weeklyItemsByTier)) {
      expect(items.every(({ itemId }) => ['keg_of_haste', 'finishers_seal'].includes(itemId))).toBe(true);
    }
    expect(LEAGUES).not.toHaveProperty('poolSplit');
    expect(LEAGUES).not.toHaveProperty('weeklyEnergyUnitsByTier');
    expect(LEAGUES).not.toHaveProperty('solSliceBps');
  });

  it('loot fractions are sane percentages of surplus', () => {
    expect(LOOT.surplusFraction).toBeGreaterThan(0);
    expect(LOOT.surplusFraction).toBeLessThan(1);
    expect(LOOT.vaultDestroyedBonusFraction).toBeGreaterThan(0);
    expect(LOOT.vaultDestroyedBonusFraction).toBeLessThan(LOOT.surplusFraction);
  });

  it('loot cap is keepLevel × 1000 — uncapped extra income on top of the energy spent (ECONOMY.md §4)', () => {
    expect(LOOT.capPerAttackerKeepLevel).toBe(1_000);
    // D-065 (owner 2026-08-21): half of a deed's shards are at stake in a raid,
    // and the best standing Vault can shield up to 30 of those 50 points by
    // level — a maxed Vault leaves 20% lootable. formulaVersion 2 marks the
    // reservations settled under this rule; v1 rows keep the old split.
    expect(LOOT.balanceLootableBps).toBe(5_000);
    expect(LOOT.vaultProtectionMaxBps).toBe(3_000);
    expect(LOOT.vaultProtectionMaxBps).toBeLessThan(LOOT.balanceLootableBps);
    expect(LOOT.formulaVersion).toBe(2);
    // Raiding costs only energy now (not KEEP), so any positive loot is net KEEP
    // income; the ×1000 cap makes a good target clearly worth an energy charge.
    expect(LOOT.capPerAttackerKeepLevel).toBeGreaterThan(0);
  });
});

describe('quests & PvE — the 5% bucket', () => {
  // REWRITTEN for M23 a15 (owner 2026-08-15: "at least 50 interesting, fully
  // working quests"): the pool grew 12 → 50 dailies + a 5-template weekly
  // rotation. The old "exactly 12" pin now pins the EXPANDED pool size AND
  // that the original 12 live-keyed templates survived unchanged.
  it('the M23 a15 pool: 50 unique dailies + 5 unique weeklies (≥50 total)', () => {
    expect(QUESTS.dailyTemplates).toHaveLength(50);
    expect(QUESTS.weeklyTemplates).toHaveLength(5);
    const dailyIds = QUESTS.dailyTemplates.map((q) => q.id);
    expect(new Set(dailyIds).size).toBe(dailyIds.length);
    const weeklyIds = QUESTS.weeklyTemplates.map((q) => q.id);
    expect(new Set(weeklyIds).size).toBe(weeklyIds.length);
    // Dailies and weeklies never share an id: the hooks fire one templateCode
    // volley, so a shared id would double-advance across scopes ambiguously.
    expect(dailyIds.filter((id) => (weeklyIds as string[]).includes(id))).toEqual([]);
    expect(dailyIds.length + weeklyIds.length).toBeGreaterThanOrEqual(50);
  });

  it('the original 12 GDD §5 templates are byte-frozen (live rows key on templateCode)', () => {
    // Production quest/progress rows reference these ids with these targets and
    // rewards. Renaming an id orphans live progress; changing a target strands
    // half-complete counters. The M23 a15 expansion may only APPEND.
    expect(QUESTS.dailyTemplates.slice(0, 12).map((q) => [q.id, q.rewardShards])).toEqual([
      ['win_2_star', 20], ['steal_500', 20], ['two_keg_runners', 15],
      ['clear_ruined_keep', 15], ['upgrade_any', 15], ['defend_success', 30],
      ['spend_200', 15], ['scout_3', 10], ['place_5_walls', 10],
      ['train_tur_rider', 15], ['all_3_buffs', 30], ['win_from_map', 20],
    ]);
    expect(
      (['win_2_star', 'steal_500', 'two_keg_runners', 'clear_ruined_keep', 'upgrade_any',
        'defend_success', 'spend_200', 'scout_3', 'place_5_walls', 'train_tur_rider',
        'all_3_buffs', 'win_from_map'] as const).map((id) => QUESTS.progressTargets[id]),
    ).toEqual([1, 500, 1, 1, 1, 1, 200, 3, 5, 1, 1, 1]);
  });

  it('progressTargets ↔ dailyTemplates is a bijection (M23 a15: no hookless or targetless quest)', () => {
    const ids = new Set<string>(QUESTS.dailyTemplates.map((q) => q.id));
    for (const q of QUESTS.dailyTemplates) {
      const target = QUESTS.progressTargets[q.id];
      expect(target, `daily ${q.id} needs a progress target`).toBeDefined();
      expect(Number.isInteger(target)).toBe(true);
      expect(target!).toBeGreaterThanOrEqual(1);
    }
    for (const key of Object.keys(QUESTS.progressTargets)) {
      expect(ids.has(key), `progressTargets.${key} has no daily template`).toBe(true);
    }
  });

  it('weekly rotation keeps earn_8_stars intact and every weekly pays the original 100', () => {
    // progressWeeklyStars still keys on QUESTS.weekly.id, so the rotation
    // entry must stay identical to the legacy weekly object.
    const anchor = QUESTS.weeklyTemplates.find((t) => t.id === QUESTS.weekly.id);
    expect(anchor).toMatchObject({
      id: 'earn_8_stars',
      target: QUESTS.weekly.goalStars,
      rewardShards: QUESTS.weekly.rewardShards,
    });
    for (const t of QUESTS.weeklyTemplates) {
      expect(Number.isInteger(t.target)).toBe(true);
      expect(t.target).toBeGreaterThanOrEqual(1);
      expect(t.rewardShards).toBe(100);
    }
  });

  it('the onboarding chain is the six first-run actions, in the order a player walks them', () => {
    // THE ORDER IS THE PRODUCT (owner 2026-08-28: onboarding "should be quest
    // driven"; "First level camp, mine, barracks … and also direct them to buy
    // land and perform first raid"). The client walks this array top to bottom
    // and shows exactly ONE step as the live objective, so a reordering here
    // silently changes what a new player is told to do first — which is the
    // single most consequential UX decision in the game.
    expect(QUESTS.onboardingTemplates.map((t) => t.id)).toEqual([
      'first_camp', 'first_mine', 'first_barracks', 'first_troops', 'first_land', 'first_raid',
    ]);
    // The army step proves completed training filled the first Camp; other
    // steps remain single actions (owner 2026-09-05).
    for (const t of QUESTS.onboardingTemplates) {
      expect(t.target).toBe(t.id === 'first_troops' ? STRUCTURES.camp.capacityPts[0] : 1);
    }
    expect(QUESTS.onboardingTemplates.find((t) => t.id === 'first_troops')!.rewardShards)
      .toBe(QUESTS.dailyTemplates.find((t) => t.id === 'train_20_points')!.rewardShards);
  });

  it('every onboarding reward REUSES an existing daily value — this lane authored no balance', () => {
    // Reward balance is the owner's call, so the quest-onboarding lane copied
    // numbers instead of inventing them (2026-08-28). Pinning that here means a
    // future edit that quietly invents a sixth reward tier has to say so.
    const dailyRewards = new Set(QUESTS.dailyTemplates.map((t) => t.rewardShards));
    for (const t of QUESTS.onboardingTemplates) {
      expect(dailyRewards.has(t.rewardShards), `${t.id} pays ${t.rewardShards}, which no daily pays`).toBe(true);
    }
  });

  it('the chain shares no id with the daily or weekly pools', () => {
    // All three scopes live in ONE quests table keyed by templateCode, and
    // progressQuest ticks EVERY live row matching a code. A collision would make
    // a daily silently complete an onboarding step, or the reverse.
    const others = new Set<string>([
      ...QUESTS.dailyTemplates.map((t) => t.id),
      ...QUESTS.weeklyTemplates.map((t) => t.id),
    ]);
    for (const t of QUESTS.onboardingTemplates) {
      expect(others.has(t.id), `${t.id} collides with a daily/weekly template`).toBe(false);
    }
  });

  it('daily rewards stay in the GDD 10–30 band so the capped bucket cannot drain', () => {
    // M23 a15 kept every new daily inside the original band (the owner allowed
    // up to 40; nothing needed it — effort scaling fits in 10–30).
    for (const q of QUESTS.dailyTemplates) {
      expect(q.rewardShards).toBeGreaterThanOrEqual(10);
      expect(q.rewardShards).toBeLessThanOrEqual(30);
    }
    expect(QUESTS.allThreeBonusShards).toBe(25);
    expect(QUESTS.weekly.rewardShards).toBe(100);
  });

  it('PvE bounty ascends by tier and never grants trophies/breaks shields', () => {
    // 9 tiers: 1–8 in rotation (owner 2026-07-24) + the ops-only MAXED practice
    // camp T9 (owner 2026-08-03) — the spawner/campaign never emit 9 (world.test.ts).
    expect(PVE.bountyByTier).toEqual([30, 50, 80, 140, 240, 420, 720, 1_200, 2_000]);
    // Strictly ascending — a harder camp always pays more.
    for (let i = 1; i < PVE.bountyByTier.length; i++) {
      expect(PVE.bountyByTier[i]!).toBeGreaterThan(PVE.bountyByTier[i - 1]!);
    }
    expect(PVE.awardsTrophies).toBe(false);
    expect(PVE.breaksShield).toBe(false);
    expect(PVE.costsEnergy).toBe(false);
  });
});

describe('buffs & obstacles', () => {
  it('powder charge makes keg + buff one-shot a t3 wall (the §3.5 promise)', () => {
    expect(TROOPS.kegrunner.wallBurst! * BUFFS.powdercharge.wallDamageMult).toBeGreaterThanOrEqual(
      STRUCTURES.wall.hpByTier[2]!,
    );
  });

  it('obstacle tiers escalate in both cost and clear time', () => {
    const { small, medium, large } = OBSTACLES.tiers;
    expect(small.costKeep).toBeLessThan(medium.costKeep);
    expect(medium.costKeep).toBeLessThan(large.costKeep);
    expect(small.clearSec).toBeLessThan(medium.clearSec);
    expect(medium.clearSec).toBeLessThan(large.clearSec);
    expect(OBSTACLES.clearRewardShards).toBe(15);
  });
});

describe('marketplace (Lane A)', () => {
  it('the item fee matches the deed royalty without coupling to league rewards', () => {
    expect(MARKETPLACE.feeBps).toBe(500);
    // Two knobs, deliberately (security review 2026-07-29 F5): feeBps is live
    // server policy; deedRoyaltyBps is immutable chain metadata. Ranked leagues
    // have no loot-tithe knob after the owner-approved 2026-08-30 reward package.
    expect(MARKETPLACE.deedRoyaltyBps).toBe(MARKETPLACE.feeBps);
    expect(LEAGUES).not.toHaveProperty('lootTitheBps');
  });

  it('trading may only be ON when a buyer can actually CLAIM the base', () => {
    // INV-2 restated after the 2026-07-29 thaw (owner: "deed nfts should be
    // tradeable"). The flag controls COPY only — the chain decides whether an
    // asset moves — so the invariant worth pinning is no longer "always false"
    // but the COUPLING: the UI must never advertise a tradable deed unless the
    // pull-based claim exists to make that deed convey a base. Selling a deed
    // that conveys nothing is the exact hazard the freeze was protecting.
    if (MARKETPLACE.tradingEnabled) {
      expect(MARKETPLACE.claim.rateLimitPerMin).toBeGreaterThan(0);
      expect(MARKETPLACE.claim.maxCandidates).toBeGreaterThan(0);
    }
    // And the royalty the deed collection was created with must still be real,
    // since a thawed deed is what earns it.
    expect(MARKETPLACE.deedRoyaltyBps).toBeGreaterThan(0);
  });

  it('builds canonical Tensor / Magic Eden URLs for an item and a collection', () => {
    const mint = 'AsSeT1111111111111111111111111111111111111';
    expect(tensorItemUrl(mint)).toBe(`https://www.tensor.trade/item/${mint}`);
    expect(magicEdenItemUrl(mint)).toBe(`https://magiceden.io/item-details/${mint}`);
    expect(tensorCollectionUrl(mint)).toBe(`https://www.tensor.trade/trade/${mint}`);
    expect(magicEdenCollectionUrl(mint)).toBe(`https://magiceden.io/marketplace/${mint}`);
  });
});

describe('hero recruitment + elite troop unlock items (D-058, owner 2026-08-16)', () => {
  it('both heroes unlock at Keep 5 and are KEEP-priced: Vex 3,000 / Theodor 10,000', () => {
    // Owner verbatim: "hero unlock start from keep level 5. Vex hero cost is
    // 3000 KEEP, Theodor 10,000 KEEP". The altar shard price is retired: the
    // recruit fee is the ONLY charge, so costShards must stay 0 or placement
    // would double-charge.
    for (const hero of HERO_KEYS) {
      expect(HEROES[hero].unlockKeepLevel).toBe(5);
      expect(BUILD_COSTS[HEROES[hero].altar]).toMatchObject({ costShards: 0, requiresKeepLevel: 5 });
      // The contract item exists, is priced exactly like the direct recruit
      // (no cheaper path), and gates its shop purchase at the same Keep 5.
      const contract = (UNLOCK_ITEMS as Record<string, { costKeep: number; acquisition: { type: string; keepLevel?: number } }>)[
        HEROES[hero].recruitItemId
      ]!;
      expect(contract.costKeep).toBe(HEROES[hero].recruitCostKeep);
      expect(contract.acquisition).toEqual({ type: 'keep_level', keepLevel: 5 });
    }
    expect(HEROES.vex.recruitCostKeep).toBe(3_000);
    expect(HEROES.theodor.recruitCostKeep).toBe(10_000);
  });

  it('every elite troop has a writ; mage sells for 5,000 KEEP; the other four are forge-drop-only yet tradeable', () => {
    // Owner verbatim: "some troops are also items, dragon, wyvern, gloamfang,
    // hexabraw(cannon), mage. some of them for example mage should cost 5,000
    // KEEP, dragon only can be dropped from gold forge, same for wyvern and
    // rest of other way unlocked troops."
    expect(Object.keys(ELITE_TROOP_UNLOCKS.itemByTroop).sort())
      .toEqual(['dragon', 'direwyvern', 'gloamfang', 'hexbarrow', 'mage'].sort());
    for (const [troop, itemId] of Object.entries(ELITE_TROOP_UNLOCKS.itemByTroop)) {
      expect(isEliteTroop(troop)).toBe(true);
      const writ = (ITEMS as Record<string, {
        effect?: { type: string; troop?: string }; dropOnly?: boolean;
        acquisition: { type: string }; costKeep: number;
      }>)[itemId]!;
      expect(writ.effect).toEqual({ type: 'troop_unlock', troop });
      // Tradeable (owner: sellable on the in-game market) — the dropOnly flag
      // is the market listing fence, so a writ must never carry it.
      expect(writ.dropOnly).toBeUndefined();
      if (troop === 'mage') {
        expect(writ.acquisition).toEqual({ type: 'shop' });
        expect(writ.costKeep).toBe(5_000); // owner: "mage should cost 5,000 KEEP"
      } else {
        // Forge-drop-only: buyItem refuses acquisition 'drop', and the writ
        // must actually be in the forge's drop table or it is unobtainable.
        expect(writ.acquisition).toEqual({ type: 'drop' });
        expect(FORGE_DROPS.independentDropBps).toHaveProperty(itemId);
      }
    }
    // Grandfather record: the retired Keep gates are preserved verbatim so the
    // backfill grants exactly what the old rules allowed.
    expect(ELITE_TROOP_UNLOCKS.grandfather.legacyKeepGates).toEqual({
      mage: 1, dragon: 1, gloamfang: 8, hexbarrow: 10, direwyvern: 14,
    });
  });
});

describe('D-057 — SOL regating of mines and the Gold Forge (owner 2026-08-16)', () => {
  // Owner verbatim: "we should not gate miners with sol at start, mines should
  // be paid to upgrade from level 5, 6,7,8 levels start with 0.5 sol pricing.
  // and we should gate gold forge from level 2, level 1 without sol, also
  // start with 0.2 sol + shards."
  it('no mine BUILD costs SOL any more — every progressive build price is 0', () => {
    expect(MINING.MINE_BUILD_SOL_LAMPORTS.every((p) => p === 0)).toBe(true);
    // …while the progressive KEEP ladder stays the real (non-SOL) charge.
    expect(MINING.MINE_BUILD_KEEP[0]).toBe(400);
    expect(MINING.MINE_BUILD_KEEP.length).toBe(MINING.MINE_BUILD_SOL_LAMPORTS.length);
  });

  it('mine upgrades: L2–L4 free of SOL, the wall starts at L5 with the owner-set 0.5', () => {
    for (const target of [2, 3, 4]) expect(upgradeSolLamports('mine', target)).toBe(0);
    expect(upgradeSolLamports('mine', 5)).toBe(500_000_000); // owner: "start with 0.5 sol pricing"
    // The curve stays monotonic through every priced step so a deeper level is
    // never cheaper than a shallower one (L6+ values are agent assumptions the
    // owner may retune — see the table's source comment).
    for (let target = 6; target <= STRUCTURES.mine.maxLevel; target++) {
      expect(upgradeSolLamports('mine', target)).toBeGreaterThan(upgradeSolLamports('mine', target - 1));
    }
  });

  it('gold forge: L1 build carries no SOL; the owner-set curve is 0.1 at L2 then +0.05 per level', () => {
    // Owner 2026-08-16 (verbatim, superseding the earlier agent-assumed
    // 0.2 + 0.1/level curve): "gold forge lv1>2 should cost 0.1 sol next more
    // 0.15 sol next more 0.2 sol and increase every level price for 0.05."
    expect('costSolLamports' in BUILD_COSTS.goldforge).toBe(false); // shards-only build
    expect(upgradeSolLamports('goldforge', 2)).toBe(100_000_000); // 0.10 SOL
    expect(upgradeSolLamports('goldforge', 3)).toBe(150_000_000); // 0.15 SOL
    expect(upgradeSolLamports('goldforge', 4)).toBe(200_000_000); // 0.20 SOL
    for (let target = 2; target <= STRUCTURES.goldforge.maxLevel; target++) {
      // Every step is exactly 0.05 SOL × target — L20 tops out at 1.00 SOL.
      expect(upgradeSolLamports('goldforge', target)).toBe(target * 50_000_000);
      // IN-FLIGHT SAFETY (D-057 retuning rule): a step may never rise above its
      // previously-published price (0.1 SOL × target) while intents can be in
      // flight — the frozen old quote must keep covering the current price so
      // the greater-is-honoured credit rule lands every already-paid upgrade.
      expect(upgradeSolLamports('goldforge', target)).toBeLessThanOrEqual(target * 100_000_000);
    }
  });

  it('no other building type is SOL-gated, and beyond-max targets price at 0', () => {
    for (const type of Object.keys(UPGRADE_COSTS)) {
      if (type === 'mine' || type === 'goldforge') continue;
      for (let target = 2; target <= 20; target++) expect(upgradeSolLamports(type, target)).toBe(0);
    }
    expect(upgradeSolLamports('mine', STRUCTURES.mine.maxLevel + 1)).toBe(0);
    expect(upgradeSolLamports('goldforge', STRUCTURES.goldforge.maxLevel + 1)).toBe(0);
  });
});

/**
 * D-085 (owner 2026-08-30): one hand-authored upgrade ladder for every building
 * except the four traps, with KEEP and GOLDFORGE on the same ladder x1.2.
 *
 * WHY THIS IS PINNED: the owner dictated these nineteen steps level by level, and
 * two of them only exist because they were queried — the L13->L14 step was given as
 * "15h" (shorter than the 16h below it) and corrected to 20h, and L18->L19 was
 * missing entirely and filled as 60h. A silent edit that reintroduces a step
 * shorter than the one below it is the defect this test exists to catch, because
 * players find non-monotonic timers immediately and the table is 20 rows of digits
 * nobody re-reads.
 */
describe('D-085 upgrade ladder', () => {
  const LADDER_SEC = [
    600, 1_200, 2_700, 3_600, 5_400, 7_200, 10_800, 14_400, 28_800, 36_000,
    43_200, 57_600, 72_000, 86_400, 100_800, 115_200, 172_800, 216_000, 259_200,
  ];
  const TRAPS = ['spiketrap', 'powdermine', 'pitfall', 'airmine'];
  const KEEP_TIER = ['keep', 'goldforge'];
  const table = UPGRADE_TIMES_SEC as unknown as Record<string, readonly number[]>;

  it('gives every non-trap building the owner-dictated ladder', () => {
    for (const [type, curve] of Object.entries(table)) {
      if (TRAPS.includes(type)) continue;
      const expected = KEEP_TIER.includes(type)
        ? LADDER_SEC.map((sec) => (sec * 6) / 5)
        : LADDER_SEC;
      expect([type, [...curve]]).toEqual([type, expected]);
    }
  });

  it('leaves the four traps on their own fast curve', () => {
    // Owner ruled explicitly: a disposable defence must not take 342.75h to max.
    for (const type of TRAPS) {
      expect([type, table[type]?.[0]]).toEqual([type, 600]);
      const total = table[type]!.reduce((a, b) => a + b, 0);
      expect([type, total < 200_000]).toEqual([type, true]);
    }
  });

  it('never lets a higher level take less time than the level below it', () => {
    for (const [type, curve] of Object.entries(table)) {
      for (let i = 1; i < curve.length; i += 1) {
        expect([type, i, curve[i]! >= curve[i - 1]!]).toEqual([type, i, true]);
      }
    }
  });

  it('keeps the KEEP the slowest ladder in the game, so it still paces progression', () => {
    const total = (t: string) => table[t]!.reduce((a, b) => a + b, 0);
    for (const type of Object.keys(table)) {
      if (type === 'keep') continue;
      expect([type, total('keep') >= total(type)]).toEqual([type, true]);
    }
  });
});

describe('RAID_PLAYBACK — hidden-tab catch-up (D-096 battle clock)', () => {
  it('replays a missed span faster than real time but still as a fight, not a jump', () => {
    // WHY: at 1× the field could never repay a hidden-tab pause — it would
    // finish late by the whole absence while the wall-clock HUD and commit ran
    // on. Past ~16× the missed events become a flicker to the verdict rather
    // than a fast-forward the player can follow.
    expect(RAID_PLAYBACK.catchUpTimeScale).toBeGreaterThan(1);
    expect(RAID_PLAYBACK.catchUpTimeScale).toBeLessThanOrEqual(16);
    expect(Number.isInteger(RAID_PLAYBACK.catchUpTimeScale)).toBe(true);
  });
});

describe('GLOBE parcel window — the marker cap (D-097, owner 2026-09-02)', () => {
  it('cuts one parcel response at a whole number of markers the rect can actually exceed', () => {
    // WHY: "even if we have all 59,000 bases minted" — D-042's 4,096-cell rect
    // is four times what a phone draws in a frame once every cell holds a base,
    // so the RESPONSE needs its own bound. It is a count of markers (whole,
    // positive), and it must sit at or under parcelViewportMaxCells: a rect can
    // never hold more bases than cells (earth_cell is unique), so a cap above
    // that bound could never bite and would be a promise the server never keeps.
    // D-042's rect numbers are the owner's and this cap does not move them.
    expect(Number.isInteger(GLOBE.parcelViewportMaxMarkers)).toBe(true);
    expect(GLOBE.parcelViewportMaxMarkers).toBeGreaterThan(0);
    expect(GLOBE.parcelViewportMaxMarkers).toBeLessThanOrEqual(GLOBE.parcelViewportMaxCells);
  });
});

describe('DEVNET_FAUCET — the in-game faucet is the only faucet (D-098, owner 2026-09-02)', () => {
  it('pays for one Land Deed in a single grant', () => {
    // WHY: the faucet exists so a fresh wallet can buy land; a grant smaller
    // than the deed would send the player looking for a second source of SOL,
    // and the public faucet may refuse them (it asks for a mainnet balance).
    expect(DEVNET_FAUCET.grantSol).toBeGreaterThanOrEqual(ECONOMY.entryFeeSol);
  });

  it('caps a wallet at a whole number of grants', () => {
    // WHY: the client shows "LIFETIME 3.0/3.0 USED" and the server refuses the
    // grant that would cross the cap; a fractional remainder would be SOL the
    // player is promised but can never receive.
    const grants = DEVNET_FAUCET.lifetimeCapSol / DEVNET_FAUCET.grantSol;
    expect(grants).toBeCloseTo(Math.round(grants), 9);
    expect(grants).toBeGreaterThanOrEqual(1);
  });

  it('lets a player who spends a grant the same day be topped up that day', () => {
    // WHY: the reporting player was refused with 0.149 SOL; a cooldown of a
    // day or more would turn "topped up when you run low" into "come back
    // tomorrow" for anyone who buys land and upgrades in one sitting.
    expect(DEVNET_FAUCET.cooldownHours).toBeGreaterThan(0);
    expect(DEVNET_FAUCET.cooldownHours).toBeLessThan(24);
  });

  it('keeps the treasury floor above one deed and the daily budget above one wallet cap', () => {
    // WHY: the faucet treasury also backs the owner's devnet operations (deed
    // mints), so the floor must cover at least one deed; and a single wallet
    // reaching its lifetime cap in a day must never exhaust the treasury-wide
    // daily budget — that budget exists to bound referral trees, not one player.
    expect(DEVNET_FAUCET.treasuryFloorSol).toBeGreaterThanOrEqual(ECONOMY.entryFeeSol);
    expect(DEVNET_FAUCET.dailyBudgetSol).toBeGreaterThanOrEqual(DEVNET_FAUCET.lifetimeCapSol);
  });
});

describe('PvP Keep-asymmetry gate (D-099, owner 2026-09-02)', () => {
  it('lets the weaker Keep attack up and stops the stronger one attacking too far down', () => {
    // WHY: "KEEP 10 cannot attack KEEP 1; KEEP 1 can attack KEEP 10". Trophies
    // measure activity, not strength, so the old ±20 % window let a K10 farm a
    // K1 who happened to share its rating and hid a strong low-trophy base from
    // everyone. Attacking UP is always fair game — the risk is the attacker's.
    for (const [attacker, defender] of [[1, 1], [1, 10], [2, 1], [10, 5], [20, 10]] as const) {
      expect(pvpAttackAllowed(attacker, defender), `K${attacker} → K${defender}`).toBe(true);
    }
    for (const [attacker, defender] of [[10, 1], [3, 1], [11, 5]] as const) {
      expect(pvpAttackAllowed(attacker, defender), `K${attacker} → K${defender}`).toBe(false);
    }
    for (let attacker = 1; attacker <= 20; attacker++) {
      for (let defender = attacker; defender <= 20; defender++) {
        expect(pvpAttackAllowed(attacker, defender)).toBe(true);
      }
    }
  });

  it('publishes the same bound the SQL candidate filter uses, as an integer ceiling', () => {
    // WHY: auto-match puts `keep_level >= pvpMinDefenderKeep(attacker)` in the
    // query and the named-target path calls pvpAttackAllowed; the two must be
    // the same rule or the map could offer a base the raid refuses. The owner's
    // table: K3→≥2, K6→≥3, K10→≥5, K11→≥6, K20→≥10 — a half rounds UP, never
    // down, or K11 could attack K5 while K10 could not.
    expect(RAID_RULES.pvpMinDefenderKeepBps).toBe(5_000);
    expect([1, 3, 6, 10, 11, 20].map(pvpMinDefenderKeep)).toEqual([1, 2, 3, 5, 6, 10]);
    for (let attacker = 1; attacker <= 20; attacker++) {
      const min = pvpMinDefenderKeep(attacker);
      expect(Number.isInteger(min)).toBe(true);
      expect(pvpAttackAllowed(attacker, min)).toBe(true);
      expect(pvpAttackAllowed(attacker, min - 1)).toBe(false);
    }
  });

  it('keeps trophies as a sort, never a filter: no window constant survives', () => {
    // WHY: the KEEP-11 report — "no eligible targets" for a player who had
    // out-climbed every peer's trophy band. A surviving window constant would
    // silently re-introduce exactly that dead end through whichever caller
    // still read it.
    const rules = RAID_RULES as Record<string, unknown>;
    for (const retired of ['autoMatchTrophyWindow', 'mapTrophyWindow', 'minTrophyWindow', 'autoMatchFallbackMult']) {
      expect(rules[retired], `${retired} must stay retired`).toBeUndefined();
    }
    expect((GLOBE as Record<string, unknown>)['trophyBucket']).toBeUndefined();
    expect(RAID_RULES.autoMatchNearestPick).toBe(10);
    expect(RAID_RULES.autoMatchNearestPick).toBeLessThanOrEqual(RAID_RULES.autoMatchCandidatePool);
  });
});

/**
 * Phase E commit A (D-152 §5; E2-WORKSHOP-CONTRACT §0-§2, §8; E2-GEMS-CONTRACT
 * §1.3). WHY THESE ARE PINNED: the five building types ship DARK — enum values
 * and constants rows with no placement — and the recipe is an owner lock. A
 * missing table row would surface as a 500 the day commit B flips placement; a
 * drifted recipe would break every ingot receipt (`shards_charged = ingots ×
 * 10,000`); a second Workshop per base would double the refine cap the owner
 * bounded per base.
 */
describe('Phase E commit A — dark building types, Forge Ingot, Gems tasks', () => {
  const PHASE_E_TYPES = ['workshop', 'lodge', 'market', 'harvester', 'berth'] as const;

  it('names exactly the five D-152 types, once each, in the enum and the catalogue metadata', () => {
    expect([...PHASE_E_BUILDINGS.types]).toEqual([...PHASE_E_TYPES]);
    expect([...PHASE_E_BUILDINGS.serviceTypes, PHASE_E_BUILDINGS.berthType]).toEqual([...PHASE_E_TYPES]);
    for (const type of PHASE_E_TYPES) expect(Object.values(BuildingType)).toContain(type);
  });

  it('gives every dark type a full row set: 2x2 passive destructible, L1 gate ≥ Keep 3, 19-step ladders', () => {
    const times = UPGRADE_TIMES_SEC as unknown as Record<string, readonly number[]>;
    for (const type of PHASE_E_TYPES) {
      // Attackable, non-firing (owner): hp only, no attack fields, like a camp.
      expect(STRUCTURES[type]).toEqual({ hp: 600, maxLevel: 20, footprint: [2, 2] });
      expect(BUILD_COSTS[type].buildSec).toBe(L1_BUILD_SEC);
      expect(BUILD_COSTS[type].costShards).toBeGreaterThan(0);
      expect(BUILD_COSTS[type].requiresKeepLevel).toBeGreaterThanOrEqual(3);
      expect(UPGRADE_COSTS[type]).toHaveLength(STRUCTURES[type].maxLevel - 1);
      expect(times[type]).toHaveLength(STRUCTURES[type].maxLevel - 1);
      // No SOL wall on any of these (E1-CONTRACTS §1.3: upper-level SOL unapproved).
      for (let target = 2; target <= 20; target++) expect(upgradeSolLamports(type, target)).toBe(0);
    }
  });

  it('the Workshop is reachable on day 1 with the starter grant: ≤ 2,000 SHARDS at Keep 3', () => {
    // JOURNEY-MODEL §3.1: 5,000 starter SHARDS pay Keep L1→3 + Gold Forge on
    // day 1 only if the Workshop costs ≤ 2,028; the contract caps it at 2,000.
    expect(BUILD_COSTS.workshop).toEqual({ costShards: 2_000, buildSec: L1_BUILD_SEC, requiresKeepLevel: 3 });
    expect(BUILD_COSTS.workshop.costShards).toBeLessThanOrEqual(2_000);
  });

  it('caps every dark type at exactly ONE per base from its gate (LOCKED owner rule; berth 1 at launch)', () => {
    for (const type of PHASE_E_TYPES) {
      const caps = BUILD_COUNT_CAP_BY_KEEP[type]!;
      const gate = BUILD_COSTS[type].requiresKeepLevel;
      expect(caps).toHaveLength(STRUCTURES.keep.maxLevel);
      for (let keep = 1; keep <= caps.length; keep++) {
        expect([type, keep, caps[keep - 1]]).toEqual([type, keep, keep >= gate ? 1 : 0]);
      }
      expect(buildCountCapForKeep(type, STRUCTURES.keep.maxLevel)).toBe(1);
    }
  });

  it('references the LOCKED recipe from the policy catalogue instead of restating it', () => {
    expect(FORGE_INGOT.shardsPerIngot).toBe(PHASE_E_POLICY.forge.shardsPerIngot);
    expect(FORGE_INGOT.shardsPerIngot).toBe(10_000);
    expect(FORGE_INGOT.committedExposure).toBe('protected_final');
    expect(FORGE_INGOT.recipeVersion).toBe(1);
  });

  it('keeps the batch, duration and cap shapes positive and bounded', () => {
    expect(FORGE_INGOT.batch.baseSize).toBeGreaterThan(0);
    expect(FORGE_INGOT.batch.perWorkshopLevel).toBeGreaterThan(0);
    expect(FORGE_INGOT.batch.max).toBeGreaterThanOrEqual(FORGE_INGOT.batch.baseSize);
    expect(FORGE_INGOT.refineSecPerIngot).toBeGreaterThan(0);
    // The per-level speed-up can never reach 100 % across the 20-level ladder.
    expect(FORGE_INGOT.refineSpeedupBpsPerLevel * (STRUCTURES.workshop.maxLevel - 1)).toBeLessThan(PHASE_E_POLICY.basisPoints);
    expect(FORGE_INGOT.refineDailyCapMultiplier).toBeGreaterThan(0);
    expect(FORGE_INGOT.holdingCapMultiplier).toBeGreaterThanOrEqual(FORGE_INGOT.refineDailyCapMultiplier);
    expect(FORGE_INGOT.rawStockTheftDivisor).toBeGreaterThan(0);
  });

  it('ships the Forge Ingot as a crafted material the system never sells', () => {
    expect(ITEMS.forge_ingot).toBe(MATERIAL_ITEMS.forge_ingot);
    expect(ITEMS.forge_ingot.kind).toBe('material');
    expect(ITEMS.forge_ingot.costKeep).toBe(0);
    expect(ITEMS.forge_ingot.acquisition).toEqual({ type: 'craft' });
    // Ordinary tradable material (owner): NOT dropOnly, no stack limit but capacity.
    expect((ITEMS.forge_ingot as { dropOnly?: boolean }).dropOnly).toBeUndefined();
    expect(ITEMS.forge_ingot.maxOwned).toBeNull();
    // The only 'craft' item today; nothing else quietly switched acquisition.
    const crafted = Object.entries(ITEMS).filter(([, spec]) => spec.acquisition.type === 'craft').map(([id]) => id);
    expect(crafted).toEqual(['forge_ingot']);
  });

  it('every Gems task is one-time and pays a positive amount; the reward-budget share is a bounded bps', () => {
    // D-152 amendment: owner-authored, once per wallet, never redoable.
    for (const [id, task] of Object.entries(GEMS_TASKS as Record<string, { gems: number; oncePerWallet: true; active: boolean; title: string }>)) {
      expect([id, task.gems > 0]).toEqual([id, true]);
      expect([id, task.oncePerWallet]).toEqual([id, true]);
      expect([id, task.title.length > 0]).toEqual([id, true]);
    }
    expect(GEMS_REWARD_BUDGET.recycledLegShareBps).toBeGreaterThan(0);
    expect(GEMS_REWARD_BUDGET.recycledLegShareBps).toBeLessThanOrEqual(PHASE_E_POLICY.basisPoints);
  });
});

describe('GEMS_TASKS (D-152 amendment; security review 2026-09-20 #2)', () => {
  it('has NO active task until claimGemsTask evaluates a server-side completion predicate', () => {
    // WHY: a claim today checks only `active`. One active row would let any
    // number of free devnet wallets drain gems_reward_budget at zero cost and
    // exit through the pre-F Gold Forge (K-152). The catalogue stays inert
    // until GemsTaskSpec carries a predicate the server checks before minting.
    for (const [id, spec] of Object.entries(GEMS_TASKS as Record<string, GemsTaskSpec>)) {
      expect([id, spec.active, spec.oncePerWallet]).toEqual([id, false, true]);
    }
  });
});

describe('Solana Island workshop policy (D-150 / K-204)', () => {
  it('keeps the locked licence count in one shared policy field', () => {
    // WHY: web and native share the policy; this source check prevents duplicate licence literals in constants.ts.
    expect(PHASE_E_POLICY.solanaIsland.workshopLicences).toBe(100);
    const source = readFileSync(new URL('./constants.ts', import.meta.url), 'utf8');
    expect(source.match(/\bworkshopLicences\s*:\s*100\b/g)).toHaveLength(1);
  });
});

describe('SKR_FAUCET (D153.263/D153.275)', () => {
  it('keeps mainnet dark and the owner grant/day values fixed', () => {
    expect(SKR_FAUCET['mainnet-beta']).toBeNull();
    expect(SKR_FAUCET.devnet.grantSkr).toBe(1_000);
    expect(SKR_FAUCET.devnet.claimsPerWalletPerDay).toBe(1);
  });
  it('refuses both recorded mainnet SKR identities and no unrelated wallet token', () => {
    const values = SKR_FAUCET.devnet.refusedMints;
    expect(values).toContain(WALLET_HUB.tokens.find((token) => token.symbol === 'SKR')!.mint);
    expect(values).toContain('SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3');
    for (const value of values) {
      let raw = 0n;
      for (const character of value) {
        const digit = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(character);
        expect(digit).toBeGreaterThanOrEqual(0); raw = raw * 58n + BigInt(digit);
      }
      const leading = value.match(/^1*/u)![0].length;
      const size = raw === 0n ? 0 : Math.ceil(raw.toString(16).length / 2);
      expect(leading + size).toBe(32);
      expect(WALLET_HUB.tokens.filter((token) => token.symbol !== 'SKR').map((token) => token.mint)).not.toContain(value);
    }
    expect(new Set(values).size).toBe(values.length);
  });
  it('bounds integer worker policy and leaves unapproved inventory ceilings unset', () => {
    const policy = SKR_FAUCET.devnet;
    for (const value of [policy.pollMs, policy.maxGrantsPerSweep, policy.maxAttempts, policy.claimRateLimitPerMin, policy.maxWalletAddedPriorityFeeLamports, policy.referenceScanPageSize, policy.referenceScanCap, policy.submitHeightMargin, policy.grantReadPageSize]) {
      expect(Number.isSafeInteger(value) && value > 0).toBe(true);
    }
    for (const value of [policy.treasuryFloorSkr, policy.dailyBudgetSkr]) {
      expect(value === null || Number.isSafeInteger(value)).toBe(true);
    }
    if (policy.treasuryFloorSkr !== null) expect(policy.treasuryFloorSkr).toBeGreaterThanOrEqual(0);
    if (policy.dailyBudgetSkr !== null) expect(policy.dailyBudgetSkr).toBeGreaterThanOrEqual(policy.grantSkr);
  });
  // Owner decision N-045 (6 Oct 2026): with either ceiling null the worker never starts (devnet-only/index.ts) and the QA
  // chain lane refuses to boot the faucet group (scripts/candidate/api.mjs), so "any player can use the SKR faucet" is
  // dark. The owner's numbers are pinned exactly: a drift would silently change how much test SKR one day can pay out.
  it('carries the owner inventory ceilings: floor 100,000 tSKR, 50,000 tSKR per UTC day, still 1,000 per grant', () => {
    const policy = SKR_FAUCET.devnet;
    expect(policy.treasuryFloorSkr).toBe(100_000);
    expect(policy.dailyBudgetSkr).toBe(50_000);
    expect(policy.grantSkr).toBe(PHASE_E_DEVNET_TEST.testSkr.faucetGrantSkr);
    for (const value of [policy.treasuryFloorSkr, policy.dailyBudgetSkr]) expect(Number.isSafeInteger(value) && value! > 0).toBe(true);
    // A day's budget is a whole number of grants, so the last grant of a day is never refused for a partial remainder.
    expect(policy.dailyBudgetSkr! % policy.grantSkr).toBe(0);
  });
});


describe('SKR reconciliation operational proposal (8938311c M1)', () => {
  it('keeps finite scan bounds, increasing backoff and a lease longer than one bounded sweep', () => {
    const p = SKR_FAUCET.devnet;
    for (const value of [p.reconcileSweepRpcBudget, p.reconcileAttemptRpcBudget, p.reconcileSweepMs,
      p.reconcileBackoffMs, p.reconcileBackoffMaxMs, p.reconcileLeaseMs, p.reconcileParkAfter])
      expect(Number.isSafeInteger(value) && value > 0).toBe(true);
    expect(p.reconcileAttemptRpcBudget).toBeLessThanOrEqual(p.reconcileSweepRpcBudget);
    expect(p.reconcileBackoffMs).toBeLessThanOrEqual(p.reconcileBackoffMaxMs);
    expect(p.reconcileLeaseMs).toBeGreaterThan(p.reconcileSweepMs);
    // This proposal never carried the activation numbers; the owner set them separately (N-045, 6 Oct 2026; was a null pin).
    expect([p.treasuryFloorSkr, p.dailyBudgetSkr]).toEqual([100_000, 50_000]);
  });
});
