import { describe, expect, it } from 'vitest';
import {
  BuildingType,
  GEAR_ITEMS,
  GEAR_MODIFIER_STATS,
  HERO_LEVELING,
  INVENTORY,
  RAID_RULES,
  type HeroCombatLoadout,
  type HeroCombatModifiers,
} from '@shardkeep/shared';
import { simulateRaid } from '../src/sim';
import { b, base, deploy, orders, resetIds } from './helpers';

const zeroModifiers = (): HeroCombatModifiers => Object.fromEntries(
  GEAR_MODIFIER_STATS.map((stat) => [stat, 0]),
) as unknown as HeroCombatModifiers;

const loadout = (overrides: Partial<HeroCombatModifiers> = {}): HeroCombatLoadout => ({
  catalogRevision: INVENTORY.catalogRevision,
  version: 1,
  hash: 'test-loadout-v1',
  modifiers: { ...zeroModifiers(), ...overrides },
});

const maxWardenLoadout = (): HeroCombatLoadout => {
  const modifiers = zeroModifiers();
  let pieces = 0;
  for (const item of Object.values(GEAR_ITEMS)) {
    if (item.set === 'warden') pieces++;
    for (const modifier of item.modifiers) modifiers[modifier.stat] += modifier.value;
  }
  if (pieces >= INVENTORY.wardenSet.equippedPieces) {
    for (const modifier of INVENTORY.wardenSet.modifiers) modifiers[modifier.stat] += modifier.value;
  }
  for (const stat of GEAR_MODIFIER_STATS) {
    const cap = INVENTORY.modifierCapsBps[stat];
    modifiers[stat] = Math.max(-cap, Math.min(cap, modifiers[stat]));
  }
  return loadout(modifiers);
};

const duel = (attacker?: HeroCombatLoadout, defender?: HeroCombatLoadout) => {
  resetIds();
  return simulateRaid({
    ...base([b(BuildingType.Keep, 14, 14, 20, 'keep')], 14),
    defenderHeroes: [{ hero: 'vex', level: 1, guardTx: 4, guardTy: 14,
      ...(defender ? { loadout: defender } : {}) }],
  }, orders([], { heroDeploys: [{ hero: 'vex', level: 1, tx: 2, ty: 14, tMs: 0,
    ...(attacker ? { loadout: attacker } : {}) }] }), 42);
};

describe('SIM7 frozen hero gear', () => {
  it('keeps legacy outcomes/events byte-identical when the optional field is absent or all-zero', () => {
    expect(duel(loadout()).events).toEqual(duel().events);
    expect(duel(loadout()).buildings).toEqual(duel().buildings);
  });

  it('clamps every replay modifier bucket to the shared cap before applying it', () => {
    const capped = zeroModifiers();
    const excessive = zeroModifiers();
    for (const stat of GEAR_MODIFIER_STATS) {
      capped[stat] = INVENTORY.modifierCapsBps[stat];
      excessive[stat] = INVENTORY.modifierCapsBps[stat] * 100;
    }
    expect(duel(loadout(excessive)).events).toEqual(duel(loadout(capped)).events);
    expect(duel(loadout(excessive)).buildings).toEqual(duel(loadout(capped)).buildings);
  });

  it('applies frozen offensive and defensive buckets on both hero sides', () => {
    const caps = INVENTORY.modifierCapsBps;
    const offense = loadout({ hero_damage_bps: caps.hero_damage_bps,
      ability_damage_bps: caps.ability_damage_bps,
      cooldown_reduction_bps: caps.cooldown_reduction_bps,
      move_speed_bps: caps.move_speed_bps, wall_damage_bps: caps.wall_damage_bps });
    const defence = loadout({ hero_hp_bps: caps.hero_hp_bps,
      incoming_damage_reduction_bps: caps.incoming_damage_reduction_bps,
      first_hit_reduction_bps: caps.first_hit_reduction_bps });
    const baseline = duel();
    const attackerGeared = duel(offense);
    const defenderGeared = duel(undefined, defence);
    const defenderId = attackerGeared.events.find((event) => event.e === 'deploy'
      && event.hero === 'vex' && event.side === 'defender')!.id;
    const gearedHit = attackerGeared.events.find((event) => event.e === 'hit'
      && event.target === defenderId);
    const baselineDefenderId = baseline.events.find((event) => event.e === 'deploy'
      && event.hero === 'vex' && event.side === 'defender')!.id;
    const baseHit = baseline.events.find((event) => event.e === 'hit'
      && event.target === baselineDefenderId);
    expect(gearedHit?.e === 'hit' ? gearedHit.dmg : 0)
      .toBeGreaterThan(baseHit?.e === 'hit' ? baseHit.dmg : 0);
    const gearedDefenderId = defenderGeared.events.find((event) => event.e === 'deploy'
      && event.hero === 'vex' && event.side === 'defender')!.id;
    const reduced = defenderGeared.events.find((event) => event.e === 'hit'
      && event.target === gearedDefenderId);
    expect(reduced?.e === 'hit' ? reduced.dmg : Infinity)
      .toBeLessThan(baseHit?.e === 'hit' ? baseHit.dmg : 0);
  });

  it('banner buckets affect allied direct troops but never the equipped hero', () => {
    const banner = loadout({
      allied_troop_hp_bps: INVENTORY.modifierCapsBps.allied_troop_hp_bps,
      allied_troop_damage_bps: INVENTORY.modifierCapsBps.allied_troop_damage_bps,
    });
    expect(duel(banner).events).toEqual(duel().events);

    const run = (gear?: HeroCombatLoadout) => {
      resetIds();
      return simulateRaid(base([b(BuildingType.Keep, 14, 14, 20, 'keep')], 14), orders([
        deploy('bowman', 2, 14),
      ], { heroDeploys: [{ hero: 'vex', level: 1, tx: 2, ty: 13,
        tMs: RAID_RULES.battleDurationSec * 1_000 - 100,
        ...(gear ? { loadout: gear } : {}) }] }), 7);
    };
    expect(run(banner).buildings[0]!.hp).toBeLessThan(run().buildings[0]!.hp);
  });

  it.each([11, 42, 91])(
    'a legal L20 Gloam counter kills max-Warden defensive Theodor inside 90s (seed %s)',
    (seed) => {
      resetIds();
      const snapshot = {
        ...base([b(BuildingType.Keep, 14, 14, 20, 'keep')], 14),
        defenderHeroes: [{
          hero: 'theodor' as const, level: HERO_LEVELING.maxLevel, guardTx: 7, guardTy: 14,
          loadout: maxWardenLoadout(),
        }],
      };
      const attackers = Array.from({ length: 50 }, (_, i) =>
        deploy('gloamfang', 2, 10 + (i % 9), i * 10));
      const result = simulateRaid(snapshot, orders(attackers), seed,
        { troopLevels: { gloamfang: HERO_LEVELING.maxLevel } });
      const defender = result.events.find((event) => event.e === 'deploy'
        && event.hero === 'theodor' && event.side === 'defender')!;
      const death = result.events.find((event) => event.e === 'troopDeath' && event.id === defender.id);
      expect(death?.t).toBeLessThan(RAID_RULES.battleDurationSec * 10);
    },
  );
});
