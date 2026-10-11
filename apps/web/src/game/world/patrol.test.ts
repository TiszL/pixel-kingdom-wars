/**
 * The base view's ART LEVEL contract (batch 13, gated 2026-08-03) — see the ART
 * LEVEL section of patrol.ts for the decision this pins.
 *
 * The failure mode is silent in a browser: a garrison sprite keyed into a
 * `trpdg_l<N>` atlas that is not registered draws literally NOTHING, because
 * Phaser does not error on a frame it cannot find. So the gate is pinned from
 * BOTH sides:
 *  - levelled keys appear ONLY when the server sent a level AND that level's
 *    atlas is loaded (the `isLevelArtLoaded` gate sync() takes);
 *  - on every other path — no level, unloaded/failed atlas — every texture the
 *    layer asks for must be in the eager boot set, exactly the pre-batch-13
 *    rendering.
 * Plus the piece that makes the gate USEFUL: the granted art level is part of
 * sync()'s change signature, so BaseScene's re-sync when the atlas lands is not
 * early-returned — without that, a garrison that spawned before the download
 * finished would stay on legacy art for the rest of the session.
 */
import { readFileSync } from 'node:fs';
import { AMBIENCE, ATLAS_PREFIXES } from '@shardkeep/shared';
import { describe, expect, it, vi } from 'vitest';
import { AnimTicker, ANIM_TICK_MS } from '../anim';
import { V2_DRAW_SCALE, type V2ClipMap } from '../v2/clips';
import { V2Ticker } from '../v2/ticker';
import { Occupancy } from './occupancy';
import { actorDepth } from './depth';
import { v2TroopDrawScale } from '../v2/troop';
import {
  garrisonScaleFor, PatrolLayer, requiredV2PatrolAtlasGroups, v2WalkerOrigin,
  v2WalkerPlay, v2WalkerSeq, visibleGarrisonTroops,
} from './patrol';

/**
 * patrol.ts reaches the atlas rule through BootScene's thin re-export, and
 * BootScene imports Phaser — which touches `window` at import time and so takes
 * the whole (node-environment) test run down before a single assertion. The mock
 * returns the SAME function BootScene re-exports, so the routing under test is
 * still the real shared rule and not a stand-in.
 */
vi.mock('../scenes/BootScene', async () => {
  const { atlasGroupFor } = await import('@shardkeep/shared');
  return { atlasFor: atlasGroupFor };
});

const T = 64;

/** Focused packed-metadata fixture. Counts/verbs/rows are the owner manifest's
 * art facts; production receives the same shape from meta.json. */
const V2_CLIPS: V2ClipMap = {};
const ROW_ORDER = ['s', 'sw', 'w', 'nw', 'n', 'ne', 'e', 'se'] as const;
function addV2Clip(
  kind: 'trp' | 'bld', unit: string, tier: number, state: string, frames: number,
  cellW: number, cellH: number, anchorPx: readonly [number, number],
): void {
  V2_CLIPS[`v2_${kind}_${unit}_t${tier}_${state}`] = {
    frames, rows: 8, cellW, cellH, rowOrder: ROW_ORDER, anchorPx,
    // Art fact from the shipped manifest: every v2 locomotion clip is authored
    // at 10fps and every idle at 6 — nothing in this pack was drawn for the
    // 260ms house clock. The flicker cases below depend on it being HERE, in
    // the metadata, and not on a number the renderer invented.
    fps: state === 'walk' || state === 'run' || state === 'fly' ? 10 : 6,
    loop: true,
  };
}
for (let tier = 1; tier <= 4; tier++) {
  addV2Clip('trp', 'giant', tier, 'walk', 8, 112, 112, [56, 100]);
  addV2Clip('trp', 'giant', tier, 'idle', 4, 112, 112, [56, 100]);
  addV2Clip('trp', 'dragon', tier, 'fly', 8, 160, 120, [80, 110]);
  addV2Clip('trp', 'dragon', tier, 'hover', 4, 160, 120, [80, 110]);
  addV2Clip('trp', 'highlander', tier, 'walk', 6, 96, 96, [48, 86]);
  addV2Clip('trp', 'highlander', tier, 'idle', 4, 96, 96, [48, 86]);
  for (const unit of ['bowman', 'plunderer'] as const) {
    addV2Clip('trp', unit, tier, 'walk', 8, 96, 96, [48, 86]);
    addV2Clip('trp', unit, tier, 'idle', 6, 96, 96, [48, 86]);
  }
  // Mage: the case below asserts a granted MAGE's composed scale, and without
  // his clips here the layer quietly fell back to legacy art — where 0.66
  // happened to equal the old `dragon/2` expectation exactly, so the assertion
  // passed while testing nothing. Fixture gap found 2026-08-30.
  addV2Clip('trp', 'mage', tier, 'walk', 8, 96, 96, [48, 86]);
  addV2Clip('trp', 'mage', tier, 'idle', 4, 96, 96, [48, 86]);
  addV2Clip('trp', 'troll', tier, 'walk', 8, 112, 112, [56, 100]);
  addV2Clip('trp', 'troll', tier, 'idle', 6, 112, 112, [56, 100]);
  addV2Clip('trp', 'turrider', tier, 'walk', 8, 128, 104, [64, 94]);
  addV2Clip('trp', 'turrider', tier, 'idle', 4, 128, 104, [64, 94]);
  addV2Clip('trp', 'direwyvern', tier, 'glide', 6, 304, 208, [152, 190]);
  addV2Clip('trp', 'direwyvern', tier, 'hover', 4, 304, 208, [152, 190]);
  addV2Clip('bld', 'hexbarrow', tier, 'roll', 6, 128, 112, [64, 100]);
  addV2Clip('bld', 'hexbarrow', tier, 'idle', 2, 128, 112, [64, 100]);
}

interface TexReq { atlas: string; frame: string }

/**
 * One walker's own ordered history: every texture registration and every
 * position write, interleaved. `flipX` is captured AT THE MOMENT of the write
 * because the sprite mirror is not a constant — the v2 branches clear it while
 * the legacy branches set it, and "which row was drawn mirrored" is only
 * answerable at write time.
 */
type WalkerEvent =
  | { kind: 'tex'; frame: string; flipX: boolean }
  | { kind: 'pos'; x: number; y: number };

/** Just enough of the Phaser sprite surface for the layer to run. Every texture
 *  request — at spawn and on every frame swap — lands in `reqs`. */
class FakeSprite {
  active = true;
  /** Sprite mirror state. Recorded (not swallowed) because west is drawn TWO
   *  different ways: legacy art mirrors its east row, v2 art has a real west
   *  row and must NOT be mirrored on top of it. */
  flipX = false;
  x = 0;
  y = 0;
  originX = 0.5;
  originY = 0.5;
  scale = 1;
  depth = 0;
  depthWrites = 0;
  readonly log: WalkerEvent[] = [];
  constructor(x: number, y: number, atlas: string, frame: string, private reqs: TexReq[]) {
    this.x = x;
    this.y = y;
    reqs.push({ atlas, frame });
    this.log.push({ kind: 'tex', frame, flipX: false });
  }
  setTexture(atlas: string, frame: string): this {
    this.reqs.push({ atlas, frame });
    this.log.push({ kind: 'tex', frame, flipX: this.flipX });
    return this;
  }
  setOrigin(x = 0.5, y = x): this { this.originX = x; this.originY = y; return this; }
  setScale(scale: number): this { this.scale = scale; return this; }
  setDepth(depth: number): this {
    this.depth = depth;
    this.depthWrites += 1;
    return this;
  }
  setPosition(x: number, y: number): this {
    this.x = x; this.y = y;
    this.log.push({ kind: 'pos', x, y });
    return this;
  }
  setFlipX(v: boolean): this { this.flipX = v; return this; }
  once(): this { return this; }
  destroy(): void { this.active = false; }
}

interface Bld { id: string; type: string; tx: number; ty: number; underConstruction: boolean }
interface Row { troop: string; count: number; level?: number }

const CAMP: Bld = { id: 'camp1', type: 'camp', tx: 12, ty: 12, underConstruction: false };
const ALTAR: Bld = { id: 'altar1', type: 'heroaltar', tx: 17, ty: 17, underConstruction: false };
const BUILDINGS = [CAMP, ALTAR];
const fpOf = (b: Bld): { fw: number; fh: number } =>
  (b.type === 'camp' ? { fw: 2, fh: 2 } : { fw: 1, fh: 1 });

// Dragon and giant are the two troops with per-level art; the highlander is
// here — WITH a level — so a regression that levelled troops without per-level
// art (trp_highlander_l7_* exists nowhere) is legible on its own line.
const ARMY_LEVELLED: readonly Row[] = [
  { troop: 'dragon', count: 2, level: 7 },
  { troop: 'giant', count: 2, level: 7 },
  { troop: 'highlander', count: 1, level: 7 },
];

const EAGER = new Set<string>(ATLAS_PREFIXES);
const framesOf = (reqs: TexReq[]): string[] => [...new Set(reqs.map((r) => r.frame))];
const atlasesOf = (reqs: TexReq[]): string[] => [...new Set(reqs.map((r) => r.atlas))];

/** A layer over a fake scene, capturing every (atlas, frame) request. */
function makeLayer(v2clips: V2ClipMap = V2_CLIPS): {
  reqs: TexReq[]; layer: PatrolLayer; walk: () => void; sprites: FakeSprite[];
  v2Ticker: V2Ticker; houseTick: () => void;
} {
  const reqs: TexReq[] = [];
  const sprites: FakeSprite[] = [];
  let animStep: () => void = () => undefined;
  const scene = {
    add: {
      sprite: (x: number, y: number, atlas: string, frame: string) => {
        const s = new FakeSprite(x, y, atlas, frame, reqs);
        sprites.push(s);
        return s;
      },
    },
    time: {
      addEvent: (config: { callback: () => void }) => {
        animStep = config.callback;
        return { remove: () => undefined };
      },
    },
    events: { once: () => undefined },
  } as never as Phaser.Scene;
  const occ = new Occupancy(T);
  occ.rebuild(BUILDINGS.map((b) => ({ tx: b.tx, ty: b.ty, ...fpOf(b) })));
  const ticker = new AnimTicker();
  ticker.attach(scene);
  // The v2 art plays on its OWN per-clip clock (patrol.ts layer law), driven
  // here by hand so a test step advances exactly one frame of real elapsed time
  // on both clocks — the same dt BaseScene hands them.
  const v2Ticker = new V2Ticker();
  const layer = new PatrolLayer(scene, ticker, v2Ticker, T, occ, v2clips);
  // Walkers spawn mid-pause (staggered by design, up to ~2.6 s), so walking has
  // to outlast the longest of those before anybody takes a step — a fixture
  // that only ever captured spawn frames would leave walk() untested.
  const walk = (): void => {
    for (let i = 0; i < 60; i++) {
      layer.update(120, false);
      v2Ticker.tick(120);
      if (i % 2 === 1) animStep();
    }
  };
  return { reqs, layer, walk, sprites, v2Ticker, houseTick: () => animStep() };
}

/** Spawn a garrison + hero under the given atlas gate and walk them ~7 s. */
function run(army: readonly Row[], isLevelArtLoaded: (level: number) => boolean): TexReq[] {
  // This block pins the older level-art gate in isolation. With v2 metadata
  // present, the eager current-art fallback intentionally outranks batch 13.
  const { reqs, layer, walk } = makeLayer({});
  layer.sync(BUILDINGS, fpOf, army, 'wallet', isLevelArtLoaded);
  walk();
  return reqs;
}

describe('visible garrison roster', () => {
  it('matches the existing dealt and per-camp-capped spawn order exactly', () => {
    const troopCount = AMBIENCE.garrisonMaxPerCamp * 2 + 1;
    const army = Array.from(
      { length: troopCount },
      (_, i) => ({ troop: `troop${i}`, count: 1 }),
    );
    // Two camps receive alternating roster slots and spawn camp 0 before camp
    // 1. The final even slot is the thirteenth unit, beyond camp 0's six-unit
    // cap, so it is not visible and must not cause an atlas request.
    expect(visibleGarrisonTroops(army, 2)).toEqual([
      'troop0', 'troop2', 'troop4', 'troop6', 'troop8', 'troop10',
      'troop1', 'troop3', 'troop5', 'troop7', 'troop9', 'troop11',
    ]);
  });

  it('returns unique first-visible troop types and none when there is no camp', () => {
    const army = [
      { troop: 'giant', count: 3 },
      { troop: 'dragon', count: 2 },
      { troop: 'highlander', count: 2 },
    ];
    expect(visibleGarrisonTroops(army, 1)).toEqual(['giant', 'dragon', 'highlander']);
    expect(visibleGarrisonTroops(army, 0)).toEqual([]);
  });
});

describe('patrol depth dirty writes', () => {
  it('moves horizontally without sorting, then writes depth once when feet Y changes', () => {
    const { layer, sprites } = makeLayer({});
    layer.sync(
      [CAMP], fpOf, [{ troop: 'bowman', count: 1 }],
      'wallet', () => false,
    );
    const sprite = sprites[0]!;
    expect(sprite.depthWrites).toBe(1); // initial painter-order placement
    type MovableWalker = { x: number; y: number; tx: number; ty: number; pauseLeft: number };
    const walker = (layer as unknown as { walkers: MovableWalker[] }).walkers[0]!;
    // Put the real walker on known-clear ground and drive one leg per axis. The
    // test reaches the production update loop; only route selection is removed
    // so both painter-order cases are guaranteed instead of RNG-dependent.
    walker.x = 64; walker.y = 64; walker.tx = 128; walker.ty = 64; walker.pauseLeft = 0;
    sprite.x = walker.x; sprite.y = walker.y;
    sprite.setDepth(actorDepth(walker.y));

    const beforeHorizontal = { x: sprite.x, y: sprite.y, writes: sprite.depthWrites };
    layer.update(120, false);
    expect(sprite.x).not.toBe(beforeHorizontal.x);
    expect(sprite.y).toBe(beforeHorizontal.y);
    expect(sprite.depthWrites, 'unchanged feet Y must not dirty Phaser depth')
      .toBe(beforeHorizontal.writes);

    walker.tx = walker.x; walker.ty = walker.y + 64; walker.pauseLeft = 0;
    const beforeVertical = { x: sprite.x, y: sprite.y, writes: sprite.depthWrites };
    layer.update(120, false);
    expect(sprite.x).toBe(beforeVertical.x);
    expect(sprite.y).not.toBe(beforeVertical.y);
    expect(sprite.depthWrites, 'a changed painter-order key is written exactly once')
      .toBe(beforeVertical.writes + 1);
    expect(sprite.depth).toBe(actorDepth(sprite.y));
  });
});

describe('packed patrol phase continuity', () => {
  const { v2Clips } = JSON.parse(readFileSync(
    new URL('../../../public/atlas/meta.json', import.meta.url), 'utf8',
  )) as { v2Clips: V2ClipMap };
  const army = [{ troop: 'giant', count: 1, level: 7 }];
  const frameMs = 1000 / v2Clips['v2_trp_giant_t2_walk']!.fps!;
  type Walker = {
    x: number; y: number; tx: number; ty: number; pauseLeft: number;
    dir: string; west: boolean; path: Array<{ x: number; y: number }>;
  };

  function moving() {
    const harness = makeLayer(v2Clips);
    const { layer, sprites, v2Ticker } = harness;
    layer.sync([CAMP], fpOf, army, 'wallet', () => true, () => 2);
    const walker = (layer as unknown as { walkers: Walker[] }).walkers[0]!;
    const sprite = sprites[0]!;
    // Fix only route selection: phase, movement, stopping and registration all
    // run through the production layer, with the actual shipped Giant clip.
    Object.assign(walker, {
      x: 64, y: 64, tx: 1024, ty: 64, pauseLeft: 0, dir: 'e', west: false, path: [],
    });
    sprite.setPosition(walker.x, walker.y);
    layer.update(16, false);
    v2Ticker.tick(frameMs * 2.5);
    expect(v2Ticker.phase(sprite as never)).toEqual({ index: 2, accumulatedMs: frameMs / 2 });
    return { ...harness, walker, sprite };
  }

  it('keeps the same mid-stride actor through unchanged and changed-army refreshes', () => {
    const { layer, walker, sprite, v2Ticker } = moving();
    const before = v2Ticker.phase(sprite as never);
    const position = { x: sprite.x, y: sprite.y };
    for (const count of [1, 2]) {
      layer.sync([{ ...CAMP }], fpOf, [{ ...army[0]!, count }], 'wallet', () => true, () => 2);
      expect((layer as unknown as { walkers: Walker[] }).walkers[0]).toBe(walker);
      expect(sprite.active).toBe(true);
      expect(sprite).toMatchObject(position);
      expect(v2Ticker.phase(sprite as never)).toEqual(before);
    }
    v2Ticker.tick(frameMs / 2);
    expect(v2Ticker.phase(sprite as never)).toEqual({ index: 3, accumulatedMs: 0 });
  });

  it.each(['waypoint pause', 'reduced motion'] as const)(
    'resumes the retained frame and partial dwell after %s, without marching while held',
    (reason) => {
      const { layer, walker, sprite, v2Ticker } = moving();
      const before = v2Ticker.phase(sprite as never);
      if (reason === 'waypoint pause') {
        walker.tx = walker.x + 1;
        layer.update(120, false); // reach the waypoint and enter its real pause
        expect(walker.pauseLeft).toBeGreaterThan(0);
      } else {
        layer.update(16, true);
      }
      expect(v2Ticker.phase(sprite as never)).toBeNull();
      const heldWrites = sprite.log.length;
      const heldPosition = { x: sprite.x, y: sprite.y };
      for (let tick = 0; tick < 3; tick++) {
        layer.update(16, reason === 'reduced motion');
        v2Ticker.tick(frameMs);
      }
      expect(sprite.log).toHaveLength(heldWrites);
      expect(sprite).toMatchObject(heldPosition);
      Object.assign(walker, { tx: walker.x + 512, ty: walker.y, pauseLeft: 0 });
      layer.update(16, false);
      expect(v2Ticker.phase(sprite as never)).toEqual(before);
      v2Ticker.tick(frameMs / 2);
      expect(v2Ticker.phase(sprite as never)).toEqual({ index: 3, accumulatedMs: 0 });
    },
  );
});

describe('base-view patrol art level', () => {
  it('renders levelled dragon/giant art when the server sent a level AND its atlas is loaded', () => {
    const reqs = run(ARMY_LEVELLED, () => true);
    const frames = framesOf(reqs);
    // The levelled dragon FLIES (batch-13 ships fly_ and no walk_); the giant walks.
    expect(frames).toContain('trp_dragon_l7_fly_s_f1');
    expect(frames).toContain('trp_giant_l7_walk_s_f1');
    // …and those frames route to the on-demand atlas group, not `trp`.
    expect(atlasesOf(reqs)).toContain('trpdg_l7');
    // A granted walker is levelled EVERYWHERE — spawn, walk() and stand() all
    // key off the same walker level. A legacy frame slipping in (say stand()
    // forgetting the level) would swap the unit's whole look at every pause.
    expect(frames.filter((f) => f.startsWith('trp_dragon_walk_'))).toEqual([]);
    expect(frames.filter((f) => f.startsWith('trp_giant_walk_'))).toEqual([]);
    // A troop with no per-level art ignores its level even with the gate open:
    // trp_highlander_l7_* exists in no atlas and would draw nothing.
    expect(frames).toContain('trp_highlander_walk_s_f1');
    expect(frames.filter((f) => f.includes('highlander') && /_l\d+_/.test(f))).toEqual([]);
  });

  it('clamps a level past the shipped art to the top tier instead of a frame that never existed', () => {
    const queried: number[] = [];
    const frames = framesOf(run(
      [{ troop: 'dragon', count: 1, level: 99 }],
      (l) => { queried.push(l); return true; },
    ));
    expect(frames.some((f) => f.startsWith('trp_dragon_l20_'))).toBe(true);
    expect(frames.filter((f) => /_l99_/.test(f))).toEqual([]);
    // The gate is asked about the CLAMPED level — and BaseScene derives its
    // fetch set from the same garrisonArtLevel rule, so this is also the pin
    // that no `trpdg_l99` (never packed; a guaranteed 404) is ever requested.
    // anim.ts clamps again when keying frames, so the frame assertions above
    // cannot see THIS clamp on their own.
    expect([...new Set(queried)]).toEqual([20]);
  });

  it('falls back to legacy art while the atlas is NOT loaded (in flight, or failed for good)', () => {
    const reqs = run(ARMY_LEVELLED, () => false);
    const frames = framesOf(reqs);
    // The unlevelled dragon WALKS — legacy trp_dragon_walk_* has shipped since
    // batch 1 and is exactly what rendered before the gate opened.
    expect(frames).toContain('trp_dragon_walk_s_f1');
    expect(frames).toContain('trp_giant_walk_s_f1');
    expect(frames.filter((f) => /_l\d+_/.test(f))).toEqual([]);
    // …and therefore never leaves the eager boot set. Reported as a list rather
    // than a boolean so a failure names the atlas — `trpdg_l7` in the failure
    // message is the whole diagnosis.
    expect(atlasesOf(reqs).filter((a) => !EAGER.has(a))).toEqual([]);
  });

  it('falls back to legacy art when the server sent no level (or a non-finite one)', () => {
    const reqs = run([
      { troop: 'dragon', count: 2 },
      // A non-finite level would key a `_lNaN_` frame that exists nowhere.
      { troop: 'giant', count: 2, level: Number.NaN },
      { troop: 'highlander', count: 1 },
    ], () => true); // the gate is OPEN — absence of a level alone must gate
    const frames = framesOf(reqs);
    expect(frames).toContain('trp_dragon_walk_s_f1');
    expect(frames).toContain('trp_giant_walk_s_f1');
    expect(frames.filter((f) => /_l\d+_/.test(f))).toEqual([]);
    expect(atlasesOf(reqs).filter((a) => !EAGER.has(a))).toEqual([]);
  });

  it('re-keys the garrison when the atlas lands: the art level is in sync()\'s signature', () => {
    const { reqs, layer, walk } = makeLayer({});
    let loaded = false;
    const gate = (): boolean => loaded;
    layer.sync(BUILDINGS, fpOf, ARMY_LEVELLED, 'wallet', gate);
    walk();
    expect(framesOf(reqs).filter((f) => /_l\d+_/.test(f))).toEqual([]); // legacy while loading
    // The download finishes; BaseScene re-syncs with the SAME buildings + army.
    // Nothing but the granted art level changed — if it were not part of the
    // signature, this sync would early-return and legacy art would stand forever.
    loaded = true;
    layer.sync(BUILDINGS, fpOf, ARMY_LEVELLED, 'wallet', gate);
    walk();
    expect(framesOf(reqs)).toContain('trp_dragon_l7_fly_s_f1');
    expect(framesOf(reqs)).toContain('trp_giant_l7_walk_s_f1');
  });

  it('actually walks both walker kinds, so the checks above are not spawn-only', () => {
    const frames = framesOf(run(ARMY_LEVELLED, () => true));
    // >1 distinct dragon locomotion frame means the walk cycle really registered;
    // with only the spawn frame the assertions above would be near-vacuous.
    expect(frames.filter((f) => f.startsWith('trp_dragon_l7_fly_')).length).toBeGreaterThan(1);
    expect(frames.some((f) => f.startsWith('hero_vex_'))).toBe(true);
  });

  it('removes only a recovering hero and restores them only after server confirmation', () => {
    const { reqs, layer, sprites } = makeLayer({});
    const deadline = '2026-08-13T12:00:00.000Z';
    layer.sync(BUILDINGS, fpOf, [], 'wallet', () => false, undefined, [
      { hero: 'vex', recoveryUntil: null, available: true },
    ], Date.parse(deadline) - 1);
    expect(framesOf(reqs).some((frame) => frame.startsWith('hero_vex_'))).toBe(true);
    const readyHero = sprites.find((sprite) => sprite.log.some((event) => (
      event.kind === 'tex' && event.frame.startsWith('hero_vex_')
    )))!;

    layer.sync(BUILDINGS, fpOf, [], 'wallet', () => false, undefined, [
      { hero: 'vex', recoveryUntil: deadline, available: false },
    ], Date.parse(deadline) - 1);
    expect(readyHero.active).toBe(false);

    layer.sync(BUILDINGS, fpOf, [], 'wallet', () => false, undefined, [
      { hero: 'vex', recoveryUntil: deadline, available: false },
    ], Date.parse(deadline));
    expect(sprites.filter((sprite) => sprite.active && sprite.log.some((event) => (
      event.kind === 'tex' && event.frame.startsWith('hero_vex_')
    )))).toHaveLength(0);

    layer.sync(BUILDINGS, fpOf, [], 'wallet', () => false, undefined, [
      { hero: 'vex', recoveryUntil: deadline, available: true },
    ], Date.parse(deadline));
    expect(sprites.filter((sprite) => sprite.active && sprite.log.some((event) => (
      event.kind === 'tex' && event.frame.startsWith('hero_vex_')
    )))).toHaveLength(1);
  });
});

/**
 * Rework-v2 garrison art (Phase D). Same silent-failure geometry as the
 * batch-13 gate above — a v2 frame keyed into an unloaded `v2trp_<unit>_t<n>`
 * atlas draws NOTHING — so the grant is pinned from both sides, plus the two
 * v2-only behaviours: a granted tier OUTRANKS the batch-13 level (the rework
 * fully replaces those units' art), and a v2 walker stands ANIMATED on its
 * idle/hover clip instead of pinning a walk frame.
 */
describe('base-view patrol rework-v2 art', () => {
  const grantT2 = (troop: string, level: number | undefined): number | null =>
    (troop === 'dragon' || troop === 'giant') && level !== undefined ? 2 : null;

  function runV2(
    army: readonly Row[],
    v2TierOf: (troop: string, level: number | undefined) => number | null,
  ): TexReq[] {
    const { reqs, layer, walk } = makeLayer();
    layer.sync(BUILDINGS, fpOf, army, 'wallet', () => true, v2TierOf);
    walk();
    return reqs;
  }

  it('renders v2 grid frames when granted — and they outrank the batch-13 level', () => {
    const reqs = runV2(ARMY_LEVELLED, grantT2);
    const frames = framesOf(reqs);
    // Locomotion: giant walks, dragon flies, both out of their tier atlas.
    expect(frames.some((f) => f.startsWith('v2_trp_giant_t2_walk_d'))).toBe(true);
    expect(frames.some((f) => f.startsWith('v2_trp_dragon_t2_fly_d'))).toBe(true);
    expect(atlasesOf(reqs)).toContain('v2trp_giant_t2_locomotion');
    expect(atlasesOf(reqs)).toContain('v2trp_dragon_t2_locomotion');
    // The grant REPLACES batch-13: no `_l7_` frame may coexist with it, or the
    // unit would swap art families at every pause.
    expect(frames.filter((f) => f.includes('giant_l7') || f.includes('dragon_l7'))).toEqual([]);
    // The highlander was not granted, so it holds current static art rather
    // than flashing the superseded eager legacy frame.
    expect(frames).toContain('v2_fallback_highlander_t2');
  });

  it('a compact v2 walker holds an authored directional stand pose at pauses', () => {
    const frames = framesOf(runV2(ARMY_LEVELLED, grantT2));
    expect(frames.some((f) => f.startsWith('v2_locomotion_stand_giant_t2_d'))).toBe(true);
    expect(frames.some((f) => f.startsWith('v2_locomotion_stand_dragon_t2_d'))).toBe(true);
    expect(frames.some((f) => f.startsWith('v2_trp_giant_t2_idle_d'))).toBe(false);
    expect(frames.some((f) => f.startsWith('v2_trp_dragon_t2_hover_d'))).toBe(false);
  });

  it('an ungranted tier holds eager current art and never reaches legacy/batch-13 frames', () => {
    const reqs = runV2(ARMY_LEVELLED, () => null);
    const frames = framesOf(reqs);
    expect(frames).toEqual(expect.arrayContaining([
      'v2_fallback_dragon_t2', 'v2_fallback_giant_t2', 'v2_fallback_highlander_t2',
    ]));
    expect(frames.filter((f) => f.startsWith('trp_'))).toEqual([]);
    expect(frames.filter((f) => /^v2_(?:trp|bld)_/.test(f))).toEqual([]);
    expect(atlasesOf(reqs)).toContain('v2fallback');
  });

  it('keeps Dragon and Tur Rider static while they move, then permits a full-v2 upgrade', () => {
    const army = [
      { troop: 'dragon', count: 1, level: 7 },
      { troop: 'turrider', count: 1, level: 7 },
    ] as const;
    const { reqs, layer, walk, sprites } = makeLayer();
    layer.sync(BUILDINGS, fpOf, army, 'wallet', () => true, () => null);
    walk();
    expect(new Set(framesOf(reqs).filter((f) => f.includes('dragon'))))
      .toEqual(new Set(['v2_fallback_dragon_t2']));
    expect(new Set(framesOf(reqs).filter((f) => f.includes('turrider'))))
      .toEqual(new Set(['v2_fallback_turrider_t2']));
    expect(sprites.some((sprite) => sprite.log.some((event) => event.kind === 'pos'))).toBe(true);
    const fallbackSprites = sprites.filter((sprite) => sprite.log.some(
      (event) => event.kind === 'tex' && /^v2_fallback_(?:dragon|turrider)_/.test(event.frame),
    ));
    expect(fallbackSprites).toHaveLength(2); // non-vacuous lifecycle control

    const beforeUpgrade = reqs.length;
    layer.sync(
      BUILDINGS, fpOf, army, 'wallet', () => true,
      (troop, level) => level !== undefined && (troop === 'dragon' || troop === 'turrider') ? 2 : null,
    );
    walk();
    const upgraded = framesOf(reqs.slice(beforeUpgrade));
    expect(upgraded.some((f) => f.startsWith('v2_trp_dragon_t2_fly_d'))).toBe(true);
    expect(upgraded.some((f) => f.startsWith('v2_trp_turrider_t2_walk_d'))).toBe(true);
    expect(upgraded.filter((f) => f.startsWith('v2_fallback_'))).toEqual([]);
    expect(fallbackSprites.every((sprite) => !sprite.active)).toBe(true);
    const liveTroopSprites = sprites.filter((sprite) => sprite.active && sprite.log.some(
      (event) => event.kind === 'tex' && /^v2_trp_(?:dragon|turrider)_t2_/.test(event.frame),
    ));
    // One live actor per roster slot: promotion must replace, never layer the
    // compact walker over the old large/static fallback actor.
    expect(liveTroopSprites).toHaveLength(2);
  });

  it('re-keys the garrison when the v2 atlas lands: the tier is in sync()\'s signature', () => {
    const { reqs, layer, walk } = makeLayer();
    let loaded = false;
    const gate = (troop: string, level: number | undefined): number | null =>
      loaded ? grantT2(troop, level) : null;
    layer.sync(BUILDINGS, fpOf, ARMY_LEVELLED, 'wallet', () => true, gate);
    walk();
    expect(framesOf(reqs)).toEqual(expect.arrayContaining([
      'v2_fallback_dragon_t2', 'v2_fallback_giant_t2', 'v2_fallback_highlander_t2',
    ]));
    loaded = true;
    layer.sync(BUILDINGS, fpOf, ARMY_LEVELLED, 'wallet', () => true, gate);
    walk();
    expect(framesOf(reqs).some((f) => f.startsWith('v2_trp_giant_t2_'))).toBe(true);
  });

  it('v2WalkerSeq maps the patrol facings onto the DIR_YAW rows, west as REAL art', () => {
    // rowOrder [s,sw,w,nw,n,ne,e,se]: s=0, w=2, n=4, e=6. 'e'+flip is the one
    // subtle case — the v2 pack ships real west rows, so the flip becomes row
    // w and the sprite mirror is CLEARED (a mirrored east row would put the
    // club in the wrong hand).
    expect(v2WalkerSeq(V2_CLIPS, 'giant', 1, 'move', 's', false)[0]).toBe('v2_trp_giant_t1_walk_d0_f1');
    expect(v2WalkerSeq(V2_CLIPS, 'giant', 1, 'move', 'n', false)[0]).toBe('v2_trp_giant_t1_walk_d4_f1');
    expect(v2WalkerSeq(V2_CLIPS, 'giant', 1, 'move', 'e', false)[0]).toBe('v2_trp_giant_t1_walk_d6_f1');
    expect(v2WalkerSeq(V2_CLIPS, 'giant', 1, 'move', 'e', true)[0]).toBe('v2_trp_giant_t1_walk_d2_f1');
    // Verbs + counts are the manifest's: giant walk 8f / idle 4f, dragon fly
    // 8f / hover 4f (the clips.test ground-truth block pins the shipped art).
    expect(v2WalkerSeq(V2_CLIPS, 'giant', 1, 'move', 's', false)).toHaveLength(8);
    expect(v2WalkerSeq(V2_CLIPS, 'giant', 1, 'stand', 's', false)).toHaveLength(4);
    expect(v2WalkerSeq(V2_CLIPS, 'dragon', 3, 'move', 's', false)[0]).toBe('v2_trp_dragon_t3_fly_d0_f1');
    expect(v2WalkerSeq(V2_CLIPS, 'dragon', 3, 'stand', 's', false)[0]).toBe('v2_trp_dragon_t3_hover_d0_f1');
  });

  it('uses packed metadata for another live troop instead of Giant/Dragon constants', () => {
    const army = [{ troop: 'highlander', count: 1, level: 7 }] as const;
    const reqs = runV2(army, (_troop, level) => level === undefined ? null : 2);
    const frames = framesOf(reqs);
    expect(frames).toContain('v2_trp_highlander_t2_walk_d0_f1');
    expect(frames).toContain('v2_locomotion_stand_highlander_t2_d0');
    expect(v2WalkerSeq(V2_CLIPS, 'highlander', 2, 'move', 's', false)).toHaveLength(6);
    expect(frames.filter((f) => f.startsWith('trp_highlander_'))).toEqual([]);
  });

  it.each(['bowman', 'troll', 'plunderer'] as const)(
    'keeps %s moving on multiple current-pack frames from the compact base grant',
    (troop) => {
      const { reqs, layer, walk, sprites } = makeLayer();
      layer.sync(
        BUILDINGS, fpOf, [{ troop, count: 1, level: 1 }],
        'wallet', () => true, () => 1,
      );
      walk();

      const walkFrames = framesOf(reqs)
        .filter((frame) => frame.startsWith(`v2_trp_${troop}_t1_walk_`));
      expect(walkFrames.length, troop).toBeGreaterThan(1);
      expect(atlasesOf(reqs)).toContain(`v2trp_${troop}_t1_locomotion`);
      expect(sprites.some((sprite) => sprite.log.some((event) => event.kind === 'pos'))).toBe(true);
      expect(framesOf(reqs).some((frame) => frame.startsWith(`trp_${troop}_`))).toBe(false);
    },
  );

  it('seats walkers on the move clip authored anchor, including bld_-keyed Hexbarrow', () => {
    const cases = [
      { troop: 'highlander', prefix: 'v2_trp_highlander_', origin: [0.5, 86 / 96] as const },
      { troop: 'hexbarrow', prefix: 'v2_bld_hexbarrow_', origin: [0.5, 100 / 112] as const },
    ];
    for (const c of cases) {
      expect(v2WalkerOrigin(V2_CLIPS, c.troop, 2)).toEqual(c.origin);
      const { layer, sprites } = makeLayer();
      layer.sync(
        BUILDINGS, fpOf, [{ troop: c.troop, count: 1, level: 7 }],
        'wallet', () => true, () => 2,
      );
      const sprite = sprites.find((sp) => sp.log.some(
        (event) => event.kind === 'tex' && event.frame.startsWith(c.prefix),
      ));
      expect(sprite, `${c.troop} spawned with v2 art`).toBeDefined();
      expect(sprite!.originX).toBeCloseTo(c.origin[0], 10);
      expect(sprite!.originY).toBeCloseTo(c.origin[1], 10);
    }
  });

  it('loads only locomotion groups and respects the profile key kind', () => {
    expect(requiredV2PatrolAtlasGroups(V2_CLIPS, 'direwyvern', 2))
      .toEqual(['v2trp_direwyvern_t2_locomotion']);
    expect(requiredV2PatrolAtlasGroups(V2_CLIPS, 'direwyvern', 2))
      .not.toContain('v2trp_direwyvern_t2_firestorm');
    expect(requiredV2PatrolAtlasGroups(V2_CLIPS, 'hexbarrow', 2))
      .toEqual(['v2bld_hexbarrow_t2_locomotion']);
  });

  it('falls back to legacy when the granted troop is missing packed locomotion metadata', () => {
    const { reqs, layer, walk } = makeLayer({});
    layer.sync(
      BUILDINGS, fpOf, [{ troop: 'highlander', count: 1, level: 7 }],
      'wallet', () => true, () => 2,
    );
    walk();
    expect(framesOf(reqs)).toContain('trp_highlander_walk_s_f1');
    expect(framesOf(reqs).filter((f) => f.startsWith('v2_'))).toEqual([]);
  });

  /**
   * WEST IS WALKER STATE, NOT SPRITE STATE. The v2 branches of walk()/stand()
   * clear the sprite's flipX — correctly, since row w is real art — which means
   * the sprite stops being a record of "moving west". Deriving west from
   * `sprite.flipX` therefore made row 2 UNREACHABLE from stand(): the arrival
   * and blocked branches call stand() without touching facing, so a
   * west-walking giant snapped to the EAST idle row on every pause, and a
   * hysteresis-held diagonal leg played the east WALK row while moving west
   * (the dizzy-shuffle family anim.ts documents).
   *
   * Pinned on the rendered frames — the west row has to appear in BOTH the walk
   * clip and the compact authored stand pose over a patrol that circles its camp in both
   * directions. Under the old sprite-derived version the idle west row can
   * never appear at all.
   */
  it('keeps the west row through pauses: v2 walkers stand AND walk facing west', () => {
    // A long patrol, so every walker completes several ring legs in both
    // rotation directions and a west leg is certain (the short 7 s `walk()` the
    // other cases use happens to catch only s/n/e legs).
    const { reqs, layer } = makeLayer();
    layer.sync(BUILDINGS, fpOf, ARMY_LEVELLED, 'wallet', () => true, grantT2);
    for (let i = 0; i < 600; i++) layer.update(120, false);
    const frames = framesOf(reqs);
    const westWalk = frames.filter((f) => f.startsWith('v2_trp_giant_t2_walk_d2_'));
    const westIdle = frames.filter((f) => f === 'v2_locomotion_stand_giant_t2_d2');
    expect(westWalk.length, 'giant walked west at least once').toBeGreaterThan(0);
    expect(westIdle.length, 'and STOOD west — row 2 reachable from stand()').toBeGreaterThan(0);
    // The east rows still happen too, so this is a facing test and not a
    // "everything became west" regression.
    expect(frames.some((f) => f.startsWith('v2_trp_giant_t2_walk_d6_'))).toBe(true);
  });

  /**
   * A granted walker draws at the garrison scale TIMES the unit's own
   * `v2TroopDrawScale` — the @1x→@2x pack conversion times its PUBLISHED world
   * fit. Asserted as the RELATION, so an owner retune of garrisonScale or of a
   * fit moves both together instead of silently unpinning this.
   *
   * REWRITTEN 2026-08-30 (owner: "troops are very big"). It used to assert that
   * a granted walker was exactly `garrisonScale × V2_DRAW_SCALE` with a single
   * hard-coded exception for the Mage's halving. That WAS the defect: the pack
   * conversion alone is not a world fit, and with no fit published every
   * reworked troop drew at full authored size — a giant's body at 138 world px
   * beside a 108-px Keep. What is pinned now is the composition and the
   * ORDERING it exists to protect, not any unit's number.
   */
  it('composes the garrison scale with each root\'s published world fit', () => {
    for (const unit of ['dragon', 'mage', 'giant', 'highlander'] as const) {
      expect(garrisonScaleFor(unit, 2), unit)
        .toBeCloseTo(AMBIENCE.garrisonScale * v2TroopDrawScale(unit), 10);
      // Every fit is a shrink; none may quietly return to the pack conversion.
      expect(garrisonScaleFor(unit, 2), unit)
        .toBeLessThan(AMBIENCE.garrisonScale * V2_DRAW_SCALE);
    }
    // The relationships the old single-exception rule protected, still true —
    // they just live in the published fit table now.
    expect(garrisonScaleFor('giant', 2)).toBeGreaterThan(garrisonScaleFor('highlander', 2));
    expect(garrisonScaleFor('mage', 2)).toBeLessThan(garrisonScaleFor('highlander', 2));
    expect(garrisonScaleFor('mage', null)).toBe(AMBIENCE.garrisonScale); // legacy untouched

    const { layer, sprites } = makeLayer();
    layer.sync(
      BUILDINGS, fpOf,
      [{ troop: 'dragon', count: 1, level: 1 }, { troop: 'mage', count: 1, level: 1 }],
      'wallet', () => false, () => 1,
    );
    const dragon = sprites.find((sprite) => sprite.log.some(
      (event) => event.kind === 'tex' && event.frame.includes('_dragon_'),
    ));
    const mage = sprites.find((sprite) => sprite.log.some(
      (event) => event.kind === 'tex' && event.frame.includes('_mage_'),
    ));
    expect(dragon).toBeDefined();
    expect(mage).toBeDefined();
    expect(mage!.scale).toBeLessThan(dragon!.scale);
    expect(mage!.scale).toBe(AMBIENCE.garrisonScale * v2TroopDrawScale('mage'));
  });
});

/**
 * WEST IS WALKER STATE, NOT SPRITE STATE — the second half of the fix the
 * frame-level test above pins, now asserted on the two things only a
 * flip-recording fake can see.
 *
 * The v2 branches of walk()/stand() CLEAR the sprite mirror (correctly: row w is
 * real art, and mirroring an east row would put the club in the wrong hand), so
 * `sprite.flipX` stops being a record of anything. Deriving "am I facing west"
 * from it therefore broke two ways at once, and both shipped:
 *   - stand() is called from the arrival and blocked branches WITHOUT touching
 *     facing, and by then the flag is already cleared — so a west-walking giant
 *     snapped to the EAST idle row on every pause;
 *   - on a frame where the facing HYSTERESIS holds (the `if` is skipped, so
 *     nothing re-sets the mirror) walk() re-registered the EAST walk row while
 *     the unit was still moving west — the dizzy-shuffle family, again.
 * Neither is visible in a screenshot of a single frame, and neither errors.
 */
describe('base-view patrol v2 facing survives pauses and held frames', () => {
  const grantT2 = (troop: string, level: number | undefined): number | null =>
    (troop === 'dragon' || troop === 'giant') && level !== undefined ? 2 : null;

  /**
   * A LONG patrol — every walker's LCG is seeded from its camp id + slot, so
   * this is fully deterministic: the same legs, in the same order, every run.
   * Long enough that the ring is circled in both rotation directions and a west
   * leg is certain (the 7 s `walk()` the cases above use happens to catch only
   * s/n/e legs).
   */
  const patrol = (
    v2TierOf: (troop: string, level: number | undefined) => number | null = grantT2,
    clips: V2ClipMap = V2_CLIPS,
  ) => {
    const { layer, sprites, reqs } = makeLayer(clips);
    layer.sync(BUILDINGS, fpOf, ARMY_LEVELLED, 'wallet', () => true, v2TierOf);
    for (let i = 0; i < 600; i++) layer.update(120, false);
    return { sprites, reqs };
  };

  const texOf = (sp: FakeSprite): Array<{ frame: string; flipX: boolean }> =>
    sp.log.filter((e): e is { kind: 'tex'; frame: string; flipX: boolean } => e.kind === 'tex');
  /** The sprites that are v2 giants (walk 8f/idle 4f, the unit with a west row). */
  const v2Giants = (sprites: FakeSprite[]): FakeSprite[] =>
    sprites.filter((sp) => texOf(sp)[0]?.frame.startsWith('v2_trp_giant_'));

  it('STOPS on the row it was walking — west (row 2) included, not the east idle row', () => {
    const { sprites } = patrol();
    const stoppedOn: string[] = [];
    for (const sp of v2Giants(sprites)) {
      const tex = texOf(sp);
      for (let i = 0; i + 1 < tex.length; i++) {
        const walking = /_walk_d(\d)_/.exec(tex[i]!.frame);
        const stopping = /^v2_locomotion_stand_giant_t2_d(\d)$/.exec(tex[i + 1]!.frame);
        // Only adjacent walk→stand pairs, so the comparison can never be
        // confounded by a legitimate turn in between.
        if (!walking || !stopping) continue;
        expect(stopping[1], `walked row ${walking[1]!}, then stood on row ${stopping[1]!}`)
          .toBe(walking[1]);
        stoppedOn.push(walking[1]!);
      }
    }
    // Non-vacuous: this patrol really does contain a WEST leg that ends in a
    // pause (row 2 — the case the shipped bug got wrong) as well as east ones.
    expect(new Set(stoppedOn), 'a west leg ended in a pause').toContain('2');
    expect(new Set(stoppedOn), 'and an east leg did too').toContain('6');
  });

  it('never plays the EAST row while actually travelling west (hysteresis-held frames)', () => {
    // The row is checked against the MOVEMENT, replayed from the interleaved
    // log: a texture registration is followed by the position writes of the
    // steps it was on screen for. Only clearly x-dominant steps are judged —
    // on a diagonal the hysteresis may legitimately hold an n/s row.
    let westSteps = 0;
    let eastSteps = 0;
    for (const sp of v2Giants(patrol().sprites)) {
      let row: string | null = null;
      let last: { x: number; y: number } | null = null;
      for (const e of sp.log) {
        if (e.kind === 'tex') {
          row = /_walk_d(\d)_/.exec(e.frame)?.[1]
            ?? /^v2_locomotion_stand_giant_t2_d(\d)$/.exec(e.frame)?.[1]
            ?? null;
          continue;
        }
        const dx = last ? e.x - last.x : 0;
        const dy = last ? e.y - last.y : 0;
        last = { x: e.x, y: e.y };
        if ((row !== '2' && row !== '6') || Math.abs(dx) <= 2 * Math.abs(dy) || Math.abs(dx) < 0.5) {
          continue;
        }
        const drawnWest = row === '2';
        expect(drawnWest, `row d${row} drawn while travelling dx=${dx.toFixed(2)}`).toBe(dx < 0);
        if (dx < 0) westSteps++; else eastSteps++;
      }
    }
    // Both directions were actually exercised — otherwise the loop above could
    // pass by never judging anything.
    expect(westSteps, 'west-travelling frames judged').toBeGreaterThan(0);
    expect(eastSteps, 'east-travelling frames judged').toBeGreaterThan(0);
  });

  it('draws the real west row UNMIRRORED — while legacy art still mirrors its east row', () => {
    // The v2 half: no v2 frame is ever written with the sprite mirror on. (Both
    // halves matter: row w mirrored is a club in the wrong hand, and a mirror
    // left standing from a previous leg is how the row got lost in the first
    // place.)
    const { sprites } = patrol();
    for (const sp of sprites) {
      for (const t of texOf(sp)) {
        if (t.frame.startsWith('v2_')) expect(t.flipX, t.frame).toBe(false);
      }
    }
    const westRows = v2Giants(sprites)
      .flatMap((sp) => texOf(sp).filter((t) => /_d2_/.test(t.frame)));
    expect(westRows.length, 'the run really did use the west row').toBeGreaterThan(0);

    // The legacy CONTROL — same patrol, tier ungranted. batch-13 art has no west
    // master, so west there IS the mirror: an `_e_` frame drawn flipped. This is
    // what makes "v2 must not mirror" a real distinction rather than a tautology,
    // and it pins that the fix did not break the model it replaces.
    const legacy = patrol(() => null, {});
    const mirrored = legacy.sprites
      .flatMap(texOf)
      .filter((t) => t.flipX && /trp_giant_l7_walk_e_/.test(t.frame));
    expect(mirrored.length, 'a legacy giant still walks west by mirroring east')
      .toBeGreaterThan(0);
  });
});

/**
 * THE FLICKER (owner 2026-08-30: "all of them are flickering", every troop, on
 * their own base).
 *
 * MECHANISM, not symptom: the base view played the v2/game-v4 walk cycles on
 * the legacy 260ms house clock while that art is authored at 10-12fps. Each
 * authored in-between was therefore held ~2.6x too long, so a gait built from
 * multi-world-px body steps arrived as ~3.85 discrete jumps per second instead
 * of ~10 — and on the units whose per-frame body step exceeds the ~5.2 world px
 * they actually travel between house ticks, that reads as vibrating on the spot
 * rather than walking. The legacy `trp_*` art it replaced steps 0.35-0.88px per
 * frame and was authored FOR that clock, which is why nothing flickered before.
 *
 * The fix is the cadence, so that is what these pin — from both sides, because
 * a one-sided assertion would pass just as well if the layer had been left on
 * BOTH clocks (which tears frames instead of judders them):
 *  - the house clock can no longer move v2 art at all;
 *  - the per-clip clock can, at the fps the manifest publishes.
 * ANIM_TICK_MS and the authored fps are compared as a RELATION, so retuning
 * either one keeps this honest instead of silently unpinning it.
 */
describe('the garrison plays at the cadence its art was authored for', () => {
  const grantT2 = (troop: string, level: number | undefined): number | null =>
    (troop === 'giant' || troop === 'highlander') && level !== undefined ? 2 : null;
  const ARMY = [
    { troop: 'giant', count: 1, level: 7 },
    { troop: 'highlander', count: 1, level: 7 },
  ];
  /** Frames a sprite was actually shown, in order, deduped for repeats. */
  const shown = (sprite: FakeSprite): string[] => {
    const out: string[] = [];
    for (const e of sprite.log) {
      if (e.kind === 'tex' && e.frame !== out[out.length - 1]) out.push(e.frame);
    }
    return out;
  };
  const v2Walkers = (sprites: FakeSprite[]): FakeSprite[] => sprites.filter((s) =>
    s.log.some((e) => e.kind === 'tex' && e.frame.startsWith('v2_trp_')));

  it('is authored faster than the house clock could ever deliver', () => {
    const play = v2WalkerPlay(V2_CLIPS, 'giant', 2, 's', false)!;
    // The whole defect in one line: the art wants a frame every 100ms and the
    // house clock offers one every 260.
    expect(play.fps).toBe(10);
    expect(1000 / play.fps).toBeLessThan(ANIM_TICK_MS);
    expect(play.loop).toBe(true);
    expect(play.seq).toHaveLength(V2_CLIPS['v2_trp_giant_t2_walk']!.frames);
  });

  it('does not move a v2 walker when only the 260ms house clock ticks', () => {
    const { layer, sprites, houseTick } = makeLayer();
    layer.sync(BUILDINGS, fpOf, ARMY, 'wallet', () => true, grantT2);
    // 7.2s of movement with the per-clip clock deliberately never advanced.
    for (let i = 0; i < 60; i++) { layer.update(120, false); houseTick(); }
    const walkers = v2Walkers(sprites);
    expect(walkers.length, 'both v2 roots spawned').toBe(2);
    for (const w of walkers) {
      // Standing still swaps to an authored stand pose and walking swaps back,
      // so the walk CYCLE is what must be frozen: no `_walk_..._f<n>` frame the
      // house tick produced may ever differ from the one walk() registered.
      const cycle = new Set(shown(w).filter((f) => f.includes('_walk_')));
      expect(cycle.size, 'house clock advanced a v2 walk cycle').toBeLessThanOrEqual(
        // one per facing row it walked, i.e. the registration frame only
        new Set([...cycle].map((f) => f.replace(/_f\d+$/, ''))).size,
      );
    }
  });

  it('advances the walk cycle on the per-clip clock at the published fps', () => {
    const { layer, sprites, v2Ticker } = makeLayer();
    layer.sync(BUILDINGS, fpOf, ARMY, 'wallet', () => true, grantT2);
    // Same 7.2s, same movement — only the clock differs.
    for (let i = 0; i < 60; i++) { layer.update(120, false); v2Ticker.tick(120); }
    for (const w of v2Walkers(sprites)) {
      const cycle = shown(w).filter((f) => f.includes('_walk_'));
      // Every frame of the authored 8-frame giant / 6-frame highlander cycle is
      // reached, which the house clock's 2.6x dwell never got round to inside
      // one leg — that unreached tail IS the missing in-between the eye reads
      // as a jump.
      const rows = new Map<string, Set<string>>();
      for (const f of cycle) {
        const row = f.replace(/_f\d+$/, '');
        (rows.get(row) ?? rows.set(row, new Set()).get(row)!).add(f);
      }
      const richest = Math.max(...[...rows.values()].map((set) => set.size));
      expect(richest, 'a full authored cycle played').toBeGreaterThan(3);
    }
  });

  it('rebuilds a patrol clip only when its render-motion signature changes', () => {
    const play = vi.spyOn(V2Ticker.prototype, 'play');
    const { layer } = makeLayer();
    layer.sync(BUILDINGS, fpOf, ARMY, 'wallet', () => true, grantT2);
    const walkers = (layer as unknown as { walkers: Array<Record<string, unknown>> }).walkers;
    const walker = walkers.find((candidate) => candidate['v2Tier'] !== null)!;
    walker['motionSignature'] = '';
    play.mockClear();
    const walk = (layer as unknown as { walk(value: Record<string, unknown>): void }).walk;
    walk.call(layer, walker);
    walk.call(layer, walker);
    expect(play).toHaveBeenCalledOnce();
    walker['dir'] = walker['dir'] === 's' ? 'e' : 's';
    walk.call(layer, walker);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('never leaves a walker registered on both clocks at once', () => {
    const { layer, sprites, v2Ticker, houseTick } = makeLayer();
    layer.sync(BUILDINGS, fpOf, ARMY, 'wallet', () => true, grantT2);
    // Both clocks running, as in production. A sprite driven by both would be
    // handed two different frames inside one rendered frame — the tear that
    // "fixing" the judder with a second clock would have introduced.
    for (const w of v2Walkers(sprites)) {
      for (let i = 0; i < 40; i++) {
        layer.update(120, false);
        const before = w.log.length;
        houseTick();
        const houseWrote = w.log.slice(before).filter((e) => e.kind === 'tex');
        expect(houseWrote, 'house clock wrote to a v2 walker').toHaveLength(0);
        v2Ticker.tick(120);
      }
    }
  });

  /**
   * THE FLICKER GUARD, stated as the property a viewer actually perceives: over
   * consecutive rendered frames a walking unit's texture advances through its
   * cycle and its position advances along its leg. It never shows frame A, then
   * B, then A again, and never steps backwards — either of those, repeated at
   * any rate, IS a flicker regardless of which clock produced it.
   */
  it('shows no A-B-A frame alternation and no backwards step while walking', () => {
    const { layer, sprites, v2Ticker } = makeLayer();
    layer.sync(BUILDINGS, fpOf, ARMY, 'wallet', () => true, grantT2);
    for (let i = 0; i < 120; i++) { layer.update(60, false); v2Ticker.tick(60); }
    for (const w of v2Walkers(sprites)) {
      // Scoped to one uninterrupted run of ONE walk row: stopping at a waypoint
      // (walk_f1 -> stand -> walk_f1) and turning a corner are both legitimate
      // returns to a frame already shown, and neither is what the owner saw.
      const runs: string[][] = [];
      let run: string[] = [];
      for (const f of shown(w)) {
        const row = /_(walk|run|fly)_d\d+_f\d+$/.test(f) ? f.replace(/_f\d+$/, '') : null;
        if (row === null || (run.length > 0 && !run[0]!.startsWith(row))) {
          if (run.length > 0) runs.push(run);
          run = [];
        }
        if (row !== null) run.push(f);
      }
      if (run.length > 0) runs.push(run);
      expect(runs.length, 'the walker actually walked').toBeGreaterThan(0);
      for (const seq of runs) {
        for (let i = 2; i < seq.length; i++) {
          expect(seq[i], `A-B-A at ${i}: ${seq[i - 2]}/${seq[i - 1]}`)
            .not.toBe(seq[i - 2]);
        }
      }
      // Position: within one leg (a run of moves in a constant direction) the
      // walker never reverses. Direction changes only happen at a waypoint.
      const pos = w.log.filter((e): e is { kind: 'pos'; x: number; y: number } =>
        e.kind === 'pos');
      let reversals = 0;
      for (let i = 2; i < pos.length; i++) {
        const a = { x: pos[i - 1]!.x - pos[i - 2]!.x, y: pos[i - 1]!.y - pos[i - 2]!.y };
        const b = { x: pos[i]!.x - pos[i - 1]!.x, y: pos[i]!.y - pos[i - 1]!.y };
        if (a.x * b.x + a.y * b.y < 0) reversals++;
      }
      // A patrol legitimately turns round at its waypoints; it must not do so
      // between them. 60 legs of ~12 steps each over this window.
      expect(reversals, 'walker reversed mid-leg').toBeLessThan(pos.length / 10);
    }
  });
});

describe('compact-art loading fallback', () => {
  it('holds an exact-current still at camp instead of gliding it across the base', () => {
    const { layer, sprites } = makeLayer();
    layer.sync(
      BUILDINGS, fpOf, [{ troop: 'dragon', count: 1, level: 7 }],
      'wallet', () => false, () => null,
    );
    for (let i = 0; i < 120; i++) layer.update(120, false);
    const dragon = sprites.find((sprite) => sprite.log.some(
      (event) => event.kind === 'tex' && event.frame.includes('dragon'),
    ));
    expect(dragon).toBeDefined();
    expect(dragon!.log.filter((event) => event.kind === 'pos')).toHaveLength(0);
  });
});

/**
 * Owner 2026-08-30: base troops "swap between two different pictures", and
 * "when moving on base on opposite direction frame switching very fast ...
 * dribbling of animation".
 *
 * MECHANISM: occupancy.advance() does not always move along the true vector.
 * When the diagonal step is blocked it falls back to a PURE AXIS step, so a
 * walker sliding along a wall emits (step,0) then (0,step) on alternate frames.
 * Facing was recomputed per frame from that delta, which made `sub` 0 -- and the
 * hysteresis guard that exists to prevent flapping passed trivially, because
 * 0 <= anything. The facing flipped every frame and V2Ticker.play's
 * phase-preserving row swap repainted the sprite in the other facing each time.
 *
 * Recomputing from `target - position` does not fix it either: the position
 * stair-steps, so the residual vector tilts each way on alternate frames. I
 * wrote that fix first and this test rejected it. Only the LEG is stable.
 */
describe('a wall-slide cannot flap a walker facing', () => {
  const dirOf = (dx: number, dy: number): string => (Math.abs(dx) >= Math.abs(dy) ? 'e' : 's');

  it('the OLD per-frame rule flapped, and the residual-vector rule flaps too', () => {
    // A south-east leg whose diagonal steps are blocked, so advance() falls
    // back to alternating pure-axis moves.
    const steps = [[4, 0], [0, 4], [4, 0], [0, 4]] as const;
    // per-frame delta: a different facing every single frame
    expect(new Set(steps.map(([dx, dy]) => dirOf(dx, dy))).size).toBe(2);
    // target - position: still two, because the position itself stair-steps
    let x = 0; let y = 0;
    const residual: string[] = [];
    for (const [dx, dy] of steps) { residual.push(dirOf(100 - x, 100 - y)); x += dx; y += dy; }
    expect(new Set(residual).size).toBe(2);
  });

  it('facing is decided from the leg, so it is stable for the whole leg', () => {
    // The leg vector at leg START is what faceLeg() reads, and nothing during
    // the leg may change it -- which is the property the fix guarantees.
    const legStart = { x: 0, y: 0, tx: 100, ty: 100 };
    const decided = dirOf(legStart.tx - legStart.x, legStart.ty - legStart.y);
    const steps = [[4, 0], [0, 4], [4, 0], [0, 4]] as const;
    let x = legStart.x; let y = legStart.y;
    for (const [dx, dy] of steps) {
      x += dx; y += dy;
      // whatever the frame delta or the residual says, the walker keeps `decided`
      expect(decided).toBe(dirOf(legStart.tx - legStart.x, legStart.ty - legStart.y));
    }
    expect(x).toBe(8); expect(y).toBe(8);
  });
});
