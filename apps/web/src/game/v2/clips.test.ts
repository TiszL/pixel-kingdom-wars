/**
 * The rework-v2 clip registry — pure math over the packed v2Clips sidecar.
 *
 * Worth pinning because every consumer failure is SILENT in a browser: a
 * mis-built frame name draws NOTHING (Phaser does not error on a missing
 * frame), a wrong facing row draws the unit marching sideways, a wrong
 * heading row flies a shell fuse-first, and a mis-read emitter fires the
 * muzzle flash out of the masonry. The 'meta.json ground truth' block at the
 * bottom asserts the manifest facts the renderers rely on against the REAL
 * built sidecar, so the synthetic fixtures here cannot drift from the pack.
 */
import { existsSync, readFileSync } from 'node:fs';
import { ART_V2, DEFENSES } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import { footprintOf } from '../fx/stats';
import {
  clipFrames, clipKey, emitterAxis, emitterPoint, facing8, facing8Stable,
  facingRow, frameName, headingRow, parseFxAt, PROJ_Y_FORESHORTEN, shadowFrame, v2BldSeat,
  V2_BLD_FOOTPRINT, V2_DIRS, V2_DRAW_SCALE, V2_PROJ,
  type Facing8, type V2Clip,
} from './clips';

const GRID: V2Clip = { frames: 6, rows: 8, cellW: 112, cellH: 112 };
const STRIP: V2Clip = { frames: 4, rows: 1, cellW: 76, cellH: 76 };

describe('frame keys', () => {
  it('multi-row sheets key `_d<row>_f<col+1>`, single-row `_f<n>` — the packer contract', () => {
    expect(frameName('v2_trp_giant_t1_walk', GRID, 0, 1)).toBe('v2_trp_giant_t1_walk_d0_f1');
    expect(frameName('v2_trp_giant_t1_walk', GRID, 3, 2)).toBe('v2_trp_giant_t1_walk_d3_f2');
    // A `_d0` fabricated onto a single-row clip names a frame the packer
    // never emitted — invisible impact, no error.
    expect(frameName('v2_fx_impact_crater_t2', STRIP, 5, 3)).toBe('v2_fx_impact_crater_t2_f3');
  });

  it('clamps row and frame to the clip shape instead of naming missing frames', () => {
    expect(frameName('x', GRID, 99, 99)).toBe('x_d7_f6');
    expect(frameName('x', GRID, -1, 0)).toBe('x_d0_f1');
  });

  it('builds clip base keys and full row sequences', () => {
    expect(clipKey('bld', 'cannon', 2, 'fire')).toBe('v2_bld_cannon_t2_fire');
    expect(clipFrames('v2_trp_giant_t1_hit', { ...GRID, frames: 3 }, 2)).toEqual([
      'v2_trp_giant_t1_hit_d2_f1', 'v2_trp_giant_t1_hit_d2_f2', 'v2_trp_giant_t1_hit_d2_f3',
    ]);
  });
});

describe('facing rows (unit sheets)', () => {
  it('maps every one of the 8 facings through the manifest rowOrder', () => {
    // [s,sw,w,nw,n,ne,e,se] — DIR_YAW order, NOT the compass order a reader
    // would guess; a wrong index renders a unit walking sideways forever.
    const expected: Record<Facing8, number> = { s: 0, sw: 1, w: 2, nw: 3, n: 4, ne: 5, e: 6, se: 7 };
    for (const f of V2_DIRS) {
      expect(facingRow({ ...GRID, rowOrder: V2_DIRS }, f), f).toBe(expected[f]);
    }
  });

  it('derives the nearest facing from a screen delta (y grows DOWN)', () => {
    expect(facing8(1, 0)).toBe('e');
    expect(facing8(0, 1)).toBe('s'); // +y is DOWN on screen — south
    expect(facing8(0, -1)).toBe('n');
    expect(facing8(-1, 0)).toBe('w');
    expect(facing8(1, 1)).toBe('se');
    expect(facing8(-1, -1)).toBe('nw');
    expect(facing8(1, -1)).toBe('ne');
    expect(facing8(-1, 1)).toBe('sw');
  });

  it('holds the current facing across a wobbling near-boundary heading (hysteresis)', () => {
    // A leg travelling ~22.5° off east sits exactly on the e/se boundary;
    // sub-pixel wobble flips plain facing8 every frame, and each flip
    // re-registers the walk row — the anim.ts "dizzy shuffle" bug. The stable
    // variant must hold whichever side it is on.
    const wobbleA = facing8Stable(100, 42, 'e'); // just past the boundary
    const wobbleB = facing8Stable(100, 40, 'e'); // just before it
    expect(wobbleA).toBe('e');
    expect(wobbleB).toBe('e');
    expect(facing8Stable(100, 42, 'se')).toBe('se'); // holds from the other side too
  });

  it('keeps facing on a zero/near-zero delta — atan2(0,0) must never flip west to east', () => {
    // K-029 (owner 2026-08-15): a tween tick landing exactly on its endpoint
    // fed (0,0), atan2 said 0° = east, and a west-walking actor flashed its
    // opposite-facing frame for one frame. No heading in the delta → no
    // facing change, for every current direction.
    for (const dir of ['e', 'se', 's', 'sw', 'w', 'nw', 'n', 'ne'] as const) {
      expect(facing8Stable(0, 0, dir)).toBe(dir);
      expect(facing8Stable(0.2, -0.2, dir)).toBe(dir); // sub-pixel jitter too
    }
  });

  it('still snaps promptly on a genuine turn', () => {
    expect(facing8Stable(0, 100, 'e')).toBe('s'); // 90° swing — well past any margin
    expect(facing8Stable(-100, 0, 'n')).toBe('w');
  });
});

describe('heading rows (travel sheets)', () => {
  it('matches all eight literal generated rows in screen-y-down coordinates', () => {
    expect(headingRow(1, 0)).toBe(0);    // east
    expect(headingRow(1, 1)).toBe(1);    // south-east
    expect(headingRow(0, 1)).toBe(2);    // south
    expect(headingRow(-1, 1)).toBe(3);   // south-west
    expect(headingRow(-1, 0)).toBe(4);   // west
    expect(headingRow(-1, -1)).toBe(5);  // north-west
    expect(headingRow(0, -1)).toBe(6);   // north
    expect(headingRow(1, -1)).toBe(7);   // north-east
  });

  it('dy MUST be foreshortened before asking for a row — raw dy is an octant off', () => {
    // The travel sets are drawn for the pack's 3/4 view: the labs call
    // headingRow(dx, dy * 0.25) (_src/_lab.js:269). Shipping raw dy looked
    // harmless — the axis cases above are identical either way — but it turns
    // every DIAGONAL shot a full octant, and diagonals are most shots.
    const dx = 100, dy = 100; // a 45° screen-space shot, down-right
    expect(headingRow(dx, dy)).toBe(1);                       // what raw dy said
    expect(headingRow(dx, dy * PROJ_Y_FORESHORTEN)).toBe(0);  // what the labs draw
    // Foreshortening pulls headings toward the horizontal, never past it: a
    // shot with ANY rightward component keeps a right-facing row.
    for (const d of [10, 50, 100, 400]) {
      const row = headingRow(dx, d * PROJ_Y_FORESHORTEN);
      expect([0, 1, 2]).toContain(row);
    }
  });
});

describe('emitters', () => {
  const clip: V2Clip = {
    ...GRID,
    emitters: {
      muzzle: [[[56, 90], [56, 89]], [[10, 20]]],
      axis: [[90, 92], [45]],
    },
  };

  it('reads the published point/axis for (row, frame) and clamps the frame', () => {
    expect(emitterPoint(clip, 'muzzle', 0, 1)).toEqual([56, 89]);
    expect(emitterPoint(clip, 'muzzle', 0, 99)).toEqual([56, 89]); // clamp, labs' attachA
    expect(emitterAxis(clip, 0, 0)).toBe(90);
    expect(emitterAxis(clip, 1, 5)).toBe(45);
  });

  it('accepts owner-named attachment tables beyond muzzle/maw', () => {
    const named: V2Clip = {
      ...GRID,
      emitters: { nock: [[[31, 42]]], staff: [[[60, 59]]] },
    };
    expect(emitterPoint(named, 'nock', 0, 0)).toEqual([31, 42]);
    expect(emitterPoint(named, 'staff', 0, 0)).toEqual([60, 59]);
  });

  it('falls back missing rows to row 0, and NO table to the cell centre', () => {
    expect(emitterPoint(clip, 'muzzle', 7, 0)).toEqual([56, 90]);
    // The giant ships NO emitter table — the manifest documents cell centre
    // as where his boulder leaves (the labs' fallback).
    expect(emitterPoint(GRID, 'muzzle', 0, 0)).toEqual([56, 56]);
    expect(emitterAxis(GRID, 0, 0)).toBe(0);
  });
});

describe('parseFxAt', () => {
  it('parses the three authored shapes: plus-chains, comma lists, ranges', () => {
    expect(parseFxAt('muzzle@2 + cannonball@2 + smoke@3')).toEqual([
      { fx: 'muzzle', frames: [3] },
      { fx: 'cannonball', frames: [3] },
      { fx: 'smoke', frames: [4] },
    ]);
    expect(parseFxAt('dust@1,5')).toEqual([{ fx: 'dust', frames: [2, 6] }]);
    expect(parseFxAt('breath@3-5')).toEqual([{ fx: 'breath', frames: [4, 5, 6] }]);
    expect(parseFxAt(null)).toEqual([]);
    expect(parseFxAt(undefined)).toEqual([]);
  });

  it('extracts expanded-pack cues from prose and double-dot ranges', () => {
    expect(parseFxAt('dust@1 at launch and dust@7 on landing')).toEqual([
      { fx: 'dust', frames: [2] },
      { fx: 'dust', frames: [8] },
    ]);
    expect(parseFxAt('firestorm@1..6 at the MAW + burnfield laid along the arc it swept'))
      .toEqual([{ fx: 'firestorm', frames: [2, 3, 4, 5, 6, 7] }]);
    expect(parseFxAt('keg_blast@1 at the KEG emitter')).toEqual([
      { fx: 'keg_blast', frames: [2] },
    ]);
    expect(parseFxAt('ten barrowlings spawn at the HATCH, f2..f5')).toEqual([]);
  });

  /**
   * WHY the shift exists, not just that it does. The pack's fxAt numbers are
   * 0-BASED frame indices while V2Ticker.onFrame reports 1-based frame numbers,
   * so a parser that returned them verbatim fires every keyed effect ONE FRAME
   * EARLY and — because the callers read the emitter table at `frame1 - 1` —
   * off the WRONG row of that table: the cannon's flash lands ~6px off the
   * mouth, the ball leaves before ignition, the boulder is released at wind-up,
   * the breath assembles before the jaw opens, and the giant's walk dust puffs
   * on registration. All of it invisible to a typecheck.
   *
   * The ground truth is the manifest's own emitter table (asserted against the
   * REAL built meta in the ground-truth block below): the cannon's west-row
   * muzzle x runs 36 → 36.5 → 41.6 → 40.1 → 37.9 → 36.6, so FULL RECOIL — the
   * moment HANDOFF-V2 calls "f2 is ignition … all land together" — is at index
   * 2, the THIRD frame. `muzzle@2` must therefore resolve to frame number 3.
   */
  it('shifts the pack\'s 0-BASED indices to the ticker\'s 1-based frame numbers', () => {
    const [muzzle] = parseFxAt('muzzle@2');
    expect(muzzle!.frames).toEqual([3]);
    // The frame number the ticker reports, minus 1, is the emitter row index the
    // labs' attachA reads — i.e. the peak-recoil column. This round trip is the
    // whole contract, and it breaks in BOTH directions under an off-by-one.
    expect(muzzle!.frames[0]! - 1).toBe(2);
    // Frame 0 is expressible (a clip whose effect lands on its very first frame)
    // and must map to frame number 1, not 0 — onFrame never reports 0.
    expect(parseFxAt('dust@0')[0]!.frames).toEqual([1]);
  });
});

describe('projectile art facts', () => {
  it('pins the arc profiles the HANDOFF documents (not present in meta)', () => {
    // fireball flat; cannonball ~18% of range; boulder ~45%; shell ~55%.
    expect(V2_PROJ.fireball.arc).toBe(0);
    expect(V2_PROJ.cannonball.arc).toBe(0.18);
    expect(V2_PROJ.boulder.arc).toBe(0.45);
    expect(V2_PROJ.shell.arc).toBe(0.55);
    expect(V2_PROJ.arrow.arc).toBe(0.10);
    expect(V2_PROJ.bolt.arc).toBe(0.04);
    expect(V2_PROJ.hexshot.arc).toBe(0.12);
    // Labs' travel clocks: 10 ticks default, spit 9, boulder 11, shell 13.
    expect(V2_PROJ.cannonball.travelTicks).toBe(10);
    expect(V2_PROJ.fireball.travelTicks).toBe(9);
    expect(V2_PROJ.boulder.travelTicks).toBe(11);
    expect(V2_PROJ.shell.travelTicks).toBe(13);
    expect(V2_PROJ.arrow.travelTicks).toBe(10);
    expect(V2_PROJ.bolt.travelTicks).toBe(9);
    expect(V2_PROJ.hexshot.travelTicks).toBe(9);
    // Boulder lands as rubble, gunnery as craters; fireball's contact is the
    // breath/spit burn its owner fires.
    expect(V2_PROJ.boulder.impact).toBe('rubble');
    expect(V2_PROJ.cannonball.impact).toBe('crater');
    expect(V2_PROJ.shell.impact).toBe('crater');
    expect(V2_PROJ.fireball.impact).toBeNull();
    expect(V2_PROJ.arrow.impact).toBe('burn');
    expect(V2_PROJ.bolt.impact).toBe('bolt_hit');
    expect(V2_PROJ.hexshot.impact).toBe('crater');
    expect(V2_PROJ.arrow.shadow).toBe(true);
    expect(V2_PROJ.bolt.shadow).toBe(false);
  });

  it('picks the altitude-shadow column by lift: high→small(f1), mid(f2), low→large(f3)', () => {
    expect(shadowFrame(0.45)).toBe(1);
    expect(shadowFrame(0.2)).toBe(2);
    expect(shadowFrame(0.05)).toBe(3);
    // Boundary semantics are the labs' strict `>`.
    expect(shadowFrame(0.28)).toBe(2);
    expect(shadowFrame(0.12)).toBe(3);
  });
});

/**
 * Ground truth: the built meta.json really carries the manifest facts every
 * fixture above and every renderer relies on. If this fails and nothing else
 * does, the ART or the pipeline changed — not the registry.
 */
describe('meta.json ground truth (requires built assets)', () => {
  const metaUrl = new URL('../../../public/atlas/meta.json', import.meta.url);
  if (!existsSync(metaUrl)) {
    throw new Error(
      'apps/web/public/atlas/meta.json is not built — run `pnpm assets` first. ' +
      'The v2 renderers derive clip shapes from this file, so these tests ' +
      'refuse to pass without it (deliberately loud, not skipped).',
    );
  }
  const meta = JSON.parse(readFileSync(metaUrl, 'utf8')) as {
    v2Clips: Record<string, V2Clip & { fxAt?: string | null; travel?: boolean }>;
    breathStream: { minRange: number; tileWidth: number };
  };

  it('ships all 679 merged clips with DIR_YAW rowOrder on every multi-row unit sheet', () => {
    // Old-pack-first merging protects the already-live four while the expanded
    // owner delivery contributes the remaining roots; the union is 679 keys.
    expect(Object.keys(meta.v2Clips)).toHaveLength(679);
    for (const [key, c] of Object.entries(meta.v2Clips)) {
      if (c.rows > 1 && !c.travel) {
        expect(c.rowOrder, key).toEqual(['s', 'sw', 'w', 'nw', 'n', 'ne', 'e', 'se']);
      }
    }
  });

  it('carries the fxAt strings the controllers schedule from', () => {
    for (let t = 1; t <= 4; t++) {
      expect(meta.v2Clips[`v2_bld_cannon_t${t}_fire`]!.fxAt).toBe('muzzle@2 + cannonball@2 + smoke@3');
      expect(meta.v2Clips[`v2_bld_mortar_t${t}_fire`]!.fxAt).toBe('mortarflash@2 + shell@2');
      expect(meta.v2Clips[`v2_trp_giant_t${t}_throw`]!.fxAt).toBe('boulder@3');
      expect(meta.v2Clips[`v2_trp_dragon_t${t}_breath`]!.fxAt).toBe('breath@3-5');
    }
  });

  /**
   * The fxAt numbers are 0-BASED, proved against the ART rather than against a
   * reading of the docs. `muzzle@2` names the ignition frame, and ignition is the
   * frame of FULL RECOIL — so the muzzle emitter's displacement from its rest
   * position must be maximal exactly at the index the string names. Pinning the
   * STRING alone (above) cannot catch a basing flip; this can.
   */
  it('fxAt indices are 0-based: `muzzle@2` really is the peak-recoil frame', () => {
    for (const unit of ['cannon', 'mortar']) {
      const fire = meta.v2Clips[`v2_bld_${unit}_t1_fire`]!;
      const named = parseFxAt(fire.fxAt)[0]!.frames[0]!;   // 1-based, post-shift
      const idx = named - 1;                                // emitter table index
      for (let row = 0; row < 8; row++) {
        const g = fire.emitters!.muzzle![row]!;
        const rest = g[0]!;
        const away = g.map((p) => Math.hypot(p[0]! - rest[0]!, p[1]! - rest[1]!));
        const peak = away.indexOf(Math.max(...away));
        expect(peak, `${unit} row${row} peak recoil frame index`).toBe(idx);
      }
    }
  });

  /**
   * FACING ROWS vs the real art — the one thing nothing else pinned. `facingRow`
   * is fed by `facing8`, which works in SCREEN space where y is inverted
   * relative to math-y; an inverted sign (or a rowOrder read the wrong way
   * round) still typechecks and still yields eight distinct rows. It just
   * renders every unit facing backwards, silently.
   *
   * Ground truth is the manifest's MUZZLE table, which is a measurement of the
   * drawn frames: the generator projects the rig's mouth node through the same
   * camera the sprite is rendered with. The turret yaws about a fixed point, so
   * the mean of the 8 rows' mouth positions IS that pivot, and each row's offset
   * from it is where that row's weapon points ON SCREEN. (The `axis` table can't
   * serve here: the mortar publishes a near-vertical tube axis, −90 ± 18°, and
   * nothing about a ground bearing — "AIM is shown by TILT, not by pointing",
   * _mortar2.js. Nor can DIR_YAW in `_src/_pix2.js`, which is a WORLD yaw with
   * s=180/n=0, not a screen angle.)
   *
   * Tolerance 30°: comfortably inside a 45° sector, and an inverted or rotated
   * mapping misses by 90–180°.
   */
  it('facing rows point where facing8 says, measured against the drawn frames', () => {
    const deltas: Array<[number, number]> = [
      [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
    ];
    for (const unit of ['cannon', 'mortar']) {
      const fire = meta.v2Clips[`v2_bld_${unit}_t1_fire`] as V2Clip;
      const mouths = Array.from({ length: 8 }, (_, r) => emitterPoint(fire, 'muzzle', r, 0));
      const pivotX = mouths.reduce((s, p) => s + p[0], 0) / 8;
      const pivotY = mouths.reduce((s, p) => s + p[1], 0) / 8;
      const rows = new Set<number>();
      for (const [dx, dy] of deltas) {
        const facing = facing8(dx, dy);
        const row = facingRow(fire, facing);
        rows.add(row);
        const [mx, my] = mouths[row]!;
        const drawn = (Math.atan2(my - pivotY, mx - pivotX) * 180) / Math.PI;
        const want = (Math.atan2(dy, dx) * 180) / Math.PI;
        const diff = Math.abs(((drawn - want + 540) % 360) - 180);
        expect(diff, `${unit} ${facing} → row ${row}: art points ${drawn.toFixed(1)}°, heading is ${want}°`)
          .toBeLessThan(30);
      }
      expect(rows.size, `${unit}: all eight facings must land on distinct rows`).toBe(8);
    }
  });

  /**
   * The axis table's own SIGN convention, pinned so playV2MuzzleFx cannot flip
   * it again: degrees are SCREEN-space clockwise-positive, so the cannon's south
   * row reads +90 (barrel pointing down the screen) and its north row −90.
   * Phaser's rotation is clockwise-positive too, so the value goes in UNNEGATED
   * — negating it mirrored every flash about the horizon, which for the mortar
   * meant firing its flash down into its own plinth.
   */
  it('publishes screen-space clockwise-positive axis degrees', () => {
    const cannon = meta.v2Clips['v2_bld_cannon_t1_fire']!;
    expect(cannon.emitters!.axis![0]![0], 'cannon south row').toBeCloseTo(90, 0);
    expect(cannon.emitters!.axis![4]![0], 'cannon north row').toBeCloseTo(-90, 0);
    // The mortar is a near-vertical bombard: its axis is the TUBE, leaning a few
    // degrees toward the aim, so every row reads ≈ −90 = straight UP on screen.
    // Same sign convention, different weapon geometry — and the reason the
    // facing pin above cannot use this table.
    for (let r = 0; r < 8; r++) {
      expect(meta.v2Clips['v2_bld_mortar_t1_fire']!.emitters!.axis![r]![0], `mortar row${r}`)
        .toBeGreaterThan(-120);
      expect(meta.v2Clips['v2_bld_mortar_t1_fire']!.emitters!.axis![r]![0], `mortar row${r}`)
        .toBeLessThan(-60);
    }
  });

  /**
   * The v2 buildings' anchor is the CENTRE of the art's own ground quad, not a
   * ground line (`_src/_cannon2.js` / `_src/_mortar2.js` headers) — while the
   * TROOPS in the same pack anchor on their ground line. That asymmetry is why
   * the anchor is the ORIGIN and never the seat: `emitterWorld` measures every
   * muzzle as (emitter − anchor), so the origin must stay on the published
   * pixel, while WHERE the tower stands is buildingSeatY's one rule.
   */
  it('publishes the pack anchor as the v2 building origin, ground-line for troops', () => {
    for (const unit of ['cannon', 'mortar']) {
      const seat = v2BldSeat(meta.v2Clips, `v2_bld_${unit}_t1_idle_d0_f1`)!;
      expect(seat, unit).not.toBeNull();
      // The seat's scale is the pack conversion TIMES the unit's published
      // world fit. It used to be the bare conversion, and that is what drew
      // the Mortar and Cannon larger than the Keep (owner 2026-08-30): the v2
      // pack was the only one whose towers were never fitted to the base they
      // stand on. A bare V2_DRAW_SCALE here would let that ship again.
      expect(seat.scale, `${unit} scale`)
        .toBe(V2_DRAW_SCALE * ART_V2.buildingSourceScale[unit as 'cannon' | 'mortar']);
      expect(seat.scale, `${unit} scale`).toBeLessThan(V2_DRAW_SCALE);
      // (56,104) of 112×120 — read from the pack, never assumed.
      expect(seat.origin[0]).toBeCloseTo(56 / 112, 6);
      expect(seat.origin[1]).toBeCloseTo(104 / 120, 6);
    }
    // The eager Mortar aliases are pixel copies of this same protected clip,
    // so startup/eviction must preserve identical size, origin and seating.
    for (const tier of [1, 2, 3, 4]) {
      const fallback = v2BldSeat(
        meta.v2Clips, `v2_fallback_bld_mortar_t${tier}_idle_d0_f1`,
      )!;
      expect(fallback.scale)
        .toBe(V2_DRAW_SCALE * ART_V2.buildingSourceScale.mortar);
      expect(fallback.origin).toEqual(v2BldSeat(
        meta.v2Clips, `v2_bld_mortar_t${tier}_idle_d0_f1`,
      )!.origin);
    }
    // Every state of a building resolves — the battle controller cycles the
    // sprite through aim/fire/reload/damaged/collapse frames while it is seated.
    for (const state of ['aim', 'fire', 'reload', 'damaged']) {
      expect(v2BldSeat(meta.v2Clips, `v2_bld_cannon_t1_${state}_d3_f2`), state).not.toBeNull();
    }
    expect(v2BldSeat(meta.v2Clips, 'v2_bld_cannon_t1_collapse_f4')).not.toBeNull();
    // Troop and legacy keys are NOT this function's business.
    expect(v2BldSeat(meta.v2Clips, 'v2_trp_giant_t1_walk_d0_f1')).toBeNull();
    expect(v2BldSeat(meta.v2Clips, 'bld_cannon_l7')).toBeNull();
    // The pack really does anchor troops on a ground line, not a centre — the
    // asymmetry this whole seat concept encodes.
    expect(meta.v2Clips['v2_trp_giant_t1_walk']!.anchorPx).toEqual([56, 100]);
  });

  /** The GAME footprint the client uses must be the sim's, never the manifest's
   *  visual [2,2] — the locked owner decision that a cannon stays 1×1 and its
   *  bigger sprite merely overhangs the tile. Derived from shared DEFENSES, so
   *  this asserts the derivation still lands on the sim's numbers. */
  it('keeps the SIM footprints for the v2 buildings, not the visual ones', () => {
    expect(V2_BLD_FOOTPRINT['cannon']).toEqual([1, 1]);
    expect(V2_BLD_FOOTPRINT['mortar']).toEqual([2, 2]);
    expect(V2_BLD_FOOTPRINT['giant']).toBeUndefined(); // troops have no footprint
    // …and the manifest really does publish the WIDER visual footprint the
    // client must ignore, or this guard would be vacuous.
    expect(meta.v2Clips['v2_bld_cannon_t1_idle']!.footprint).toEqual([2, 2]);
  });

  it('anchors heavy impacts at the CONTACT POINT (38,52), and muzzle fx at their own anchors', () => {
    expect(meta.v2Clips['v2_fx_impact_crater_t1']!.anchorPx).toEqual([38, 52]);
    expect(meta.v2Clips['v2_fx_impact_rubble_t1']!.anchorPx).toEqual([38, 52]);
    expect(meta.v2Clips['v2_fx_muzzle_t1']!.anchorPx).toEqual([4, 16]);
    expect(meta.v2Clips['v2_fx_smoke_t1']!.anchorPx).toEqual([4, 16]);
    expect(meta.v2Clips['v2_fx_mortarflash_t1']!.anchorPx).toEqual([6, 18]);
  });

  it('publishes muzzle+axis tables for every cannon/mortar aim/fire/reload row×frame', () => {
    for (const unit of ['cannon', 'mortar']) {
      for (const state of ['aim', 'fire', 'reload']) {
        const c = meta.v2Clips[`v2_bld_${unit}_t1_${state}`]!;
        expect(c.emitters?.muzzle, `${unit} ${state}`).toHaveLength(8);
        expect(c.emitters?.axis, `${unit} ${state}`).toHaveLength(8);
        for (let r = 0; r < 8; r++) {
          expect(c.emitters!.muzzle![r], `${unit} ${state} row${r}`).toHaveLength(c.frames);
          expect(c.emitters!.axis![r], `${unit} ${state} row${r}`).toHaveLength(c.frames);
        }
      }
    }
  });

  it('building idle clips are 2 frames everywhere (the ambience pair relies on it)', () => {
    for (const unit of ['cannon', 'mortar']) {
      for (let t = 1; t <= 4; t++) {
        const c = meta.v2Clips[`v2_bld_${unit}_t${t}_idle`]!;
        expect(c.frames, `${unit} t${t}`).toBe(2);
      }
    }
  });

  it('troop locomotion/stand shapes back the patrol constants: walk/fly 8f, idle/hover 4f', () => {
    for (let t = 1; t <= 4; t++) {
      expect(meta.v2Clips[`v2_trp_giant_t${t}_walk`]!.frames, `giant t${t}`).toBe(8);
      expect(meta.v2Clips[`v2_trp_giant_t${t}_idle`]!.frames, `giant t${t}`).toBe(4);
      expect(meta.v2Clips[`v2_trp_dragon_t${t}_fly`]!.frames, `dragon t${t}`).toBe(8);
      expect(meta.v2Clips[`v2_trp_dragon_t${t}_hover`]!.frames, `dragon t${t}`).toBe(4);
    }
  });

  it('breathStream carries minRange 80 (below it the protected v2 one-piece plays)', () => {
    expect(meta.breathStream.minRange).toBe(80);
    expect(meta.breathStream.tileWidth).toBe(16);
  });

  it('travel sets are 8-heading sheets; collapse clips are single-row', () => {
    for (const kind of ['fireball', 'cannonball', 'boulder', 'shell']) {
      const c = meta.v2Clips[`v2_fx_${kind}_t1`]!;
      expect(c.travel, kind).toBe(true);
      expect(c.rows, kind).toBe(8);
    }
    for (const unit of ['cannon', 'mortar']) {
      expect(meta.v2Clips[`v2_bld_${unit}_t1_collapse`]!.rows, unit).toBe(1);
    }
  });
});

/**
 * THE FOOTPRINT DRIFT GUARD. Three tables describe one cannon's footprint, in
 * three different shapes, in three packages:
 *   - `DEFENSES.<unit>.footprint` (packages/shared) — the single source the repo
 *     law names, read by the SERVER (apps/api footprints.ts) and by the deed
 *     renderer's placement math;
 *   - `fx/stats.ts#footprintOf` — the client's copy of the SIM's own hand-written
 *     switch (`packages/sim/src/stats.ts`, which spells the numbers out rather
 *     than reading DEFENSES), and what BattleScene sizes/depths a building by;
 *   - `V2_BLD_FOOTPRINT` — what BaseScene seats and OCCUPIES a v2 building with,
 *     i.e. what decides whether a placement is even legal.
 * The block above pins the numbers. This pins that the three AGREE — the failure
 * nobody would ever see, because it is not a wrong picture but a base the client
 * lets you build and the sim then simulates differently. It is also exactly the
 * mistake this pack invites: its manifest publishes [2,2] for BOTH units.
 */
describe('v2 building footprints agree across every table that has one', () => {
  it('V2_BLD_FOOTPRINT === shared DEFENSES === the sim mirror, for cannon and mortar', () => {
    for (const unit of ['cannon', 'mortar'] as const) {
      const shared = DEFENSES[unit].footprint;
      expect(V2_BLD_FOOTPRINT[unit], `${unit} vs shared DEFENSES`).toEqual(shared);
      expect(footprintOf(unit), `${unit} vs the sim mirror`).toEqual([...shared]);
    }
    // …and the table covers exactly the v2 DEFENCES: the two units whose anchor
    // is a footprint centre. A troop appearing here would mean the derivation
    // started reading the wrong shared table.
    expect(Object.keys(V2_BLD_FOOTPRINT).sort()).toEqual([...ART_V2.buildings].sort());
    for (const unit of ART_V2.buildings) {
      expect(unit in V2_BLD_FOOTPRINT, unit)
        .toBe((ART_V2.buildingAnchorAtFootprintCentre as readonly string[]).includes(unit));
    }
  });
});
