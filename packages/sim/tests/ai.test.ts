import { describe, expect, it } from 'vitest';
import {
  BuildingType, DEFENSES, GEAR_MODIFIER_STATS, HERO_COMBAT, HERO_LEVELING, HERO_SKILLS,
  INVENTORY, RAID_RULES, TROOPS, TROOP_ABILITIES, authoredAttackTiming,
  type HeroCombatLoadout, type HeroCombatModifiers,
} from '@shardkeep/shared';
import { roleOf, simulateRaid } from '../src/sim';
import { costField, WALL_COST } from '../src/path';
import { unitToTile } from '../src/fixed';
import type { SimEvent } from '../src/types';
import { TICKS_PER_SEC, buildingMaxHp, defenseCombat, footprintOf, reachFor, troopCombat } from '../src/stats';
import {
  b, base, deploy, fnv1a, orders, resetIds, wallLine, wallRing, withoutHeroSwingHits,
} from './helpers';

describe('troop AI contracts (GDD §3.2)', () => {
  it('keg runner detonates the wall that opens the path; the wall falls', () => {
    const snap = base([
      b(BuildingType.Keep, 8, 8, 1, 'keep'),
      ...wallLine(4, 2, 15, 1),
    ]);
    const r = simulateRaid(snap, orders([deploy('kegrunner', 0, 8)]), 42);
    const det = r.events.find((e) => e.e === 'detonate');
    expect(det).toBeDefined();
    const destroyedWalls = r.events.filter(
      (e) => e.e === 'destroyed' && String(e.id).startsWith('wall'),
    );
    expect(destroyedWalls.length).toBeGreaterThanOrEqual(1);
    // t1 wall (300 hp) one-shot by the 900 burst
    expect(r.events.some((e) => e.e === 'troopDeath' && e.id === 0)).toBe(true); // self-destructs
  });

  it('emits approach keyframes so replay art reaches the authoritative detonation point', () => {
    // WHY: Keg Runner had a dedicated movement branch that updated simulation
    // coordinates without emitting `pos`. Its wall damage was correct, while
    // the client showed it running and exploding forever at the deploy tile.
    const snap = base([
      b(BuildingType.Keep, 8, 8, 1, 'keep'),
      ...wallLine(4, 2, 15, 1),
    ]);
    const r = simulateRaid(snap, orders([deploy('kegrunner', 0, 8)]), 42);
    const det = r.events.find((e) => e.e === 'detonate');
    const pos = r.events.filter((e) => e.e === 'pos' && e.id === 0);

    expect(det).toBeDefined();
    expect(pos.length).toBeGreaterThan(0);
    expect(pos.every((e) => e.t % 5 === 0)).toBe(true);
    const distanceSq = (e: Extract<SimEvent, { e: 'pos' | 'detonate' }>) =>
      (e.x - det!.x) ** 2 + (e.y - det!.y) ** 2;
    expect(distanceSq(pos.at(-1)!)).toBeLessThan(distanceSq(pos[0]!));
    expect(pos.at(-1)!.t).toBeLessThanOrEqual(det!.t);
    expect(det!.t - pos.at(-1)!.t).toBeLessThan(5);
  });

  it('keg runner + powder charge one-shots a t3 wall', () => {
    const snap = base([
      b(BuildingType.Keep, 8, 8, 1, 'keep'),
      ...wallLine(4, 2, 15, 3), // t3: 1200 hp; 900 < 1200 but 900*1.6 = 1440 ≥ 1200
    ]);
    const r = simulateRaid(snap, orders([deploy('kegrunner', 0, 8)], { buffs: { powdercharge: true } }), 42);
    expect(r.events.some((e) => e.e === 'destroyed' && String(e.id).startsWith('wall'))).toBe(true);
  });

  it('tunneler burrows under walls, never damages them, and hits the building inside', () => {
    const snap = base([
      b(BuildingType.Keep, 8, 8, 1, 'keep'),
      ...wallLine(4, 2, 15, 1),
    ]);
    const r = simulateRaid(snap, orders([deploy('tunneler', 0, 8)]), 42);
    expect(r.events.some((e) => e.e === 'burrow')).toBe(true);
    expect(r.events.some((e) => e.e === 'emerge')).toBe(true);
    for (const out of r.buildings) {
      if (out.type === BuildingType.Wall) expect(out.hp).toBe(out.maxHp);
    }
    const keep = r.buildings.find((x) => x.id === 'keep')!;
    expect(keep.hp).toBeLessThan(keep.maxHp);
  });

  it('tunneler replay keyframes travel underground and pin its exact emerge point', () => {
    // WHY: authoritative coordinates moved under the wall, but the replay got no
    // positions between burrow/emerge and surfaced the authored body at wall entry.
    // The final point is deliberately immediate (even off cadence), so emerge can
    // never render up to four simulation ticks behind.
    const r = simulateRaid(base([
      b(BuildingType.Keep, 8, 8, 1, 'keep'),
      ...wallLine(4, 2, 15, 1),
    ]), orders([deploy('tunneler', 0, 8)]), 42);
    const burrow = r.events.findIndex((e) => e.e === 'burrow' && e.id === 0);
    const emerge = r.events.findIndex((e) => e.e === 'emerge' && e.id === 0);
    const underground = r.events
      .map((event, index) => ({ event, index }))
      .filter(({ event, index }) => event.e === 'pos' && event.id === 0 && burrow < index && index < emerge);

    expect(burrow).toBeGreaterThanOrEqual(0);
    expect(emerge).toBeGreaterThan(burrow);
    expect(underground.length).toBeGreaterThan(0);
    expect(underground.slice(0, -1).every(({ event }) => event.t % 5 === 0)).toBe(true);
    const terminal = underground.at(-1)!;
    const surface = r.events[emerge]!;
    expect(terminal.index).toBe(emerge - 1); // authoritative position immediately precedes emerge
    expect(terminal.event.t).toBe(surface.t);
    expect(surface).toMatchObject({ e: 'emerge', x: terminal.event.x, y: terminal.event.y });
    expect(r.events.filter((e) => e.e === 'pos' && e.id === 0 && e.t === terminal.event.t)).toHaveLength(1);
    expect(new Set(underground.map(({ event }) => `${event.x},${event.y}`)).size).toBeGreaterThan(1);
  });

  it('plunderer goes for the vault past a closer building', () => {
    const snap = base([
      b(BuildingType.Keep, 4, 8, 1, 'keep'),   // closer to the deploy point
      b(BuildingType.Vault, 12, 8, 1, 'vault'), // farther, but the plunderer wants it
    ]);
    const r = simulateRaid(snap, orders([deploy('plunderer', 0, 8)]), 42);
    // resources-first: the farther vault falls BEFORE the closer keep takes its first loss
    const destroyedOrder = r.events.filter((e) => e.e === 'destroyed').map((e) => e.id);
    expect(destroyedOrder.indexOf('vault')).toBeGreaterThanOrEqual(0);
    if (destroyedOrder.includes('keep')) {
      expect(destroyedOrder.indexOf('vault')).toBeLessThan(destroyedOrder.indexOf('keep'));
    }
  });

  it('tur rider attacks defenses before other buildings', () => {
    const snap = base([
      b(BuildingType.Vault, 4, 8, 1, 'vault'),    // closer non-defense
      b(BuildingType.Cannon, 12, 8, 1, 'cannon'), // farther defense
    ]);
    const r = simulateRaid(snap, orders([deploy('turrider', 0, 8)]), 42);
    const cannon = r.buildings.find((x) => x.id === 'cannon')!;
    expect(cannon.hp).toBeLessThan(cannon.maxHp);
  });

  it('mortar never fires inside its dead zone', () => {
    // Mortar footprint corner at the claim corner: the deploy tile next to it
    // is already within the 2-tile dead zone, and stays there all the way in.
    const snap = base([b(BuildingType.Mortar, 2, 2, 1, 'mortar')]);
    const r = simulateRaid(snap, orders([deploy('highlander', 1, 2)]), 42);
    expect(r.events.filter((e) => e.e === 'fire')).toHaveLength(0);
    expect(r.destructionPct).toBe(100); // troop demolished it unopposed
  });

  it('a spike trap triggers exactly once, on the first troop', () => {
    const snap = base([
      b(BuildingType.Keep, 8, 8, 1, 'keep'),
      b(BuildingType.SpikeTrap, 3, 8, 1, 'trap'),
    ]);
    const r = simulateRaid(
      snap,
      orders([deploy('highlander', 0, 8, 0), deploy('highlander', 0, 8, 2000)]),
      42,
    );
    const traps = r.events.filter((e) => e.e === 'trap');
    expect(traps).toHaveLength(1);
    expect(traps[0]).toMatchObject({ victim: 0 });
    // 250 burst kills a 120hp highlander: victim dies, second troop survives the trap tile
    expect(r.events.some((e) => e.e === 'troopDeath' && e.id === 0)).toBe(true);
    expect(r.events.some((e) => e.e === 'troopDeath' && e.id === 1)).toBe(false);
  });

  it('a ranged troop in reach shoots THROUGH a wall and never damages it', () => {
    // Owner behavior table 2026-07-26 rule 4, LOCKING BEHAVIOUR THAT ALREADY HOLDS:
    // there is no line-of-sight model, so a wall between a ranged troop and its
    // target does not stop the shot, and a troop that is already in range never
    // steps into the wall (the in-range branch precedes movement). Bowman range 3.5
    // tiles = 896 units; from tile 2 the keep's rect edge at tile 5 is 640 units
    // away, so it fires from spawn without moving.
    // ⚠ This does NOT cover the case the owner actually reported — a bowman whose
    // target is OUT of range behind a wall still walks up and chews it, because
    // approaching is the only way to get in range. Giving it something better to do
    // (path to an opening / follow a tank) is B1/B3, not B2.
    const snap = base([
      b(BuildingType.Keep, 5, 8, 1, 'keep'),
      ...wallLine(4, 2, 15, 1),
    ]);
    const r = simulateRaid(snap, orders([deploy('bowman', 2, 8)]), 42);
    const keep = r.buildings.find((x) => x.id === 'keep')!;
    expect(keep.hp).toBeLessThan(keep.maxHp); // it shot the keep…
    for (const out of r.buildings) {
      if (out.type === BuildingType.Wall) expect(out.hp).toBe(out.maxHp); // …and never the wall
    }
  });

  it('a ranged attacker emits complete attack runs; melee emits no projectile run', () => {
    // Owner 2026-07-26: bowmen shot with nothing rendered, because troop attacks
    // emitted NO events at all. SIM9 makes the complete run authoritative for
    // both the visible release and impact timing, and it is ranged-only here.
    const snap = base([b(BuildingType.Keep, 5, 8, 1, 'keep')]);
    const bow = simulateRaid(snap, orders([deploy('bowman', 1, 8)]), 42);
    const fires = bow.events.filter((e) => e.e === 'attackRun' && e.mode === 'projectile');
    expect(fires.length).toBeGreaterThan(0);
    expect(fires.every((f) => f.id === 0 && f.target === 'keep')).toBe(true);
    // cadenced by the full authored draw→loose body, never an accelerated tick
    const ticks = fires.map((f) => f.t);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]! - ticks[i - 1]!).toBe(authoredAttackTiming('bowman', 'building').cadenceTicks);
    }
    // a melee troop never emits one
    const melee = simulateRaid(snap, orders([deploy('highlander', 1, 8)]), 42);
    expect(melee.events.some((e) => e.e === 'attackRun' && e.mode === 'projectile')).toBe(false);
  });

  it.each([
    'highlander', 'tunneler', 'turrider', 'plunderer', 'giant',
    'troll', 'bilgewraith', 'gloamfang',
  ] as const)('%s publishes an authoritative ordinary attack contact', (troop) => {
    // WHY: these are all directly deployable melee attackers. Renderer profile
    // coverage is useless if one sim branch can damage a structure silently.
    const r = simulateRaid(
      base([b(BuildingType.Keep, 5, 8, 20, 'keep')], 14),
      orders([deploy(troop, 1, 8)]), 300 + troop.length,
    );
    expect(r.events.some((e) => e.e === 'attackRun' && e.id === 0
      && e.targetKind === 'building' && e.target === 'keep'), troop).toBe(true);
  });

  it.each(['bowman', 'dragon', 'mage', 'hexbarrow'] as const)(
    '%s publishes an authoritative ranged release',
    (troop) => {
      const r = simulateRaid(
        base([b(BuildingType.Keep, 5, 8, 20, 'keep')], 14),
        orders([deploy(troop, 1, 8)]), 400 + troop.length,
      );
      expect(r.events.some((e) => e.e === 'attackRun' && e.id === 0
        && (e.mode === 'projectile' || e.mode === 'stream')
        && e.target === 'keep'), troop).toBe(true);
    },
  );

  it('D-099: a blocked follow-troop opens the wall in front of it when the walk to an ally\'s breach costs more', () => {
    // 2026-07-26 the owner asked for ONE hole (the CoC shape) and SIM7 imposed
    // it: every blocked ally regrouped on the lowest troop id's wall. 2026-09-02
    // the owner's complaint is the walk itself — "a unit that walks the
    // perimeter in a 90-second battle loses the stage for the army" — so D-099
    // PRICES the join instead of imposing it. Same ring, same drops as the SIM7
    // test: the troll (row 11) and two highlanders (rows 6 and 18) each meet a
    // T1 segment in front of them. Walking 5–12 tiles to a neighbour's equal
    // segment costs 50–100 more ticks than chewing their own, so each opens its
    // own row — three breaches — and the Keep still falls. Joining when it IS
    // cheaper is pinned by "four blocked units join the NEAREST live breach".
    // Needs a SEALED ring: a single wall LINE never encloses anything, and the
    // detour would win. BuildingOutcome carries no coords, hence the ids.
    const snap = {
      ...base([b(BuildingType.Keep, 11, 11, 1, 'keep'), ...wallRing(4, 20, 1, 'w')]),
      claimMin: 4, claimMax: 21,
    };
    const r = simulateRaid(snap, orders([
      deploy('troll', 0, 11),
      deploy('highlander', 0, 6),
      deploy('highlander', 0, 18),
    ]), 42);
    const chewed = r.buildings.filter((x) => x.type === BuildingType.Wall && x.hp < x.maxHp);
    expect(chewed).toHaveLength(3); // one breach per blocked unit, not one per army
    // Three distinct rows of the west column: nobody walked to a neighbour's segment.
    const rows = new Set(chewed.map((w) => w.id.split('_')[2]));
    expect(chewed.every((w) => w.id.startsWith('w_4_'))).toBe(true);
    expect(rows.size).toBe(3);
    expect(r.buildings.find((x) => x.id === 'keep')!.hp).toBe(0); // and they got in
  });

  it('a LAST-RESORT melee troop chews a sealed wall when no opener is alive', () => {
    // Rule 1 says only 'break' troops attack walls by choice — but a lone
    // 'follow' troop with no tank to follow and no gap to use must still be able to
    // win, or a sealed base would be invulnerable to any army lacking a tank. Needs
    // a SEALED ring: against a mere wall LINE it would now (correctly) walk around.
    const snap = {
      ...base([b(BuildingType.Keep, 11, 11, 1, 'keep'), ...wallRing(4, 20, 1, 'w')]),
      claimMin: 4, claimMax: 21,
    };
    const r = simulateRaid(snap, orders([deploy('highlander', 0, 11)]), 42);
    expect(r.events.some((e) => e.e === 'destroyed' && String(e.id).startsWith('w_'))).toBe(true);
    const keep = r.buildings.find((x) => x.id === 'keep')!;
    expect(keep.hp).toBeLessThan(keep.maxHp); // it got through and hit the keep
  });
});

describe('live mid-battle deploy invariant (A3)', () => {
  it('adding a LATER deploy leaves every earlier event byte-identical', () => {
    // THE LINCHPIN for deploying during a raid. If this holds, the client can run
    // the pure sim locally, and on each tap simply APPEND the deploy at the real
    // elapsed tMs and re-simulate — the events already played are guaranteed
    // unchanged, so playback continues seamlessly. That is why A3 needs no
    // "stepper" and no sim change whatsoever.
    //
    // It holds because deploys are processed in tMs order and nothing before tick T
    // can depend on a troop that does not exist until T. This test exists to catch
    // the day someone breaks that — e.g. by reading orders.deploys.length up front
    // for a wave bonus, which would silently make live deploy impossible.
    const mk = () => base([
      b(BuildingType.Keep, 8, 8, 2, 'keep'),
      b(BuildingType.Cannon, 6, 6, 2, 'c1'),
      b(BuildingType.ArcherTower, 10, 10, 2, 'a1'),
    ]);
    const seed = 0xa3;
    const already = [deploy('highlander', 0, 8, 0), deploy('bowman', 0, 9, 0)];
    const before = simulateRaid(mk(), orders([...already]), seed);
    const LATE_MS = 4000;
    const after = simulateRaid(mk(), orders([...already, deploy('giant', 0, 7, LATE_MS)]), seed);
    const cut = Math.floor(LATE_MS / 100);
    const prefix = (r: typeof before) => JSON.stringify(r.events.filter((e) => e.t < cut));
    expect(prefix(before)).not.toBe('[]');       // the prefix is non-trivial
    expect(prefix(after)).toBe(prefix(before));  // …and untouched by the late deploy
  });
});

describe('input validation', () => {
  it('rejects deploys strictly interior to the claim', () => {
    // (8,8) is deep inside the 14×14 claim — strictly interior, so rejected.
    const snap = base([b(BuildingType.Keep, 8, 8, 1, 'keep')]);
    expect(() => simulateRaid(snap, orders([deploy('highlander', 8, 8)]), 1)).toThrow(/deploy zone/);
  });

  it('rejects deploys on a building footprint', () => {
    // Vault at (5,8) is on the claim edge ring (col 5… not interior) but its
    // footprint tile is still an invalid drop: troops can't spawn on a building.
    const snap = base([
      b(BuildingType.Keep, 8, 8, 1, 'keep'),
      b(BuildingType.Vault, 3, 3, 1, 'vault'),
    ]);
    expect(() => simulateRaid(snap, orders([deploy('highlander', 3, 3)]), 1)).toThrow(/deploy zone/);
  });

  it('rejects deploys beyond the 4-tile battlefield margin', () => {
    const snap = base([b(BuildingType.Keep, 8, 8, 1, 'keep')]);
    // tile -5 is one past the −4 margin → off the expanded field.
    expect(() => simulateRaid(snap, orders([deploy('highlander', -5, 8)]), 1)).toThrow(/deploy zone/);
    // tile 34 is one past the far margin (plot 30 + 4) → off the field.
    expect(() => simulateRaid(snap, orders([deploy('highlander', 34, 8)]), 1)).toThrow(/deploy zone/);
  });

  it('accepts deploys in the claim edge ring (empty gap between the core and walls)', () => {
    // A BARE snapshot (no claimMin/claimMax) falls back to the sim DEFAULT [2,16);
    // the edge ring (cols/rows 2 and 15) is NOT strictly interior, so an empty edge
    // gap is a legal drop. Real bases carry explicit CENTERED bounds (below).
    const snap = base([b(BuildingType.Keep, 8, 8, 1, 'keep')]);
    expect(() => simulateRaid(snap, orders([deploy('highlander', 2, 8)]), 1)).not.toThrow();
  });

  it('honors the CENTERED claim bounds carried on the snapshot', () => {
    // A real (post-migration) base sends claimMin/claimMax from footprints.claimRect.
    // A fresh centered claim is [8,22): (15,15) is strictly interior → rejected, but
    // the corner (8,15) is the claim edge ring → a legal drop. This is exactly what
    // fixes the "deploy outside the deploy zone" bug: the client reads these same
    // bounds instead of recomputing them, so client and sim always agree.
    const snap = { ...base([b(BuildingType.Keep, 14, 14, 1, 'keep')]), claimMin: 8, claimMax: 22 };
    expect(() => simulateRaid(snap, orders([deploy('highlander', 15, 15)]), 1)).toThrow(/deploy zone/);
    expect(() => simulateRaid(snap, orders([deploy('highlander', 8, 15)]), 1)).not.toThrow();
  });

  it('accepts a deploy mid-battle but rejects one past the battle end', () => {
    // CONTRACT CHANGE 2026-07-26: a deploy may land at ANY tick of the battle, not
    // only inside the pre-battle window — the owner wants remaining troops
    // committable during the fight, and the sim's deploy loop already schedules by
    // tMs across all MAX_TICKS. RAID_RULES.deployWindowSec is now purely the
    // CLIENT's pre-battle countdown before auto-commit. The only remaining bound is
    // the battle itself: a troop cannot land after the fight is over.
    const snap = base([b(BuildingType.Keep, 8, 8, 1, 'keep')]);
    const battleMs = RAID_RULES.battleDurationSec * 1000;
    // well past the 30s pre-battle window, still inside the 90s battle → allowed
    expect(() => simulateRaid(snap, orders([deploy('highlander', 0, 8, 45_000)]), 1)).not.toThrow();
    // at/after the final tick → rejected
    expect(() => simulateRaid(snap, orders([deploy('highlander', 0, 8, battleMs)]), 1)).toThrow(/outside the battle/);
  });
});

describe('deploy-zone contract (R5): drops far outside the base reach a building', () => {
  it('a troop deployed in the far margin (tile -3) paths inward and hits the keep', () => {
    const snap = base([b(BuildingType.Keep, 8, 8, 1, 'keep')]);
    const r = simulateRaid(snap, orders([deploy('highlander', -3, 8)]), 42);
    // It deployed at a negative tile…
    const dep = r.events.find((e) => e.e === 'deploy');
    expect(dep).toBeDefined();
    // …pathed all the way in across the margin and damaged the keep.
    const keep = r.buildings.find((x) => x.id === 'keep')!;
    expect(keep.hp).toBeLessThan(keep.maxHp);
  });

  it('a troop deployed past the far edge (tile 20) also reaches the keep', () => {
    const snap = base([b(BuildingType.Keep, 8, 8, 1, 'keep')]);
    const r = simulateRaid(snap, orders([deploy('highlander', 20, 8)]), 42);
    const keep = r.buildings.find((x) => x.id === 'keep')!;
    expect(keep.hp).toBeLessThan(keep.maxHp);
  });

  it('a keg runner deployed in the margin still picks its wall and detonates', () => {
    // A wall line guards the keep; a keg from outside the plot must clamp its
    // path start, choose a wall, and blow it.
    const snap = base([
      b(BuildingType.Keep, 8, 8, 1, 'keep'),
      ...wallLine(4, 2, 15, 1),
    ]);
    const r = simulateRaid(snap, orders([deploy('kegrunner', -2, 8)]), 42);
    expect(r.events.some((e) => e.e === 'detonate')).toBe(true);
    expect(r.events.some((e) => e.e === 'destroyed' && String(e.id).startsWith('wall'))).toBe(true);
  });
});

// ===========================================================================
// Pixel Kingdom Wars Phase 2b — new-roster combat mechanics (each test encodes
// WHY the role matters, not just that it runs; Rule 9).
// ===========================================================================
describe('new-roster combat mechanics (Phase 2b)', () => {
  const pinned = (buildings: ReturnType<typeof b>[]) => ({ ...base(buildings), claimMin: 2, claimMax: 16 });

  it('the giant is a TANK, not a wall-breaker: he walks past masonry to kill a defence', () => {
    // WHY (owner 2026-07-29): "rework Giant troop its tank not wall breaker so he
    // should be focusing on defences not on walls". Two halves to that role, and
    // this asserts the targeting half — a Cannon further away beats a Mine right
    // in front of him, because his aiTarget is 'defenses'. If someone flips him
    // back to 'buildings'/'nearest' the Mine dies first and this fails.
    const r = simulateRaid(
      pinned([
        b(BuildingType.Keep, 12, 12, 1, 'keep'),
        b(BuildingType.Mine, 4, 8, 1, 'mine'),     // NEARER to the drop
        b(BuildingType.Cannon, 10, 8, 1, 'cannon'), // further, but a DEFENCE
      ]),
      orders([deploy('giant', 0, 8)]), 7);
    const at = (id: string): number => {
      const e = r.events.find((x) => x.e === 'destroyed' && x.id === id);
      return e ? e.t : Infinity;
    };
    expect(at('cannon')).toBeLessThan(at('mine'));
  });

  it('the giant chews a blocking wall at dps×2 when beyond throw range with no opener', () => {
    // Rework v2 (owner 2026-08-08, superseding 2026-07-29's "1× last-resort
    // only"): a wall standing in his path is melee'd at dps×buildingDamageMult
    // — 110 deci per tick. STILL last-resort-only: he never seeks walls, and
    // this scenario forces the branch — his defense target (the cannon, deep
    // inside) is far beyond the 2.5-tile throw, the ring is sealed (no gap) and
    // he is alone (no opener to regroup on). The assertion window is the tell:
    // walk-in (~43 ticks) + a t3 segment at 110 deci (~110 ticks) lands well
    // UNDER the bare 1× chew figure (~218 ticks), which the old behaviour —
    // walk-in PLUS 1× chew (~261) — could never reach.
    const ring = {
      ...base([
        b(BuildingType.Cannon, 11, 11, 1, 'cannon'),
        b(BuildingType.Keep, 13, 11, 1, 'keep'),
        ...wallRing(4, 20, 3, 'w'),
      ]),
      claimMin: 4, claimMax: 21,
    };
    const r = simulateRaid(ring, orders([deploy('giant', 0, 11)]), 7);
    const first = r.events.find((e) => e.e === 'destroyed' && String(e.id).startsWith('w_'));
    expect(first).toBeDefined(); // not locked out of a sealed base
    const wall = r.buildings.find((x) => x.id.startsWith('w_') && x.destroyed)!;
    const at2x = (wall.maxHp / (TROOPS.giant.dps * 2)) * TICKS_PER_SEC;
    expect(first!.t).toBeGreaterThan(at2x);      // he still walks in first — the chew is not free
    expect(first!.t).toBeLessThan(at2x * 2);     // and it is nowhere near the 1× figure
    // Beyond-range kept the 'follow' shape: he breached, walked in and killed
    // the defense he was after all along.
    expect(r.buildings.find((x) => x.id === 'cannon')!.destroyed).toBe(true);
  });

  it('the troll is the roster wall-breaker: it destroys a wall a highlander only nibbles', () => {
    // Wall-opening moved to the troll when the giant became a tank. Sealed ring,
    // not a lone wall tile: rule 2 would route either troop around a single tile.
    const breakTick = (troop: 'troll' | 'highlander'): number => {
      // Sealed ring, not a lone wall tile: rule 2 would route either troop around a
      // single tile, so neither would ever attack it and both would return Infinity.
      const r = simulateRaid(
        { ...base([b(BuildingType.Keep, 11, 11, 1, 'keep'), ...wallRing(4, 20, 3, 'w')]), claimMin: 4, claimMax: 21 },
        orders([deploy(troop, 0, 11)]), 7);
      const ev = r.events.find((e) => e.e === 'destroyed' && String(e.id).startsWith('w_'));
      return ev ? ev.t : Infinity;
    };
    expect(breakTick('troll')).toBeLessThan(breakTick('highlander'));
  });

  it('emits cadenced Troll attack cues at building and blocked-wall contact points', () => {
    // WHY: attack is the authored troop-only sweep; pound is the authored strike
    // against both walls and buildings. Authored contacts already execute;
    // this protocol cue tells replay art which real contact it is depicting.
    const open = simulateRaid(
      pinned([b(BuildingType.Keep, 5, 8, 1, 'keep')]),
      orders([deploy('troll', 1, 8, 300)]), 7);
    const building = open.events.filter((e) => e.e === 'attackRun' && e.troop === 'troll');
    expect(building.length).toBeGreaterThan(0);
    expect(building.every((e) => e.id === 0 && e.target === 'keep')).toBe(true);
    expect(building.every((e) =>
      e.ix >= 5 * 256 && e.ix <= 7 * 256 && e.iy >= 8 * 256 && e.iy <= 10 * 256,
    )).toBe(true);

    const ring = simulateRaid(
      { ...base([b(BuildingType.Keep, 11, 11, 1, 'keep'), ...wallRing(4, 20, 3, 'w')]), claimMin: 4, claimMax: 21 },
      orders([deploy('troll', 0, 11)]), 7);
    const wall = ring.events.filter((e) =>
      e.e === 'attackRun' && typeof e.target === 'string' && e.target.startsWith('w_'));
    expect(wall.length).toBeGreaterThan(0);

    for (const [outcome, cues] of [[open, building], [ring, wall]] as const) {
      expect(cues.every((e) => e.cadenceTicks >= e.cycleTicks)).toBe(true);
      expect(cues.every((e) => Number.isInteger(e.ix) && Number.isInteger(e.iy))).toBe(true);
    }
  });

  it('keeps Troll retaliation specialized while ordinary melee contacts use generic strike', () => {
    const encounter = (troop: 'troll' | 'highlander') => simulateRaid(
      pinned([
        b(BuildingType.Keep, 14, 14, 5, 'keep'),
        b(BuildingType.DragonNest, 5, 8, 3, 'nest'),
      ]),
      orders([deploy(troop, 1, 8)]), 7);

    const troll = encounter('troll');
    const spawned = new Set(troll.events.filter((e) => e.e === 'spawn').map((e) => e.id));
    const retaliation = troll.events.filter((e) => e.e === 'attackRun' && typeof e.target === 'number');
    expect(retaliation.length).toBeGreaterThan(0);
    expect(retaliation.every((e) => spawned.has(e.target))).toBe(true);
    for (const attack of retaliation) {
      const impact = attack.t + attack.impactOffsetsTicks[0]!;
      const hit = troll.events.some((e) => e.e === 'hit' && e.t === impact
        && e.target === attack.target);
      const diedFirst = troll.events.some((e) => e.e === 'troopDeath'
        && e.id === attack.target && e.t <= impact);
      const sourceDied = troll.events.some((e) => e.e === 'troopDeath'
        && e.id === attack.id && e.t <= impact);
      expect(hit || diedFirst || sourceDied).toBe(true); // melee needs two live bodies
    }

    const highlander = encounter('highlander');
    const strikes = highlander.events.filter((e) => e.e === 'attackRun');
    expect(strikes.length).toBeGreaterThan(0);
    expect(strikes.every((e) => e.technique === 'strike'
      && e.targetKind === 'building' && e.target === 'nest')).toBe(true);
  });

  it.each([
    ['highlander', 'strike'],
    ['turrider', 'strike'],
    ['plunderer', 'strike'],
    ['giant', 'strike'],
    ['troll', 'slam'],
    ['gloamfang', 'rend'],
  ] as const)('%s publishes exact wall contact coordinates on a sealed base', (troop, technique) => {
    // WHY: these are every directly deployable melee body that can apply
    // ordinary DPS to masonry. Two sealed rings keep Gloamfang honest: its
    // authored leap may cross the first, but its cooldown leaves the second as
    // a real rend target. Tunneler/Bilgewraith burrow without wall damage and
    // Keg Runner's one-shot detonation has its own event contract above.
    const wallSnapshot = {
      ...base([
        b(BuildingType.Cannon, 11, 11, 20, 'cannon'),
        b(BuildingType.Keep, 13, 11, 20, 'keep'),
        ...wallRing(4, 20, 20, 'outer'),
        ...(troop === 'gloamfang' ? [
          ...wallRing(5, 19, 20, 'middle_a'),
          ...wallRing(6, 18, 20, 'middle_b'),
          ...wallRing(7, 17, 20, 'inner'),
        ] : []),
      ]),
      claimMin: 4, claimMax: 21,
    };
    const r = simulateRaid(wallSnapshot, orders([deploy(troop, 0, 11)]), 700 + troop.length);
    const cue = r.events.find((e) => e.e === 'attackRun'
      && e.targetKind === 'building' && String(e.target).includes('_'));
    expect(cue, troop).toBeDefined();
    expect(cue!.troop).toBe(troop);
    expect(cue!.technique).toBe(technique);
    expect(cue!.cadenceTicks).toBe(authoredAttackTiming(troop, 'building').cadenceTicks);
    const wall = wallSnapshot.buildings.find((building) => building.id === cue!.target)!;
    const { fw, fh } = footprintOf(wall.type);
    expect(wall.type).toBe(BuildingType.Wall);
    expect(cue!.ix).toBeGreaterThanOrEqual(wall.tx * 256);
    expect(cue!.ix).toBeLessThanOrEqual((wall.tx + fw) * 256);
    expect(cue!.iy).toBeGreaterThanOrEqual(wall.ty * 256);
    expect(cue!.iy).toBeLessThanOrEqual((wall.ty + fh) * 256);
  });

  it('electric tower chains to at most 2 nearby troops, damage decaying per hop', () => {
    const r = simulateRaid(
      pinned([b(BuildingType.Keep, 8, 8, 1, 'keep'), b(BuildingType.ElectricTower, 8, 6, 3, 'electric')]),
      orders([deploy('highlander', 7, 1), deploy('highlander', 8, 1), deploy('highlander', 9, 1)]), 3,
    );
    const chains = r.events.filter((e) => e.e === 'chain');
    expect(chains.length).toBeGreaterThan(0);
    for (const c of chains) {
      expect(c.targets.length).toBeLessThanOrEqual(2);          // chainMax = 2
      expect(new Set(c.targets).size).toBe(c.targets.length);    // never revisits a troop
      if (c.dmg.length === 2) expect(c.dmg[0]!).toBeGreaterThan(c.dmg[1]!); // 50% > 25% falloff
    }
  });

  it('mage tower is an AoE defense (splash radius > 0)', () => {
    expect(defenseCombat(BuildingType.MageTower, 1)!.splashUnits).toBeGreaterThan(0);
  });

  it('mage attacker bolts exactly one target per authored cast', () => {
    const r = simulateRaid(
      pinned([
        b(BuildingType.Keep, 8, 8, 1, 'keep'),
        b(BuildingType.Vault, 10, 8, 1, 'vault'),
        b(BuildingType.Mine, 8, 10, 1, 'mine'),
      ]),
      orders([deploy('mage', 0, 8)]), 5,
    );
    // Owner 2026-08-12: ordinary Mage cast is single-target, never an AoE.
    const perTick = new Map<number, number>();
    for (const e of r.events) {
      if (e.e === 'hit' && typeof e.target === 'string') perTick.set(e.t, (perTick.get(e.t) ?? 0) + 1);
    }
    expect([...perTick.values()].every((n) => n === 1)).toBe(true);
  });

  it('bilgewraith hunts the Mine and burrows under walls to reach it', () => {
    const r = simulateRaid(
      pinned([
        b(BuildingType.Keep, 8, 8, 1, 'keep'),
        b(BuildingType.Vault, 5, 8, 1, 'vault'),   // closer to the deploy, deliberately ignored
        b(BuildingType.Mine, 12, 8, 1, 'mine'),
        ...wallLine(10, 6, 10, 1),
      ]),
      orders([deploy('bilgewraith', 0, 8)]), 9,
    );
    expect(r.events.some((e) => e.e === 'burrow')).toBe(true);
    expect(r.events.some((e) => e.e === 'emerge')).toBe(true);
    const burrow = r.events.findIndex((e) => e.e === 'burrow' && e.id === 0);
    const emerge = r.events.findIndex((e) => e.e === 'emerge' && e.id === 0);
    const underground = r.events
      .map((event, index) => ({ event, index }))
      .filter(({ event, index }) => event.e === 'pos' && event.id === 0 && burrow < index && index < emerge);
    expect(underground.length).toBeGreaterThan(0);
    expect(underground.at(-1)!.index).toBe(emerge - 1);
    expect(underground.at(-1)!.event.t).toBe(r.events[emerge]!.t);
    expect(r.events[emerge]).toMatchObject({
      e: 'emerge', x: underground.at(-1)!.event.x, y: underground.at(-1)!.event.y,
    });
    expect(new Set(underground.map(({ event }) => `${event.x},${event.y}`)).size).toBeGreaterThan(1);
    expect(r.mineDestroyed).toBe(true); // it reached + destroyed the Mine (its aiTarget)
  });

  it('laser tower fires an instant single-target beam', () => {
    const d = defenseCombat(BuildingType.LaserTower, 1)!;
    expect(d.proj).toBe('beam');
    expect(d.splashUnits).toBe(0);          // single-target, not AoE
    expect(d.projTicks).toBeLessThanOrEqual(1); // near-instant
    const r = simulateRaid(
      pinned([b(BuildingType.Keep, 8, 8, 1, 'keep'), b(BuildingType.LaserTower, 8, 6, 3, 'laser')]),
      orders([deploy('highlander', 8, 1)]), 5,
    );
    expect(r.events.some((e) => e.e === 'fire' && e.proj === 'beam')).toBe(true);
  });

  it('flying Dragon flies over walls to its target (no wall-break, no burrow)', () => {
    // WHY: the Dragon is an AIR unit — it ignores walls entirely and reaches the keep.
    const r = simulateRaid(
      pinned([b(BuildingType.Keep, 8, 8, 1, 'keep'), ...wallLine(4, 4, 12, 2)]),
      orders([deploy('dragon', 0, 8)]), 4,
    );
    expect(r.events.some((e) => e.e === 'destroyed' && String(e.id).startsWith('wall'))).toBe(false);
    expect(r.events.some((e) => e.e === 'burrow')).toBe(false);
    const keep = r.buildings.find((x) => x.id === 'keep')!;
    expect(keep.hp).toBeLessThan(keep.maxHp); // reached + damaged the keep despite the wall
  });

  it('Cannon fires at ground troops but only air-capable towers can hit a flying Dragon', () => {
    // Tower placed in the dragon's face (3 tiles) so range asymmetry can't mask the
    // air rule: the archer (targetsAir) fires; the cannon (ground) never can.
    const layout = (tower: BuildingType) => pinned([
      b(BuildingType.Keep, 8, 8, 1, 'keep'), b(tower, 3, 8, 3, 'def'),
    ]);
    const cannonR = simulateRaid(layout(BuildingType.Cannon), orders([deploy('dragon', 0, 8)]), 4);
    expect(cannonR.events.some((e) => e.e === 'fire')).toBe(false); // cannon can't target air
    const groundR = simulateRaid(layout(BuildingType.Cannon), orders([deploy('highlander', 0, 8)]), 4);
    expect(groundR.events.some((e) => e.e === 'fire' && e.proj === 'cannonball')).toBe(true);
    const archerR = simulateRaid(layout(BuildingType.ArcherTower), orders([deploy('dragon', 0, 8)]), 4);
    expect(archerR.events.some((e) => e.e === 'fire')).toBe(true); // archer CAN
  });

  it('cannon/mortar/laser cannot target air; archer/mage/electric can', () => {
    const air = (t: BuildingType) => defenseCombat(t, 1)!.targetsAir;
    expect(air(BuildingType.ArcherTower)).toBe(true);
    expect(air(BuildingType.MageTower)).toBe(true);
    expect(air(BuildingType.ElectricTower)).toBe(true);
    expect(air(BuildingType.Cannon)).toBe(false);
    expect(air(BuildingType.Mortar)).toBe(false);
    expect(air(BuildingType.LaserTower)).toBe(false);
  });

  // K-030 / D-060 (SIM11). Under SIM10 a range-4 Dragon dismantling a range-4
  // tower hovered ~4.4–4.9 tiles from its CENTRE (the dragon measures reach to
  // the tower's footprint edge; the tower measured back centre-to-point), so a
  // point-blank archer/mage/electric tower fired ZERO shots for the whole
  // fight and pure-dragon armies dominated campaign and PvP. Owner 2026-08-16:
  // "dragons should be attacked by heroes, by archers, air defence …, by tesla
  // tower and by mage tower too."
  it.each([
    [BuildingType.ArcherTower, 'archer'],
    [BuildingType.ElectricTower, 'tesla'],
    [BuildingType.MageTower, 'magetower'],
  ] as const)('%s fires on the Dragon dismantling it from its own hover range (K-030)', (tower) => {
    // The dragon approaches from far away and parks at ITS chosen range — the
    // exact geometry that used to produce the zero-shot fight.
    const r = simulateRaid(
      pinned([b(BuildingType.Keep, 14, 8, 1, 'keep'), b(tower, 9, 8, 3, 'def')]),
      orders([deploy('dragon', 0, 8)]), 4,
    );
    const fires = r.events.filter((e) => e.e === 'fire' && e.id === 'def');
    expect(fires.length).toBeGreaterThan(0);
    expect(fires.every((e) => (e as { target: number }).target === 0)).toBe(true);
    expect(r.events.some((e) => e.e === 'hit' && e.target === 0)).toBe(true);
  });

  it('anti-air reach is edge-anchored: the 4-tile tesla hits a hover point farther than 4 tiles from its centre', () => {
    // The mechanism pin, not just the outcome: the dragon's hover point sits
    // OUTSIDE the tower's range measured centre-to-point (the SIM10 gate that
    // produced zero shots) yet INSIDE it measured to the footprint edge — the
    // flyer's own anchor. If someone reverts valid() to centre-to-point, the
    // fires above vanish and this geometry assertion goes vacuous with them.
    const r = simulateRaid(
      pinned([b(BuildingType.Keep, 14, 8, 1, 'keep'), b(BuildingType.ElectricTower, 9, 8, 3, 'def')]),
      orders([deploy('dragon', 0, 8)]), 4,
    );
    // The fire event records the dragon's EXACT position at fire time (ix/iy),
    // so the geometry claim needs no pos-keyframe interpolation.
    const firstFire = r.events.find((e) => e.e === 'fire' && e.id === 'def') as
      { ix: number; iy: number } | undefined;
    expect(firstFire).toBeDefined();
    const hover = { x: firstFire!.ix, y: firstFire!.iy };
    const rangeUnits = defenseCombat(BuildingType.ElectricTower, 3)!.rangeUnits;
    const cx = 9 * 256 + 128, cy = 8 * 256 + 128; // 1×1 tower centre
    const centreD2 = (hover.x - cx) ** 2 + (hover.y - cy) ** 2;
    expect(centreD2).toBeGreaterThan(rangeUnits ** 2); // SIM10 would never fire
    // Edge distance (1×1 tower at (9,8)): clamp the hover point onto the rect,
    // mirroring fixed.ts#dist2ToRect (inclusive [tx*256, (tx+fw)*256] bounds).
    const qx = Math.max(9 * 256, Math.min(10 * 256, hover.x));
    const qy = Math.max(8 * 256, Math.min(9 * 256, hover.y));
    expect((hover.x - qx) ** 2 + (hover.y - qy) ** 2).toBeLessThanOrEqual(rangeUnits ** 2);
  });

  it('the doubled cannon out-reaches a bowman kiting it (D-060: "increase cannon range 2 times")', () => {
    // Same asymmetry class as K-030 on the ground: a bowman attacks the cannon
    // from 3.5 tiles off its rect (~4.1 from centre), which the old 3-tile
    // cannon could never answer. At 6 tiles it shoots back. Ground reach stays
    // centre-measured — the buff here is the doubled number, not the anchor.
    const r = simulateRaid(
      pinned([b(BuildingType.Keep, 14, 8, 1, 'keep'), b(BuildingType.Cannon, 9, 8, 3, 'def')]),
      orders([deploy('bowman', 0, 8)]), 4,
    );
    const fires = r.events.filter((e) => e.e === 'fire' && e.id === 'def');
    expect(fires.length).toBeGreaterThan(0);
    expect(fires.every((e) => (e as { target: number }).target === 0)).toBe(true);
  });

  it.each([
    [BuildingType.ArcherTower, 'arrow'],
    [BuildingType.Cannon, 'cannonball'],
    [BuildingType.Mortar, 'shell'],
    [BuildingType.MageTower, 'arrow'],
    [BuildingType.ElectricTower, 'arrow'],
    [BuildingType.LaserTower, 'beam'],
  ] as const)('%s damage is preceded by its intended shot cue', (tower, projectile) => {
    // WHY: the renderer selects arrow/orb/zap by defense identity, but every
    // damaging route still needs an authoritative fire origin and contact time.
    const r = simulateRaid(
      pinned([b(BuildingType.Keep, 8, 8, 1, 'keep'), b(tower, 6, 8, 3, 'def')]),
      orders([deploy('giant', 0, 8)]), 17,
    );
    const shot = r.events.find((e) => e.e === 'fire' && e.id === 'def');
    expect(shot).toMatchObject({ proj: projectile, target: 0 });
    expect(r.events.some((e) => e.e === 'hit' && e.target === 0 && e.t >= shot!.t)).toBe(true);
  });

  it('Dragon Nest spawns defender wyrmlings that fight raiders and are killable', () => {
    // WHY: the Nest is a DEFENSE building that spawns defender wyrmlings (the one
    // exception to "trained troops don't defend"). Attackers retaliate, so wyrmlings
    // die — the mechanic isn't a permanent un-counterable drain.
    const r = simulateRaid(
      pinned([b(BuildingType.Keep, 8, 8, 1, 'keep'), b(BuildingType.DragonNest, 11, 8, 3, 'nest')]),
      orders([deploy('highlander', 0, 8), deploy('highlander', 0, 9), deploy('highlander', 0, 7)]), 6,
    );
    const spawns = r.events.filter((e) => e.e === 'spawn');
    expect(spawns.length).toBeGreaterThan(0);
    expect(spawns.every((e) => e.troop === 'wyrmling')).toBe(true);
    const spawnIds = new Set(spawns.map((e) => e.id));
    expect(r.events.some((e) => e.e === 'troopDeath' && spawnIds.has(e.id))).toBe(true); // killable
    const breaths = r.events.filter((e) => e.e === 'troopFire' && spawnIds.has(e.id));
    // WHY: Wyrmling damage must never materialize without the spawned defender's
    // authored breath/contact cue. The target is a troop id, unlike buildings.
    expect(breaths.length).toBeGreaterThan(0);
    expect(breaths.every((e) => typeof e.target === 'number')).toBe(true);
  });
});

// ===========================================================================
// Rework v2 — the giant's siegeThrow (owner 2026-08-08). His reach became
// TARGET-dependent: 2.5 tiles (640 units) of boulder throw against DEFENSES —
// over walls, same no-LoS convention as wallPolicy 'over' — and plain melee
// (160) against everything else. Routed through behaviorOf, because the reach
// is a ROLE and Theodor (giant donor) must not inherit it: the exact leak
// class that once made him a wall-chewer (2026-07-29).
// ===========================================================================
describe('the giant\'s siegeThrow (rework v2)', () => {
  /** A cannon sealed inside a one-tile ring, with a legal drop tile 2 tiles
   *  from its rect — inside the 2.5-tile throw, with the ring's wall directly
   *  between thrower and target. The cannon is the ONLY destructible (walls
   *  never count), so the battle ends the moment it falls and the end-state
   *  walls are exactly the walls as of the kill. */
  const cannonInRing = () => ({
    ...base([
      b(BuildingType.Cannon, 4, 4, 1, 'cannon'),
      ...wallRing(3, 5, 1, 'w'),
    ]),
    claimMin: 2, claimMax: 16,
  });

  it('throws boulders at a cannon OVER a sealed wall: cannon dies, wall never touched', () => {
    // WHY: "within siegeThrow range he lobs boulders at them (even over walls)"
    // — the throw is what makes him a tank instead of a unit that dismantles
    // masonry to reach the gun shelling him. From (4,2) the cannon rect is 384
    // units away (in throw range at spawn) and wall w_4_3 stands on the straight
    // line; under melee-only reach he would be blocked and chew that wall.
    const r = simulateRaid(cannonInRing(), orders([deploy('giant', 4, 2)]), 42);
    // The attack run is the complete throw body + projectile contract.
    const fires = r.events.filter((e) => e.e === 'attackRun');
    expect(fires.length).toBeGreaterThan(0);
    expect(fires.every((f) => f.technique === 'boulder' && f.id === 0
      && f.target === 'cannon')).toBe(true);
    const ticks = fires.map((f) => f.t);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]! - ticks[i - 1]!).toBe(fires[i]!.cadenceTicks);
    }
    // The damage went THROUGH the wall to the defense…
    expect(r.buildings.find((x) => x.id === 'cannon')!.destroyed).toBe(true);
    // …and the wall itself was never attacked — he threw over it, he did not
    // walk through it or chew it.
    for (const out of r.buildings) {
      if (out.type === BuildingType.Wall) expect(out.hp).toBe(out.maxHp);
    }
  });

  it('Theodor (giant donor) inherits NO throw: no troopFire, no siegeThrow via behaviorOf', () => {
    // WHY: a hero is a pseudo-deploy of its donor troop, and every behavioural
    // field must resolve through behaviorOf or the donor's role leaks in — the
    // bug class that gave Theodor the giant's wall habits on 2026-07-29. His
    // HERO_COMBAT entry declares no siegeThrow, so in the exact scenario where
    // a giant throws boulders he must emit not one troopFire cue.
    expect(roleOf(null, 'giant').siegeThrow).toEqual(TROOPS.giant.siegeThrow); // the troop HAS the role…
    expect(roleOf('theodor', 'giant').siegeThrow).toBeUndefined();             // …the hero does NOT
    const r = simulateRaid(
      cannonInRing(),
      { deploys: [], heroDeploys: [{ hero: 'theodor', tx: 4, ty: 2, tMs: 0, level: 1 }] },
      42,
    );
    expect(r.events.some((e) => e.e === 'troopFire')).toBe(false);
  });

  it('reach pin: 640 units vs a defense, melee 160 vs a wall / everything else', () => {
    // The numbers themselves, pinned at the seam the sim reads them through:
    // floor(2.5×256) = 640 — deliberately under bowman 3.5 / archertower 4 —
    // and the melee 160 everywhere the throw does not apply (walls included:
    // reachFor takes "is the target a defense", and a wall is not).
    const g = troopCombat('giant', 1);
    expect(g.rangeUnits).toBe(160); // his own range stays melee
    const role = roleOf(null, 'giant');
    expect(reachFor(g.rangeUnits, role.siegeThrow, true)).toBe(640);
    expect(reachFor(g.rangeUnits, role.siegeThrow, false)).toBe(160);
    // And through the hero seam the throw reach simply does not exist.
    expect(reachFor(g.rangeUnits, roleOf('theodor', 'giant').siegeThrow, true)).toBe(160);
  });
});

// ===========================================================================
// Rework v2 — the giant's HP POOL (owner 2026-08-08: "rework Giant … its tank
// not wall breaker", hp 700 → 1600, source comment in constants.ts: "he dies
// like a fly"). 1600 is not decoration: the whole point of the rework is that
// he can WALK INTO a live gun line, soak it, and still finish the job. Nothing
// else in the suite could see that number move — verified by counterfactual,
// 2026-08-08: reverting TROOPS.giant.hp to 700 left every other giant
// assertion green (the throw scenario, the wall-chew window, the giant_smash
// golden and hero-skills case 3 all replay bit-identically at 700, because in
// those the gun dies long before he is in any danger). This block is the ONLY
// mechanical consequence of the hp decision.
// ===========================================================================
describe('the giant\'s 1600 hp buys real survival (rework v2)', () => {
  /**
   * The pre-rework value, deliberately spelled out HERE and nowhere else: it is
   * not a live game number (constants.ts owns the live one), it is the
   * superseded figure the owner's complaint was about, kept as the A/B control
   * that proves this scenario is genuinely lethal to the OLD giant. Same
   * technique — and the same always-restored discipline — as the HERO_COMBAT
   * patching in "a hero inherits its donor troop's ROLE from no one" below.
   */
  const PRE_REWORK_HP = 700;

  const withGiantHp = <T>(hp: number, fn: () => T): T => {
    const t = TROOPS.giant as unknown as { hp: number };
    const orig = t.hp;
    t.hp = hp;
    try { return fn(); } finally { t.hp = orig; }
  };

  /**
   * A GUN LINE: three archer towers strung across his approach with the Keep
   * behind them. Archer towers, not cannons, for two reasons — they out-range
   * his 2.5-tile throw (7 tiles) so the boulder cannot answer them from safety,
   * and they keep shooting him while he is busy hammering the tower in front of
   * him. That is exactly the situation the owner described.
   *
   * RECALIBRATED L3 → L1 for D-060/SIM11 ("increase archer range too", 4 → 7):
   * the same three L3 towers now open fire ~3 tiles earlier each and land
   * ~1,614 on his approach — past even the reworked 1600 pool — so the L3 line
   * stopped separating the old giant from the new one (both died). The pin is
   * about the HP REWORK, not a fixed tower level: at L1 the 7-tile line lands
   * ~1,266 at this seed — still nearly double the old pool, still a real
   * fraction of the new one — and the 700-hp control still dies mid-base.
   */
  const gunLine = () => ({
    ...base([
      b(BuildingType.ArcherTower, 8, 8, 1, 'at0'),
      b(BuildingType.ArcherTower, 11, 8, 1, 'at1'),
      b(BuildingType.ArcherTower, 14, 8, 1, 'at2'),
      b(BuildingType.Keep, 20, 8, 1, 'keep'),
    ]),
    claimMin: 2, claimMax: 16,
  });

  /** Damage that actually LANDED on the giant, in HP (defense projectiles emit
   *  `hit` events; troop melee now lands through authored attack runs, and nothing here
   *  can hit him except the towers). */
  const raid = (hp: number) => withGiantHp(hp, () => {
    resetIds();
    const r = simulateRaid(gunLine(), orders([deploy('giant', 0, 8)]), 42);
    return {
      absorbed: (r.events.filter((e) => e.e === 'hit' && e.target === 0) as Array<{ dmg: number }>)
        .reduce((s, h) => s + h.dmg, 0),
      died: r.events.some((e) => e.e === 'troopDeath' && e.id === 0),
      stars: r.stars,
      towersDown: r.buildings.filter((x) => x.id.startsWith('at') && x.destroyed).length,
      keepDown: r.buildings.find((x) => x.id === 'keep')!.destroyed,
    };
  });

  it('walks through more fire than a pre-rework giant could hold, and still clears the base', () => {
    const now = raid(TROOPS.giant.hp);
    // He ate MORE than an entire old giant's health pool and lived. This is the
    // pin: retune hp down to anything at or below what the gun line lands
    // (~1266 at this seed under SIM11's 7-tile archers) and he dies here
    // instead, failing both halves.
    expect(now.absorbed).toBeGreaterThan(PRE_REWORK_HP);
    expect(now.died).toBe(false);
    // …and survival is not the whole claim — a tank that survives without
    // finishing anything is not what the owner asked for. He kills the entire
    // gun line and the Keep behind it: 3 stars.
    expect(now.towersDown).toBe(3);
    expect(now.keepDown).toBe(true);
    expect(now.stars).toBe(3);
    // NOT vacuous in the other direction either: the fire he takes is a real
    // fraction of the new pool, so this is a scenario that tests the hp rather
    // than a stroll (a 10× hp buff would make this test meaningless — it would
    // also make `absorbed < hp` trivially true, which is why the assertion
    // above is against the OLD number, not the new one).
    expect(now.absorbed).toBeGreaterThan(TROOPS.giant.hp / 2);
  });

  it('…and the SAME gun line kills a 700-hp giant mid-base — the owner\'s complaint, reproduced', () => {
    // The control. Without it "he survived" could just mean "the towers barely
    // scratched him", and the test above would pass at any hp.
    const then = raid(PRE_REWORK_HP);
    expect(then.died).toBe(true);
    expect(then.keepDown).toBe(false);
    expect(then.stars).toBe(0);   // the raid FAILS outright
    expect(then.towersDown).toBeLessThan(3);
    // He died with fire still incoming, i.e. he ran out of hp rather than out of
    // targets — the raid ended early, so he absorbed less than the full giant.
    expect(then.absorbed).toBeLessThan(raid(TROOPS.giant.hp).absorbed);
    // And the patch really was restored, so nothing downstream inherits it.
    expect(TROOPS.giant.hp).not.toBe(PRE_REWORK_HP);
  });
});

// ===========================================================================
// FOOTPRINTS: the sim spells them out, the shared table owns them.
//
// `stats.ts#footprintOf` is a hand-written switch, not a read of DEFENSES — so
// it is the one place a footprint can drift away from constants.ts without any
// typecheck noticing. It matters most for the rework-v2 pair: the art pack
// publishes a [2,2] VISUAL footprint for BOTH the cannon and the mortar, and
// the locked owner decision (docs/REWORK-V2-PLAN.md #1) is that the cannon stays
// 1x1 in sim/server/DB with its bigger sprite merely overhanging the tile. The
// client derives its own v2 footprint table from DEFENSES (apps/web
// game/v2/clips.ts#V2_BLD_FOOTPRINT, pinned there against this same source), so
// this end holds the sim to it: if the two ever disagree the client lets a base
// be built that the sim then simulates on a different rect — occupancy,
// deploy-exclusion and every dist2ToRect in here would all be measured against
// a tower shape the defender never placed.
// ===========================================================================
describe('the sim footprint table IS the shared table', () => {
  it('cannon stays 1x1 and mortar 2x2, straight off DEFENSES', () => {
    for (const [type, unit] of [
      [BuildingType.Cannon, 'cannon'],
      [BuildingType.Mortar, 'mortar'],
    ] as const) {
      const { fw, fh } = footprintOf(type);
      expect([fw, fh], unit).toEqual([...DEFENSES[unit].footprint]);
    }
    // Non-vacuous: the two really are DIFFERENT shapes, so a switch that fell
    // through to the 1x1 default (or widened the cannon to the pack's visual
    // 2x2) cannot pass by accident.
    expect(DEFENSES.cannon.footprint).not.toEqual(DEFENSES.mortar.footprint);
  });
});

// ===========================================================================
// A defender that cannot act THIS tick is PAUSED, not gone (2026-07-29).
//
// `phase = 'idle'` is terminal — pass 3 skips it and nothing ever clears it —
// and the defender branch used to park stunned / momentarily target-less
// wyrmlings there. Both tests below therefore assert RESUMPTION, which is the
// only thing that separates a pause from a deletion; both fail if the branch
// goes back to 'idle'.
//
// Neither scenario has a firing defense (the Nest shoots nothing, and there are
// no towers or traps), so the ONLY thing that can damage an attacker troop is a
// wyrmling bite — that is what makes "an attacker took damage" attributable.
// ===========================================================================
describe('defender wyrmlings pause, never exit', () => {
  const pinned = (buildings: ReturnType<typeof b>[]) => ({ ...base(buildings), claimMin: 2, claimMax: 16 });

  /** ids of wyrmlings alive at `t`, from the spawn/death events alone. */
  const liveWyrmlings = (events: SimEvent[], t: number): number[] => {
    const death = new Map<number, number>();
    for (const e of events) if (e.e === 'troopDeath') death.set(e.id, e.t);
    return events
      .filter((e) => e.e === 'spawn' && e.t <= t && t < (death.get(e.id) ?? Infinity))
      .map((e) => (e as { id: number }).id);
  };

  it('a stunned wyrmling bites again once the stun expires', () => {
    // WHY: Cheek Quake stuns defender troops for stunDeciSec — a PAUSE. Parking
    // the wyrmling in the terminal phase removed it from the battle for good,
    // which silently turned Theodor's L1 signature into "delete the Dragon Nest's
    // defenders", a far stronger skill than the spec's 1-second stun.
    const stunTicks = Math.floor((HERO_SKILLS.theodor.cheekQuake.stunDeciSec[0]! * TICKS_PER_SEC) / 10);
    const r = simulateRaid(
      { ...pinned([
        b(BuildingType.Keep, 8, 8, 5, 'keep'),
        b(BuildingType.DragonNest, 12, 8, 3, 'nest'),
      ]), keepLevel: 5 },
      {
        deploys: [deploy('highlander', 0, 8), deploy('highlander', 0, 9), deploy('highlander', 0, 10)],
        heroDeploys: [{ hero: 'theodor', tx: 0, ty: 7, tMs: 0, level: 1 }],
      },
      7,
    );
    const attackers = new Set(r.events.filter((e) => e.e === 'deploy').map((e) => (e as { id: number }).id));

    // A quake that caught a wyrmling and did NOT kill it: the quake's own damage
    // lands on every troop it stuns, so a 'hit' on a wyrmling at the cast tick is
    // exactly the set of units that took the stun.
    const deaths = new Map<number, number>();
    for (const e of r.events) if (e.e === 'troopDeath') deaths.set(e.id, e.t);
    const spawned = new Set(r.events.filter((e) => e.e === 'spawn').map((e) => (e as { id: number }).id));
    let castTick = -1;
    let stunned = new Set<number>();
    for (const e of r.events) {
      if (e.e !== 'heroSkill' || e.skill !== 'cheekQuake') continue;
      const caught = new Set(
        r.events
          .filter((h) => h.e === 'hit' && h.t === e.t && typeof h.target === 'number' && spawned.has(h.target))
          .map((h) => (h as { target: number }).target)
          .filter((id) => (deaths.get(id) ?? Infinity) > e.t),
      );
      if (caught.size > 0) { castTick = e.t; stunned = caught; break; }
    }
    expect(castTick).toBeGreaterThanOrEqual(0); // the scenario must actually stun something

    // Damage dealt to a raider after the stun window, at a tick when every live
    // wyrmling is one that was stunned — so the bite can only come from a unit
    // that RESUMED. Zero of these before the fix.
    const bitesAfterStun = r.events.filter((e) =>
      e.e === 'hit' && e.t > castTick + stunTicks &&
      typeof e.target === 'number' && attackers.has(e.target) &&
      liveWyrmlings(r.events, e.t).length > 0 &&
      liveWyrmlings(r.events, e.t).every((w) => stunned.has(w)));
    expect(bitesAfterStun.length).toBeGreaterThan(0);
  });

  it('a stunned wyrmling is SILENT for the whole stun window', () => {
    // The companion to the test above, and the one that proves the stun is
    // HONOURED rather than merely survivable. Deleting the stun read entirely
    // left the suite green: "it bites again afterwards" is equally true of a
    // wyrmling that never stopped biting. This asserts the pause itself.
    const stunTicks = Math.floor((HERO_SKILLS.theodor.cheekQuake.stunDeciSec[0]! * TICKS_PER_SEC) / 10);
    const r = simulateRaid(
      { ...pinned([
        b(BuildingType.Keep, 8, 8, 5, 'keep'),
        b(BuildingType.DragonNest, 12, 8, 3, 'nest'),
      ]), keepLevel: 5 },
      {
        deploys: [deploy('highlander', 0, 8), deploy('highlander', 0, 9), deploy('highlander', 0, 10)],
        heroDeploys: [{ hero: 'theodor', tx: 0, ty: 7, tMs: 0, level: 1 }],
      },
      7,
    );
    const attackers = new Set(r.events.filter((e) => e.e === 'deploy').map((e) => (e as { id: number }).id));
    const deaths = new Map<number, number>();
    for (const e of r.events) if (e.e === 'troopDeath') deaths.set(e.id, e.t);
    const spawned = new Set(r.events.filter((e) => e.e === 'spawn').map((e) => (e as { id: number }).id));

    // Find a quake that stunned wyrmlings AND left no un-stunned one alive, so
    // any bite inside the window can only come from a unit that ignored its stun.
    let castTick = -1;
    for (const e of r.events) {
      if (e.e !== 'heroSkill' || e.skill !== 'cheekQuake') continue;
      const caught = new Set(
        r.events
          .filter((h) => h.e === 'hit' && h.t === e.t && typeof h.target === 'number' && spawned.has(h.target))
          .map((h) => (h as { target: number }).target)
          .filter((id) => (deaths.get(id) ?? Infinity) > e.t),
      );
      if (caught.size === 0) continue;
      const live = liveWyrmlings(r.events, e.t);
      if (live.length > 0 && live.every((w) => caught.has(w))) { castTick = e.t; break; }
    }
    expect(castTick).toBeGreaterThanOrEqual(0); // scenario must actually stun the whole garrison

    // NOT ONE bite on a raider while every live wyrmling is stunned.
    const bitesDuringStun = r.events.filter((e) =>
      e.e === 'hit' && e.t > castTick && e.t < castTick + stunTicks &&
      typeof e.target === 'number' && attackers.has(e.target));
    expect(bitesDuringStun).toHaveLength(0);
  });

  it('a wyrmling left target-less by a burrowing tunneler engages once it surfaces', () => {
    // WHY: nearestEnemyTroop skips BURROWED units, so a tunneler-only opener makes
    // the board look empty for a few seconds. Parking the wyrmling in the terminal
    // phase meant one burrow tick disabled the whole Nest defense for the rest of
    // the raid — the tunneler then walked the base unopposed.
    const r = simulateRaid(
      { ...pinned([
        b(BuildingType.Keep, 8, 8, 3, 'keep'),
        b(BuildingType.DragonNest, 11, 8, 3, 'nest'),
        ...wallLine(4, 2, 15, 1),
      ]), keepLevel: 3 },
      // Deployed late on purpose: the tunneler must still be walking when the Nest
      // spawns (so a wyrmling exists) and be UNDERGROUND on the tick that wyrmling
      // first looks for a target.
      orders([deploy('tunneler', 0, 8, 3000)]),
      7,
    );
    const tunnelerId = (r.events.find((e) => e.e === 'deploy') as { id: number }).id;
    const spawns = r.events.filter((e) => e.e === 'spawn') as { t: number; id: number }[];
    const first = spawns[0]!;
    const burrowTick = (r.events.find((e) => e.e === 'burrow') as { t: number }).t;
    const emergeTick = (r.events.find((e) => e.e === 'emerge') as { t: number }).t;
    // The scenario only tests anything if the wyrmling's first look happens while
    // the tunneler is underground.
    expect(first.t).toBeLessThan(burrowTick);
    expect(burrowTick).toBeLessThan(emergeTick);

    // Until the second spawn, that first wyrmling is the only defender alive, so
    // both the movement keyframes and the damage below are unambiguously its own.
    const nextSpawn = spawns[1]?.t ?? Infinity;
    const window = (t: number): boolean => t > emergeTick && t < nextSpawn;
    expect(r.events.some((e) => e.e === 'pos' && e.id === first.id && window(e.t))).toBe(true);
    expect(r.events.some((e) =>
      e.e === 'hit' && e.target === tunnelerId && window(e.t) &&
      liveWyrmlings(r.events, e.t).join() === String(first.id))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D4a — heroes in combat (2026-07-28). A hero is a donor troop's ROLE with the
// HERO_COMBAT integer stats. What must hold: byte-identical determinism, the
// stat override actually applying, and the A3 live-deploy prefix invariant
// surviving a mid-battle hero drop.
// ---------------------------------------------------------------------------
describe('hero deploys (D4a)', () => {
  const heroBase = () => base([
    b(BuildingType.Keep, 14, 13, 3),
    b(BuildingType.Cannon, 12, 16, 2),
  ], 3);

  it('replays bit-identically and the hero fights with HERO stats, not donor stats', () => {
    const withHero = {
      ...orders([deploy('highlander', 0, 14, 0)]),
      heroDeploys: [{ hero: 'vex' as const, tx: 0, ty: 15, tMs: 0 }],
    };
    // ONE snapshot for both runs: the b() helper mints fresh building ids per
    // call, and events embed them — two heroBase() calls differ by id strings
    // alone, which is id churn, not nondeterminism (the golden-fixture lesson).
    const snapOnce = heroBase();
    const a = simulateRaid(snapOnce, withHero, 42);
    const b2 = simulateRaid(snapOnce, withHero, 42);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b2.events)); // determinism

    // The hero's deploy event is tagged for the renderer…
    const heroEv = a.events.find((e) => e.e === 'deploy' && (e as { hero?: string }).hero === 'vex');
    expect(heroEv).toBeDefined();
    // …and the unit fights with Vex's numbers. Provable from the OUTCOME: the
    // same battle with the hero replaced by a 2nd L1 highlander must do
    // strictly worse — Vex carries ~14x a highlander's hp and ~17x its dps.
    const noHero = simulateRaid(heroBase(),
      orders([deploy('highlander', 0, 14, 0), deploy('highlander', 0, 15, 0)]), 42);
    expect(a.destructionPct).toBeGreaterThan(noHero.destructionPct);
  });

  it('the SAME hero cannot be fielded twice — one Vex exists (triple-Theodor regression)', () => {
    // WHY this is a sim invariant and not a UI rule: a hero is ONE unit the
    // player owns, so two entries for the same hero can only ever be a bug.
    // On 2026-07-28 a stale-closure guard in the deploy tray let a 120ms
    // hold-repeat append Theodor three times and the sim happily spawned three
    // of him, each autocasting his kit. Rejecting it here also means a
    // hand-rolled replay or a bugged client cannot forge a hero army.
    const dupes = {
      ...orders([deploy('highlander', 0, 14, 0)]),
      heroDeploys: [
        { hero: 'theodor' as const, tx: 14, ty: 0, tMs: 0 },
        { hero: 'theodor' as const, tx: 14, ty: 1, tMs: 120 },
      ],
    };
    expect(() => simulateRaid(heroBase(), dupes, 7)).toThrow(/duplicate hero deploy: theodor/);
    // Two DIFFERENT heroes stay legal — that is a normal two-altar raid.
    const both = {
      ...orders([deploy('highlander', 0, 14, 0)]),
      heroDeploys: [
        { hero: 'vex' as const, tx: 0, ty: 15, tMs: 0 },
        { hero: 'theodor' as const, tx: 0, ty: 16, tMs: 0 },
      ],
    };
    const r = simulateRaid(heroBase(), both, 7);
    const heroDeployEvents = r.events.filter((e) => e.e === 'deploy' && (e as { hero?: string }).hero);
    expect(heroDeployEvents.map((e) => (e as unknown as { hero: string }).hero).sort()).toEqual(['theodor', 'vex']);
  });

  it('a LATER hero drop leaves every earlier event byte-identical (A3 invariant)', () => {
    const plain = orders([deploy('highlander', 0, 14, 0), deploy('highlander', 29, 14, 200)]);
    const withHero = { ...plain, heroDeploys: [{ hero: 'theodor' as const, tx: 14, ty: 0, tMs: 4_000 }] };
    const before = simulateRaid(heroBase(), plain, 7).events;
    const after = simulateRaid(heroBase(), withHero, 7).events;
    const heroTick = Math.floor(4_000 / 100);
    expect(JSON.stringify(after.filter((e) => e.t < heroTick)))
      .toBe(JSON.stringify(before.filter((e) => e.t < heroTick)));
  });
});

describe('hero skills (D4b — L1 signatures, autocast)', () => {
  it('Crimson Dash closes the gap and burns through walls at x3 (heroSkill event tagged)', () => {
    // A SEALED keep with Vex dropped 5+ tiles out: the dash must fire (gap >=
    // minGapTiles), advance him, and damage the wall it crosses. The ring has to be
    // closed — this used to be an open-ended wall ROW, which passed only because a
    // routing bug pinned him against it (owner 2026-07-29). With that fixed he
    // correctly walks around an open row and never dashes through anything.
    // TIER 20 since D-099 (was 3): the first dash lands short of the ring, and
    // a blocked Vex now COMMITS to chewing the segment with the highlander
    // beside him instead of wandering. At T3 the pair opened it on tick 119,
    // one tick before the dash came off cooldown, so the second dash crossed a
    // hole and the assertion below had no live wall to see. T20 outlives the
    // 12 s cooldown, and the dash pierces the standing segment as designed.
    const snapOnce = {
      ...base([
        b(BuildingType.Keep, 13, 13, 3),
        ...wallRing(6, 20, 20, 'w'),
      ], 3),
      claimMin: 6, claimMax: 21,
    };
    const withVex = {
      ...orders([deploy('highlander', 13, 0, 0)]),
      heroDeploys: [{ hero: 'vex' as const, tx: 13, ty: 1, tMs: 0 }],
    };
    const r = simulateRaid(snapOnce, withVex, 42);
    const dash = r.events.find((e) => e.e === 'heroSkill' && (e as { skill?: string }).skill === 'crimsonDash');
    expect(dash).toBeDefined();
    // The dash repositioned him — a pos event for the hero at the dash tick.
    const heroDeployEv = r.events.find((e) => e.e === 'deploy' && (e as { hero?: string }).hero === 'vex') as { id: number };
    const posAtDash = r.events.find((e) => e.e === 'pos' && e.t === dash!.t && (e as { id: number }).id === heroDeployEv.id);
    expect(posAtDash).toBeDefined();
    // Adversarial-review fix: dash wall damage must emit 'hit' events (keg
    // precedent) or the client HP mirror / crack overlay silently drifts. The
    // FIRST dash fires before the wall row — assert on whichever dash crosses.
    const dashTicks = new Set(r.events
      .filter((e) => e.e === 'heroSkill' && (e as { skill?: string }).skill === 'crimsonDash')
      .map((e) => e.t));
    const wallHit = r.events.find((e) => e.e === 'hit' && dashTicks.has(e.t) && typeof (e as { target: unknown }).target === 'string');
    expect(wallHit).toBeDefined();
  });

  it('hero skill tier is pinned to L1 — donor troop RESEARCH must not buy T4 skills', () => {
    // Adversarial-review fix: tr.level for hero pseudo-deploys came from the
    // DONOR troop's research level, so L16 highlander research silently granted
    // T4 Crimson Dash (5-tile range) in server-authoritative raids. Heroes are
    // L1 until D-Q1 wires hero leveling: research level must change NOTHING
    // about the hero's skill events.
    const mk = () => base([
      b(BuildingType.Keep, 14, 13, 3),
      ...[12, 13, 14, 15, 16, 17, 18].map((x) => b(BuildingType.Wall, x, 10, 3)),
    ], 3);
    const withVex = {
      ...orders([deploy('highlander', 14, 0, 0)]),
      heroDeploys: [{ hero: 'vex' as const, tx: 14, ty: 1, tMs: 0 }],
    };
    const lo = simulateRaid(mk(), withVex, 42, { troopLevels: { highlander: 1 } });
    const hi = simulateRaid(mk(), withVex, 42, { troopLevels: { highlander: 16 } });
    const firstDash = (r: typeof lo): unknown =>
      r.events.find((e) => e.e === 'heroSkill' && (e as { skill?: string }).skill === 'crimsonDash');
    // Same tick, same landing point — the tier (range/damage) did not scale.
    expect(firstDash(hi)).toEqual(firstDash(lo));
  });

  it('dash never strands the hero on a live wall tile (battle-long freeze regression)', () => {
    // Adversarial repro: L20 wall row at y=11, Vex dropped at (16,7) — the raw
    // dash endpoint fell INSIDE wall tile (15,11), where the cost field prices
    // the hero's own tile at WALL_COST and movement froze for the whole battle.
    // The fix backs the landing off to the last wall-free sample.
    const snap = base([
      b(BuildingType.Keep, 14, 13, 3),
      ...[8, 9, 10, 11, 12, 13, 14, 15].map((x) => b(BuildingType.Wall, x, 11, 20)),
    ], 3);
    const withVex = {
      ...orders([deploy('highlander', 2, 2, 0)]),
      heroDeploys: [{ hero: 'vex' as const, tx: 16, ty: 7, tMs: 0 }],
    };
    const r = simulateRaid(snap, withVex, 42);
    for (const e of r.events) {
      if (e.e !== 'heroSkill' || (e as { skill?: string }).skill !== 'crimsonDash') continue;
      const { x, y } = e as { x: number; y: number };
      const tx = Math.floor(x / 256), ty = Math.floor(y / 256);
      // An L20 wall cannot die to a single dash hit, so landing in the row
      // means landing INSIDE a live wall — exactly the frozen-hero bug.
      expect(ty === 11 && tx >= 8 && tx <= 15).toBe(false);
    }
  });

  it('Cheek Quake STUNS defenses (their fire is provably suppressed) and taunts them onto the stool', () => {
    // A cannon that would otherwise shell the attackers freely; Theodor lands
    // beside it and quakes every 10s. Count the cannon's fire events with and
    // without him — the stun MUST suppress shots or the skill does nothing.
    // THREE L3 highlanders (was two L1) since D-060/SIM11: the 6-tile cannon
    // opens fire tiles earlier and the two L1s were dead before the first
    // quake tick in the unstunned control, leaving it no post-quake shot to
    // compare against. The stun mechanic under test is unchanged.
    const mk = () => base([
      b(BuildingType.Keep, 14, 13, 3),
      b(BuildingType.Cannon, 10, 10, 3),
    ], 3);
    const plain = orders([
      deploy('highlander', 2, 9, 0), deploy('highlander', 2, 11, 0),
      deploy('highlander', 2, 12, 0),
    ]);
    const withTheo = { ...plain, heroDeploys: [{ hero: 'theodor' as const, tx: 2, ty: 10, tMs: 0 }] };
    const levels = { troopLevels: { highlander: 3 } } as const;
    const a = simulateRaid(mk(), plain, 9, levels);
    const br = simulateRaid(mk(), withTheo, 9, levels);
    const quakes = br.events.filter((e) => e.e === 'heroSkill' && (e as { skill?: string }).skill === 'cheekQuake');
    expect(quakes.length).toBeGreaterThanOrEqual(1);
    // The DIRECT observable of a 1.0s stun is DELAY: the cannon's next shot
    // after the quake lands strictly later than in the unstunned battle
    // (measured: tick 85 vs 78 at seed 9 — deterministic, so a strict
    // inequality is stable). A count-based window check was too weak: the 3s
    // window still fits the same number of shots, and the no-stun mutation
    // passed it — this version fails when the stun line is removed.
    const q0 = quakes[0]!.t;
    const nextFire = (evs: typeof a.events): number =>
      (evs.find((e) => e.e === 'fire' && e.t > q0) as { t: number } | undefined)?.t ?? Number.MAX_SAFE_INTEGER;
    expect(nextFire(br.events)).toBeGreaterThan(nextFire(a.events));
    // Taunt: after the quake the cannon's NEXT shot (if any) targets the hero.
    const heroId = (br.events.find((e) => e.e === 'deploy' && (e as { hero?: string }).hero === 'theodor') as { id: number }).id;
    const postQuakeFire = br.events.find((e) => e.e === 'fire' && e.t > quakes[0]!.t) as { target: number } | undefined;
    if (postQuakeFire) expect(postQuakeFire.target).toBe(heroId);
  });
});

// ---------------------------------------------------------------------------
// Heroes own their behaviour (2026-07-29 bug report). A hero is deployed as a
// pseudo-deploy of a DONOR troop so it reuses the deterministic troop
// machinery — but the donor is art. When the sim read movement/targeting/wall
// policy off `tr.type` (the donor) it produced two live bugs:
//   - Vex sprinted at the highlander's 1.2 tiles/s (he is a raid leader whose
//     burst is Crimson Dash, not his walk);
//   - Theodor inherited the giant's wallPolicy 'break' + 2x buildingDamageMult
//     and spent whole raids chewing perimeter at 38 dps instead of walking at
//     the guns he is built to soak.
// These pin the DATA→behaviour link, so a future hero cannot silently pick up
// its donor's role again.
// ---------------------------------------------------------------------------
describe('heroes own their behaviour, never the donor troop\'s', () => {
  /** Units/tick the sim must derive from a tiles/sec figure (stats.ts). */
  const perTick = (tilesPerSec: number): number => Math.floor((tilesPerSec * 256) / 10);

  /**
   * Open-field walking speed, measured from the sim's own `pos` keyframes: the
   * widest 5-tick x-advance in a window containing no heroSkill event (Crimson
   * Dash teleports, and would otherwise mask the walk it is meant to contrast
   * with). Drop and target share a row, so `stepToward` moves purely in x and
   * the measurement is exact, not approximate.
   */
  const measureUnitsPerTick = (r: { events: readonly SimEvent[] }, id: number): number => {
    const skillTicks = new Set(r.events.filter((e) => e.e === 'heroSkill').map((e) => e.t));
    const pos = r.events.filter((e) => e.e === 'pos' && (e as { id: number }).id === id) as
      { t: number; x: number }[];
    let best = 0;
    for (let i = 1; i < pos.length; i++) {
      const a = pos[i - 1]!, c = pos[i]!;
      const span = c.t - a.t;
      if (span <= 0) continue;
      let skilled = false;
      for (let t = a.t; t <= c.t; t++) if (skillTicks.has(t)) skilled = true;
      if (skilled) continue;
      best = Math.max(best, Math.floor((c.x - a.x) / span));
    }
    return best;
  };

  it('Vex walks at HERO_COMBAT speed, NOT the highlander donor speed', () => {
    // WHY this matters: the donor is a sprite contract. Vex's kit gives him one
    // burst — "dash if target >= 3 tiles (wall-piercing)" — and if his WALK is
    // also a raider's 1.2 t/s the dash reads as a teleport on top of a sprint,
    // which is exactly what the owner reported seeing.
    const line = () => base([b(BuildingType.Keep, 26, 8, 3, 'keep')], 3);
    const vex = simulateRaid(line(), {
      ...orders([]), heroDeploys: [{ hero: 'vex' as const, tx: 0, ty: 8, tMs: 0 }],
    }, 42);
    const troop = simulateRaid(line(), orders([deploy('highlander', 0, 8, 0)]), 42);

    const vexId = (vex.events.find((e) => e.e === 'deploy' && (e as { hero?: string }).hero === 'vex') as { id: number }).id;
    const vexSpeed = measureUnitsPerTick(vex, vexId);
    const donorSpeed = measureUnitsPerTick(troop, 0);

    // The donor troop still moves at its own documented pace (nothing was nerfed
    // for troops) …
    expect(donorSpeed).toBe(perTick(TROOPS[HERO_COMBAT.vex.donor].speedTilesPerSec));
    // … and Vex moves at HIS number, which is a different number. Both halves
    // are asserted so the test cannot go vacuous if the two constants converge.
    expect(HERO_COMBAT.vex.speedTilesPerSec).not.toBe(TROOPS[HERO_COMBAT.vex.donor].speedTilesPerSec);
    expect(vexSpeed).toBe(perTick(HERO_COMBAT.vex.speedTilesPerSec));
    expect(vexSpeed).toBeLessThan(donorSpeed);
  });

  it('Theodor walks at HERO_COMBAT speed — the slowest unit in the game', () => {
    // "HOW HE DIES: Slowly, loudly" / "WADDLE" — he must be under the giant's
    // 0.85 t/s, not equal to it.
    const line = () => base([b(BuildingType.Keep, 26, 8, 3, 'keep')], 3);
    const r = simulateRaid(line(), {
      ...orders([]), heroDeploys: [{ hero: 'theodor' as const, tx: 0, ty: 8, tMs: 0 }],
    }, 42);
    const id = (r.events.find((e) => e.e === 'deploy' && (e as { hero?: string }).hero === 'theodor') as { id: number }).id;
    expect(HERO_COMBAT.theodor.speedTilesPerSec).toBeLessThan(TROOPS[HERO_COMBAT.theodor.donor].speedTilesPerSec);
    expect(measureUnitsPerTick(r, id)).toBe(perTick(HERO_COMBAT.theodor.speedTilesPerSec));
  });

  it('Theodor walks at a reachable DEFENSE instead of gnawing a sealed wall ring', () => {
    // WHY: his spec role is "TANK · AGGRO MAGNET — PULLS ALL DEFENCES IN R6",
    // "every arrow aimed at him is an arrow not aimed at anything that matters".
    // Riding the giant's role gave him aiTarget 'buildings' (nearest = the
    // walled Keep) plus wallPolicy 'break', so he committed to the perimeter:
    // 38 dps x the giant's 2x vs 1200 hp/segment is ~16s a wall, a whole battle
    // for 3-4 stones — and, being flagged an "opener", the rest of the 'follow'
    // army regrouped on him there. His answer to a wall is BROWN NOTE deletion
    // at L14 ("the only unit that ignores wall HP entirely"), never chewing.
    //
    // Scenario: the Keep is sealed inside a ring (nearest targetable, so the OLD
    // aiTarget picks it and the OLD wallPolicy parks him on the stones), while
    // two Cannons sit outside it, further away but wall-free. Two, so the gun
    // line outlasts the 90s battle — with nothing left to shoot he would
    // correctly fall back to the walled Keep, and this test is about the choice
    // he makes while a reachable target exists.
    const scenario = () => base([
      b(BuildingType.Keep, 13, 13, 3, 'keep'),
      ...wallRing(8, 20, 3, 'ring'),
      b(BuildingType.Cannon, 26, 2, 3, 'gun'),
      b(BuildingType.Cannon, 26, 20, 3, 'gun2'),
    ], 3);
    const r = simulateRaid(scenario(), {
      ...orders([]), heroDeploys: [{ hero: 'theodor' as const, tx: 0, ty: 2, tMs: 0 }],
    }, 42);
    const ringDamage = (o: typeof r): number => o.buildings
      .filter((x) => x.id.startsWith('ring'))
      .reduce((n, w) => n + (w.maxHp - w.hp), 0);

    // He walked past the perimeter and killed the gun …
    expect(r.buildings.find((x) => x.id === 'gun')!.destroyed).toBe(true);
    // … and up to that moment had not opened a single wall segment. (Asserting
    // a pristine ring at END of battle would be wrong for the right reason: once
    // every reachable defence is dead he legitimately falls back to the walled
    // Keep. The claim under test is what he does WHILE a reachable target
    // exists.)
    const gunDown = r.events.find((e) => e.e === 'destroyed' && e.id === 'gun')!.t;
    const ringDown = r.events.filter((e) => e.e === 'destroyed' && String(e.id).startsWith('ring'));
    expect(ringDown.every((e) => e.t > gunDown)).toBe(true);

    // Control — a real wall-opener must STILL commit to the perimeter (this fix is
    // hero-scoped). The TROLL, not the giant: the giant stopped being an opener on
    // 2026-07-29 and is now a defence-seeking tank like Theodor himself.
    const opener = simulateRaid(scenario(), orders([deploy('troll', 0, 2, 0)]), 42);
    expect(opener.buildings.filter((x) => x.id.startsWith('ring')).some((w) => w.destroyed)).toBe(true);
    expect(ringDamage(r)).toBeLessThan(ringDamage(opener));
  });
});

// ---------------------------------------------------------------------------
// ROLE IS DATA (2026-07-29, adversarial review). Speed and wall policy were
// fixed above, but three branches still keyed on `tr.type`: keg wall-selection,
// keg detonation and the plunderer's resource multiplier. Vex's donor is a
// highlander and Theodor's a giant, so nothing shipped was wrong TODAY — but the
// next hero authored with a kegrunner or plunderer donor would have silently
// inherited a suicide bomb or a 2x resource bonus nobody wrote down, which is
// precisely how Theodor ended up a wall-chewer.
//
// These tests build the dangerous heroes the only legitimate way: by editing the
// HERO tables (the sim is never patched), then restoring them.
// ---------------------------------------------------------------------------
describe('a hero inherits its donor troop\'s ROLE from no one', () => {
  /** Run `fn` with HERO_COMBAT.vex patched; always restored. */
  const withVex = <T>(patch: Partial<typeof HERO_COMBAT.vex>, fn: () => T): T => {
    const orig = HERO_COMBAT.vex;
    HERO_COMBAT.vex = { ...orig, ...patch };
    try { return fn(); } finally { HERO_COMBAT.vex = orig; }
  };
  const dropVex = (tx: number, ty: number) => ({
    ...orders([]), heroDeploys: [{ hero: 'vex' as const, tx, ty, tMs: 0 }],
  });
  const heroId = (r: { events: readonly SimEvent[] }): number =>
    (r.events.find((e) => e.e === 'deploy' && (e as { hero?: string }).hero === 'vex') as { id: number }).id;

  it('a KEGRUNNER-donor hero does not blow itself up on the wall', () => {
    // The role flag is `selfDestructs`, and only the keg runner declares it: a
    // hero that does not is not carrying a keg, whatever sprite it wears.
    expect(TROOPS.kegrunner.selfDestructs).toBe(true);
    expect(HERO_COMBAT.vex.selfDestructs).toBeUndefined();

    const scenario = () => base([
      b(BuildingType.Keep, 8, 8, 1, 'keep'),
      ...wallLine(4, 2, 15, 1),
    ]);
    // Control: the scenario DOES trigger a detonation — the troop reaches the
    // wall that opens the path and blows it. Without this the test could pass
    // for the boring reason that nothing ever got close enough.
    const keg = simulateRaid(scenario(), orders([deploy('kegrunner', 0, 8)]), 42);
    expect(keg.events.some((e) => e.e === 'detonate')).toBe(true);

    const r = withVex({ donor: 'kegrunner' }, () => simulateRaid(scenario(), dropVex(0, 8), 42));
    // Same drop, same wall, same tick budget — and no keg goes off …
    expect(r.events.some((e) => e.e === 'detonate')).toBe(false);
    // … so the hero is still standing at the end instead of having killed
    // himself on a stone (an undefended base cannot kill him any other way).
    const id = heroId(r);
    expect(r.events.some((e) => e.e === 'troopDeath' && e.id === id)).toBe(false);
  });

  it('the ROLE LOOKUP itself refuses to hand a hero its donor\'s keg role', () => {
    // Independent lock on the WALL-SELECTION branch (sim.ts:507). Verification
    // 2026-07-29 caught that reverting selection alone left the suite green:
    // once detonation is fixed, a wrongly-assigned keg wall never explodes, so
    // the leak has no behavioural signature to assert. Both branches now read
    // the SAME lookup, so locking the lookup locks both — reverting either to
    // `tr.type === 'kegrunner'` reintroduces exactly what this forbids.
    expect(roleOf(null, 'kegrunner').selfDestructs).toBe(true);
    expect(roleOf('vex', 'kegrunner').selfDestructs).toBeFalsy();
    expect(roleOf(null, 'plunderer').resourceDamageMult).toBe(2);
    expect(roleOf('vex', 'plunderer').resourceDamageMult).toBeFalsy();
  });

  it('a PLUNDERER-donor hero does not inherit the 2x resource multiplier', () => {
    // Only the plunderer declares resourceDamageMult; a hero must earn it by
    // declaring it, not by borrowing a sprite.
    expect(TROOPS.plunderer.resourceDamageMult).toBe(2);
    expect(HERO_COMBAT.vex.resourceDamageMult).toBeUndefined();

    // One L20 Mine, nothing else: ticks-to-destroy is then a clean integer
    // readout of the damage multiplier actually applied.
    const scenario = () => base([b(BuildingType.Mine, 12, 8, 20, 'mine')], 3);
    const killTick = (r: { events: readonly SimEvent[] }): number => {
      const ev = r.events.find((e) => e.e === 'destroyed' && e.id === 'mine');
      expect(ev).toBeDefined();
      return ev!.t;
    };

    const neutralDonor = simulateRaid(scenario(), dropVex(0, 8), 42);
    const plundererDonor = withVex({ donor: 'plunderer' }, () => simulateRaid(scenario(), dropVex(0, 8), 42));
    // Swapping the sprite to the plunderer changes NOTHING about the fight.
    expect(killTick(plundererDonor)).toBe(killTick(neutralDonor));

    // And the counterpart the review asked for: resourceDamageMult was declared
    // on UnitBehavior but never read, so a hero author setting it got a
    // typecheck-clean no-op. A hero that DECLARES it now kills the Mine
    // strictly faster — the field is wired, and the previous assertion is
    // therefore about inheritance rather than a dead code path.
    const declared = withVex({ resourceDamageMult: 2 }, () => simulateRaid(scenario(), dropVex(0, 8), 42));
    expect(killTick(declared)).toBeLessThan(killTick(neutralDonor));
  });
});

// ---------------------------------------------------------------------------
// Two bugs the owner reported on 2026-07-29, neither of which had any coverage.
// ---------------------------------------------------------------------------
describe('a blocked unit commits to its detour', () => {
  it('walks the whole way round a ring to an open breach instead of stalling at the wall', () => {
    // THE BUG: "theodor still not going in base wtf, why he so dumb properly
    // implement his attacking habits still stuck at wals despite there is breach".
    //
    // Two rules were fighting each tick. Blocked by a wall, a unit stepped one tile
    // along the wall-free route and cleared `blockedWall` — so the NEXT tick it was
    // no longer blocked, took the straight line to its target, and walked back into
    // the wall. Net displacement zero. Traced: he correctly rounded three sides of
    // this ring and then bounced between two tiles ~8 tiles short of the hole, for
    // the entire remaining raid, attacking nothing.
    //
    // The breach is on the OPPOSITE side from the drop on purpose: a gap on the
    // straight line is walked through by the plain movement code and proves nothing.
    resetIds();
    const ring = wallRing(6, 16, 3, 'w').filter((w) => !(w.tx === 6 && w.ty === 8));
    const r = simulateRaid(
      {
        ...base([
          b(BuildingType.Keep, 10, 10, 5, 'keep'),
          b(BuildingType.Cannon, 12, 9, 3, 'cannon'),
          ...ring,
        ], 5),
        claimMin: 2, claimMax: 20,
      },
      { deploys: [], heroDeploys: [{ hero: 'theodor', tx: 20, ty: 8, tMs: 0, level: 1 }] },
      7,
    );
    const id = (r.events.find((e) => e.e === 'deploy') as { id: number }).id;
    const pos = r.events.filter((e) => e.e === 'pos' && (e as { id: number }).id === id) as
      Array<{ x: number; y: number }>;
    const last = pos.at(-1)!;
    const tile = { x: Math.floor(last.x / 256), y: Math.floor(last.y / 256) };
    // Strictly INSIDE the ring — he got through the hole rather than dying outside it.
    expect(tile.x).toBeGreaterThan(6);
    expect(tile.x).toBeLessThan(16);
    expect(tile.y).toBeGreaterThan(6);
    expect(tile.y).toBeLessThan(16);
    // And the ring is intact: he routed, he did not chew his way in. Under the bug
    // this was false in the other direction — he never damaged anything at all.
    expect(r.buildings.filter((x) => x.id.startsWith('w_')).every((w) => !w.destroyed)).toBe(true);
  });
});

describe('hero damage is deci-per-TICK, like every troop', () => {
  it('an L1 hero deals its published DPS, not ten times it', () => {
    // THE BUG: heroes were spawned with `dpsDeci: HERO_LEVELING.dps[...] * 10`, but
    // `dpsDeci` is deci-damage per 100ms TICK (stats.ts) — numerically the dps
    // figure, which is how every troop is built. So both heroes hit for 10x their
    // stat for the whole of D4a/D4b, while apps/api/src/game/heroes.ts served the
    // player the honest number. Found by watching a 1200 hp t3 wall die in 13 ticks.
    //
    // Measured end-to-end: seal a keep behind a ring so Theodor must chew one
    // segment with his ordinary attack, and time it.
    resetIds();
    const wallHp = buildingMaxHp(BuildingType.Wall, 3);
    const r = simulateRaid(
      { ...base([b(BuildingType.Keep, 11, 11, 1, 'keep'), ...wallRing(4, 20, 3, 'w')]), claimMin: 4, claimMax: 21 },
      { deploys: [], heroDeploys: [{ hero: 'theodor', tx: 0, ty: 11, tMs: 0, level: 1 }] },
      7,
    );
    const down = r.events.find((e) => e.e === 'destroyed' && String(e.id).startsWith('w_')) as { t: number };
    expect(down).toBeDefined();
    const dps = HERO_LEVELING.dps.theodor[0]!;
    const chewTicks = (wallHp / dps) * TICKS_PER_SEC; // ticks of chewing at the true rate
    // He walks in first, so the real tick is at least the chew time; the point is
    // that it is nowhere near a tenth of it, which is where the x10 bug put it.
    expect(down.t).toBeGreaterThanOrEqual(chewTicks);
    expect(down.t).toBeLessThan(chewTicks * 1.5);
  });
});

// ===========================================================================
// D-099 (owner 2026-09-02, SIM_VERSION 12) — WALLS ARE DECISIVE.
// "Giants/Theodor turn back at walls": a 90-second battle cannot afford a
// unit that changes its mind at masonry. Root cause A was the cost field
// itself — a wall hugging the target was a GOAL tile, so the building read as
// open from outside and a blocked unit walked the perimeter toward a gap that
// did not exist.
// ===========================================================================
describe('D-099 — a wall hugging the target is not a gap', () => {
  it('costField: a goal hugged by live walls prices every outside tile at WALL_COST or more', () => {
    // 5×5 grid, the footprint tile (2,2) is the only goal and masonry sits on
    // its four sides. Cost is paid to ENTER a tile, so with the walls kept OUT
    // of the goal set the seal is visible from anywhere outside. Had the hugging
    // walls been goals (the pre-SIM12 shape of goalTilesFor) the tile beside
    // them would read 1 — "open" — and stepThroughGap would send a blocked unit
    // walking toward it.
    const size = 5;
    const wallIndex = new Int32Array(size * size).fill(-1);
    for (const [x, y] of [[1, 2], [3, 2], [2, 1], [2, 3]] as const) wallIndex[y * size + x] = 0;
    const f = costField({ size, wallIndex }, [2 * size + 2]);
    expect(f[2 * size + 1]).toBe(WALL_COST);                 // the wall tile: one wall entered
    expect(f[2 * size + 0]).toBeGreaterThanOrEqual(WALL_COST); // beside it: sealed
    expect(f[0]).toBeGreaterThanOrEqual(WALL_COST);            // a corner: no diagonal squeeze
    // The leak, spelled out: walls as goals make the same layout read open.
    const leaky = costField({ size, wallIndex },
      [2 * size + 2, 2 * size + 1, 2 * size + 3, 1 * size + 2, 3 * size + 2]);
    expect(leaky[2 * size + 0]).toBe(1);
  });

  it('a blocked Troll attacks the segment that blocks it on that tick — never walks to another side', () => {
    // A 2×2 Keep hugged on every adjacent tile, behind a PARTIAL outer line that
    // crosses the Troll's straight path. Pre-SIM12 the hugged Keep's field said
    // "open" (the hug ring was the goal set), so the Troll routed around the
    // outer line, walked north, and only then found the hug ring — a perimeter
    // walk to a wall no better than the one in front of him. Now the Keep is
    // sealed on the field, and the outer segment on his row is the breach.
    resetIds();
    const outer = [7, 8, 9, 10, 11, 12, 13].map((y) => b(BuildingType.Wall, 6, y, 1, `outer_${y}`));
    const r = simulateRaid(
      { ...base([b(BuildingType.Keep, 10, 10, 1, 'keep'), ...wallRing(9, 12, 1, 'hug'), ...outer]),
        claimMin: 2, claimMax: 16 },
      orders([deploy('troll', 0, 10)]), 42);
    const runs = r.events.filter((e) => e.e === 'attackRun' && e.id === 0) as
      Array<Extract<SimEvent, { e: 'attackRun' }>>;
    expect(runs.length).toBeGreaterThan(0);
    // The FIRST thing he hits is the outer segment on his own row …
    expect(runs[0]!.target).toBe('outer_10');
    // … on the tick he is blocked: the last keyframe before the swing is at
    // most one keyframe cadence old, so he never wandered before deciding.
    const posBefore = r.events.filter((e) => e.e === 'pos' && e.id === 0 && e.t <= runs[0]!.t) as
      Array<{ t: number; x: number; y: number }>;
    expect(runs[0]!.t - posBefore.at(-1)!.t).toBeLessThan(5);
    // And every keyframe he ever emitted stays on row 10: no walk around the line.
    const all = r.events.filter((e) => e.e === 'pos' && e.id === 0) as Array<{ x: number; y: number }>;
    expect(all.every((p) => unitToTile(p.y) === 10)).toBe(true);
    // The outer segment falls before any hug segment is so much as scratched.
    const outerDown = r.events.find((e) => e.e === 'destroyed' && e.id === 'outer_10')!;
    expect(outerDown).toBeDefined();
    expect(r.events.some((e) => e.e === 'hit' && String(e.target).startsWith('hug_') && e.t < outerDown.t)).toBe(false);
  });
});

describe('D-099 — a blocked unit decides ONCE, breach or detour, and commits', () => {
  /**
   * A T2 ring (6..16) with one Cannon inside at (11,11) and a single gap. The
   * unit is dropped due west on row 11, walks straight into w_6_11 and prices
   * its two answers THERE, in ticks, from decideAtWall's own integer arithmetic:
   *   giant   21 units/tick, 110 deci/tick vs walls (55 × buildingDamageMult 2)
   *           breach w_6_11 = 0 walk + ceil(6000/110) = 55 + 5 tiles after (61) = 116
   *   theodor 17 units/tick, 38 deci/tick, no multiplier
   *           breach w_6_11 = 0 walk + ceil(6000/38) = 158 + 5 tiles after (76) = 234
   * The detour is the wall-free field distance to the Cannon's goal tiles:
   *   gap at (11,6), the north wall — 12 tiles of walking from the drop row —
   *           17 tiles: giant 208, theodor 256 → BREACH for both
   *   gap at (6,9), two rows up the same wall — 8 tiles: giant 98 → DETOUR
   * Why it matters: the pre-SIM12 branch re-ran the gap check every tick and
   * re-elected the side breach, so a unit could step toward a gap, be pulled
   * back to the wall, and step out again — in a 90 s battle every reversal is
   * stage time the army never gets back.
   */
  const ringWithGap = (gapX: number, gapY: number) => {
    resetIds();
    return {
      ...base([
        b(BuildingType.Cannon, 11, 11, 1, 'cannon'),
        ...wallRing(6, 16, 2, 'w').filter((w) => !(w.tx === gapX && w.ty === gapY)),
      ], 3),
      claimMin: 2, claimMax: 20,
    };
  };
  type R = ReturnType<typeof simulateRaid>;
  const posOf = (r: R, id: number) =>
    r.events.filter((e) => e.e === 'pos' && e.id === id) as Array<{ t: number; x: number; y: number }>;
  const wallTargets = (r: R, id: number): string[] => r.events
    .filter((e) => (e.e === 'attackRun' || e.e === 'heroAttack') && e.id === id
      && e.targetKind === 'building' && String(e.target).startsWith('w_'))
    .map((e) => String((e as { target: unknown }).target));
  const wallsIntact = (r: R): boolean =>
    r.buildings.filter((x) => x.id.startsWith('w_')).every((w) => w.hp === w.maxHp);

  it('(a) the Giant breaches the wall in front of him when the gap is 12 tiles away — and never leaves it', () => {
    const r = simulateRaid(ringWithGap(11, 6), orders([deploy('giant', 0, 11)]), 7);
    const targets = wallTargets(r, 0);
    expect(targets[0]).toBe('w_6_11');
    expect(new Set(targets).size).toBe(1); // one segment, start to finish
    const down = r.events.find((e) => e.e === 'destroyed' && e.id === 'w_6_11')!;
    expect(down).toBeDefined();
    // Every keyframe up to the breach is on his own row, west of the ring: he
    // walked in, stopped, and chewed. No step toward the north gap, ever.
    expect(posOf(r, 0).filter((p) => p.t <= down.t)
      .every((p) => unitToTile(p.y) === 11 && unitToTile(p.x) <= 5)).toBe(true);
    expect(r.buildings.find((x) => x.id === 'cannon')!.destroyed).toBe(true);
  });

  it('(b) the same Giant detours through a gap 2 tiles away and never chews', () => {
    const r = simulateRaid(ringWithGap(6, 9), orders([deploy('giant', 0, 11)]), 7);
    expect(wallTargets(r, 0)).toHaveLength(0);
    expect(wallsIntact(r)).toBe(true);
    // He went through THE gap (tile (6,9)), then finished the gun.
    expect(posOf(r, 0).some((p) => unitToTile(p.x) === 6 && unitToTile(p.y) === 9)).toBe(true);
    expect(r.buildings.find((x) => x.id === 'cannon')!.destroyed).toBe(true);
  });

  it('(c) Theodor decides like the Giant — breach, and no following of a moving ally', () => {
    // SIM6/7 kept a hero-only habit: blocked, he walked toward the nearest
    // "opener" wherever it was going. D-099 gives him the same priced decision.
    const r = simulateRaid(ringWithGap(11, 6),
      { deploys: [], heroDeploys: [{ hero: 'theodor', tx: 0, ty: 11, tMs: 0, level: 1 }] }, 7);
    // The committed breach publishes the same truthful hero body cue as an
    // ordinary building swing; damage remains in attackBlockingWall itself.
    const attacks = r.events.filter((e) => e.e === 'heroAttack' && e.id === 0
      && e.target === 'w_6_11') as Array<Extract<SimEvent, { e: 'heroAttack' }>>;
    expect(attacks.length).toBeGreaterThan(1);
    expect(attacks.every((e) => e.targetKind === 'building'
      && e.recoveryUntil > e.t)).toBe(true);
    // The ONE segment that fell is the one in front of him, and he stood on his
    // row until it did. Cheek Quake scuffs neighbours; none of them falls.
    const down = r.events.find((e) => e.e === 'destroyed' && e.id === 'w_6_11')!;
    expect(down).toBeDefined();
    expect(r.buildings.filter((x) => x.id.startsWith('w_') && x.destroyed).map((x) => x.id)).toEqual(['w_6_11']);
    expect(posOf(r, 0).filter((p) => p.t <= down.t)
      .every((p) => unitToTile(p.y) === 11 && unitToTile(p.x) <= 5)).toBe(true);
    const afterBreach = posOf(r, 0).filter((p) => p.t > down.t);
    expect(afterBreach.some((p) => unitToTile(p.x) > 6)).toBe(true);
    expect(r.events.some((e) => e.e === 'heroAttack' && e.id === 0
      && e.target === 'cannon' && e.t > down.t)).toBe(true);
    expect(r.buildings.find((x) => x.id === 'cannon')!.destroyed).toBe(true);
  });

  it('(d) four blocked units join the NEAREST live breach, not the lowest troop id\'s', () => {
    // Two trolls open the north and south walls of a T1 ring on the same tick;
    // four highlanders dropped five seconds later, two per side, are blocked on
    // the tile beside each hole-in-progress. SIM7 published ONE breach per side
    // — the lowest id's, the north troll's — and sent all four north, a 10-tile
    // walk for the south pair. D-099 prices joining the NEAREST breach (a
    // half-chewed segment in reach beats a fresh one), so each pair joins its
    // own side's troll and both holes open sooner.
    resetIds();
    const snap = {
      ...base([b(BuildingType.Keep, 11, 11, 1, 'keep'), ...wallRing(6, 16, 1, 'w')], 3),
      claimMin: 2, claimMax: 20,
    };
    const r = simulateRaid(snap, orders([
      deploy('troll', 11, 0, 0), deploy('troll', 11, 22, 0),
      deploy('highlander', 10, 0, 5_000), deploy('highlander', 12, 0, 5_000),
      deploy('highlander', 10, 22, 5_000), deploy('highlander', 12, 22, 5_000),
    ]), 42);
    // Ids follow the sim's (tMs, tx, ty) deploy order, so read each unit's side
    // off its own deploy event rather than assuming the order written above.
    const deploys = r.events.filter((e) => e.e === 'deploy') as Array<{ id: number; y: number }>;
    expect(deploys).toHaveLength(6);
    for (const d of deploys) {
      const side = unitToTile(d.y) < 11 ? 'w_11_6' : 'w_11_16';
      expect(wallTargets(r, d.id)[0], `unit ${d.id}`).toBe(side);
    }
    expect(r.buildings.find((x) => x.id === 'keep')!.destroyed).toBe(true);
  });

  it('(e) a defence-seeker breaches toward a sealed Cannon before touching an open Keep', () => {
    // The Giant's role is the guns (aiTarget 'defenses'). SIM7 let a sealed
    // favourite fall through to the nearest REACHABLE ordinary building, so a
    // Giant dropped beside an open Keep turned his back on the Cannon shelling
    // him — the fallback is now for when no defence stands.
    resetIds();
    const snap = {
      ...base([
        b(BuildingType.Keep, 2, 11, 1, 'keep'),      // open, on the drop row
        b(BuildingType.Cannon, 11, 11, 1, 'cannon'), // sealed in a T2 ring
        ...wallRing(6, 16, 2, 'w'),
      ], 3),
      claimMin: 2, claimMax: 20,
    };
    const r = simulateRaid(snap, orders([deploy('giant', 0, 11)]), 7);
    const cannonDown = r.events.find((e) => e.e === 'destroyed' && e.id === 'cannon')!;
    expect(cannonDown).toBeDefined();
    expect(wallTargets(r, 0)[0]).toBe('w_6_11');
    expect(r.events.some((e) => e.e === 'hit' && e.target === 'keep' && e.t < cannonDown.t)).toBe(false);
    // Once no defence stands, the Keep is his target again.
    expect(r.buildings.find((x) => x.id === 'keep')!.hp).toBeLessThan(
      r.buildings.find((x) => x.id === 'keep')!.maxHp);
  });

  it('(f) N deploys with the same tMs land on one tick and each emits its first pos on that tick', () => {
    // D-099 "deploys start together": the client used to stamp pre-battle
    // orders tMs = index × 150 ms (P4 removes that). The sim never staggered —
    // this pins the contract the client now relies on, at tick 0 and again at
    // a mid-battle keyframe tick, so a "spread the crowd" tweak cannot land
    // here unnoticed.
    for (const tMs of [0, 500]) {
      resetIds();
      const r = simulateRaid(base([b(BuildingType.Keep, 14, 14, 1, 'keep')]),
        orders(Array.from({ length: 6 }, (_, i) => deploy('highlander', 0, 10 + i, tMs))), 42);
      const tick = tMs / 100;
      const deploys = r.events.filter((e) => e.e === 'deploy') as Array<{ t: number; id: number }>;
      expect(deploys).toHaveLength(6);
      expect(deploys.every((e) => e.t === tick)).toBe(true);
      for (const d of deploys) {
        expect(posOf(r, d.id)[0]?.t, `unit ${d.id} at ${tMs}ms`).toBe(tick);
      }
    }
  });
});

describe('SIM14 — a hero\'s basic swing on a building publishes the hit it applies', () => {
  // WHY (tester report, build cee3869/SIM13, 2026-09-04): "hero attacks happen
  // but … the target building HP bar does not visibly decrease, but the
  // building eventually gets destroyed. This makes the hero look completely
  // idle even though damage is being applied in the background." Every other
  // building-damage path (troop impacts, skills, splash, chain, burn, DoT)
  // records a `hit`; the hero's ordinary swing and its committed wall chew
  // called damageBuilding directly, and `heroAttack` carries no amount. The
  // client's building HP mirror (BattleScene.onHit) moves on `hit` ONLY, so a
  // hero-only assault kept the bar full until `destroyed`. These tests pin the
  // contract the renderer relies on: a swing's damage is always published,
  // published as the sim's own accounting, and published without changing
  // anything else about the fight.
  type Swing = Extract<SimEvent, { e: 'heroAttack' }>;
  type Hit = Extract<SimEvent, { e: 'hit' }>;
  type R = ReturnType<typeof simulateRaid>;
  const swingsOn = (r: R, target: string): Swing[] => r.events.filter((e): e is Swing =>
    e.e === 'heroAttack' && e.targetKind === 'building' && e.target === target);
  /** The `hit` a swing publishes: the very next record, same tick and target. */
  const hitOf = (r: R, swing: Swing): Hit => {
    const next = r.events[r.events.indexOf(swing) + 1];
    expect(next, `swing at t=${swing.t} on ${String(swing.target)} must publish its hit`)
      .toMatchObject({ e: 'hit', t: swing.t, target: swing.target });
    return next as Hit;
  };
  /**
   * BattleScene.onHit's mirror, verbatim: hp = max(0, hp − dmg) per `hit` in
   * log order. The tester's expectation is exactly that this mirror empties at
   * the tick the sim declares `destroyed` — never before, never after.
   */
  const expectMirrorEmptiesAtDestroyed = (r: R, id: string): void => {
    let hp = r.buildings.find((x) => x.id === id)!.maxHp;
    let emptiedAt = -1;
    for (const e of r.events) {
      if (e.e === 'hit' && e.target === id) {
        expect(e.dmg, `hit on ${id} at t=${e.t}`).toBeGreaterThan(0);
        hp = Math.max(0, hp - e.dmg);
        if (hp === 0 && emptiedAt < 0) emptiedAt = e.t;
      }
      if (e.e === 'destroyed' && e.id === id) {
        expect(hp, `${id} mirror when the sim destroys it`).toBe(0);
        expect(emptiedAt, `${id} mirror must empty on the destroying tick`).toBe(e.t);
        return;
      }
    }
    throw new Error(`${id} was never destroyed`);
  };
  const outcomeFp = (r: R): string => fnv1a(JSON.stringify({
    stars: r.stars, destructionPct: r.destructionPct, ticks: r.ticks, buildings: r.buildings,
  }));
  const gearedLoadout = (overrides: Partial<HeroCombatModifiers>): HeroCombatLoadout => ({
    catalogRevision: INVENTORY.catalogRevision, version: 1, hash: 'sim14-swing-hit',
    modifiers: { ...Object.fromEntries(GEAR_MODIFIER_STATS.map((stat) => [stat, 0])), ...overrides } as HeroCombatModifiers,
  });

  it('(a) Vex alone vs a cannon and the keep: every swing publishes a same-tick hit and the mirror empties exactly at `destroyed`', () => {
    resetIds();
    const r = simulateRaid(
      base([b(BuildingType.Keep, 20, 20, 1, 'keep'), b(BuildingType.Cannon, 24, 20, 1, 'gun')]),
      orders([], { heroDeploys: [{ hero: 'vex', tx: 30, ty: 20, tMs: 0, level: 1 }] }), 7,
    );
    for (const id of ['gun', 'keep']) {
      const swings = swingsOn(r, id);
      expect(swings.length, `${id} takes hero swings`).toBeGreaterThan(0);
      for (const swing of swings) hitOf(r, swing);
      expectMirrorEmptiesAtDestroyed(r, id);
    }
    // The amount is the sim's own accounting, never a client re-derivation:
    // an ungeared, unbuffed L1 Vex swings for dps × recovery ticks.
    expect(hitOf(r, swingsOn(r, 'gun')[0]!).dmg).toBe(Math.round(
      (HERO_LEVELING.dps.vex[0]! * HERO_COMBAT.vex.attackRecoveryDeciSec) / 10,
    ));
    // Render-only. Both values were captured on SIM13 for this exact scenario:
    // strip each swing's adjacent hit and the SIM13 log returns byte for byte,
    // and the outcome (stars, %, ticks, every building's HP) never moved.
    expect(fnv1a(JSON.stringify(withoutHeroSwingHits(r.events)))).toBe('13f3364d');
    expect(outcomeFp(r)).toBe('c5b71bcd');
  });

  it('(b) Theodor alone vs a sealed ring: the committed wall chew publishes a hit per swing and the segment empties exactly when it falls', () => {
    // The SIM13 cue fires every chew tick (attackBlockingWall); each one now
    // carries its applied damage, so the client sees the segment wear down
    // instead of standing at full HP for the whole breach.
    resetIds();
    const r = simulateRaid(
      base([b(BuildingType.Keep, 20, 20, 1, 'keep'), ...wallRing(17, 24, 1, 'w')]),
      orders([], { heroDeploys: [{ hero: 'theodor', tx: 30, ty: 20, tMs: 0, level: 1 }] }), 7,
    );
    const chewed = [...new Set(r.events
      .filter((e): e is Swing => e.e === 'heroAttack' && e.targetKind === 'building'
        && String(e.target).startsWith('w_'))
      .map((e) => String(e.target)))];
    expect(chewed, 'he commits to ONE segment').toHaveLength(1);
    const wall = chewed[0]!;
    const swings = swingsOn(r, wall);
    expect(swings.length).toBeGreaterThan(1);
    for (const swing of swings) hitOf(r, swing);
    expectMirrorEmptiesAtDestroyed(r, wall);
    expectMirrorEmptiesAtDestroyed(r, 'keep');
    expect(fnv1a(JSON.stringify(withoutHeroSwingHits(r.events)))).toBe('606e60ad');
    expect(outcomeFp(r)).toBe('8e648a7f');
  });

  it('(c) a levelled, geared Vex: the published amount is the gear-adjusted one, so the mirror still empties at `destroyed`', () => {
    // K-032 documents a hero max-HP mirror that ignores gear; the damage side
    // must not repeat that. The hit carries what the sim applied (hero_damage_bps
    // included), which is the only way the client can stay exact without ever
    // learning the loadout.
    const run = (loadout?: HeroCombatLoadout): R => {
      resetIds();
      return simulateRaid(
        base([
          b(BuildingType.Keep, 20, 20, 3, 'keep'),
          b(BuildingType.Mine, 24, 20, 2, 'mine'),
          b(BuildingType.Vault, 16, 20, 2, 'vault'),
        ], 3),
        orders([], { heroDeploys: [{ hero: 'vex', tx: 30, ty: 20, tMs: 0, level: 12,
          ...(loadout ? { loadout } : {}) }] }), 3,
      );
    };
    const plain = run();
    const geared = run(gearedLoadout({ hero_damage_bps: INVENTORY.modifierCapsBps.hero_damage_bps }));
    for (const r of [plain, geared]) {
      for (const id of ['mine', 'vault', 'keep']) {
        const swings = swingsOn(r, id);
        expect(swings.length, `${id} takes hero swings`).toBeGreaterThan(0);
        for (const swing of swings) hitOf(r, swing);
        expectMirrorEmptiesAtDestroyed(r, id);
      }
    }
    const firstMineHit = (r: R): number => hitOf(r, swingsOn(r, 'mine')[0]!).dmg;
    expect(firstMineHit(geared)).toBeGreaterThan(firstMineHit(plain));
    // The ungeared L12 scenario was captured on SIM13 as well.
    expect(fnv1a(JSON.stringify(withoutHeroSwingHits(plain.events)))).toBe('0db6a597');
    expect(outcomeFp(plain)).toBe('be5059cb');
  });
});
