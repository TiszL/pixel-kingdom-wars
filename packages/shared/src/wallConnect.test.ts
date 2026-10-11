/**
 * Wall auto-connect (HANDOFF §3.4 + the 16-state upgrade, wallfixcon handout
 * 2026-07-26; four-tier M22 mapping owner 2026-08-15). These tests encode WHY the rule exists: walls must seam
 * pixel-exact without ever rotating a master, so the frame is derived from the
 * 4-neighborhood. The batch-11 art completed the family from 6 to all 16 masks —
 * junctions, run-ends, posts and crossings now have DEDICATED masters, so the
 * old "substitute a piece with a missing arm" fallbacks are gone: those exact
 * substitutions were the reported grass-gap bug (wallfixcon/img/reported.png).
 */
import { describe, expect, it } from 'vitest';
import { resolveWallFrames, wallFrame, wallShape } from './wallConnect';

const N = { n: true, e: false, s: false, w: false };

describe('wallShape — 4-neighborhood → 16-state family', () => {
  it('an isolated segment is a POST — no longer a fake straight with open ends', () => {
    expect(wallShape({ n: false, e: false, s: false, w: false })).toBe('post');
  });

  it('a run terminus is an END cap named by the direction the run CONTINUES', () => {
    expect(wallShape(N)).toBe('end_n');                                        // continues north
    expect(wallShape({ n: false, e: true, s: false, w: false })).toBe('end_e');
    expect(wallShape({ n: false, e: false, s: true, w: false })).toBe('end_s');
    expect(wallShape({ n: false, e: false, s: false, w: true })).toBe('end_w');
  });

  it('collinear pairs keep the through-wall sprite (unchanged from the 6-state family)', () => {
    expect(wallShape({ n: false, e: true, s: false, w: true })).toBe('straight'); // E+W
    expect(wallShape({ n: true, e: false, s: true, w: false })).toBe('ns'); // N+S
  });

  it('each perpendicular pair maps to its OUTER-ELBOW-quadrant frame (art convention, unchanged)', () => {
    // Verified against SHARDKEEP App.html hand-authored enclosures + the SVG
    // masters: a piece with N+E neighbours is the SW-position elbow, etc. The
    // handout explicitly preserves this trap — a regression here renders every
    // corner facing the wrong way (the 2026-07-19 bug).
    expect(wallShape({ n: true, e: true, s: false, w: false })).toBe('corner_sw'); // N+E
    expect(wallShape({ n: true, e: false, s: false, w: true })).toBe('corner_se'); // N+W
    expect(wallShape({ n: false, e: true, s: true, w: false })).toBe('corner_nw'); // S+E
    expect(wallShape({ n: false, e: false, s: true, w: true })).toBe('corner_ne'); // S+W
  });

  it('T-junctions select the TEE named by the BRANCH direction — the old dominant-axis fallback severed the branch', () => {
    expect(wallShape({ n: true, e: true, s: true, w: false })).toBe('tee_e');  // N–S run, branch east
    expect(wallShape({ n: false, e: true, s: true, w: true })).toBe('tee_s');  // E–W run, branch south
    expect(wallShape({ n: true, e: true, s: false, w: true })).toBe('tee_n');  // E–W run, branch north
    expect(wallShape({ n: true, e: false, s: true, w: true })).toBe('tee_w');  // N–S run, branch west
  });

  it('a 4-way junction is a CROSS', () => {
    expect(wallShape({ n: true, e: true, s: true, w: true })).toBe('cross');
  });

  it('the full mask table is total — every one of the 16 neighborhoods yields a shape', () => {
    // A hole in the table would render `wall5_tN_undefined_intact_f1` — an invisible
    // wall. Enumerate all 16 rather than trusting the spot checks above.
    for (let mask = 0; mask < 16; mask++) {
      const shape = wallShape({ n: !!(mask & 1), e: !!(mask & 2), s: !!(mask & 4), w: !!(mask & 8) });
      expect(shape, `mask ${mask}`).toBeTruthy();
    }
  });
});

describe('wallFrame — gameplay levels map to the five authored tiers without changing other buildings', () => {
  it('builds the exact atlas key per shape and four-level tier band', () => {
    expect(wallFrame({ n: false, e: true, s: false, w: true }, 6)).toBe('wall5_t2_straight_intact_f1');
    expect(wallFrame(N, 11)).toBe('wall5_t3_end_n_intact_f1');
    expect(wallFrame({ n: true, e: true, s: false, w: false }, 1)).toBe('wall5_t1_corner_sw_intact_f1'); // N+E → SW elbow
    expect(wallFrame({ n: true, e: true, s: true, w: true }, 7)).toBe('wall5_t2_cross_intact_f1');
    expect(wallFrame({ n: false, e: false, s: false, w: false }, 4)).toBe('wall5_t1_post_intact_f1');
  });

  it('clamps gameplay level and never requests a nonexistent sixth tier', () => {
    expect(wallFrame(N, 0)).toBe('wall5_t1_end_n_intact_f1');   // below floor → t1
    expect(wallFrame(N, 9)).toBe('wall5_t3_end_n_intact_f1');
    expect(wallFrame(N, 25)).toBe('wall5_t5_end_n_intact_f1');
  });
});

describe('resolveWallFrames — real layouts seam without gaps', () => {
  it('an L-ring: corner + straights + ns runs + PROPER end caps at the run ends', () => {
    // L-shape: a row along the top + a column down the left, meeting at (0,0).
    // Before batch 11 the two run-ends faked full straights/ns with open ends —
    // the exact reported bug. They are END caps now.
    const walls = [
      { id: 'c', tx: 0, ty: 0, tier: 6 }, // E + S neighbours → corner_nw (art convention)
      { id: 'e1', tx: 1, ty: 0, tier: 6 }, // top run: W + E → straight
      { id: 'e2', tx: 2, ty: 0, tier: 6 }, // top run terminus: only W → end_w cap
      { id: 's1', tx: 0, ty: 1, tier: 6 }, // left run: N + S → ns
      { id: 's2', tx: 0, ty: 2, tier: 6 }, // left run terminus: only N → end_n cap
    ];
    const frames = resolveWallFrames(walls);
    expect(frames.get('c')).toBe('wall5_t2_corner_nw_intact_f1');
    expect(frames.get('e1')).toBe('wall5_t2_straight_intact_f1');
    expect(frames.get('e2')).toBe('wall5_t2_end_w_intact_f1');
    expect(frames.get('s1')).toBe('wall5_t2_ns_intact_f1');
    expect(frames.get('s2')).toBe('wall5_t2_end_n_intact_f1');
  });

  it('the reported-bug shape: a wall spur off a run resolves to a TEE, not a severed straight', () => {
    // ═╦═ : horizontal run with a spur hanging south off the middle piece.
    const walls = [
      { id: 'w1', tx: 0, ty: 0, tier: 1 },
      { id: 'mid', tx: 1, ty: 0, tier: 1 },
      { id: 'w2', tx: 2, ty: 0, tier: 1 },
      { id: 'spur', tx: 1, ty: 1, tier: 1 },
    ];
    const frames = resolveWallFrames(walls);
    expect(frames.get('mid')).toBe('wall5_t1_tee_s_intact_f1'); // E+W+S → south tee
    expect(frames.get('spur')).toBe('wall5_t1_end_n_intact_f1'); // connects NORTH to the run, capped below
  });
});

describe('wallRowThrough shared selection/purchase boundary', () => {
  it('uses the same longest contiguous axis and horizontal tie-break for movement and paid upgrade', async () => {
    const { wallRowThrough } = await import('./wallConnect');
    const walls = [[1, 2], [2, 2], [3, 2], [2, 1], [2, 3], [5, 2]]
      .map(([tx, ty]) => ({ id: `${tx},${ty}`, tx: tx!, ty: ty! }));
    expect(wallRowThrough(walls, '2,2').map((w) => w.id).sort()).toEqual(['1,2', '2,2', '3,2']);
    walls.push({ id: '2,4', tx: 2, ty: 4 });
    expect(wallRowThrough(walls, '2,2').map((w) => w.id).sort()).toEqual(['2,1', '2,2', '2,3', '2,4']);
    expect(wallRowThrough(walls, '5,2').map((w) => w.id)).toEqual(['5,2']);
    expect(wallRowThrough(walls, 'not-owned')).toEqual([]);
  });
});
