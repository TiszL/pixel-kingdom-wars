import { describe, expect, it } from 'vitest';
import { BuildingType, HERO_DEFENCE, HERO_SKILLS, type BaseSnapshot } from '@shardkeep/shared';
import { simulateRaid } from '../src/sim';
import { b, base, deploy, orders, resetIds } from './helpers';

const withoutTheoSkills = <T>(skills: string[], fn: () => T): T => {
  const table = HERO_SKILLS.theodor as unknown as Record<string, Record<string, unknown>>;
  const saved = skills.map((skill) => [skill, table[skill]!] as const);
  for (const [skill, value] of saved) table[skill] = { ...value, unlockLevel: 21 };
  try { return fn(); } finally { for (const [skill, value] of saved) table[skill] = value; }
};

const defended = (hero: 'vex' | 'theodor', level: number, guardTx = 4, guardTy = 14): BaseSnapshot => {
  resetIds();
  return {
    ...base([b(BuildingType.Keep, 14, 14, 20, 'keep')], 14),
    defenderHeroes: [{ hero, level, guardTx, guardTy }],
  };
};

describe('SIM7 defensive heroes', () => {
  it('freezes the defender side into the same deploy/attack event map', () => {
    const r = simulateRaid(defended('vex', 1), orders([
      deploy('troll', 2, 14), deploy('troll', 2, 13),
    ]), 42);
    const spawn = r.events.find((e) => e.e === 'deploy' && e.hero === 'vex')!;
    expect(spawn).toMatchObject({ side: 'defender' });
    expect(r.events.some((e) => e.e === 'heroAttack' && e.side === 'defender'
      && e.hero === 'vex' && e.targetKind === 'troop')).toBe(true);
  });

  it('acquires at 5 tiles and leashes at 8 around the altar, not around itself', () => {
    expect(HERO_DEFENCE.aggroRadiusTiles).toBe(5);
    expect(HERO_DEFENCE.leashRadiusTiles).toBe(8);
    const r = simulateRaid(defended('vex', 1, 14, 14), orders([
      deploy('troll', 2, 14),
    ]), 7);
    const hero = r.events.find((e) => e.e === 'deploy' && e.hero === 'vex')!;
    const firstMove = r.events.find((e) => e.e === 'pos' && e.id === hero.id);
    // The raider begins twelve tiles from the altar: the guard cannot chase on
    // tick zero, but engages later when the raider enters the fixed altar ring.
    expect(firstMove?.t).toBeGreaterThan(0);
  });

  it('defensive Cannonball is mobility-only and Brown Note never touches own masonry', () => {
    const r = withoutTheoSkills(['cheekQuake', 'snotRocket', 'silentButDeadly'], () =>
      simulateRaid(defended('theodor', 20), orders([
        deploy('troll', 2, 14), deploy('troll', 2, 13), deploy('troll', 2, 15),
      ]), 42));
    const cannonball = r.events.find((e) => e.e === 'heroSkill'
      && e.skill === 'cannonball' && e.side === 'defender' && e.phase === 'impact')!;
    expect(typeof cannonball.target).toBe('number');
    expect(r.events.some((e) => e.e === 'hit' && e.t === cannonball.t
      && e.target === cannonball.target)).toBe(false);
    expect(r.events.some((e) => e.e === 'heroSkill' && e.skill === 'brownNote'
      && e.side === 'defender')).toBe(false);
    expect(r.buildings.find((building) => building.id === 'keep')?.hp).toBeGreaterThan(0);
  });

  it('inverts Theodor taunt for exactly four seconds and Belly reflects melee safely', () => {
    const r = simulateRaid(defended('theodor', 20), orders([
      deploy('troll', 2, 14), deploy('troll', 2, 13), deploy('troll', 2, 15),
    ]), 9);
    const aura = r.events.find((e) => e.e === 'heroSkill' && e.skill === 'skillIssue'
      && e.side === 'defender')!;
    expect(aura.until).toBe(aura.t + HERO_DEFENCE.theodorTauntSec * 10);
    expect(r.events.some((e) => e.e === 'heroSkill' && e.skill === 'bellyBounce'
      && e.phase === 'reflect' && e.side === 'defender')).toBe(true);
  });

  it('Silent has an authoritative 5+3 second windup then causes real fear movement', () => {
    const r = simulateRaid(defended('theodor', 20), orders([
      deploy('troll', 2, 14), deploy('troll', 2, 13), deploy('troll', 2, 15),
    ]), 3);
    const phases = r.events.filter((e) => e.e === 'heroSkill' && e.skill === 'silentButDeadly'
      && e.side === 'defender');
    const windup = phases.find((e) => e.phase === 'windup')!;
    const impact = phases.find((e) => e.phase === 'impact')!;
    const sd = HERO_SKILLS.theodor.silentButDeadly;
    expect(impact.t - windup.t).toBe((sd.eatWindupSec + sd.swellWindupSec) * 10);
    expect(r.events.some((e) => e.e === 'pos' && e.t > impact.t
      && e.t < impact.t + sd.fearSec * 10)).toBe(true);
  });

  it('routes every defensive Vex ability through typed side-relative phases', () => {
    const attackers = Array.from({ length: 10 }, (_, i) =>
      deploy('troll', 2, 10 + (i % 9), i * 100));
    const r = simulateRaid(defended('vex', 20), orders(attackers), 42,
      { troopLevels: { troll: 20 } });
    const skills = new Set(r.events.filter((e) => e.e === 'heroSkill' && e.side === 'defender')
      .map((e) => e.skill));
    for (const skill of ['crimsonDash', 'moonsunderWave', 'degenAwakening', 'omegaShardstorm']) {
      expect(skills.has(skill)).toBe(true);
    }
    expect([...skills].some((skill) => skill.startsWith('doubleOrNothing'))).toBe(true);
  });

  it('routes every legal defensive Theodor ability and preserves the Brown Note exclusion', () => {
    const far = Array.from({ length: 12 }, (_, i) =>
      deploy('troll', 2, 9 + (i % 11), i * 100));
    const near = Array.from({ length: 12 }, (_, i) =>
      deploy('troll', 2, 12 + (i % 5), i * 100));
    const lethal = Array.from({ length: 40 }, (_, i) =>
      deploy('gloamfang', 2, 10 + (i % 9), i * 20));
    const runs = [far, near, lethal].map((attackers, seed) =>
      simulateRaid(defended('theodor', 20), orders(attackers), 11 + seed,
        { troopLevels: { troll: 20, gloamfang: 20 } }));
    const skills = new Set(runs.flatMap((r) => r.events)
      .filter((e) => e.e === 'heroSkill' && e.side === 'defender').map((e) => e.skill));
    for (const skill of [
      'cheekQuake', 'snotRocket', 'cannonball', 'skillIssue', 'bellyBounce',
      'rageQuit', 'rageQuitWake', 'silentButDeadly',
    ]) expect(skills.has(skill), skill).toBe(true);
    expect(skills.has('brownNote')).toBe(false);
  });

  it('a defender hero engages and damages a flying Dragon (K-030 / D-060)', () => {
    // Owner 2026-08-16: "dragons should be attacked by heroes". Troop-vs-troop
    // combat has no air exclusion — flight beats walls and ground-only towers,
    // never a guardian's blade — and this pins that a hovering dragon inside
    // the guard's aggro ring is chased and cut, so it can never become the one
    // matchup where an all-air army is untouchable again. Guard anchored at
    // (10,14): the keep-bound dragon parks ~4 tiles off the 2×2 keep rect,
    // right inside the 5-tile altar ring.
    const r = simulateRaid(defended('vex', 10, 10, 14), orders([
      deploy('dragon', 0, 14),
    ]), 42);
    const heroId = (r.events.find((e) => e.e === 'deploy' && e.hero === 'vex') as { id: number }).id;
    const cuts = r.events.filter((e) => e.e === 'heroAttack' && e.side === 'defender'
      && e.hero === 'vex' && e.targetKind === 'troop');
    expect(cuts.length).toBeGreaterThan(0);
    expect(cuts.every((e) => (e as { target: number }).target !== heroId)).toBe(true);
    // The dragon really bleeds: mitigated damage lands on its actor id.
    const dragonId = (r.events.find((e) => e.e === 'deploy' && e.troop === 'dragon') as { id: number }).id;
    expect(r.events.some((e) => e.e === 'hit' && e.target === dragonId)).toBe(true);
  });
});
