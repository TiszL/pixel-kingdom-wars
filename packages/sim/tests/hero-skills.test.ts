/**
 * D4b COMPLETE — the eleven data-only hero skills get engine code (2026-07-29).
 *
 * Until now only the two L1 signatures (Crimson Dash, Cheek Quake) existed in the
 * sim; the other eleven were tier tables in HERO_SKILLS that nothing read. Hero
 * LEVELING is KEEP-priced and live, so a player who paid to reach an advertised
 * unlock level got stats and no skill. These tests pin that shut.
 *
 * What every skill gets here:
 *   1. an UNLOCK GATE test — it does not fire one level below `unlockLevel`;
 *   2. an EFFECT test — the effect is observable in the event log or the outcome,
 *      and would disappear if the engine line were removed.
 *
 * Where a level pair would confound two things (a higher level also means more
 * hp/dps), the skill is A/B'd at ONE level by pushing its own `unlockLevel` past
 * max — the same isolation technique the role-leak suite uses on HERO_COMBAT. The
 * sim is never patched.
 */
import { describe, expect, it } from 'vitest';
import { BuildingType, HERO_COMBAT, HERO_LEVELING, HERO_SKILLS, TROOPS, heroTier } from '@shardkeep/shared';
import { simulateRaid } from '../src/sim';
import { TRAP_BURST_DECI, footprintOf } from '../src/stats';
import { b, base, deploy, fnv1a, orders, resetIds, wallRing, withoutHeroSwingHits } from './helpers';
import type { SimEvent } from '../src/types';

type R = ReturnType<typeof simulateRaid>;
type HeroKey = 'vex' | 'theodor';

const heroIdOf = (r: R, hero: HeroKey): number =>
  (r.events.find((e) => e.e === 'deploy' && (e as { hero?: string }).hero === hero) as { id: number }).id;
const skillEvents = (r: R, skill: string): Array<SimEvent & { t: number; x: number; y: number }> =>
  r.events.filter((e) => e.e === 'heroSkill' && (e as { skill?: string }).skill === skill) as never;
const impactSkillEvents = (r: R, skill: string): Array<SimEvent & { t: number; x: number; y: number }> =>
  skillEvents(r, skill).filter((e) => (e as { phase?: string }).phase === 'impact');
const fired = (r: R, skill: string): boolean => skillEvents(r, skill).length > 0;
/** `hit` events aimed at a BUILDING (string target) vs a TROOP (numeric target). */
const buildingHits = (r: R, id: string): Array<{ t: number; dmg: number }> =>
  r.events.filter((e) => e.e === 'hit' && e.target === id) as never;
const troopHits = (r: R, id: number): Array<{ t: number; dmg: number }> =>
  r.events.filter((e) => e.e === 'hit' && e.target === id) as never;
const drop = (hero: HeroKey, tx: number, ty: number, level: number, tMs = 0) =>
  ({ hero, tx, ty, tMs, level });

/**
 * Temporarily patch one HERO_SKILLS entry, always restored. `as const` gives the
 * table readonly TYPES but leaves a perfectly mutable object at runtime, which is
 * exactly how the role-leak suite patches HERO_COMBAT.
 */
function withSkill<T>(hero: HeroKey, skill: string, patch: Record<string, unknown>, fn: () => T): T {
  const table = HERO_SKILLS[hero] as unknown as Record<string, Record<string, unknown>>;
  const orig = table[skill]!;
  table[skill] = { ...orig, ...patch };
  try { return fn(); } finally { table[skill] = orig; }
}
/** Run `fn` with a skill switched off — the A/B control for "this line matters". */
const without = <T>(hero: HeroKey, skill: string, fn: () => T): T =>
  withSkill(hero, skill, { unlockLevel: HERO_LEVELING.maxLevel + 1 }, fn);

// ---------------------------------------------------------------------------
// 0. NOTHING THAT EXISTED MOVED.
// ---------------------------------------------------------------------------
describe('a level-1 hero, and every keg blast, replay exactly as before D4b', () => {
  /**
   * These four fingerprints were captured by running the PRE-CHANGE sim (git
   * stash) over the same scenarios; they are pasted here verbatim. They are the
   * only mechanical proof that eleven new skills, three new state fields, a DoT
   * pass and the keg-magnitude refactor changed nothing a player could already
   * see. The golden fixtures cover troop-only raids (none of them contains a
   * hero deploy at all); these cover the hero paths the fixtures cannot.
   *
   * If one of these moves, something that was NOT supposed to change did. Do not
   * re-capture them to make the suite green.
   *
   * RE-CAPTURED ONCE, 2026-07-29, for two deliberate sim fixes — with the reason
   * recorded here because the rule above is otherwise absolute:
   *   1. Hero dps was spawned as `dps * 10` into a field that is deci-per-TICK,
   *      so both heroes hit for 10x their stat. Every hero fingerprint necessarily
   *      moves when that is corrected.
   *   2. A blocked unit forgot its detour the tick after taking it and walked back
   *      into the wall, so wall scenarios deadlocked.
   * The fourth case (keg blast, no hero) did NOT move — which is the evidence that
   * these two fixes are hero- and wall-scoped and nothing else drifted.
   *
   * RE-CAPTURED case 3 ONLY, 2026-08-08, for the rework-v2 giant (SIM_VERSION 3,
   * owner decision in docs/REWORK-V2-PLAN.md): hp 700→1600, siegeThrow boulders
   * at defenses within 2.5 tiles (over walls), and the blocking-wall chew now at
   * dps×buildingDamageMult. That case fields the only giant in this file, so its
   * fingerprint necessarily moves (he now survives the gun and kills it with
   * boulder troopFire cues). Cases 1, 2 and 4 contain no siegeThrow unit and did
   * NOT move — the evidence that the rework is giant-scoped and the hero seam
   * (behaviorOf) still isolates Theodor from his donor.
   *
   * RE-CAPTURED the two Keg Runner cases, 2026-08-10, for SIM_VERSION 4:
   * the dedicated keg approach now emits the same render-only `pos` keyframes
   * as other moving troops. Outcomes and every case without a keg remain
   * unchanged; only event-log placement gained the missing movement cues.
   *
   * RE-CAPTURED the three hero cases, 2026-08-12, for SIM_VERSION 7: hero basic
   * attacks now use authoritative recovery bursts (same listed DPS over time)
   * and emit typed heroAttack/heroSkill phases. The troop-only keg case remains
   * unchanged, proving the replay movement is hero-scoped.
   *
   * RE-CAPTURED cases 1 and 2, 2026-08-12, inside the same unreleased SIM7
   * boundary: their ordinary Highlanders now publish the generic target-aware
   * `troopAttack: strike` cues promised by SIM7. Hero mechanics and outcomes do
   * not move; case 3 remains unchanged because its giant reaches no new ordinary
   * melee cadence before the existing keg/hero resolution.
   *
   * RE-CAPTURED case 2 ONLY, 2026-08-15, for SIM10/M22: the same T1 spike
   * damage remains 250, but its replay event now identifies the trap family and
   * complete victim set so spent-state playback is authoritative.
   *
   * RE-CAPTURED cases 2 and 3, 2026-08-16, for SIM11/D-060: both field a
   * Cannon, whose range doubled to 6 tiles ("increase cannon range 2 times for
   * attack"), so the gun opens fire on approach ticks it used to sit out.
   * Cases 1 and 4 field no cannon/archer and no flyer and did NOT move — the
   * evidence that D-060 is tower-range/anti-air-scoped and hero mechanics,
   * keg magnitude and wall behaviour did not drift.
   *
   * RE-CAPTURED case 3 ONLY, 2026-09-02, for SIM12/D-099: heroes decide at a
   * wall exactly like troops now, so Vex no longer treats the sealed Keep as
   * "reachable because a keg runner exists" and walks toward that moving
   * ally — he takes the open gun like the tank beside him. Cases 1, 2 and 4
   * did NOT move: case 1's wall ROW is walked around under both rules, case 2
   * has no wall, and case 4 has no hero — the evidence that D-099 changes
   * only what a blocked unit does at masonry.
   *
   * RE-CAPTURED case 3 ONLY, 2026-09-03, for SIM13: a hero's already-existing
   * blocking-wall swing now publishes its missing presentation-only heroAttack
   * cue. Damage, cadence, targeting and outcomes are unchanged; cases without
   * a hero chewing a committed breach did NOT move.
   *
   * RE-CAPTURED the three hero cases, 2026-09-04, for SIM14: a hero's basic
   * swing on a building now publishes its applied damage as an ordinary `hit`
   * right after its `heroAttack` cue (the client's HP mirror moves on `hit`
   * only, so hero-only damage used to leave the bar full until `destroyed`).
   * Each tuple keeps its PRE-SIM14 fingerprint too: stripping exactly those
   * adjacent swing hits must reproduce it, which is the mechanical proof that
   * nothing but the missing `hit` records was added. Case 4 fields no hero and
   * did NOT move, so both of its fingerprints are the same value.
   */
  const cases: Array<[string, string, string, () => R]> = [
    ['vex L1 vs a walled keep', '25cc02ee', 'cfc6f7da', () => {
      resetIds();
      return simulateRaid(base([
        b(BuildingType.Keep, 14, 13, 3, 'keep'),
        ...[12, 13, 14, 15, 16, 17, 18].map((x) => b(BuildingType.Wall, x, 10, 3)),
      ], 3), {
        ...orders([deploy('highlander', 14, 0, 0)]),
        heroDeploys: [{ hero: 'vex', tx: 14, ty: 1, tMs: 0 }],
      }, 42);
    }],
    ['theodor L1 into guns and a trap', 'f561bc42', 'e3f2ec45', () => {
      resetIds();
      return simulateRaid(base([
        b(BuildingType.Keep, 14, 13, 3, 'keep'),
        b(BuildingType.Cannon, 10, 10, 3, 'cannon'),
        b(BuildingType.SpikeTrap, 6, 10, 1, 'trap'),
      ], 3), {
        ...orders([deploy('highlander', 2, 9, 0), deploy('highlander', 2, 11, 0)]),
        heroDeploys: [{ hero: 'theodor', tx: 2, ty: 10, tMs: 0 }],
      }, 9);
    }],
    ['both L1 heroes + a keg + a giant vs a sealed ring', '8ca7ab4e', '47536062', () => {
      resetIds();
      return simulateRaid(base([
        b(BuildingType.Keep, 13, 13, 3, 'keep'),
        ...wallRing(8, 20, 3, 'ring'),
        b(BuildingType.Cannon, 26, 2, 3, 'gun'),
        b(BuildingType.Mine, 12, 12, 4, 'mine'),
      ], 3), {
        ...orders([deploy('kegrunner', 0, 8, 0), deploy('giant', 0, 9, 0)]),
        heroDeploys: [
          { hero: 'vex', tx: 0, ty: 15, tMs: 0 },
          { hero: 'theodor', tx: 0, ty: 16, tMs: 500 },
        ],
      }, 7);
    }],
    // The keg-magnitude refactor's own regression: L7 kegs, so BOTH the wall
    // burst and the splash go through the level-scaling path that changed shape.
    ['researched kegs vs a nest + ring (keg magnitude)', '6876a70e', '6876a70e', () => {
      resetIds();
      return simulateRaid(base([
        b(BuildingType.Keep, 14, 14, 3, 'keep'),
        b(BuildingType.DragonNest, 12, 12, 3, 'nest'),
        ...wallRing(9, 19, 2, 'ring'),
      ], 3), {
        ...orders([deploy('kegrunner', 0, 14, 0), deploy('kegrunner', 0, 15, 300)]),
      }, 5, { troopLevels: { kegrunner: 7 } });
    }],
  ];

  for (const [name, fingerprint, preSim14Fingerprint, run] of cases) {
    it(`${name} — SIM9 synchronized event fingerprint`, () => {
      const { events } = run();
      expect(fnv1a(JSON.stringify(events))).toBe(fingerprint);
      // SIM14 proof: the same log minus each swing's adjacent `hit` is the
      // pre-SIM14 log, byte for byte. A drift in damage, cadence or targeting
      // would move this second fingerprint as well as the first.
      expect(fnv1a(JSON.stringify(withoutHeroSwingHits(events)))).toBe(preSim14Fingerprint);
    });
  }

  it('a level-1 hero casts the two L1 signatures and NOTHING else', () => {
    // The single clearest statement of the compatibility contract: eleven new
    // skills exist, and an unlevelled hero fires none of them.
    resetIds();
    const snap = base([
      b(BuildingType.Keep, 14, 14, 3, 'keep'),
      b(BuildingType.Cannon, 12, 14, 3, 'cannon'),
      ...wallRing(10, 18, 3, 'ring'),
    ], 3);
    const r = simulateRaid(snap, {
      ...orders([]), heroDeploys: [drop('vex', 0, 14, 1), drop('theodor', 0, 15, 1)],
    }, 42);
    const cast = new Set(r.events.filter((e) => e.e === 'heroSkill').map((e) => (e as { skill: string }).skill));
    expect([...cast].sort()).toEqual(['cheekQuake', 'crimsonDash']);
  });
});

// ---------------------------------------------------------------------------
// 1. THEODOR
// ---------------------------------------------------------------------------
describe('SNOT ROCKET (Theodor L3) — damage, blind, forced aggro', () => {
  /** A LASER tower on purpose: its 7-tile reach exceeds the rocket's 6, so the
   *  gun is already shooting when the slime arrives and the blind has something
   *  to interrupt. Against a 3-tile cannon the skill outranges the gun and the
   *  blind window would be vacuously quiet. */
  const scenario = () => { resetIds(); return base([
    b(BuildingType.Keep, 20, 12, 3, 'keep'),
    b(BuildingType.LaserTower, 12, 12, 8, 'gun'),
  ], 3); };
  const run = (level: number): R => simulateRaid(scenario(), {
    ...orders([]), heroDeploys: [drop('theodor', 0, 12, level)],
  }, 42);

  it('does not exist at L2 and fires at L3', () => {
    expect(fired(run(2), 'snotRocket')).toBe(false);
    expect(fired(run(3), 'snotRocket')).toBe(true);
  });

  it('lands the tier-1 damage row exactly and BLINDS the gun for 2s', () => {
    const r = run(3);
    const snot = skillEvents(r, 'snotRocket')[0]!;
    // 25% DPS at T1 off Theodor's L3 dps, in deci, rounded for the event.
    const dps = HERO_LEVELING.dps.theodor[2]!;
    const expected = Math.round(Math.floor((dps * HERO_SKILLS.theodor.snotRocket.dmgPctDps[0]!) / 100) / 10);
    expect(buildingHits(r, 'gun').some((h) => h.t === snot.t && h.dmg === expected)).toBe(true);

    // BLIND 2s = 20 ticks: the gun was firing before, and fires nothing at all
    // for the whole window. A laser reloads every 15 ticks, so an unblinded gun
    // would certainly have fired inside it — the assertion cannot go vacuous.
    const fires = r.events.filter((e) => e.e === 'fire' && e.id === 'gun') as Array<{ t: number }>;
    expect(fires.some((f) => f.t < snot.t)).toBe(true);
    const blind = HERO_SKILLS.theodor.snotRocket.blindDeciSec[0]!; // deci-sec → ticks 1:1
    expect(fires.filter((f) => f.t >= snot.t && f.t < snot.t + blind)).toHaveLength(0);
    expect(fires.some((f) => f.t >= snot.t + blind)).toBe(true);
  });

  it('FORCED AGGRO: the gun shoots the stool once the slime lands', () => {
    const r = run(3);
    const snot = skillEvents(r, 'snotRocket')[0]!;
    const id = heroIdOf(r, 'theodor');
    const next = r.events.find((e) => e.e === 'fire' && e.id === 'gun' && e.t > snot.t) as
      { target: number } | undefined;
    expect(next).toBeDefined();
    expect(next!.target).toBe(id);
  });
});

describe('CANNONBALL (Theodor L5) — the leap, the impact, the parting gift', () => {
  const scenario = () => { resetIds(); return base([
    b(BuildingType.Keep, 20, 12, 3, 'keep'),
    b(BuildingType.Cannon, 12, 12, 5, 'cannon'),
  ], 3); };
  const run = (level: number): R => simulateRaid(scenario(), {
    ...orders([]), heroDeploys: [drop('theodor', 0, 12, level)],
  }, 42);

  it('does not exist at L4 and fires at L5', () => {
    expect(fired(run(4), 'cannonball')).toBe(false);
    expect(fired(run(5), 'cannonball')).toBe(true);
  });

  it('covers ground no waddle could — a one-tick jump onto the roof', () => {
    const r = run(5);
    const id = heroIdOf(r, 'theodor');
    const cb = skillEvents(r, 'cannonball')[0]!;
    const pos = r.events.filter((e) => e.e === 'pos' && (e as { id: number }).id === id) as
      Array<{ t: number; x: number; y: number }>;
    const before = pos.filter((p) => p.t < cb.t).at(-1)!;
    const landed = pos.find((p) => p.t === cb.t)!;
    // He lands ON the gun's centre tile …
    expect([landed.x, landed.y]).toEqual([12 * 256 + 128, 12 * 256 + 128]);
    // … having crossed, in ONE tick, far more than his own top speed.
    const walk = Math.floor((HERO_COMBAT.theodor.speedTilesPerSec * 256) / 10);
    expect(landed.x - before.x).toBeGreaterThan(walk * 5);
    // Impact = 120% DPS at T1.
    const dps = HERO_LEVELING.dps.theodor[4]!;
    const expected = Math.round(Math.floor((dps * HERO_SKILLS.theodor.cannonball.impactDmgPctDps[0]!) / 100) / 10);
    expect(buildingHits(r, 'cannon').some((h) => h.t === cb.t && h.dmg === expected)).toBe(true);
  });

  it('PARTING GIFT starts on departure, never on landing', () => {
    resetIds();
    const r = simulateRaid(base([
      b(BuildingType.Keep, 20, 12, 3, 'keep'),
      b(BuildingType.Cannon, 12, 12, 5, 'gun'),
    ], 3), { ...orders([]), heroDeploys: [drop('theodor', 0, 12, 11)] }, 42);
    const cb = impactSkillEvents(r, 'cannonball')[0]!;
    const depart = skillEvents(r, 'cannonball').find((e) => (e as { phase?: string }).phase === 'depart')!;
    const s = HERO_SKILLS.theodor.cannonball;
    const perTick = s.partingGiftDps[2]!; // T3 = 35 dps = 35 deci/tick exactly
    expect(perTick).toBeGreaterThan(0);
    const giftDmg = Math.round(perTick / 10);
    const gift = buildingHits(r, 'gun').filter((h) => h.dmg === giftDmg);
    expect(depart.t).toBeGreaterThan(cb.t);
    expect(gift.some((h) => h.t >= cb.t && h.t < depart.t)).toBe(false);
  });
});

describe('SKILL ISSUE (Theodor L8) — the aggro aura and the damage reduction', () => {
  /**
   * The retarget half needs a COMPETING target, or "he pulls the gun" is
   * indistinguishable from "he is the only thing to shoot".
   *
   * Layout: the hero is dropped already touching a tanky `perch`, so he stands
   * still all battle at a known point. A `gun` sits 4.47 tiles away — beyond
   * Cheek Quake's 4-tile taunt at this tier, inside SKILL ISSUE's 5-tile
   * retarget — and a highlander parks about 1 tile from that gun, so absent the
   * aura the gun always prefers the highlander.
   */
  const scenario = () => { resetIds(); return base([
    // L12, not L20: with hero dps corrected (2026-07-29) an L20 perch outlived
    // Theodor, he died mid-raid and the freed gun then killed the decoy — which
    // read as "the aura failed" when it had not. Any perch in L6..L14 reproduces
    // the intended split, so this sits mid-band rather than on an edge.
    b(BuildingType.LaserTower, 20, 26, 12, 'perch'),
    b(BuildingType.LaserTower, 18, 21, 1, 'gun'),
  ], 3); };
  const run = (level: number): R => simulateRaid(scenario(), {
    ...orders([deploy('highlander', 18, 18, 0)]),
    heroDeploys: [drop('theodor', 20, 25, level)],
  }, 42);

  it('at L7 the gun shoots the poor highlander; at L8 it can only see Theodor', () => {
    const lo = run(7);
    const hi = run(8);
    expect(fired(lo, 'skillIssue')).toBe(false);
    expect(fired(hi, 'skillIssue')).toBe(true);

    const decoy = (lo.events.find((e) => e.e === 'deploy' && !(e as { hero?: string }).hero) as { id: number }).id;
    const gunFires = (r: R) => r.events.filter((e) => e.e === 'fire' && e.id === 'gun') as
      Array<{ t: number; target: number }>;
    const died = (r: R, id: number) => r.events.some((e) => e.e === 'troopDeath' && e.id === id);

    // Without the aura the gun kills the highlander.
    expect(gunFires(lo).filter((f) => f.target === decoy).length).toBeGreaterThan(0);
    expect(died(lo, decoy)).toBe(true);
    // With it, "every arrow aimed at him is an arrow not aimed at anything that
    // matters": the gun never once shoots the highlander, and it survives.
    expect(gunFires(hi).filter((f) => f.target === decoy)).toHaveLength(0);
    expect(gunFires(hi).filter((f) => f.target === heroIdOf(hi, 'theodor')).length).toBeGreaterThan(0);
    expect(died(hi, decoy)).toBe(false);
  });
});

describe('BELLY BOUNCE (Theodor L11) + SKILL ISSUE damage reduction — exact arithmetic', () => {
  /**
   * A spike trap is the one damage source in this sim with NO jitter: a flat
   * TRAP_BURST_DECI. That makes the mitigation chain readable to the deci, which
   * is the only way to prove each passive contributes SEPARATELY — a "takes less
   * damage" inequality would pass with either one of them wired.
   *
   * Chain (multiplicative, floored at each step, exactly as `mitigate` runs it):
   *   SKILL ISSUE from L8, then BELLY BOUNCE's self-DR from L11.
   */
  const expectedHit = (level: number): number => {
    const i = level >= 16 ? 3 : level >= 11 ? 2 : level >= 6 ? 1 : 0;
    let d = TRAP_BURST_DECI;
    if (level >= HERO_SKILLS.theodor.skillIssue.unlockLevel) {
      d = Math.floor((d * (100 - HERO_SKILLS.theodor.skillIssue.dmgTakenReductionPct[i]!)) / 100);
    }
    if (level >= HERO_SKILLS.theodor.bellyBounce.unlockLevel) {
      d = Math.floor((d * (100 - HERO_SKILLS.theodor.bellyBounce.selfDrPct[i]!)) / 100);
    }
    return Math.round(d / 10);
  };

  /** He waddles east along y=10 into a trap one tile out, with his target 25
   *  tiles away — far past CANNONBALL's leap, so nothing carries him over it. */
  const trapRun = (level: number): { r: R; id: number } => {
    resetIds();
    const snap = base([
      b(BuildingType.Keep, 25, 10, 3, 'keep'),
      b(BuildingType.SpikeTrap, 1, 10, 1, 'trap'),
    ], 3);
    const r = simulateRaid(snap, { ...orders([]), heroDeploys: [drop('theodor', 0, 10, level)] }, 42);
    return { r, id: heroIdOf(r, 'theodor') };
  };

  it.each([
    [1, 250],   // no passives:            2500 deci
    [8, 175],   // SKILL ISSUE −30% (T2):  floor(2500*70/100) = 1750
    [10, 175],  // still T2, BELLY locked: unchanged — the level did not buy it
    [11, 146],  // T3: floor(2500*65/100)=1625, then floor(1625*90/100)=1462
  ])('a level-%i Theodor takes exactly %i from the trap', (level, dmg) => {
    const { r, id } = trapRun(level);
    expect(r.events.some((e) => e.e === 'trap')).toBe(true); // never vacuous
    const first = troopHits(r, id)[0]!;
    expect(first.dmg).toBe(dmg);
    expect(first.dmg).toBe(expectedHit(level));
  });

  it('L10 → L11 is BELLY BOUNCE alone: 163 would be Skill Issue T3 on its own', () => {
    // Guards the multiplicative composition. If bellyBounce were dropped, L11
    // would read floor(2500*65/100)/10 = 163 (not 146); if skillIssue's tier were
    // read wrong it would not be 146 either. Only the exact chain gives 146.
    expect(Math.round(Math.floor((TRAP_BURST_DECI * 65) / 100) / 10)).toBe(163);
    expect(trapRun(11).r.events.filter((e) => e.e === 'hit')[0]).toMatchObject({ dmg: 146 });
  });
});

describe('BROWN NOTE (Theodor L14) — a wall segment is deleted, HP is irrelevant', () => {
  /** Tier-20 stone (13,201 hp) sealed around the only defence, and Theodor
   *  parked outside it: at 62 dps he could not chew through this in ten battles,
   *  and the ring is far enough out that CANNONBALL cannot carry him over. */
  const scenario = () => { resetIds(); return base([
    b(BuildingType.LaserTower, 14, 14, 3, 'laser'),
    ...wallRing(6, 22, 20, 'ring'),
  ], 3); };
  const run = (level: number): R => simulateRaid(scenario(), {
    ...orders([]), heroDeploys: [drop('theodor', 0, 14, level)],
  }, 42);

  it('L13 cannot open the wall; L14 deletes it outright, the same tick it casts', () => {
    const lo = run(13);
    const hi = run(14);
    expect(fired(lo, 'brownNote')).toBe(false);
    const note = skillEvents(hi, 'brownNote')[0]!;

    const opened = (r: R) => r.events.filter((e) => e.e === 'destroyed' && String(e.id).startsWith('ring')) as
      Array<{ t: number; id: string }>;
    // Deletion is INSTANT: the segment dies on the cast tick.
    expect(opened(hi)[0]).toMatchObject({ t: note.t });
    // And it is deletion, not damage — the reported hit is the segment's whole
    // remaining HP, three orders of magnitude past a Theodor swing.
    const kill = buildingHits(hi, opened(hi)[0]!.id).find((h) => h.t === note.t)!;
    expect(kill.dmg).toBeGreaterThan(10_000);
    // Without the skill, nothing is open by then — he is still gnawing.
    expect(opened(lo).filter((e) => e.t <= note.t)).toHaveLength(0);
  });

  it('T4 takes a SECOND, ADJACENT segment in the same breath', () => {
    const r = run(20);
    const note = skillEvents(r, 'brownNote')[0]!;
    const sameTick = r.events.filter((e) => e.e === 'destroyed' && String(e.id).startsWith('ring') && e.t === note.t) as
      Array<{ id: string }>;
    expect(HERO_SKILLS.theodor.brownNote.wallSegments[3]).toBe(2);
    expect(sameTick).toHaveLength(2);
    // Adjacent: the ids carry their tile, so the pair must differ by one step.
    const tiles = sameTick.map((e) => e.id.split('_').slice(1).map(Number) as [number, number]);
    const [[ax, ay], [bx, by]] = tiles as [[number, number], [number, number]];
    expect(Math.abs(ax - bx) + Math.abs(ay - by)).toBe(1);
  });
});

describe('SILENT BUT DEADLY (Theodor L20) — the ultimate', () => {
  const scenario = () => { resetIds(); return base([
    b(BuildingType.Keep, 14, 12, 3, 'keep'),
    b(BuildingType.Cannon, 12, 12, 5, 'cannon'),
    b(BuildingType.Vault, 12, 14, 5, 'vault'),
  ], 3); };
  const run = (level: number): R => simulateRaid(scenario(), {
    ...orders([]), heroDeploys: [drop('theodor', 0, 12, level)],
  }, 42);

  it('L19 never gets it; L20 detonates a 6-tile nova for exactly 250% DPS, once', () => {
    expect(fired(run(19), 'silentButDeadly')).toBe(false);
    const r = run(20);
    const ult = impactSkillEvents(r, 'silentButDeadly');
    expect(ult).toHaveLength(1); // ONCE PER BATTLE

    const dps = HERO_LEVELING.dps.theodor[19]!;
    const nova = Math.round(Math.floor((dps * HERO_SKILLS.theodor.silentButDeadly.novaDmgPctDps) / 100) / 10);
    const struck = r.events.filter((e) => e.e === 'hit' && e.t === ult[0]!.t
      && typeof (e as { target: unknown }).target === 'string'
      && (e as { dmg: number }).dmg === nova);
    // A nova, not a single-target poke: several buildings eat the same number.
    expect(struck.length).toBeGreaterThanOrEqual(3);
  });
});

describe('RAGE QUIT (Theodor L17) — the first death is a lie', () => {
  /** A gun line heavy enough to actually kill 15,493 hp through 47% mitigation. */
  const scenario = () => { resetIds(); return base([
    b(BuildingType.Keep, 14, 14, 3, 'keep'),
    ...[10, 12, 14, 16, 18].flatMap((x) => [
      b(BuildingType.LaserTower, x, 10, 20), b(BuildingType.LaserTower, x, 18, 20)]),
  ], 3); };
  const run = (level: number): R => simulateRaid(scenario(), {
    ...orders([]), heroDeploys: [drop('theodor', 0, 14, level)],
  }, 42);

  it('L16 dies once and stays dead', () => {
    expect(fired(run(16), 'rageQuit')).toBe(false);
  });

  it('L17 flops, is untargetable for 3s, then gets up with an AoE stun', () => {
    const r = run(17);
    const id = heroIdOf(r, 'theodor');
    const proc = skillEvents(r, 'rageQuit');
    const wake = skillEvents(r, 'rageQuitWake');
    expect(proc).toHaveLength(1); // ONCE PER BATTLE — the second death is real
    expect(wake).toHaveLength(1);

    const s = HERO_SKILLS.theodor.rageQuit;
    // The wake lands exactly when the untargetable window closes.
    expect(wake[0]!.t).toBe(proc[0]!.t + s.untargetableSec * 10);
    // He was NOT killed at the proc …
    const deaths = r.events.filter((e) => e.e === 'troopDeath' && e.id === id) as Array<{ t: number }>;
    expect(deaths.every((d) => d.t > proc[0]!.t)).toBe(true);
    // … and nothing could touch him while he lay there.
    expect(troopHits(r, id).filter((h) => h.t > proc[0]!.t && h.t < wake[0]!.t)).toHaveLength(0);

    // UNTARGETABLE, not merely invulnerable: "defences must re-acquire" (the
    // integration note). While he plays dead not one gun even AIMS at him — and
    // they certainly were before, so the quiet window is the skill and not an
    // accident of the scenario.
    const aimedAtHim = (from: number, to: number) => r.events.filter((e) => e.e === 'fire'
      && (e as { target: number }).target === id && e.t > from && e.t < to);
    expect(aimedAtHim(-1, proc[0]!.t).length).toBeGreaterThan(0);
    expect(aimedAtHim(proc[0]!.t, wake[0]!.t)).toHaveLength(0);
    // He is up again afterwards: the guns find him and the hits resume.
    expect(troopHits(r, id).some((h) => h.t >= wake[0]!.t)).toBe(true);
  });

  it('the fake death is what buys him the extra life — A/B at the same level', () => {
    const withIt = run(17);
    const withoutIt = without('theodor', 'rageQuit', () => run(17));
    const id = heroIdOf(withIt, 'theodor');
    const deathTick = (r: R) =>
      (r.events.find((e) => e.e === 'troopDeath' && e.id === id) as { t: number } | undefined)?.t ?? Infinity;
    expect(deathTick(withIt)).toBeGreaterThan(deathTick(withoutIt));
  });
});

// ---------------------------------------------------------------------------
// 2. VEX
// ---------------------------------------------------------------------------
describe('MOONSUNDER WAVE (Vex L6) — a stationary crescent that pierces', () => {
  /** Three buildings in a line east of the drop, so "pierces everything" has
   *  something to pierce and the wave's reach past the first is visible. */
  const scenario = () => { resetIds(); return base([
    b(BuildingType.Cannon, 8, 14, 3, 'near'),
    b(BuildingType.Vault, 10, 14, 3, 'mid'),
    b(BuildingType.Keep, 12, 14, 3, 'far'),
  ], 3); };
  const run = (level: number): R => simulateRaid(scenario(), {
    ...orders([]), heroDeploys: [drop('vex', 0, 14, level)],
  }, 42);

  it('unlocks at the first non-zero tier boundary, never one paid level early', () => {
    expect(HERO_SKILLS.vex.moonsunderWave.unlockLevel).toBe(6);
    expect(HERO_SKILLS.vex.moonsunderWave.waveDmgPctDps[0]).toBe(0);
    expect(fired(run(4), 'moonsunderWave')).toBe(false);
    expect(fired(run(5), 'moonsunderWave')).toBe(false);
    expect(fired(run(6), 'moonsunderWave')).toBe(true);
  });

  it('cuts through several buildings at once for exactly 150% DPS', () => {
    const r = run(6);
    const wave = skillEvents(r, 'moonsunderWave')[0]!;
    const dps = HERO_LEVELING.dps.vex[5]!;
    const expected = Math.round(Math.floor((dps * HERO_SKILLS.vex.moonsunderWave.waveDmgPctDps[1]!) / 100) / 10);
    const struck = new Set((r.events.filter((e) => e.e === 'hit' && e.t === wave.t
      && (e as { dmg: number }).dmg === expected) as Array<{ target: string }>).map((h) => h.target));
    expect(struck.size).toBeGreaterThanOrEqual(2); // it pierced past the first
  });
});

describe('DEGEN AWAKENING (Vex L11) — the self-buff, and what it unlocks', () => {
  const scenario = () => { resetIds(); return base([
    b(BuildingType.Keep, 14, 14, 5, 'keep'),
    b(BuildingType.Cannon, 12, 14, 5, 'cannon'),
    b(BuildingType.Vault, 16, 14, 5, 'vault'),
  ], 3); };
  const run = (level: number): R => simulateRaid(scenario(), {
    ...orders([]), heroDeploys: [drop('vex', 0, 14, level)],
  }, 42);

  it('unlocks at the first non-zero tier boundary', () => {
    const d = HERO_SKILLS.vex.degenAwakening;
    expect(d.unlockLevel).toBe(11);
    expect([d.dmgPct[1], d.atkSpeedPct[1], d.lifestealPct[1]]).toEqual([0, 0, 0]);
    expect(fired(run(10), 'degenAwakening')).toBe(false);
    expect(fired(run(11), 'degenAwakening')).toBe(true);
  });

  it('an awakened Vex hits measurably harder — A/B at the same level', () => {
    // Same hero, same level, same seed: the ONLY difference is the buff. Ticks to
    // finish the base is a clean readout of damage per tick.
    const withIt = run(11);
    const withoutIt = without('vex', 'degenAwakening', () => run(11));
    expect(withIt.destructionPct).toBe(100);
    expect(withoutIt.destructionPct).toBe(100);
    expect(withIt.ticks).toBeLessThan(withoutIt.ticks);
  });
});

describe('DOUBLE OR NOTHING (Vex L16) — the coin', () => {
  const scenario = () => { resetIds(); return base([
    b(BuildingType.Keep, 14, 14, 3, 'keep'),
    ...[10, 12, 14, 16, 18].flatMap((x) => [
      b(BuildingType.LaserTower, x, 10, 20), b(BuildingType.LaserTower, x, 18, 20)]),
  ], 3); };
  const run = (level: number, seed: number): R => simulateRaid(scenario(), {
    ...orders([]), heroDeploys: [drop('vex', 0, 14, level)],
  }, seed);
  const faces = (r: R): string[] => r.events
    .filter((e) => e.e === 'heroSkill' && String((e as { skill: string }).skill).startsWith('doubleOrNothing'))
    .map((e) => (e as { skill: string }).skill);

  it('unlocks at the first non-zero tier boundary', () => {
    expect(HERO_SKILLS.vex.doubleOrNothing.unlockLevel).toBe(16);
    expect(HERO_SKILLS.vex.doubleOrNothing.reviveHpPct[2]).toBe(0);
    expect(faces(run(15, 42))).toHaveLength(0);
    expect(faces(run(16, 42))).toHaveLength(1);
  });

  it('the coin is a coin: seeds land on both faces, and each face means what it says', () => {
    // Tails — he stays down, and the outcome is reported so the server can comp
    // half his regen timer (`tailsRegenRefundPct`; no downed-hero state exists
    // server-side yet, so reporting it is the sim's whole job here).
    const tails = run(16, 42);
    expect(faces(tails)).toEqual(['doubleOrNothingTails']);
    const tailsId = heroIdOf(tails, 'vex');
    const coinT = skillEvents(tails, 'doubleOrNothingTails')[0]!;
    expect(tails.events.some((e) => e.e === 'troopDeath' && e.id === tailsId && e.t === coinT.t)).toBe(true);

    // Heads — back on his feet, and untouchable for the stated second.
    const heads = run(16, 2);
    expect(faces(heads)).toEqual(['doubleOrNothingHeads']);
    const headsId = heroIdOf(heads, 'vex');
    const coinH = skillEvents(heads, 'doubleOrNothingHeads')[0]!;
    expect(heads.events.some((e) => e.e === 'troopDeath' && e.id === headsId && e.t === coinH.t)).toBe(false);
    const immune = HERO_SKILLS.vex.doubleOrNothing.immuneSec * 10;
    expect(troopHits(heads, headsId).filter((h) => h.t > coinH.t && h.t < coinH.t + immune)).toHaveLength(0);
  });

  it('the coin does NOT re-phase the defense-damage stream (why it has its own rng)', () => {
    // THE determinism hazard in the whole kit. Drawing the coin from the shared
    // `rng` would shift every subsequent jitter roll, so a hero's coin would
    // retro-actively change unrelated damage numbers in the same battle. Proof:
    // with the skill switched off, every event BEFORE the coin is byte-identical
    // — the extra draw perturbed nothing.
    const withIt = run(16, 42);
    const withoutIt = without('vex', 'doubleOrNothing', () => run(16, 42));
    const coin = skillEvents(withIt, 'doubleOrNothingTails')[0]!;
    expect(JSON.stringify(withIt.events.filter((e) => e.t < coin.t)))
      .toBe(JSON.stringify(withoutIt.events.filter((e) => e.t < coin.t)));
  });
});

describe('ALL IN: OMEGA SHARDSTORM (Vex L20) — nova plus eight crescents', () => {
  const scenario = () => { resetIds(); return base([
    b(BuildingType.Keep, 14, 14, 5, 'keep'),
    b(BuildingType.Cannon, 12, 14, 5, 'cannon'),
    b(BuildingType.Vault, 16, 14, 5, 'vault'),
    b(BuildingType.Mine, 14, 16, 5, 'mine'),
  ], 3); };
  const run = (level: number): R => simulateRaid(scenario(), {
    ...orders([]), heroDeploys: [drop('vex', 0, 14, level)],
  }, 42);

  it('L19 never gets it; L20 fires it exactly once', () => {
    expect(fired(run(19), 'omegaShardstorm')).toBe(false);
    expect(skillEvents(run(20), 'omegaShardstorm')).toHaveLength(1);
  });

  it('AWAKENED ONLY is a real gate — no Degen Awakening, no ultimate', () => {
    expect(fired(without('vex', 'degenAwakening', () => run(20)), 'omegaShardstorm')).toBe(false);
  });

  it('lands a 300% nova AND the eight 250% crescents on the same tick', () => {
    const r = run(20);
    const ult = skillEvents(r, 'omegaShardstorm')[0]!;
    const dps = HERO_LEVELING.dps.vex[19]!;
    const nova = Math.round(Math.floor((dps * HERO_SKILLS.vex.omegaShardstorm.novaDmgPctDps[3]!) / 100) / 10);
    const crescent = Math.round(Math.floor((dps * HERO_SKILLS.vex.moonsunderWave.waveDmgPctDps[3]!) / 100) / 10);
    expect(nova).not.toBe(crescent); // the two are distinguishable in the log
    const atTick = r.events.filter((e) => e.e === 'hit' && e.t === ult.t) as Array<{ dmg: number }>;
    expect(atTick.some((h) => h.dmg === nova)).toBe(true);
    expect(atTick.some((h) => h.dmg === crescent)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. DETERMINISM — the hard rule, over the full thirteen-skill surface.
// ---------------------------------------------------------------------------
describe('determinism across the whole kit', () => {
  const bigRaid = (seed: number): R => {
    resetIds();
    const snap = base([
      b(BuildingType.Keep, 14, 14, 5, 'keep'),
      b(BuildingType.DragonNest, 17, 14, 3, 'nest'),
      b(BuildingType.Cannon, 12, 12, 5, 'cannon'),
      b(BuildingType.LaserTower, 12, 16, 5, 'laser'),
      b(BuildingType.Mine, 16, 17, 5, 'mine'),
      b(BuildingType.SpikeTrap, 5, 14, 1, 'trap'),
      ...wallRing(9, 19, 8, 'ring'),
    ], 3);
    return simulateRaid(snap, {
      ...orders([deploy('giant', 0, 9, 0), deploy('bowman', 0, 20, 400)]),
      heroDeploys: [drop('vex', 0, 14, 20), drop('theodor', 0, 15, 20, 200)],
    }, seed, { troopLevels: { giant: 6 } });
  };

  it('two L20 heroes firing all thirteen skills replay bit-identically', () => {
    const a = bigRaid(1234);
    const c = bigRaid(1234);
    expect(JSON.stringify(c.events)).toBe(JSON.stringify(a.events));
    expect(c).toEqual(a);
    // Never vacuous: the run really does exercise the new surface.
    const cast = new Set(a.events.filter((e) => e.e === 'heroSkill').map((e) => (e as { skill: string }).skill));
    expect(cast.size).toBeGreaterThanOrEqual(6);
  });

  it('a different seed still produces a different log (the shared rng still lives)', () => {
    expect(JSON.stringify(bigRaid(1).events)).not.toBe(JSON.stringify(bigRaid(999).events));
  });
});

// ---------------------------------------------------------------------------
// 4. KEG MAGNITUDE IS DATA (the role-leak fix's second half).
// ---------------------------------------------------------------------------
describe('a hero cannot inherit a keg runner\'s BLAST, only its sprite', () => {
  /**
   * `selfDestructs` became behaviour data on 2026-07-29, but the blast SIZE did
   * not: the sim read TROOPS.kegrunner.wallBurst unconditionally and scaled it by
   * `tr.level` — the HERO level for a hero. So a hero declaring the role got a
   * keg runner's 900 wall burst on a hero's curve, which nobody wrote down. The
   * magnitude now travels with the behaviour.
   */
  const withVex = <T>(patch: Partial<typeof HERO_COMBAT.vex>, fn: () => T): T => {
    const orig = HERO_COMBAT.vex;
    HERO_COMBAT.vex = { ...orig, ...patch };
    try { return fn(); } finally { HERO_COMBAT.vex = orig; }
  };
  /** A wall line with a Mine tucked right behind it, so ONE detonation exercises
   *  both halves of the blast: the cross-shaped wall burst and the non-wall
   *  splash. The heroes here stay L1 — a levelled Vex opens the line with Crimson
   *  Dash instead and never reaches a wall to blow up. */
  const scenario = () => { resetIds(); return base([
    b(BuildingType.Keep, 8, 8, 1, 'keep'),
    b(BuildingType.Mine, 5, 8, 1, 'mine'),
    ...Array.from({ length: 14 }, (_, i) => b(BuildingType.Wall, 4, i + 2, 3, `w${i + 2}`)),
  ]); };
  /** Damage the blast itself put into stone — read at the authored contact and
   *  restricted to wall ids, so no other skill's wall damage can be mistaken
   *  for the burst. */
  const burstDealt = (r: R): number[] => {
    const boom = r.events.find((e) => e.e === 'detonate') as { t: number } | undefined;
    if (!boom) return [];
    const run = r.events.find((e) => e.e === 'attackRun' && e.technique === 'detonate') as
      Extract<SimEvent, { e: 'attackRun' }>;
    const impact = run.t + run.impactOffsetsTicks[0]!;
    return (r.events.filter((e) => e.e === 'hit' && e.t === impact
      && String((e as { target: unknown }).target).startsWith('w')) as Array<{ dmg: number }>).map((h) => h.dmg);
  };
  const splashDealt = (r: R): number => {
    const run = r.events.find((e) => e.e === 'attackRun' && e.technique === 'detonate') as
      Extract<SimEvent, { e: 'attackRun' }>;
    const impact = run.t + run.impactOffsetsTicks[0]!;
    return ((r.events.find((e) => e.e === 'hit' && e.t === impact && e.target === 'mine')) as
      { dmg: number }).dmg;
  };
  const bomber = (patch: Partial<typeof HERO_COMBAT.vex>): R =>
    withVex({ donor: 'kegrunner', selfDestructs: true, ...patch }, () =>
      simulateRaid(scenario(), { ...orders([]), heroDeploys: [drop('vex', 0, 8, 1)] }, 42));

  it('a bomber hero with no wallBurst of its own bursts for nothing', () => {
    expect(TROOPS.kegrunner.wallBurst).toBe(900);
    expect(HERO_COMBAT.vex.wallBurst).toBeUndefined();

    // Control: a real L1 keg runner puts its documented 900 into the stone.
    const keg = simulateRaid(scenario(), orders([deploy('kegrunner', 0, 8)]), 42);
    expect(burstDealt(keg)).toContain(900);

    // The hero declares the ROLE but not the NUMBER. It really does detonate
    // (same code path — so this is not passing for the boring reason), and every
    // stone in the cross takes zero. Before this fix it took a keg runner's 900
    // scaled up a HERO's level curve, which nobody had written down.
    const hero = bomber({});
    expect(hero.events.some((e) => e.e === 'detonate')).toBe(true);
    expect(burstDealt(hero).length).toBeGreaterThan(0);
    expect(burstDealt(hero).every((d) => d === 0)).toBe(true);
  });

  it('…and a hero that DECLARES a wallBurst gets its own, so the field is wired', () => {
    expect(burstDealt(bomber({ wallBurst: 900 }))).toContain(900);
  });

  it('the non-wall splash is ONE SECOND of the detonating unit\'s own dps', () => {
    // The other half of the magnitude leak: splash was read off
    // TROOPS.kegrunner.dps too. Vex's dps is nothing like a keg runner's, so the
    // two blasts must differ — and the hero's must be HIS number.
    const keg = simulateRaid(scenario(), orders([deploy('kegrunner', 0, 8)]), 42);
    expect(splashDealt(keg)).toBe(TROOPS.kegrunner.dps);
    expect(splashDealt(bomber({}))).not.toBe(splashDealt(keg));

    // ⚠ SEPARATE, PRE-EXISTING BUG, deliberately pinned rather than fixed here:
    // a hero's `dpsDeci` is HERO_LEVELING.dps × 10, while a TROOP's is the raw
    // dps figure — and the sim treats the field as deci-per-TICK either way
    // (stats.ts: "dps points/sec == deci-points per 100ms tick"). Heroes have
    // therefore been dealing 10× their advertised DPS since D4a, which every
    // "% of DPS" skill number now inherits. Fixing it is a balance change and an
    // owner call; this assertion documents the factor so the fix has a test to
    // flip rather than a silent behaviour swing.
    expect(splashDealt(bomber({}))).toBe(HERO_LEVELING.dps.vex[0]!);
  });
});

// ---------------------------------------------------------------------------
// 5. MUTATION HARDENING (2026-07-29).
//
// An independent audit ran 16 mutants against the suite above and FOURTEEN
// SURVIVED: the skills worked, but almost nothing PINNED them, so any later edit
// could delete an effect in silence. Every test below was written against a
// specific mutation and verified the honest way — apply the mutation, watch this
// test go red, revert, watch it go green. Each one names its mutant.
//
// Two of them use `withSkill` to scale a number the shipped data leaves
// unreachable. That is not a licence to move the goalposts: in both cases the
// EFFECT IS DEAD CODE at the shipped numbers, which is a finding recorded on the
// test itself. The engine wiring is what is being pinned, and the mutation still
// kills the test with the data patched.
// ---------------------------------------------------------------------------

/** Ticks at which building `id` fired, in order. */
const firesOf = (r: R, id: string): number[] =>
  (r.events.filter((e) => e.e === 'fire' && e.id === id) as Array<{ t: number }>).map((f) => f.t);
/** First shot at or after `t` — the readout every stun test uses. */
const firstFireFrom = (r: R, id: string, t: number): number | undefined =>
  firesOf(r, id).find((f) => f >= t);
const spawnsOf = (r: R): Array<{ t: number; id: number }> =>
  r.events.filter((e) => e.e === 'spawn') as never;

describe('MUTANT: SILENT BUT DEADLY — the cloud is deleted', () => {
  /**
   * The nova and the cloud are two different things, and only the cloud LINGERS.
   * A Dragon Nest inside the blast radius keeps posting fresh wyrmlings into the
   * crater long after the bang: each one spawns UNTOUCHED by the nova (it did not
   * exist when the nova fired) and then rots at exactly `cloudDps`. That is the
   * cloud and it cannot be anything else.
   */
  const run = (): R => {
    resetIds();
    return simulateRaid(base([
      b(BuildingType.Keep, 25, 12, 3, 'keep'),
      b(BuildingType.LaserTower, 10, 12, 20, 'gunA'),
      b(BuildingType.DragonNest, 12, 14, 10, 'nest'),
    ], 3), { ...orders([]), heroDeploys: [drop('theodor', 0, 12, 20)] }, 42);
  };

  it('wyrmlings that spawn AFTER the nova still drown in the lingering cloud', () => {
    const r = run();
    const sd = HERO_SKILLS.theodor.silentButDeadly;
    const ult = impactSkillEvents(r, 'silentButDeadly')[0]!;
    const tick = Math.round(sd.cloudDps / 10); // 60 dps = 60 deci/tick → dmg 6
    // Spawned after the nova AND inside the cloud window — the count guard below is
    // what keeps this honest, so narrowing the filter cannot make it vacuous.
    const late = spawnsOf(r).filter((s) => s.t > ult.t && s.t < ult.t + sd.cloudSec * 10);
    expect(late.length).toBeGreaterThanOrEqual(1); // never vacuous

    for (const w of late) {
      const rot = troopHits(r, w.id).filter((h) => h.dmg === tick).map((h) => h.t);
      // 60 hp of wyrmling ÷ 60 dps = one second of cloud, tick by tick, starting
      // the tick after it spawns — and the cloud is what kills it.
      expect(rot).toEqual(Array.from({ length: 10 }, (_, i) => w.t + 1 + i));
      expect(r.events.some((e) => e.e === 'troopDeath' && e.id === w.id && e.t === rot.at(-1))).toBe(true);
    }
  });
});

describe('MUTANT: SILENT BUT DEADLY — the fear is deleted', () => {
  /**
   * FEAR maps to the same stun channel the sim uses everywhere (a defence's own
   * cooldown), so the readable proof is a gun that goes quiet for exactly
   * `fearSec` and not a tick more. `gunB` sits ~4 tiles out: inside the 6-tile
   * nova, OUTSIDE Cheek Quake's 3-tile AoE, and never Snot Rocket's victim
   * (that skill always takes the NEAREST shooter, which is gunA).
   */
  const scene = (): R => {
    resetIds();
    return simulateRaid(base([
      b(BuildingType.Keep, 25, 12, 3, 'keep'),
      b(BuildingType.LaserTower, 10, 12, 20, 'gunA'),
      b(BuildingType.LaserTower, 15, 12, 20, 'gunB'),
    ], 3), { ...orders([]), heroDeploys: [drop('theodor', 0, 12, 20)] }, 42);
  };

  it('every gun in the nova stops shooting for exactly fearSec', () => {
    const sd = HERO_SKILLS.theodor.silentButDeadly;
    const r = scene();
    const ult = impactSkillEvents(r, 'silentButDeadly')[0]!;
    expect(firstFireFrom(r, 'gunB', ult.t)).toBe(ult.t + sd.fearSec * 10);

    // CONTROL — the same battle with the fear switched off in DATA. gunB fires on
    // the ult tick itself, so the silence above is the skill and not a reload.
    const ctrl = withSkill('theodor', 'silentButDeadly', { fearSec: 0 }, scene);
    const u2 = impactSkillEvents(ctrl, 'silentButDeadly')[0]!;
    expect(u2.t).toBe(ult.t);
    expect(firstFireFrom(r, 'gunB', ult.t)!).toBeGreaterThan(firstFireFrom(ctrl, 'gunB', u2.t)!);
  });
});

describe('MUTANT: OMEGA SHARDSTORM — the stun is deleted', () => {
  const scene = (): R => {
    resetIds();
    return simulateRaid(base([
      b(BuildingType.Vault, 10, 14, 5, 'anvil'),
      b(BuildingType.LaserTower, 14, 14, 20, 'gun'),
      b(BuildingType.Keep, 20, 20, 3, 'keep'),
    ], 3), { ...orders([]), heroDeploys: [drop('vex', 0, 14, 20)] }, 42);
  };

  it('the ult silences the guns it catches for its stated 2 seconds', () => {
    const om = HERO_SKILLS.vex.omegaShardstorm;
    const stun = Math.floor((om.stunDeciSec[3]! * 10) / 10); // deci-sec → ticks
    const r = scene();
    const ult = skillEvents(r, 'omegaShardstorm')[0]!;
    expect(firstFireFrom(r, 'gun', ult.t)).toBe(ult.t + stun);
    // The gun was mid-fight, not idle: it had been shooting before the ult.
    expect(firesOf(r, 'gun').some((t) => t < ult.t)).toBe(true);

    // CONTROL — stun row zeroed: it comes back on its own reload, sooner.
    const ctrl = withSkill('vex', 'omegaShardstorm', { stunDeciSec: [0, 0, 0, 0] }, scene);
    const u2 = skillEvents(ctrl, 'omegaShardstorm')[0]!;
    expect(u2.t).toBe(ult.t);
    expect(firstFireFrom(ctrl, 'gun', u2.t)!).toBeLessThan(ult.t + stun);
  });
});

describe('MUTANT: OMEGA SHARDSTORM fires ONE crescent instead of eight', () => {
  /**
   * "Eight crescents" is a radial pattern, so the test is directional: a
   * tier-20 wall ring around the detonation eats crescent damage on EVERY
   * bearing. One crescent (the +x bearing) can only ever mark the eastern arc.
   */
  const run = (): R => {
    resetIds();
    return simulateRaid(base([
      b(BuildingType.Keep, 14, 14, 5, 'keep'),
      ...wallRing(10, 18, 20, 'ring'), // T20 stone: it survives to be counted
    ], 3), { ...orders([]), heroDeploys: [drop('vex', 0, 14, 20)] }, 42);
  };

  it('crescent damage lands on every side of him, not just downrange', () => {
    const r = run();
    const ult = skillEvents(r, 'omegaShardstorm')[0]!;
    const dps = HERO_LEVELING.dps.vex[19]!;
    const crescent = Math.round(Math.floor((dps * HERO_SKILLS.vex.moonsunderWave.waveDmgPctDps[3]!) / 100) / 10);
    const nova = Math.round(Math.floor((dps * HERO_SKILLS.vex.omegaShardstorm.novaDmgPctDps[3]!) / 100) / 10);
    expect(crescent).not.toBe(nova); // the two are separable in the log

    // Ring ids carry their tile, so each hit has a bearing from the hero.
    const struck = (r.events.filter((e) => e.e === 'hit' && e.t === ult.t
      && (e as { dmg: number }).dmg === crescent
      && String(e.target).startsWith('ring')) as Array<{ target: string }>)
      .map((h) => h.target.split('_').slice(1).map(Number) as [number, number]);
    const hx = Math.floor(ult.x / 256), hy = Math.floor(ult.y / 256);
    const octants = new Set(struck.map(([x, y]) => `${Math.sign(x - hx)},${Math.sign(y - hy)}`));

    expect(HERO_SKILLS.vex.omegaShardstorm.crescents[3]).toBe(8);
    expect(struck.length).toBeGreaterThanOrEqual(12);
    expect(octants.size).toBeGreaterThanOrEqual(6);
    // Explicitly: stone opened up north, south, east AND west of him.
    expect(struck.some(([x]) => x > hx)).toBe(true);
    expect(struck.some(([x]) => x < hx)).toBe(true);
    expect(struck.some(([, y]) => y > hy)).toBe(true);
    expect(struck.some(([, y]) => y < hy)).toBe(true);
  });
});

describe('MUTANT: the T4 crescent is forced back to width 1', () => {
  /**
   * The second line is offset half a tile PERPENDICULAR to the sweep, which at
   * this geometry is a whole tile row over. So: a wall line one row south of the
   * hero's lane, nothing at all in the lane itself for six tiles, and a target
   * far past the crescent's reach. A width-1 wave has nothing to cut and
   * `castCrescent` declines outright; the width-2 wave shears the row.
   */
  const run = (level: number): R => {
    resetIds();
    return simulateRaid(base([
      b(BuildingType.Keep, 25, 14, 3, 'keep'), // 25 tiles east: out of wave range
      ...Array.from({ length: 17 }, (_, i) => b(BuildingType.Wall, i + 2, 15, 20, `w15_${i + 2}`)),
    ], 3), { ...orders([]), heroDeploys: [drop('vex', 0, 14, level)] }, 42);
  };

  it('T4 shears the row beside him; T3 cannot reach it at all', () => {
    expect(HERO_SKILLS.vex.moonsunderWave.widthTiles).toEqual([0, 1, 1, 2]);
    const wide = run(16);
    const wave = skillEvents(wide, 'moonsunderWave')[0]!;
    const dps = HERO_LEVELING.dps.vex[15]!;
    const dmg = Math.round(Math.floor((dps * HERO_SKILLS.vex.moonsunderWave.waveDmgPctDps[3]!) / 100) / 10);
    const cut = wide.events.filter((e) => e.e === 'hit' && e.t === wave.t
      && (e as { dmg: number }).dmg === dmg && String(e.target).startsWith('w15_'));
    expect(cut.length).toBeGreaterThanOrEqual(4);
    // He is in row 14 and every single thing he cut is in row 15 — the offset line.
    expect(Math.floor(wave.y / 256)).toBe(14);

    // T3 (width 1) has only the centre line: nothing in row 14 within 6 tiles, so
    // the skill refuses to cast at all rather than swinging at air.
    const narrow = run(11);
    const first = skillEvents(narrow, 'moonsunderWave')[0];
    expect(first === undefined || first.t > wave.t + 100).toBe(true);
  });
});

describe('MUTANT: MOONSUNDER WAVE — the bleed DoT is deleted', () => {
  /**
   * ⚠ FINDING, not a test artefact: with the SHIPPED numbers this bleed can never
   * be observed. It only applies to a DEFENDER troop that SURVIVES the crescent,
   * and the only defender troop is the 60 hp (600 deci) wyrmling. That USED to be
   * unreachable: while heroes ran at 10x their stat the weakest crescent landed
   * 1950 deci and every victim died on impact. With the dps unit fixed (2026-07-29)
   * the same crescent lands 195, so the bleed is reachable in production after all
   * — asserted below. The scaled scenario stays because it pins the wiring
   * (per-tick integer, 4s window, victim-scoped) deterministically.
   */
  it('the bleed is a real per-tick DoT on the victim, not part of the hit', () => {
    const w = HERO_SKILLS.vex.moonsunderWave;
    // The finding itself, asserted so it cannot rot silently:
    const weakest = Math.floor((HERO_LEVELING.dps.vex[5]! * w.waveDmgPctDps[1]!) / 100);
    expect(weakest).toBeLessThan(TROOPS.wyrmling.hp * 10); // survivable → the bleed can be observed

    const bleedPct = 50;
    const r = withSkill('vex', 'moonsunderWave',
      { waveDmgPctDps: [0, 1, 1, 1], bleedPctMaxHpPer4s: [0, bleedPct, bleedPct, bleedPct], cdSec: 1 },
      () => {
        resetIds();
        return simulateRaid(base([
          b(BuildingType.Keep, 25, 12, 3, 'keep'),
          b(BuildingType.DragonNest, 12, 12, 10, 'nest'),
        ], 3), { ...orders([]), heroDeploys: [drop('vex', 0, 12, 11)] }, 42);
      });

    const victim = spawnsOf(r)[0]!;
    const perTick = Math.floor((TROOPS.wyrmling.hp * 10 * bleedPct) / (100 * w.bleedSec * 10));
    expect(perTick).toBeGreaterThan(0);
    const bleedDmg = Math.round(perTick / 10);
    const waveTicks = new Set(skillEvents(r, 'moonsunderWave').map((e) => e.t));
    const bleeds = troopHits(r, victim.id).filter((h) => h.dmg === bleedDmg).map((h) => h.t);
    const firstWaveOnVictim = Math.min(...bleeds);
    expect(waveTicks.has(firstWaveOnVictim)).toBe(true); // it started with a cut

    // It ticks on its own afterwards — on ticks where NO wave was cast, which is
    // the whole claim: the damage lingers on the victim rather than being part of
    // the swing. Ten quiet ticks is far more than a stray coincidence.
    const quiet = bleeds.filter((t) => !waveTicks.has(t));
    expect(quiet.length).toBeGreaterThanOrEqual(10);
    expect(quiet.every((t) => t <= firstWaveOnVictim + w.bleedSec * 10)).toBe(true);
  });
});

describe('MUTANT: BROWN NOTE — the gas zone is deleted', () => {
  /**
   * ⚠ FINDING, same shape as the bleed: `gasRadiusTiles` is 1 (an ⚠ ALPHA number
   * that is NOT in the spec), and the only troops the gas may damage are
   * wyrmlings, which hover at their own 2-tile attack range. A zone centred on
   * the hole the hero is standing in can therefore never reach them except in
   * transit. The radius is widened here to make the zone observable at all; the
   * dps, the duration and the fact that the zone exists are what is pinned.
   */
  it('the hole keeps poisoning what walks through it, tick by tick', () => {
    const bn = HERO_SKILLS.theodor.brownNote;
    const r = withSkill('theodor', 'brownNote', { gasRadiusTiles: 3 }, () => {
      resetIds();
      return simulateRaid(base([
        b(BuildingType.DragonNest, 14, 14, 10, 'nest'), // 8 tiles in: past his leap
        ...wallRing(6, 22, 20, 'ring'),
      ], 3), { ...orders([]), heroDeploys: [drop('theodor', 0, 14, 20)] }, 42);
    });
    const note = skillEvents(r, 'brownNote')[0]!;
    const dmg = Math.round(bn.gasDps / 10);
    const gassed = spawnsOf(r).flatMap((victim) =>
      troopHits(r, victim.id).filter((h) => h.dmg === dmg).map((h) => h.t));
    expect(gassed.length).toBeGreaterThanOrEqual(10);
    // Inside the stated window, and never before the note opened the wall.
    expect(Math.min(...gassed)).toBeGreaterThanOrEqual(note.t);
    expect(Math.max(...gassed)).toBeLessThan(note.t + bn.gasSec[3]! * 10);
  });
});

describe('MUTANT: RAGE QUIT — the wake-up stun is deleted', () => {
  /**
   * The wake stun and Cheek Quake share a radius AND a tick: three seconds of
   * playing dead is long enough for the Quake to come off cooldown, so it casts
   * the instant he stands up and its longer stun hides the wake's entirely.
   * Cheek Quake's stun row is therefore zeroed in BOTH arms — the confound is
   * pushed out of the way, nothing else is touched.
   */
  const scene = (): R => {
    resetIds();
    return simulateRaid(base([
      b(BuildingType.Keep, 14, 14, 3, 'keep'),
      ...[10, 12, 14, 16, 18].flatMap((x) => [
        b(BuildingType.LaserTower, x, 10, 20, `n${x}`), b(BuildingType.LaserTower, x, 18, 20, `s${x}`)]),
    ], 3), { ...orders([]), heroDeploys: [drop('theodor', 0, 14, 17)] }, 42);
  };
  const quiet = <T>(fn: () => T): T =>
    withSkill('theodor', 'cheekQuake', { stunDeciSec: [0, 0, 0, 0] }, fn);

  it('he gets up INTO the guns and they eat a 1s stun', () => {
    const rq = HERO_SKILLS.theodor.rageQuit;
    const r = quiet(scene);
    const wake = skillEvents(r, 'rageQuitWake')[0]!;
    // Guns inside the stated stun radius of where he wakes — DERIVED from the wake
    // event, not hard-coded. Where he collapses depends on how fast he is killing
    // the battery, so the correct hero-dps fix (2026-07-29) moved him and the
    // hard-coded pair fell out of radius, failing a stun that was working fine.
    const guns = [10, 12, 14, 16, 18].flatMap((x) => [
      { id: `n${x}`, tx: x, ty: 10 }, { id: `s${x}`, tx: x, ty: 18 },
    ]);
    const { fw, fh } = footprintOf(BuildingType.LaserTower);
    const rad2 = (rq.wakeStunRadiusTiles * 256) ** 2;
    const near = guns.filter((g) => {
      const cx = g.tx * 256 + 128 + ((fw - 1) * 256) / 2;
      const cy = g.ty * 256 + 128 + ((fh - 1) * 256) / 2;
      return (cx - wake.x) ** 2 + (cy - wake.y) ** 2 <= rad2;
    }).map((g) => g.id);
    expect(near.length).toBeGreaterThan(0); // never vacuous
    // The claim is SILENCE for the stun window. Asserting a shot on the exact tick
    // the stun lifts is a stronger claim than the skill makes — it also requires the
    // gun's own reload to be ready and Theodor to still be in its arc — and it broke
    // for that reason, not because the stun failed.
    const stunTicks = rq.wakeStunSec * 10;
    for (const id of near) {
      const during = firesOf(r, id).filter((f) => f >= wake.t && f < wake.t + stunTicks);
      expect(during).toHaveLength(0);
    }

    // CONTROL — wake stun zeroed: a gun in that same radius fires on the wake tick
    // itself, because an untargetable body is the only reason they were quiet
    // before it. Without this the silence above could just be nobody in range.
    const ctrl = quiet(() => withSkill('theodor', 'rageQuit', { wakeStunSec: 0 }, scene));
    const w2 = skillEvents(ctrl, 'rageQuitWake')[0]!;
    expect(w2.t).toBe(wake.t);
    expect(near.some((id) => firstFireFrom(ctrl, id, w2.t) === w2.t)).toBe(true);
  });
});

describe('MUTANT: DEGEN AWAKENING — the lifesteal is zeroed', () => {
  /**
   * Lifesteal is invisible in the event log (the sim emits no `heal`), so the
   * only honest readout is the OUTCOME. Tuned to the knife edge: two lasers
   * out-damage an awakened Vex by a hair, and the 20% he drinks back is the
   * whole difference between a razed base and a corpse. The level moved L12 → L8
   * when hero dps was corrected (2026-07-29): lifesteal is a cut of damage DEALT,
   * so a 10x smaller hero heals 10x less and the edge sits 4 levels lower.
   */
  const scene = (): R => {
    resetIds();
    return simulateRaid(base([
      b(BuildingType.Keep, 14, 14, 12, 'keep'),
      b(BuildingType.LaserTower, 10, 10, 8, 'g0'),
      b(BuildingType.LaserTower, 11, 10, 8, 'g1'),
    ], 3), { ...orders([]), heroDeploys: [drop('vex', 0, 14, 11)] }, 42);
  };

  it('the drinking is what keeps him standing — A/B on the lifesteal row alone', () => {
    expect(HERO_SKILLS.vex.degenAwakening.lifestealPct[2]).toBeGreaterThan(0);
    const drinking = scene();
    const dry = withSkill('vex', 'degenAwakening', { lifestealPct: [0, 0, 0, 0] }, scene);

    const died = (r: R): boolean => r.events.some((e) => e.e === 'troopDeath' && e.id === heroIdOf(r, 'vex'));
    expect(died(drinking)).toBe(false);
    expect(drinking.destructionPct).toBe(100);
    // Without it the SAME hero, at the SAME level, under the SAME guns, dies with
    // the base barely scratched.
    expect(died(dry)).toBe(true);
    expect(dry.destructionPct).toBeLessThan(50);
  });
});

describe('MUTANT: the play-dead guard is removed from the trap pass', () => {
  /**
   * "A body playing dead sets nothing off." Reproducing that needs a hero who is
   * untargetable while STANDING ON armed traps, which the sim only ever produces
   * one way: he must die ON the tile, in the tick the traps go off. So the tile
   * carries twenty of them. Sixteen kill him (38,650 deci of hero ÷ 2,500 a
   * trap), the coin comes up heads, and the remaining four are looking at an
   * untargetable body — they hold their charge until the immunity lapses.
   *
   * Without the guard all twenty would burn in that one tick, on a corpse, for
   * nothing: free trap-clearing for any hero with a death-cheat.
   */
  it('the traps under a downed hero hold their charge until he is up again', () => {
    resetIds();
    const r = simulateRaid(base([
      b(BuildingType.Keep, 25, 10, 3, 'keep'),
      ...Array.from({ length: 20 }, (_, i) => b(BuildingType.SpikeTrap, 10, 10, 1, `trap${i}`)),
    ], 3), { ...orders([]), heroDeploys: [drop('vex', 0, 10, 16)] }, 2);

    const hp = HERO_LEVELING.hp.vex[15]! * 10;
    const lethal = Math.ceil(hp / TRAP_BURST_DECI);
    expect(lethal).toBe(16); // why the split below falls where it does

    const coin = skillEvents(r, 'doubleOrNothingHeads')[0]!;
    const traps = r.events.filter((e) => e.e === 'trap') as Array<{ t: number }>;
    const immune = HERO_SKILLS.vex.doubleOrNothing.immuneSec * 10;
    expect(traps).toHaveLength(20);
    expect(traps.filter((t) => t.t === coin.t)).toHaveLength(lethal);
    expect(traps.filter((t) => t.t === coin.t + immune)).toHaveLength(20 - lethal);
    // And nothing touched him while he was down: the four that waited did no
    // damage in the window either.
    expect(troopHits(r, heroIdOf(r, 'vex')).filter((h) => h.t > coin.t && h.t < coin.t + immune))
      .toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. CROSS-HERO PASSIVE LEAK — one instance, and the class.
// ---------------------------------------------------------------------------
describe('MUTANT: `mitigate` gates on !tr.hero — Vex inherits Theodor\'s armour', () => {
  /**
   * sim.ts's `mitigate` is Theodor's, and ONLY Theodor's: SKILL ISSUE and BELLY
   * BOUNCE are his passives. Widening the guard from `tr.hero !== 'theodor'` to
   * `!tr.hero` hands Vex 20-40% damage reduction he never bought — and it moved
   * the event fingerprint of 10 of 12 probe raids without failing one test.
   *
   * The spike trap is the sim's one jitter-free damage source, so Vex's number is
   * exact at every level: 250, always, because he has no mitigation at all.
   */
  const trapRun = (level: number): R => {
    resetIds();
    return simulateRaid(base([
      b(BuildingType.Keep, 25, 10, 3, 'keep'),
      b(BuildingType.SpikeTrap, 10, 10, 1, 'trap'), // past his opening dash
    ], 3), { ...orders([]), heroDeploys: [drop('vex', 0, 10, level)] }, 42);
  };

  it.each([1, 8, 11, 16, 20])('a level-%i Vex takes the trap RAW', (level) => {
    const r = trapRun(level);
    expect(r.events.some((e) => e.e === 'trap')).toBe(true); // never vacuous
    const first = troopHits(r, heroIdOf(r, 'vex'))[0]!;
    expect(first.dmg).toBe(Math.round(TRAP_BURST_DECI / 10)); // 250, unreduced
    // What Theodor would have taken at the same level, for contrast — if Vex ever
    // reads these rows, one of these is the number that shows up instead.
    const i = heroTier(level) - 1;
    const si = HERO_SKILLS.theodor.skillIssue;
    if (level >= si.unlockLevel) {
      expect(first.dmg).not.toBe(
        Math.round(Math.floor((TRAP_BURST_DECI * (100 - si.dmgTakenReductionPct[i]!)) / 100) / 10));
    }
  });
});

describe('a hero can never read the OTHER hero\'s numbers (the whole leak class)', () => {
  /**
   * The `mitigate` leak is one instance of a class the project has already been
   * bitten by twice (Theodor chewing walls on the giant's role; the keg runner's
   * blast on a hero's curve). The generic statement is: Vex's battle must not
   * depend on ANY number in Theodor's kit, and vice versa.
   *
   * So: shift every number in the other hero's skill table and demand a
   * BYTE-IDENTICAL replay. Unlock levels, radii, percents, durations — all of
   * them. Any code path that reaches across heroes changes something, and the
   * fingerprint says so, whichever field it was. This is the behavioural twin of
   * the `tr.type ===` source guard in banned-tokens.test.ts.
   */
  const mangleValue = (v: unknown): unknown => {
    if (typeof v === 'number') return v + 7;
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'number' ? x + 7 : x));
    return v;
  };
  const withForeignKitShifted = <T>(hero: HeroKey, fn: () => T): T => {
    const table = HERO_SKILLS[hero] as unknown as Record<string, Record<string, unknown>>;
    const orig = { ...table };
    for (const [name, skill] of Object.entries(orig)) {
      table[name] = Object.fromEntries(Object.entries(skill).map(([f, v]) => [f, mangleValue(v)]));
    }
    try { return fn(); } finally { for (const [name, skill] of Object.entries(orig)) table[name] = skill; }
  };

  /** One hero, alone, at L20, in a base built to make him use everything and to
   *  hurt him while he does it (traps + guns + stone → mitigation, walls, DoTs). */
  const solo = (hero: HeroKey): R => {
    resetIds();
    return simulateRaid(base([
      b(BuildingType.Keep, 14, 14, 5, 'keep'),
      b(BuildingType.Cannon, 12, 12, 8, 'cannon'),
      b(BuildingType.LaserTower, 16, 16, 8, 'laser'),
      b(BuildingType.DragonNest, 12, 16, 6, 'nest'),
      b(BuildingType.SpikeTrap, 5, 14, 1, 'trap'),
      ...wallRing(9, 19, 6, 'ring'),
    ], 3), { ...orders([]), heroDeploys: [drop(hero, 0, 14, 20)] }, 42);
  };

  it.each([['vex', 'theodor'], ['theodor', 'vex']] as Array<[HeroKey, HeroKey]>)(
    '%s replays identically when every number in %s\'s kit moves', (mine, foreign) => {
      const before = solo(mine);
      const after = withForeignKitShifted(foreign, () => solo(mine));
      // Never vacuous: the raid really does exercise the hero's own kit.
      const cast = new Set(before.events.filter((e) => e.e === 'heroSkill').map((e) => (e as { skill: string }).skill));
      expect(cast.size).toBeGreaterThanOrEqual(4);
      expect(before.events.some((e) => e.e === 'hit' && e.target === heroIdOf(before, mine))).toBe(true);
      expect(JSON.stringify(after.events)).toBe(JSON.stringify(before.events));
      expect(after).toEqual(before);
    });
});

/*
 * M09 (damageTroop's damage CLAMP) REMAINS UNPINNED, deliberately and honestly.
 * Two independent audits could not kill it: its only consumer is lifesteal, and
 * the melee-hero-vs-defender-troop path is near-unreachable at shipped values
 * (an awakened Vex would have to melee a range-2 FLYING wyrmling, the only
 * defender troop in the game). I wrote the scenario, ran it, and it produced
 * zero troop hits — so a test asserting on them would have been vacuous, which
 * is worse than no test.
 *
 * What DID land: lifesteal now emits a heal event. That is the missing
 * observable, and it is what makes the clamp assertable the moment the path
 * becomes reachable — e.g. when defender HEROES land and a melee hero finally
 * has a ground target worth hitting. Revisit then.
 */

/*
 * ATTACKER-SIDE STUN (audit M18) is now honoured — `stunUntil` is read once, in
 * pass 3, for both sides. It is deliberately NOT unit-tested here, because there
 * is currently NO production path that stuns an attacker: Cheek Quake, Silent
 * But Deadly and Omega all filter to defender troops. Testing it today would
 * mean inventing a state-injection seam into a pure simulator purely to observe
 * a field, which is a worse trade than waiting.
 *
 * The path arrives with DEFENDER HEROES: a defending Theodor stuns ATTACKER
 * troops, and that is precisely the case that would have silently done nothing
 * under the old defender-only read. docs/HERO-DEFENCE-PLAN.md carries this as a
 * REQUIRED test for that work ("stun is not a delete", both directions).
 */
