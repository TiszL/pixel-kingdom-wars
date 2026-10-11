/**
 * `stopAfterTick` is how the API scores an accepted RETREAT: the settled
 * result must be the battle's exact state at the retreat tick, never a
 * placeholder (tester f7c978e8, 2026-09-16: keep down and 13 % live, settled
 * 0 % / 0★ / -5 trophies). These tests pin WHY that is safe to trust as money
 * truth: a truncated run is the byte-identical prefix of the full run, it
 * carries the real partial destruction, and the option is inert once the
 * battle has already ended — so no archived replay or golden fixture can move.
 */
import { describe, expect, it } from 'vitest';
import { BuildingType } from '@shardkeep/shared';
import { computeStars, simulateRaid } from '../src/sim';
import { SimInputError } from '../src/types';
import { b, base, deploy, orders } from './helpers';

/** Two buildings that fall at different ticks (stars.test's overwhelming army),
 * so a boundary at the first fall is genuinely mid-battle. */
const snap = () =>
  base([
    b(BuildingType.Keep, 8, 8, 1, 'keep'),
    b(BuildingType.Mine, 11, 8, 1, 'mine'),
  ]);

const army = () =>
  orders([
    deploy('turrider', 0, 8, 0),
    deploy('turrider', 17, 8, 0),
    deploy('highlander', 8, 0, 0),
    deploy('highlander', 8, 17, 0),
  ]);
const SEED = 5;

describe('stopAfterTick (retreat boundary)', () => {
  const full = simulateRaid(snap(), army(), SEED);
  const firstFall = full.events.find((event) => event.e === 'destroyed');

  it('the fixture actually loses a building before the battle ends', () => {
    // Never vacuous: a mid-battle boundary must have real partial progress.
    expect(firstFall).toBeDefined();
    expect(firstFall!.t).toBeLessThan(full.ticks - 1);
    expect(full.destructionPct).toBe(100);
  });

  it('is the byte-identical prefix of the full run with real partial destruction', () => {
    const boundary = firstFall!.t;
    const cut = simulateRaid(snap(), army(), SEED, { stopAfterTick: boundary });
    // WHY: settlement stores these events as the replay and this outcome as
    // the result; if the prefix could differ from the full run, a retreat and
    // its own archive would disagree about what the player watched.
    expect(cut.events).toEqual(full.events.filter((event) => event.t <= boundary));
    expect(cut.ticks).toBe(boundary + 1);
    expect(cut.destructionPct).toBeGreaterThan(0);
    expect(cut.destructionPct).toBeLessThan(full.destructionPct);
    expect(cut.stars).toBe(computeStars(cut.destructionPct, cut.keepDestroyed));
    expect(cut.victory).toBe(cut.stars >= 1);
    const fallenByBoundary = new Set(full.events
      .filter((event) => event.e === 'destroyed' && event.t <= boundary)
      .map((event) => (event as { id: string }).id));
    expect(cut.keepDestroyed).toBe(fallenByBoundary.has('keep'));
    for (const building of cut.buildings) {
      const final = full.buildings.find((other) => other.id === building.id)!;
      expect(building.maxHp).toBe(final.maxHp);
      expect(building.destroyed).toBe(fallenByBoundary.has(building.id));
      // Damage only accumulates: nothing after the boundary may have landed.
      expect(building.hp).toBeGreaterThanOrEqual(final.hp);
    }
  });

  it('stops at tick zero with only the opening deploys', () => {
    const cut = simulateRaid(snap(), army(), SEED, { stopAfterTick: 0 });
    expect(cut.ticks).toBe(1);
    expect(cut.events.every((event) => event.t === 0)).toBe(true);
    expect(cut).toMatchObject({ destructionPct: 0, stars: 0, keepDestroyed: false, victory: false });
  });

  it('is inert once the battle has already ended, so no existing replay moves', () => {
    expect(simulateRaid(snap(), army(), SEED, { stopAfterTick: full.ticks })).toEqual(full);
    expect(simulateRaid(snap(), army(), SEED, { stopAfterTick: full.ticks + 500 })).toEqual(full);
  });

  it('refuses a boundary that is not a whole non-negative tick', () => {
    expect(() => simulateRaid(snap(), army(), SEED, { stopAfterTick: -1 })).toThrow(SimInputError);
    expect(() => simulateRaid(snap(), army(), SEED, { stopAfterTick: 1.5 })).toThrow(SimInputError);
  });
});
