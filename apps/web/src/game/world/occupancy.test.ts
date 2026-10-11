/**
 * The base's walking layers (villagers.ts, patrol.ts) are pure presentation, so
 * the thing worth pinning is the PROPERTY the owner reported broken on
 * 2026-07-29: "troops and heroes on base moving under buildings and walls".
 * A walker inside a footprint is, by the painter's-order depth rule the whole
 * scene is built on, drawn underneath that building — so "never inside a
 * footprint" is what makes the render correct. These tests assert that
 * invariant end-to-end (waypoint → route → every simulated step), not the
 * particular helper shapes, which are free to change.
 */
import { describe, expect, it } from 'vitest';
import { Occupancy } from './occupancy';

const T = 64;
/** feet position at the centre-bottom of tile (tx,ty) */
const at = (tx: number, ty: number): { x: number; y: number } => ({ x: (tx + 0.5) * T, y: (ty + 1) * T - 1 });

describe('Occupancy', () => {
  it('reports building tiles blocked and everything else free', () => {
    const occ = new Occupancy(T);
    occ.rebuild([{ tx: 5, ty: 5, fw: 2, fh: 2 }]);
    expect(occ.tileFree(5, 5)).toBe(false);
    expect(occ.tileFree(6, 6)).toBe(false);
    expect(occ.tileFree(7, 5)).toBe(true);
    expect(occ.tileFree(4, 5)).toBe(true);
  });

  it('only bumps version on a REAL change — a refresh that changes nothing must not re-route', () => {
    // Why: the layers key their teardown off this. A version that ticked on
    // every base:refresh would reset walkers mid-stride, which is exactly the
    // "hero is frozen on the dais" bug patrol.ts documents.
    const occ = new Occupancy(T);
    occ.rebuild([{ tx: 3, ty: 3, fw: 1, fh: 1 }]);
    const v = occ.version;
    occ.rebuild([{ tx: 3, ty: 3, fw: 1, fh: 1 }]);
    expect(occ.version).toBe(v);
    occ.rebuild([{ tx: 3, ty: 3, fw: 1, fh: 1 }, { tx: 9, ty: 9, fw: 1, fh: 1 }]);
    expect(occ.version).toBeGreaterThan(v);
  });

  it('pulls a waypoint that landed on a footprint out to free ground', () => {
    // A door whose tile got walled in must become a stop the walker can stand
    // on, not a standing order to walk into the wall.
    const occ = new Occupancy(T);
    occ.rebuild([{ tx: 5, ty: 5, fw: 2, fh: 2 }]);
    const p = occ.nearestFree({ x: 5.5 * T, y: 5.5 * T });
    expect(p).not.toBeNull();
    expect(occ.free(p!.x, p!.y)).toBe(true);
  });

  it('drops a waypoint that is buried deeper than the search radius', () => {
    const occ = new Occupancy(T);
    occ.rebuild([{ tx: 0, ty: 0, fw: 20, fh: 20 }]);
    expect(occ.nearestFree({ x: 10.5 * T, y: 10.5 * T })).toBeNull();
  });

  it('never routes a leg straight through a building — it bends around it', () => {
    const occ = new Occupancy(T);
    occ.rebuild([{ tx: 5, ty: 0, fw: 1, fh: 12 }]); // a long wall between the two doors
    const from = at(2, 6);
    const to = at(8, 6);
    const route = occ.route(from.x, from.y, to);
    // Straight across is not on offer …
    expect(occ.clearLine(from.x, from.y, to.x, to.y)).toBe(false);
    // … and if a route came back, every one of its legs is clear ground.
    if (route) {
      let cx = from.x, cy = from.y;
      for (const p of route) {
        expect(occ.clearLine(cx, cy, p.x, p.y)).toBe(true);
        cx = p.x; cy = p.y;
      }
      expect(route[route.length - 1]).toEqual(to);
    }
  });

  it('finds the GATE of a walled town — the case that froze the hero', () => {
    // Why this test exists: bases are walled, and the router's first cut (a
    // straight line, else one L-bend, else a parallel lane) could not find a
    // single gap in a wall ring. On the live base that left Theodor standing on
    // his altar forever. A route through a one-tile gate must be found.
    const occ = new Occupancy(T);
    const wall: Array<{ tx: number; ty: number; fw: number; fh: number }> = [];
    for (let i = 4; i <= 12; i++) {
      wall.push({ tx: i, ty: 4, fw: 1, fh: 1 });
      wall.push({ tx: i, ty: 12, fw: 1, fh: 1 });
      if (i !== 8) wall.push({ tx: 4, ty: i, fw: 1, fh: 1 }); // (4,8) is the gate
      wall.push({ tx: 12, ty: i, fw: 1, fh: 1 });
    }
    occ.rebuild(wall);
    const outside = at(1, 8);
    const inside = at(8, 8);
    const route = occ.route(outside.x, outside.y, inside)!;
    expect(route).not.toBeNull();
    let cx = outside.x, cy = outside.y;
    for (const p of route) {
      expect(occ.clearLine(cx, cy, p.x, p.y)).toBe(true); // every leg on free ground
      cx = p.x; cy = p.y;
    }
    expect(route[route.length - 1]).toEqual(inside);

    // …and with the gate bricked up, the honest answer is "you cannot".
    occ.rebuild([...wall, { tx: 4, ty: 8, fw: 1, fh: 1 }]);
    expect(occ.route(outside.x, outside.y, inside)).toBeNull();
  });

  it('returns null rather than a route into a sealed destination', () => {
    const occ = new Occupancy(T);
    // a closed 3×3 box: the centre is unreachable from outside
    occ.rebuild([
      { tx: 5, ty: 5, fw: 3, fh: 1 }, { tx: 5, ty: 7, fw: 3, fh: 1 },
      { tx: 5, ty: 6, fw: 1, fh: 1 }, { tx: 7, ty: 6, fw: 1, fh: 1 },
    ]);
    const from = at(2, 6);
    expect(occ.route(from.x, from.y, at(6, 6))).toBeNull();
  });

  it('walks a whole leg without ever standing inside a footprint', () => {
    // THE regression test for the owner's report: simulate the leg the way the
    // layers do (route, then advance frame by frame) and assert the feet are on
    // free ground at every single frame.
    const occ = new Occupancy(T);
    occ.rebuild([{ tx: 5, ty: 4, fw: 2, fh: 4 }]);
    const from = at(2, 6);
    const to = at(9, 6);
    const route = occ.route(from.x, from.y, to)!;
    expect(route).not.toBeNull();
    let x = from.x, y = from.y;
    let leg = 0;
    for (let frame = 0; frame < 4_000 && leg < route.length; frame++) {
      const target = route[leg]!;
      const next = occ.advance(x, y, target.x, target.y, 4);
      expect(next.moved).toBe(true);
      x = next.x; y = next.y;
      expect(occ.free(x, y)).toBe(true); // never inside the building
      if (x === target.x && y === target.y) leg++;
    }
    expect(leg).toBe(route.length); // and it actually arrives
  });

  it('lets a walker that a building went up on top of walk back out', () => {
    // Buildings are placed while the town is walking. Being caught inside one
    // must be escapable, or the unit is stuck in the wall forever.
    const occ = new Occupancy(T);
    occ.rebuild([{ tx: 5, ty: 5, fw: 1, fh: 1 }]);
    const inside = { x: 5.5 * T, y: 5.5 * T };
    const out = at(2, 5);
    const step = occ.advance(inside.x, inside.y, out.x, out.y, 8);
    expect(step.moved).toBe(true);
    expect(step.x).toBeLessThan(inside.x);
  });

  it('slides along a wall instead of grinding into it', () => {
    const occ = new Occupancy(T);
    occ.rebuild([{ tx: 5, ty: 5, fw: 1, fh: 1 }]);
    // heading down-right into the block's top-left corner: the free axis wins
    const from = { x: 5.4 * T, y: 4.9 * T };
    const next = occ.advance(from.x, from.y, 6.5 * T, 6.5 * T, 8);
    expect(next.moved).toBe(true);
    expect(occ.free(next.x, next.y)).toBe(true);
  });

  it('reuses one result record so a patrol frame allocates no movement objects', () => {
    const occ = new Occupancy(T);
    const first = occ.advance(0, 0, 100, 0, 4);
    const second = occ.advance(4, 0, 100, 0, 4);
    expect(second).toBe(first);
    expect(second).toEqual({ x: 8, y: 0, moved: true });
  });
});
