/** SIM6 dark-roster mechanics. These tests pin the authored WHY: summons are
 * never direct army units, Direwyvern damage lives in persistent zones,
 * Hexbarrow's threat is ten short-lived actors, and target preferences may not
 * strand a troop behind masonry while a valid fallback is exposed. */
import {
  BUILD_COUNT_CAP_BY_KEEP, BuildingType, GRID, LEVEL_STEP_TROOP, RAID_RULES,
  RAID_REPLAY_LIMITS, STRUCTURES, TROOPS, TROOP_ABILITIES,
} from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import { UNITS_PER_TILE } from '../src/fixed';
import { simulateRaid } from '../src/sim';
import { footprintOf, troopCombat } from '../src/stats';
import { SimInputError, SimRepresentationLimitError, type SimEvent } from '../src/types';
import { b, base, deploy, orders, resetIds, wallRing } from './helpers';

describe('SIM6 dark attacker family', () => {
  it('uses the existing L1-20 troop scale, with Direwyvern remaining much stronger than Dragon at every level', () => {
    for (let level = 1; level <= LEVEL_STEP_TROOP.length; level++) {
      let hp = TROOPS.direwyvern.hp;
      let dps = TROOPS.direwyvern.dps;
      for (let i = 1; i < level; i++) {
        hp *= LEVEL_STEP_TROOP[i] ?? 1;
        dps *= LEVEL_STEP_TROOP[i] ?? 1;
      }
      const dire = troopCombat('direwyvern', level);
      const dragon = troopCombat('dragon', level);
      expect(dire.hp).toBe(Math.round(hp));
      expect(dire.dpsDeci).toBe(Math.round(dps));
      expect(dire.hp * 100).toBeGreaterThanOrEqual(dragon.hp * 399); // rounding-safe ~4x
      expect(dire.dpsDeci).toBeGreaterThan(dragon.dpsDeci * 3);
    }
  });

  it('rejects both attacker-side and defender-side spawn products as direct deploys', () => {
    const target = base([b(BuildingType.Keep, 8, 8, 20, 'keep')], 14);
    for (const troop of ['barrowling', 'wyrmling'] as const) {
      expect(() => simulateRaid(target, orders([deploy(troop, 0, 8)]), 1))
        .toThrowError(new SimInputError(`troop cannot be deployed directly: ${troop}`));
    }
  });

  it('Direwyvern firestorm has no impact hit, then creates exactly three five-second damage fields', () => {
    const r = simulateRaid(
      base([b(BuildingType.Keep, 8, 8, 20, 'keep')], 14),
      orders([deploy('direwyvern', 0, 8)]),
      11,
    );
    const cast = r.events.find((e) => e.e === 'troopAbility' && e.ability === 'firestorm') as
      Extract<SimEvent, { e: 'troopAbility' }>;
    expect(cast).toBeDefined();
    expect(cast.targetBuildingId).toBe('keep');
    const fields = r.events.filter((e) => e.e === 'burnfield' && e.id === cast.id) as
      Array<Extract<SimEvent, { e: 'burnfield' }>>;
    expect(fields.slice(0, 3)).toHaveLength(3);
    expect(fields[0]!.t).toBe(cast.t + TROOP_ABILITIES.direwyvern.firestorm.effectDelayDeciSec);
    expect(fields[0]!.until - fields[0]!.t)
      .toBe(TROOP_ABILITIES.direwyvern.firestorm.fieldLifetimeSec * 10);
    expect(r.events.some((e) => e.e === 'hit' && e.target === 'keep' && e.t < fields[0]!.t)).toBe(false);
    expect(r.events.some((e) => e.e === 'troopFire' && e.id === cast.id)).toBe(false);
    // Three overlapping patches from ONE caster are a union, not triple damage.
    expect(r.events.filter((e) => e.e === 'hit' && e.target === 'keep' && e.t === fields[0]!.t))
      .toHaveLength(1);
  });

  it('different Direwyvern casters stack exact damage in one bounded hit event', () => {
    const r = simulateRaid(
      base([b(BuildingType.Keep, 8, 8, 20, 'keep')], 14),
      orders([deploy('direwyvern', 0, 8), deploy('direwyvern', 0, 9)]),
      111,
    );
    const firstFields = r.events.filter((e) => e.e === 'burnfield').slice(0, 6) as
      Array<Extract<SimEvent, { e: 'burnfield' }>>;
    expect(new Set(firstFields.map((e) => e.id)).size).toBe(2);
    const effectTick = firstFields[0]!.t;
    expect(firstFields.every((e) => e.t === effectTick)).toBe(true);
    expect(r.events.filter((e) => e.e === 'hit' && e.target === 'keep' && e.t === effectTick))
      .toEqual([{
        t: effectTick,
        e: 'hit',
        target: 'keep',
        dmg: TROOPS.direwyvern.dps
          * TROOP_ABILITIES.direwyvern.firestorm.fieldDpsPct / 100 * 2 / 10,
      }]);
  });

  it('Gloamfang howls after two seconds, then lunges a distant defender for 150% of one-second DPS', () => {
    const r = simulateRaid(
      base([
        b(BuildingType.Keep, 8, 8, 20, 'keep'),
        b(BuildingType.DragonNest, 15, 15, 20, 'nest'),
      ], 14),
      orders([deploy('gloamfang', 0, 8)]),
      112,
    );
    const howl = r.events.find((e) => e.e === 'troopAbility' && e.ability === 'howl') as
      Extract<SimEvent, { e: 'troopAbility' }>;
    expect(howl.t).toBe(TROOP_ABILITIES.gloamfang.howl.firstDelaySec * 10);
    const lunge = r.events.find((e) => e.e === 'troopAbility' && e.ability === 'lunge') as
      Extract<SimEvent, { e: 'troopAbility' }>;
    expect(lunge).toBeDefined();
    const victim = r.events.find((e) => e.e === 'spawn' && e.troop === 'wyrmling') as
      Extract<SimEvent, { e: 'spawn' }>;
    expect(r.events).toContainEqual({
      t: lunge.t + TROOP_ABILITIES.gloamfang.lunge.travelDeciSec,
      e: 'hit', target: victim.id,
      dmg: Math.floor(TROOPS.gloamfang.dps * TROOP_ABILITIES.gloamfang.lunge.damagePctDps / 100),
    });
    expect(r.events.filter((e) => e.e === 'hit' && e.target === victim.id
      && e.t === lunge.t + TROOP_ABILITIES.gloamfang.lunge.travelDeciSec))
      .toHaveLength(1);
  });

  it('Gloamfang emits self-describing rend contacts on its real ten-tick damage cadence', () => {
    const r = simulateRaid(
      base([b(BuildingType.Keep, 8, 8, 20, 'keep')], 14),
      orders([deploy('gloamfang', 0, 8)]),
      1121,
    );
    const rends = r.events.filter((e): e is Extract<SimEvent, { e: 'attackRun' }> =>
      e.e === 'attackRun' && e.technique === 'rend');
    expect(rends.length).toBeGreaterThan(0);
    expect(rends.every((e) => e.troop === 'gloamfang' && e.side === 'attacker'
      && e.targetKind === 'building' && e.target === 'keep'
      && e.cadenceTicks === TROOP_ABILITIES.gloamfang.attackIntervalDeciSec)).toBe(true);
    for (let i = 1; i < rends.length; i++) {
      // Howl/leap may occupy an otherwise-ready tick, but a rend can never run
      // faster than the authored damage interval.
      expect(rends[i]!.t - rends[i - 1]!.t)
        .toBeGreaterThanOrEqual(TROOP_ABILITIES.gloamfang.attackIntervalDeciSec);
    }
    expect(r.buildings.find((building) => building.id === 'keep')!.hp).toBeLessThan(
      r.buildings.find((building) => building.id === 'keep')!.maxHp,
    );
  });

  it('spawned Barrowlings publish strike contacts when a sealed wall takes their DPS', () => {
    // Spawn-only actors cannot be placed in orders, so the real Hexbarrow brood
    // path is the only truthful way to cover their wall-contact protocol.
    const wallSnapshot = {
      ...base([
        b(BuildingType.Keep, 11, 11, 20, 'keep'),
        ...wallRing(4, 20, 20, 'sealed'),
      ], 14),
      claimMin: 4, claimMax: 21,
    };
    const r = simulateRaid(wallSnapshot, orders([deploy('hexbarrow', 0, 11)]), 1122);
    const spawned = new Set(r.events.filter((e) => e.e === 'troopSpawn'
      && e.troop === 'barrowling').map((e) => e.id));
    const cue = r.events.find((e) => e.e === 'attackRun' && spawned.has(e.id)
      && e.technique === 'claw' && e.targetKind === 'building'
      && String(e.target).startsWith('sealed_'));
    expect(spawned.size).toBeGreaterThan(0);
    expect(cue).toBeDefined();
    expect(cue!.troop).toBe('barrowling');
    expect(cue!.cadenceTicks).toBe(TROOP_ABILITIES.barrowling.attackIntervalDeciSec);
    const wall = wallSnapshot.buildings.find((building) => building.id === cue!.target)!;
    const { fw, fh } = footprintOf(wall.type);
    expect(cue!.ix).toBeGreaterThanOrEqual(wall.tx * UNITS_PER_TILE);
    expect(cue!.ix).toBeLessThanOrEqual((wall.tx + fw) * UNITS_PER_TILE);
    expect(cue!.iy).toBeGreaterThanOrEqual(wall.ty * UNITS_PER_TILE);
    expect(cue!.iy).toBeLessThanOrEqual((wall.ty + fh) * UNITS_PER_TILE);
  });

  it('Direwyvern maul is a delayed close anti-defender strike, not a hidden basic bite', () => {
    const r = simulateRaid(
      base([
        b(BuildingType.Keep, 8, 8, 20, 'keep'),
        b(BuildingType.DragonNest, 15, 15, 20, 'nest'),
      ], 14),
      orders([deploy('direwyvern', 0, 8)]),
      113,
    );
    const maul = r.events.find((e) => e.e === 'troopAbility' && e.ability === 'maul') as
      Extract<SimEvent, { e: 'troopAbility' }>;
    expect(maul).toBeDefined();
    const firstSpawn = r.events.find((e) => e.e === 'spawn') as Extract<SimEvent, { e: 'spawn' }>;
    expect(r.events).toContainEqual({
      t: maul.t + TROOP_ABILITIES.direwyvern.maul.impactDelayDeciSec,
      e: 'hit', target: firstSpawn.id,
      dmg: Math.floor(TROOPS.direwyvern.dps * TROOP_ABILITIES.direwyvern.maul.damagePctDps / 100),
    });
    const impactTick = maul.t + TROOP_ABILITIES.direwyvern.maul.impactDelayDeciSec;
    expect(r.events.some((e) => e.e === 'troopAbility' && e.id === maul.id
      && e.ability === 'firestorm' && e.t === impactTick)).toBe(false);
  });

  it('Direwyvern firestorm occupies its impact tick before a nearby maul', () => {
    const r = simulateRaid(
      base([
        b(BuildingType.Keep, 16, 16, 20, 'keep'),
        b(BuildingType.DragonNest, 4, 4, 20, 'nest'),
      ], 14),
      orders([deploy('direwyvern', 0, 14)]),
      114,
    );
    const firestorm = r.events.find((e) => e.e === 'troopAbility' && e.ability === 'firestorm') as
      Extract<SimEvent, { e: 'troopAbility' }>;
    const impactTick = firestorm.t + TROOP_ABILITIES.direwyvern.firestorm.effectDelayDeciSec;
    expect(r.events.some((e) => e.e === 'troopAbility' && e.id === firestorm.id
      && e.ability === 'maul' && e.t === impactTick)).toBe(false);
    expect(r.events.some((e) => e.e === 'troopAbility' && e.id === firestorm.id
      && e.ability === 'maul' && e.t > impactTick)).toBe(true);
  });

  it('Hexbarrow disgorges 3/3/2/2 Barrowlings with inherited level, fixed variants and exact lifetimes', () => {
    const level = 4;
    const r = simulateRaid(
      base([b(BuildingType.Keep, 8, 8, 20, 'keep')], 14),
      orders([deploy('hexbarrow', 0, 8)]),
      12,
      { troopLevels: { hexbarrow: level } },
    );
    const cast = r.events.find((e) => e.e === 'troopAbility' && e.ability === 'disgorge') as
      Extract<SimEvent, { e: 'troopAbility' }>;
    expect(cast.t).toBeGreaterThanOrEqual(TROOP_ABILITIES.hexbarrow.brood.firstDelaySec * 10);
    expect(cast.t).toBeLessThan(TROOP_ABILITIES.hexbarrow.brood.firstDelaySec * 10 + 8);
    const firstBatch = r.events.filter((e) => e.e === 'troopSpawn'
      && e.from === cast.id && e.t <= cast.t + TROOP_ABILITIES.hexbarrow.brood.spawnOffsetsDeciSec.at(-1)!) as
      Array<Extract<SimEvent, { e: 'troopSpawn' }>>;
    expect(firstBatch.map((e) => e.t - cast.t)).toEqual([2, 2, 2, 3, 3, 3, 4, 4, 5, 5]);
    expect(firstBatch.map((e) => e.variant)).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0, 1]);
    expect(firstBatch.every((e) => e.level === level && e.troop === 'barrowling')).toBe(true);
    for (const spawn of firstBatch) {
      expect(r.events).toContainEqual({
        t: spawn.t + TROOP_ABILITIES.hexbarrow.brood.lifespanSec * 10,
        e: 'troopDeath', id: spawn.id,
      });
    }
  });

  it('keeps edge-hatched brood inside the expanded battlefield', () => {
    resetIds();
    const r = simulateRaid(
      { ...base([b(BuildingType.Keep, 27, 16, 20, 'keep')], 14),
        claimMin: 2, claimMax: 30 },
      orders([deploy('hexbarrow', 33, 16)]),
      121,
    );
    const cast = r.events.find((e) => e.e === 'troopAbility' && e.ability === 'disgorge') as
      Extract<SimEvent, { e: 'troopAbility' }>;
    const brood = r.events.filter((e) => e.e === 'troopSpawn'
      && e.t <= cast.t + TROOP_ABILITIES.hexbarrow.brood.spawnOffsetsDeciSec.at(-1)!) as
      Array<Extract<SimEvent, { e: 'troopSpawn' }>>;
    expect(brood).toHaveLength(10);
    const min = -RAID_RULES.deployMarginTiles * UNITS_PER_TILE;
    const maxExclusive = (GRID.plotTiles + RAID_RULES.deployMarginTiles) * UNITS_PER_TILE;
    expect(brood.every((e) => e.x >= min && e.x < maxExclusive
      && e.y >= min && e.y < maxExclusive)).toBe(true);
    expect(Math.max(...brood.map((e) => e.x))).toBe(maxExclusive - 1);
  });

  it('keeps a maximum legal four-camp Hexbarrow assault deterministic and bounded', () => {
    const maxCampCount = BUILD_COUNT_CAP_BY_KEEP.camp.at(-1)!;
    const maxCampCapacity = STRUCTURES.camp.capacityPts.at(-1)! * maxCampCount;
    const count = Math.floor(maxCampCapacity / TROOPS.hexbarrow.pts);
    expect(count).toBe(40); // 4 × 180 capacity / 18 points
    const deploys = Array.from({ length: count }, () => deploy('hexbarrow', -4, -4));
    // Three legal L20 structures around the claim's far corners force the slow
    // 0.55-tile/s shell army to traverse the expanded claim twice. There is no unreachable
    // geometry and no hostile defense to kill a parent early, so all forty
    // Hexbarrows author all five cohorts across the full 90-second envelope.
    const target = {
      ...base([
        b(BuildingType.Vault, 2, 27, 20, 'vault'),
        b(BuildingType.Forge, 27, 27, 20, 'forge'),
        b(BuildingType.Keep, 26, 2, 20, 'keep'),
      ], 14),
      claimMin: 2,
      claimMax: 28,
    };

    resetIds();
    const first = simulateRaid(target, orders(deploys), 122);
    resetIds();
    const replay = simulateRaid(target, orders(deploys), 122);

    expect(replay).toEqual(first);
    expect(first.ticks).toBe(RAID_RULES.battleDurationSec * 10);
    const brood = TROOP_ABILITIES.hexbarrow.brood;
    const lastTick = RAID_RULES.battleDurationSec * 10 - 1;
    const cohorts = 1 + Math.floor(
      (lastTick - brood.firstDelaySec * 10) / (brood.intervalSec * 10),
    );
    expect(cohorts).toBe(5);
    expect(first.events.filter((e) => e.e === 'troopSpawn'))
      .toHaveLength(count * cohorts * brood.spawnCounts.reduce((sum, n) => sum + n, 0));
    // A visual cadence mistake must not turn the worst legal authored summon
    // envelope into an unbounded replay payload.
    expect(first.events.length).toBeLessThanOrEqual(RAID_REPLAY_LIMITS.maxEvents);
  }, 15_000);

  it('accepts the legal 720-Bowman ceiling deterministically across both replay envelopes', () => {
    // WHY: the representation boundary protects JSONB/replay responses; it may
    // not become a second, hidden army-cap rule. Four L20 camps legally hold 720
    // one-point Bowmen. The immediate drop is the maximum concurrent direct
    // actor/event burst; the delayed drop forces the complete 900-tick envelope.
    expect(RAID_REPLAY_LIMITS.maxDirectDeploys).toBe(720);
    const target = base([b(BuildingType.Keep, 15, 15, 20, 'keep')], 14);
    const immediate = Array.from({ length: RAID_REPLAY_LIMITS.maxDirectDeploys }, (_, i) =>
      deploy('bowman', -4, -4 + (i % 38), 0));

    resetIds();
    const first = simulateRaid(target, orders(immediate), 123);
    resetIds();
    const replay = simulateRaid(target, orders(immediate), 123);
    expect(replay).toEqual(first);
    expect(first.events.length).toBeLessThanOrEqual(RAID_REPLAY_LIMITS.maxEvents);

    const atFinalTick = immediate.map((d) => ({ ...d, tMs: 89_900 }));
    resetIds();
    const fullDuration = simulateRaid(target, orders(atFinalTick), 123);
    expect(fullDuration.ticks).toBe(RAID_RULES.battleDurationSec * 10);
    expect(fullDuration.events.length).toBeLessThanOrEqual(RAID_REPLAY_LIMITS.maxEvents);
  // This deliberately runs three maximum-size deterministic simulations. Slow
  // shared CI runners can exceed Vitest's generic 5 s limit without any failed
  // assertion, so the stress case owns the same explicit budget as its peers.
  }, 15_000);

  it('keeps a maximum legal Direwyvern firestorm replay deterministic and coalesced', () => {
    const capacity = BUILD_COUNT_CAP_BY_KEEP.camp.at(-1)!
      * STRUCTURES.camp.capacityPts.at(-1)!;
    const count = Math.floor(capacity / TROOPS.direwyvern.pts);
    expect(count).toBe(28);
    const deploys = Array.from({ length: count }, () => deploy('direwyvern', -4, -4));
    // Three compact, legal L20 clusters make overlapping fields touch several
    // targets, while their corner-to-corner route keeps the battle alive for
    // the complete envelope. This is the event-amplifying case coalescing is for.
    const target = {
      ...base([
        b(BuildingType.Vault, 2, 27, 20, 'vault'),
        b(BuildingType.Barracks, 3, 27, 20, 'barracks_a'),
        b(BuildingType.Forge, 27, 27, 20, 'forge'),
        b(BuildingType.Camp, 24, 26, 20, 'camp_a'),
        b(BuildingType.Keep, 26, 2, 20, 'keep'),
        b(BuildingType.GoldForge, 23, 2, 20, 'goldforge'),
      ], 14),
      claimMin: 2,
      claimMax: 28,
    };
    resetIds();
    const first = simulateRaid(target, orders(deploys), 125);
    resetIds();
    const replay = simulateRaid(target, orders(deploys), 125);
    expect(replay).toEqual(first);
    expect(first.ticks).toBeGreaterThan(RAID_RULES.battleDurationSec * 10);
    expect(first.ticks).toBeLessThanOrEqual(
      RAID_RULES.battleDurationSec * 10 + RAID_REPLAY_LIMITS.postBattleDrainTicks,
    );
    expect(first.events.length).toBeLessThanOrEqual(RAID_REPLAY_LIMITS.maxEvents);
    const hits = first.events.filter((e) => e.e === 'hit');
    expect(new Set(hits.map((e) => `${e.t}:${e.target}`)).size).toBe(hits.length);
  }, 15_000);

  it('rejects only direct deployments beyond the existing legal four-camp ceiling', () => {
    const target = base([b(BuildingType.Keep, 15, 15, 20, 'keep')], 14);
    const tooMany = Array.from({ length: RAID_REPLAY_LIMITS.maxDirectDeploys + 1 }, () =>
      deploy('bowman', -4, 0));
    expect(() => simulateRaid(target, orders(tooMany), 124))
      .toThrowError(new SimRepresentationLimitError(
        `replay direct-actor limit exceeded: ${tooMany.length}/${RAID_REPLAY_LIMITS.maxDirectDeploys}`,
      ));
  });

  it('Gloamfang leaps a sealed wall without damaging it and emits the exact landing point', () => {
    resetIds();
    const r = simulateRaid(
      { ...base([b(BuildingType.Keep, 9, 9, 20, 'keep'), ...wallRing(6, 14, 20, 'wall')], 14),
        claimMin: 2, claimMax: 16 },
      orders([deploy('gloamfang', 0, 9)]),
      13,
    );
    const leap = r.events.find((e) => e.e === 'troopAbility' && e.ability === 'leap') as
      Extract<SimEvent, { e: 'troopAbility' }>;
    expect(leap).toBeDefined();
    expect(leap.ix).toBeDefined();
    expect(leap.iy).toBeDefined();
    expect(r.events).toContainEqual({ t: leap.t, e: 'pos', id: leap.id, x: leap.ix, y: leap.iy });
    expect(r.buildings.filter((x) => x.id.startsWith('wall_')).every((w) => !w.destroyed)).toBe(true);
  });

  it('preferred-target troops attack an exposed fallback before a sealed favorite instead of stalling', () => {
    // D-099 (owner 2026-09-02) carves the DEFENCE-seeker out of this rule: a
    // tank whose only defence is sealed breaches toward it — the Keep and the
    // rest are his fallback only once no defence stands — so the Giant now
    // goes for the sealed Cannon first (here with boulders over the ring, never
    // touching a T20 segment). Resource/nearest seekers keep the exposed
    // fallback: a Plunderer with an open structure beside a sealed Mine loots.
    // The Cannon is L1 (was L20): an L20 gun killed the L1 Giant on his way
    // into throw range, leaving nothing to observe; the other two troops never
    // enter its reach, so their assertions do not depend on its level.
    const scenario = (troop: 'giant' | 'plunderer' | 'mage') => {
      resetIds();
      const ring = wallRing(8, 14, 20, 'wall');
      return simulateRaid(
        { ...base([
          b(BuildingType.Cannon, 10, 10, 1, 'sealed_cannon'),
          // Plunderer's favorite is the sealed Mine; Giant's is the sealed
          // Cannon. Mage has no favorite class and proves nearest-target
          // fallback stays intact.
          b(BuildingType.Mine, 10, 11, 20, 'sealed_mine'),
          b(BuildingType.Barracks, 3, 8, 1, 'exposed_barracks'),
          ...ring,
        ], 14), claimMin: 2, claimMax: 16 },
        orders([deploy(troop, 0, 8)]),
        14,
      );
    };
    for (const troop of ['plunderer', 'mage'] as const) {
      const r = scenario(troop);
      const firstDestroyed = r.events.find((e) => e.e === 'destroyed');
      expect(firstDestroyed, troop).toMatchObject({ e: 'destroyed', id: 'exposed_barracks' });
      expect(r.events.some((e) => e.e === 'destroyed' && e.id.startsWith('wall_')
        && e.t < firstDestroyed!.t), troop).toBe(false);
    }
    // The L20 gun outlives an L1 Giant, so the observable is his CHOICE: the
    // first thing he attacks is the sealed Cannon (a boulder over the ring),
    // not the open Barracks behind him, and no wall is touched on the way.
    const giant = scenario('giant');
    const firstRun = giant.events.find((e) => e.e === 'attackRun' && e.id === 0)!;
    expect(firstRun, 'giant').toMatchObject({ target: 'sealed_cannon', technique: 'boulder' });
    expect(giant.events.some((e) => e.e === 'hit' && e.target === 'exposed_barracks'
      && e.t < firstRun.t), 'giant').toBe(false);
    // Not a scratch on the ring until the gun is down. (Afterwards, with no
    // defence left, he falls back to the sealed Mine and chews — that is the
    // fallback working as specified, not a wall preference.)
    const cannonDown = giant.events.find((e) => e.e === 'destroyed' && e.id === 'sealed_cannon')!;
    expect(cannonDown, 'giant').toBeDefined();
    expect(giant.events.some((e) => e.e === 'hit' && String(e.target).startsWith('wall_')
      && e.t <= cannonDown.t), 'giant').toBe(false);
  });

  it('ranged troops publish their real attack cue when a wall is the only path forward', () => {
    for (const troop of ['bowman', 'mage', 'hexbarrow'] as const) {
      resetIds();
      const r = simulateRaid(
        { ...base([
          // Far inside the enclosure: no ranged unit can simply fire over the
          // west wall from its outside contact point.
          b(BuildingType.Keep, 11, 11, 20, 'keep'),
          ...wallRing(4, 18, 20, 'wall'),
        ], 14), claimMin: 2, claimMax: 18 },
        orders([deploy(troop, 0, 11)]),
        141,
      );
      const shot = r.events.find((e) => e.e === 'attackRun' && e.mode === 'projectile') as
        Extract<SimEvent, { e: 'attackRun' }> | undefined;
      expect(shot, `${troop} wall fire cue`).toBeDefined();
      expect(String(shot!.target), `${troop} targets the blocker`).toMatch(/^wall_/);
      const blocker = r.buildings.find((b) => b.id === shot!.target)!;
      expect(blocker.hp, `${troop} damages the wall rather than stalling`)
        .toBeLessThan(blocker.maxHp);
      expect(r.events.some((e) => e.e === 'hit'
        && e.t === shot!.t + shot!.impactOffsetsTicks[0]!
        && String(e.target).startsWith('wall_'))).toBe(true);
    }
  });
});
