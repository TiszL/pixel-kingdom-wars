/**
 * SIM16 — the giant no longer walks away from a gun beside him.
 *
 * Owner relaying players (2026-09-17): "giants: how they act on the battlefield
 * needs correction — some people complain about it going to another place when
 * a target is nearby". Reproduced on SIM15 with the layout in the first test: a
 * giant dropped 4.5 tiles from a cannon sealed in a one-tile ring picked an open
 * cannon 13.5 tiles away instead (pickTarget: "reachable favourite first"), chewed
 * the ring wall in his path, stood 2.3 tiles from the sealed cannon — inside his
 * 2.5-tile boulder throw — and walked off north to the far one. He died having
 * killed nothing but a wall.
 *
 * Two rules fix it, both deterministic and both re-checked here on purpose:
 *   (a) NEVER WALK PAST A GUN YOU CAN HIT — while his held target is out of
 *       reach, the nearest defence inside his throw reach takes over (sim.ts,
 *       tick loop, gated on the siegeThrow role via behaviorOf);
 *   (b) a sealed defence is priced as distance + SIM_TARGETING.
 *       sealedDefenceAllowanceTiles against the nearest open one when a
 *       defence-seeker picks its target (sim.ts pickTarget).
 * The intended design is untouched: he is still a defence-seeking tank that
 * throws boulders over masonry and decides once at a wall (D-099).
 */
import { describe, expect, it } from 'vitest';
import { BuildingType, SIM_TARGETING, TROOPS } from '@shardkeep/shared';
import { simulateRaid } from '../src/sim';
import { b, base, deploy, orders, resetIds, wallRing } from './helpers';
import type { SimEvent } from '../src/types';

const destroyedAt = (events: readonly SimEvent[], id: string): number => {
  const e = events.find((x) => x.e === 'destroyed' && x.id === id);
  return e ? e.t : Infinity;
};
const attackRuns = (events: readonly SimEvent[]) =>
  events.filter((e): e is Extract<SimEvent, { e: 'attackRun' }> => e.e === 'attackRun');

describe('the giant never walks away from a gun he can hit (SIM16)', () => {
  it('REPRODUCTION: a sealed cannon 4.5 tiles from the drop beats an open one 13.5 tiles away', () => {
    // WHY: this is the players' complaint, byte for byte. cannonNear sits in a
    // sealed T1 ring 4.5 tiles east of the drop — beyond his 2.5-tile throw, so
    // not "reachable" — and cannonFar is open 13.5 tiles away. On SIM15 the
    // reachable-first hierarchy sent him to cannonFar and he died on the way
    // without a single throw at the gun beside him. Rule (b): 4.5 + 6 < 13.5,
    // the sealed gun wins, he walks two tiles, throws over the wall and lives
    // to clear the base.
    resetIds();
    const r = simulateRaid({ ...base([
      b(BuildingType.Keep, 14, 14, 1, 'keep'),
      b(BuildingType.Cannon, 7, 7, 1, 'cannonNear'),
      ...wallRing(5, 9, 1, 'w'),
      b(BuildingType.Cannon, 16, 7, 1, 'cannonFar'),
    ]), claimMin: 4, claimMax: 20 }, orders([deploy('giant', 2, 7)]), 7);
    const runs = attackRuns(r.events);
    expect(runs[0]).toMatchObject({ target: 'cannonNear', technique: 'boulder' });
    expect(destroyedAt(r.events, 'cannonNear')).toBeLessThan(destroyedAt(r.events, 'cannonFar'));
    // The tank survives and finishes the job: both guns fall.
    expect(destroyedAt(r.events, 'cannonFar')).toBeLessThan(Infinity);
    expect(r.events.some((e) => e.e === 'troopDeath' && e.id === 0)).toBe(false);
    // The sealed gun died to boulders thrown OVER the ring — the wall between
    // them was never touched before the kill (still the tank, not a breacher).
    const wallHitBeforeKill = runs.some((run) => run.t < destroyedAt(r.events, 'cannonNear')
      && String(run.target).startsWith('w_'));
    expect(wallHitBeforeKill).toBe(false);
  });

  it('the allowance is a breach PRICE, not a lock: an open gun a little farther still wins', () => {
    // WHY: rule (b) must not turn the giant back into a wall-chewer. cannonSealed
    // is 5.7 tiles away behind a ring (priced 5.7 + 6 = 11.7), cannonOpen is 7.5
    // tiles away in the open: the open gun is cheaper, so he takes it first and
    // only then breaches to the sealed one (D-099: a defence-seeker breaches to
    // its defence once nothing open remains). The ring is placed so his walk
    // never comes inside throw reach of the sealed gun — that is rule (a)'s
    // job, tested separately below.
    resetIds();
    const r = simulateRaid({ ...base([
      b(BuildingType.Keep, 16, 16, 1, 'keep'),
      b(BuildingType.Cannon, 7, 6, 1, 'cannonSealed'),
      ...wallRing(5, 8, 1, 'w'),
      b(BuildingType.Cannon, 10, 10, 1, 'cannonOpen'),
    ]), claimMin: 4, claimMax: 20 }, orders([deploy('giant', 2, 10)]), 7);
    const runs = attackRuns(r.events);
    expect(runs[0]).toMatchObject({ target: 'cannonOpen', technique: 'boulder' });
    expect(destroyedAt(r.events, 'cannonOpen')).toBeLessThan(destroyedAt(r.events, 'cannonSealed'));
    expect(destroyedAt(r.events, 'cannonSealed')).toBeLessThan(Infinity);
    // Pin the number the pricing rests on: change the allowance and this
    // scenario's answer may legitimately flip — say so in constants.ts.
    expect(SIM_TARGETING.sealedDefenceAllowanceTiles).toBe(6);
  });

  it('a gun that comes inside his throw ON THE WAY takes over — he does not walk past it', () => {
    // WHY (rule a): the held target is chosen at deploy and kept until it dies.
    // cannonSealed is 4.7 tiles from the drop behind a ring (priced 10.7, so the
    // open cannon 9.5 tiles east is picked), but his straight walk to the open
    // gun passes 1.5 tiles from the sealed one — inside the 2.5-tile throw. On
    // SIM15 he marched straight past it. Now the first boulder flies at the
    // sealed gun mid-walk, it falls first, and he still goes on to the held one:
    // a switch toward a gun in reach is progress, never a reversal.
    resetIds();
    const r = simulateRaid({ ...base([
      b(BuildingType.Keep, 16, 16, 1, 'keep'),
      b(BuildingType.Cannon, 7, 8, 1, 'cannonSealed'),
      ...wallRing(5, 9, 1, 'w'),
      b(BuildingType.Cannon, 12, 10, 1, 'cannonOpen'),
    ]), claimMin: 4, claimMax: 20 }, orders([deploy('giant', 2, 10)]), 7);
    const runs = attackRuns(r.events);
    expect(runs[0]).toMatchObject({ target: 'cannonSealed', technique: 'boulder' });
    expect(runs[0]!.t).toBeGreaterThan(0); // mid-walk, not a deploy-time pick
    expect(destroyedAt(r.events, 'cannonSealed')).toBeLessThan(destroyedAt(r.events, 'cannonOpen'));
    expect(destroyedAt(r.events, 'cannonOpen')).toBeLessThan(Infinity);
    // Every throw before the sealed gun fell went at the sealed gun: once in
    // reach he stands and throws, he does not resume the walk.
    const before = runs.filter((run) => run.t < destroyedAt(r.events, 'cannonSealed'));
    expect(before.length).toBeGreaterThan(1);
    expect(before.every((run) => run.target === 'cannonSealed')).toBe(true);
  });

  it('two guns in reach at once never make him flip-flop: the switch is gated on the held target being OUT of reach', () => {
    // WHY: rule (a) only fires while the held target cannot be hit from where
    // he stands. With an archer tower adjacent and a cannon 1.5 tiles away he
    // takes the nearest and every throw until it falls goes at that one gun —
    // D-099's "no reversals a 90-second battle can afford" holds for targeting
    // too.
    resetIds();
    const r = simulateRaid({ ...base([
      b(BuildingType.Keep, 14, 14, 1, 'keep'),
      b(BuildingType.ArcherTower, 5, 8, 1, 'archer'),
      b(BuildingType.Cannon, 5, 10, 1, 'cannon'),
    ]), claimMin: 4, claimMax: 20 }, orders([deploy('giant', 4, 8)]), 7);
    const runs = attackRuns(r.events);
    const first = runs[0]!.target;
    const firstDies = destroyedAt(r.events, String(first));
    expect(firstDies).toBeLessThan(Infinity);
    expect(runs.filter((run) => run.t < firstDies).every((run) => run.target === first)).toBe(true);
    // …and the other gun is next, not the Keep: still a defence-seeker.
    const second = runs.find((run) => run.t >= firstDies)!;
    expect(new Set([first, second.target])).toEqual(new Set(['archer', 'cannon']));
  });

  it('Theodor (giant donor) does not inherit the throw-reach switch: his walk to the open gun is unchanged', () => {
    // WHY: rule (a) is a siegeThrow ROLE read through behaviorOf, exactly like
    // the throw itself (2026-08-08). Theodor is a grounded defence-seeker on the
    // giant's sprite with melee reach and no siegeThrow: in the rule-(a) layout
    // he prices the sealed gun the same way (rule b applies to every grounded
    // defence-seeker), picks the open one, and walking 1.5 tiles past the
    // sealed gun changes nothing — his first swing lands on the open cannon.
    expect(TROOPS.giant.siegeThrow).toBeDefined();
    resetIds();
    const r = simulateRaid({ ...base([
      b(BuildingType.Keep, 16, 16, 1, 'keep'),
      b(BuildingType.Cannon, 7, 8, 1, 'cannonSealed'),
      ...wallRing(5, 9, 1, 'w'),
      b(BuildingType.Cannon, 12, 10, 1, 'cannonOpen'),
    ]), claimMin: 4, claimMax: 20 }, {
      ...orders([]), heroDeploys: [{ hero: 'theodor', tx: 2, ty: 10, tMs: 0, level: 1 }],
    }, 7);
    const swing = r.events.find((e) => e.e === 'heroAttack' && e.targetKind === 'building');
    expect(swing).toMatchObject({ hero: 'theodor', target: 'cannonOpen' });
    expect(attackRuns(r.events).length).toBe(0); // no boulders: still no throw
  });
});
