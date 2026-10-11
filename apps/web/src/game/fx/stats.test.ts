import { DEFENSES, HERO_LEVELING, HERO_DEFENCE, INVENTORY, STRUCTURES, type HeroCombatLoadout } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import { battleArmyHpBps, battleHealthContext, battleUnitMaxHp, buildingMaxHp, footprintOf, troopMaxHp } from './stats';

const loadout = (hpBps: number, heroHpBps = 0): HeroCombatLoadout => ({ catalogRevision: 2, version: 1, hash: 'frozen', modifiers: {
  hero_hp_bps: heroHpBps, allied_troop_hp_bps: hpBps, hero_damage_bps: 0, ability_damage_bps: 0,
  cooldown_reduction_bps: 0, move_speed_bps: 0, incoming_damage_reduction_bps: 0,
  first_hit_reduction_bps: 0, wall_damage_bps: 0, allied_troop_damage_bps: 0,
} });

describe('battleUnitMaxHp', () => {
  it('uses the frozen hero level rather than donor-troop HP', () => {
    // WHY: Vex is deployed through the Highlander order channel, but lifesteal
    // heal events must clamp to Vex's real HP or her replay bar is wrong from
    // the first tick. Theodor has the same contract through Giant.
    expect(battleUnitMaxHp('highlander', 20, 'vex', 7))
      .toBe(HERO_LEVELING.hp.vex[6]);
    expect(battleUnitMaxHp('giant', 20, 'theodor', 9))
      .toBe(HERO_LEVELING.hp.theodor[8]);
    expect(battleUnitMaxHp('highlander', 20, 'vex', 7))
      .not.toBe(troopMaxHp('highlander', 20));
  });

  it('keeps ordinary troops on their research level and clamps old hero bundles to L1', () => {
    expect(battleUnitMaxHp('bowman', 4)).toBe(troopMaxHp('bowman', 4));
    expect(battleUnitMaxHp('highlander', 20, 'vex', 0))
      .toBe(HERO_LEVELING.hp.vex[0]);
  });

  it('uses only frozen accepted hero orders, even before their deployment, and preserves gearless archives', () => {
    const frozen = { theodor: loadout(600), vex: loadout(800) };
    const orders = { heroDeploys: [{ hero: 'theodor' as const, tMs: 80_000 }] };
    const context = battleHealthContext(orders, frozen);
    expect(context.heroLoadouts).toEqual({ theodor: frozen.theodor });
    const armyHpBps = battleArmyHpBps(context);
    expect(armyHpBps).toBe(600);
    const base = troopMaxHp('hexbarrow', 20);
    expect(battleUnitMaxHp('hexbarrow', 20, undefined, 1, { armyHpBps }))
      .toBe(Math.floor(base * 10_600 / 10_000));
    expect(battleHealthContext(undefined, frozen)).toEqual({});
    expect(battleArmyHpBps(battleHealthContext(orders))).toBe(0);
    expect(battleUnitMaxHp('hexbarrow', 20)).toBe(base);
    // Summoned brood are intentionally not passed direct army modifiers.
    expect(troopMaxHp('barrowling', 20)).toBe(battleUnitMaxHp('barrowling', 20));
  });

  it('matches individual-then-total sim caps and keeps a pinned order loadout over another roster projection', () => {
    const cap = INVENTORY.modifierCapsBps.allied_troop_hp_bps;
    expect(battleArmyHpBps({ heroLoadouts: { vex: loadout(cap * 3), theodor: loadout(-cap) } })).toBe(0);
    expect(battleArmyHpBps({ heroLoadouts: { vex: loadout(cap), theodor: loadout(cap) } })).toBe(cap);
    expect(battleArmyHpBps(battleHealthContext({ heroDeploys: [{ hero: 'vex', loadout: loadout(600) }] }, { vex: loadout(0) }))).toBe(600);
  });

  it('keeps frozen hero equipment separate from allied troop HP and scales defenders before equipment', () => {
    const gear = loadout(600, 1200);
    const heroHp = HERO_LEVELING.hp.theodor[8]!;
    expect(battleUnitMaxHp('giant', 20, 'theodor', 9, { armyHpBps: 1500, loadout: gear }))
      .toBe(Math.floor(heroHp * 11_200 / 10_000));
    expect(battleUnitMaxHp('giant', 20, 'theodor', 9, { defender: true, loadout: gear }))
      .toBe(Math.floor(Math.floor(heroHp * HERO_DEFENCE.statPct / 100) * 11_200 / 10_000));
  });
});

describe('footprintOf', () => {
  it('reads every world footprint from the same constants as the simulator', () => {
    // WHY: a hand-maintained BattleScene switch missed both M22 2×2 additions,
    // making their occupied/deploy geometry disagree with the authoritative sim.
    expect({
      keep: footprintOf('keep'),
      barracks: footprintOf('barracks'),
      mortar: footprintOf('mortar'),
      dragonnest: footprintOf('dragonnest'),
      airdefence: footprintOf('airdefence'),
      clanhall: footprintOf('clanhall'),
      mine: footprintOf('mine'),
    }).toEqual({
      keep: [2, 2],
      barracks: [2, 1],
      mortar: [2, 2],
      dragonnest: [2, 2],
      airdefence: [2, 2],
      clanhall: [2, 2],
      mine: [1, 1],
    });
  });

  it('keeps an unknown stored presentation conservatively renderable', () => {
    expect(footprintOf('future-building')).toEqual([1, 1]);
  });

  it('widens only an explicitly versioned v2 KEEP and fails closed otherwise', () => {
    expect(footprintOf('keep')).toEqual([2, 2]);
    expect(footprintOf('keep', 1)).toEqual([2, 2]);
    expect(footprintOf('keep', 2)).toEqual([4, 4]);
    // Geometry version is a snapshot contract, not a KEEP-only hint: malformed
    // persisted JSON must be refused even if the first decoded row is another type.
    expect(() => footprintOf('mine', 3)).toThrow(/unsupported building geometry version/);
  });
});

describe('buildingMaxHp', () => {
  it('keeps every new raid target destructible while traps remain untargetable', () => {
    // WHY: the old client mirror omitted these M22 types. The authoritative sim
    // damaged them, but BattleScene rendered no HP bar or destruction progress.
    expect(buildingMaxHp('airdefence', 1)).toBe(DEFENSES.airdefence.hp);
    expect(buildingMaxHp('clanhall', 1)).toBe(STRUCTURES.clanhall.hp);
    expect(buildingMaxHp('heroaltar', 1)).toBe(STRUCTURES.heroaltar.hp);
    expect(['spiketrap', 'powdermine', 'pitfall', 'airmine']
      .map((type) => buildingMaxHp(type, 20))).toEqual([0, 0, 0, 0]);
  });
});
