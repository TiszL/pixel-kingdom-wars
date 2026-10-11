import { describe, expect, it } from 'vitest';
import { DEFENSE_PROJECTILE_TIMINGS } from './constants';
import { attackPayloadDeci, authoredAttackTiming, splitAttackPayloadDeci } from './combatTiming';

describe('SIM9 authored attack timing', () => {
  it('lets the Bowman finish draw and loose before its arrow lands', () => {
    const bow = authoredAttackTiming('bowman', 'building');
    expect(bow.cycleTicks).toBe(7);
    expect(bow.releaseOffsetTicks).toBe(5);
    expect(bow.impactOffsetsTicks).toEqual([14]);
  });

  it('represents Dragon as three contacts in one connected breath', () => {
    const dragon = authoredAttackTiming('dragon', 'building');
    expect(dragon.mode).toBe('stream');
    expect(dragon.impactOffsetsTicks).toEqual([3, 4, 5]);
    expect(dragon.cycleTicks).toBe(7);
  });

  it('preserves exact integer DPS across multi-contact cycles', () => {
    const payload = attackPayloadDeci(71, 7);
    expect(splitAttackPayloadDeci(payload, 3).reduce((a, b) => a + b, 0)).toBe(payload);
  });

  it('keeps defense damage behind the visible V2 release and complete flight', () => {
    expect(DEFENSE_PROJECTILE_TIMINGS.cannon).toEqual({ releaseOffsetMs: 143, flightMs: 950 });
    expect(DEFENSE_PROJECTILE_TIMINGS.mortar).toEqual({ releaseOffsetMs: 143, flightMs: 1_235 });
  });
});
