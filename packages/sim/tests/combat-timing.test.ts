import { describe, expect, it } from 'vitest';
import { authoredAttackTiming, BuildingType } from '@shardkeep/shared';
import { simulateRaid } from '../src/sim';
import { b, base, deploy, orders, resetIds } from './helpers';

describe('SIM9 synchronized authored attacks', () => {
  for (const troop of [
    'highlander', 'bowman', 'tunneler', 'turrider', 'plunderer', 'giant',
    'troll', 'dragon', 'mage', 'bilgewraith', 'gloamfang', 'hexbarrow', 'barrowling',
  ] as const) {
    if (troop === 'barrowling') continue; // spawn-only path is pinned in dark-troops.test
    it(`${troop} damages only on its published contact clock`, () => {
      resetIds();
      const out = simulateRaid(base([b(BuildingType.Keep, 8, 8, 20, 'keep')], 14),
        orders([deploy(troop, 1, 8)]), 90 + troop.length);
      const run = out.events.find((e) => e.e === 'attackRun' && e.troop === troop
        && e.target === 'keep');
      expect(run, troop).toBeDefined();
      const timing = authoredAttackTiming(troop, 'building');
      expect(run!.cycleTicks).toBe(timing.cycleTicks);
      expect(run!.impactOffsetsTicks).toEqual(timing.impactOffsetsTicks);
      for (const offset of run!.impactOffsetsTicks) {
        expect(out.events.some((e) => e.e === 'hit' && e.target === 'keep'
          && e.t === run!.t + offset)).toBe(true);
      }
      expect(out.events.some((e) => e.e === 'hit' && e.target === 'keep'
        && e.t < run!.t + run!.impactOffsetsTicks[0]!)).toBe(false);
    });
  }

  it('Keg damage waits for its authored blast contact', () => {
    resetIds();
    const out = simulateRaid(base([b(BuildingType.Keep, 8, 8, 1, 'keep')]),
      orders([deploy('kegrunner', 1, 8)]), 7);
    const run = out.events.find((e) => e.e === 'attackRun' && e.technique === 'detonate')!;
    expect(out.events.some((e) => e.e === 'hit'
      && e.t === run.t + run.impactOffsetsTicks[0]!)).toBe(true);
  });

  it('defense hit ticks equal each published release plus flight ceiling', () => {
    resetIds();
    const out = simulateRaid(base([
      b(BuildingType.Keep, 14, 14, 1, 'keep'),
      b(BuildingType.Cannon, 5, 8, 1, 'cannon'),
    ]), orders([deploy('highlander', 1, 8)]), 12);
    const fire = out.events.find((e) => e.e === 'fire' && e.id === 'cannon')!;
    expect(fire.impactOffsetTicks).toBe(Math.ceil(
      (fire.releaseOffsetMs + fire.flightMs) / 100,
    ));
    expect(out.events.some((e) => e.e === 'hit' && e.target === fire.target
      && e.t === fire.t + fire.impactOffsetTicks)).toBe(true);
  });

  it('cancels an attacker projectile when its source dies before release', () => {
    resetIds();
    const out = simulateRaid(base([
      b(BuildingType.Keep, 8, 8, 1, 'keep'),
      b(BuildingType.LaserTower, 4, 8, 3, 'laser'),
    ]), orders([deploy('bowman', 1, 8)]), 73);
    const run = out.events.find((e) => e.e === 'attackRun' && e.id === 0)!;
    const death = out.events.find((e) => e.e === 'troopDeath' && e.id === 0)!;
    expect(death.t).toBeLessThan(run.t + run.releaseOffsetTicks);
    expect(out.events.some((e) => e.e === 'hit' && e.target === run.target
      && e.t === run.t + run.impactOffsetsTicks[0]!)).toBe(false);
  });

  it('lets a released projectile land after its source dies', () => {
    resetIds();
    const out = simulateRaid(base([
      b(BuildingType.Keep, 8, 8, 1, 'keep'),
      b(BuildingType.Cannon, 4, 8, 3, 'cannon'),
    ]), orders([deploy('mage', 1, 8)]), 74);
    const run = out.events.find((e) => e.e === 'attackRun' && e.id === 0)!;
    const death = out.events.find((e) => e.e === 'troopDeath' && e.id === 0)!;
    const impactTick = run.t + run.impactOffsetsTicks[0]!;
    expect(death.t).toBeGreaterThanOrEqual(run.t + run.releaseOffsetTicks);
    expect(death.t).toBeLessThan(impactTick);
    expect(out.events.some((e) => e.e === 'hit' && e.target === run.target
      && e.t === impactTick)).toBe(true);
  });
});
