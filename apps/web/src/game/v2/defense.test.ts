/**
 * V2DefenseFx — the rework-v2 cannon/mortar battle controller.
 *
 * WHY THIS NEEDS TESTS AT ALL: every failure in this file is a silent one. Phaser
 * draws NOTHING for a frame a texture does not hold and raises nothing, so a
 * wrong row/state key is an invisible tower; a flash placed at the sprite's
 * anchor instead of the published emitter fires out of the masonry; a projectile
 * launched twice (or never) on one shot is a visual the player reads as "the
 * cannon looks broken"; and a continuation scheduled before a collapse repaints
 * rubble as a live tower — the exact regression fx/muzzle.ts documents for the
 * legacy path and pins in muzzle.test.ts. None of it errors, and none of it is
 * visible in a screenshot of one frame.
 *
 * The clip data here is the REAL packed sidecar (apps/web/public/atlas/meta.json)
 * for the same reason clips.test.ts uses it: synthetic fps/anchor/emitter numbers
 * would pass forever after the pack changed underneath them.
 *
 * NOT REACHABLE FROM HERE (BattleScene value-imports Phaser, which touches
 * `window` at import time and takes a node test run down — the reason
 * patrol.test.ts mocks BootScene and BattleScene has no unit tests at all):
 *  - the HP mirror's `hp / maxHp < 0.5` comparison that CALLS setDamaged
 *    (BattleScene.onHit) — this file pins what the controller does with the
 *    boolean, at rest and mid-shot;
 *  - the `if (b.v2) { b.v2.collapse(); return; }` branch that routes v2 towers
 *    to their authored collapse and everything else to the generic fx_rubble
 *    (BattleScene.onDestroyed) — this file pins that the v2 side never touches
 *    an fx_rubble key, and muzzle.test.ts already pins the legacy rubble path.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  emitterAxis, emitterPoint, facing8, facingRow, headingRow, parseFxAt,
  v2BldArtFit, v2BldDrawScale,
  V2_DRAW_SCALE,
  type V2Clip, type V2ClipMap,
} from './clips';
import { V2DefenseFx } from './defense';
import { V2FX_ATLAS } from './projectiles';
import { V2Ticker } from './ticker';
import { advanceCombatEffects } from './effects';

// ---------------------------------------------------------------------------
// The real packed clip table (loud, never skipped — clips.test.ts precedent).
// ---------------------------------------------------------------------------
const metaUrl = new URL('../../../public/atlas/meta.json', import.meta.url);
if (!existsSync(metaUrl)) {
  throw new Error(
    'apps/web/public/atlas/meta.json is not built — run `pnpm assets` first. '
    + 'These tests drive the v2 controllers off the REAL clip table on purpose.',
  );
}
const CLIPS = (JSON.parse(readFileSync(metaUrl, 'utf8')) as { v2Clips: V2ClipMap }).v2Clips;
const clip = (key: string): V2Clip => {
  const c = CLIPS[key];
  if (!c) throw new Error(`meta.json has no v2 clip ${key}`);
  return c;
};

// ---------------------------------------------------------------------------
// Fakes. Same shape and semantics as fx/troop.test.ts's harness (a hand-cranked
// clock, every texture write recorded in order) plus the surface the v2
// projectile/fx layer touches: images, a repeating frame timer, the flight
// counter tween, the texture registry the rollback gate reads, and the camera the
// §3.10 landing shake pokes.
// ---------------------------------------------------------------------------
class FakeSprite {
  active = true;
  depth = 40;
  scale = 1;
  origin: [number, number] = [0.5, 1];
  rotation = 0;
  /** Every texture the sprite has shown: `atlas/frame`, in order. */
  readonly writes: string[] = [];
  constructor(public x = 0, public y = 0) {}
  setTexture(atlas: string, frame: string): this {
    this.writes.push(`${atlas}/${frame}`);
    return this;
  }
  setOrigin(ox: number, oy: number): this { this.origin = [ox, oy]; return this; }
  setScale(s: number): this { this.scale = s; return this; }
  setDepth(d: number): this { this.depth = d; return this; }
  setPosition(x: number, y: number): this { this.x = x; this.y = y; return this; }
  setRotation(r: number): this { this.rotation = r; return this; }
  setAlpha(): this { return this; }
  setVisible(): this { return this; }
  once(): this { return this; }
  destroy(): void { this.active = false; }
}

interface Counter {
  duration: number;
  onUpdate?: ((tw: { getValue: () => number }) => void) | undefined;
  onComplete?: (() => void) | undefined;
}

class FakeScene {
  now = 0;
  private timers: Array<{ at: number; fn: () => void }> = [];
  /** add.image() calls — projectiles, shadows, muzzle/smoke fx. */
  readonly images: FakeSprite[] = [];
  readonly counters: Counter[] = [];
  readonly shakes: number[] = [];
  /** Atlas groups the game has actually registered (isV2AtlasLoaded's authority). */
  readonly loaded = new Set<string>([V2FX_ATLAS]);

  readonly textures = { exists: (key: string): boolean => this.loaded.has(key) };
  readonly cameras = { main: { shake: (ms: number): void => { this.shakes.push(ms); } } };
  readonly tweens = {
    add: (): unknown => ({}),
    addCounter: (cfg: Counter): unknown => { this.counters.push(cfg); return {}; },
  };
  readonly time = {
    delayedCall: (ms: number, fn: () => void): unknown => {
      this.timers.push({ at: this.now + ms, fn });
      return {};
    },
    addEvent: (): { remove: () => void } => ({ remove: (): void => undefined }),
  };
  readonly add = {
    image: (x: number, y: number, atlas: string, frame: string): FakeSprite => {
      const s = new FakeSprite(x, y);
      s.writes.push(`${atlas}/${frame}`);
      this.images.push(s);
      return s;
    },
  };

  advanceTo(ms: number): void {
    for (;;) {
      const due = this.timers.filter((t) => t.at <= ms).sort((a, b) => a.at - b.at);
      if (due.length === 0) break;
      const next = due[0]!;
      this.timers = this.timers.filter((t) => t !== next);
      this.now = next.at;
      next.fn();
    }
    this.now = ms;
  }
  /** Land every projectile currently in flight (drives the counter tween's end). */
  landAll(): void {
    advanceCombatEffects(this as never, 10_000);
  }
}

/** A seated tower, exactly as BattleScene.adoptV2Defenses hands one over. */
function tower(unit: 'cannon' | 'mortar' = 'cannon', tier = 1) {
  const scene = new FakeScene();
  const sprite = new FakeSprite(500, 600);
  const ticker = new V2Ticker();
  const fx = new V2DefenseFx(
    scene as never,
    { ticker, clips: CLIPS, unit, tier },
    sprite as never,
  );
  return { scene, sprite, ticker, fx, unit, tier };
}

/** Frame keys written since `mark`, atlas prefix stripped. */
const since = (sprite: FakeSprite, mark: number): string[] =>
  sprite.writes.slice(mark).map((w) => w.split('/')[1]!);
/** ms it takes to play `frames` of a clip at its own fps, plus a nudge. */
const runMs = (c: V2Clip, extra = 1): number => (1000 / (c.fps ?? 12)) * (c.frames + extra);

// A target due WEST of the tower: facing8 → 'w' → rowOrder index 2. Deliberately
// not row 0, so "rests on the aim row" and "row 0 by accident" are different
// answers.
const WEST = { ix: 100, iy: 600 };
const WEST_ROW = facingRow(clip('v2_bld_cannon_t1_fire'), facing8(WEST.ix - 500, WEST.iy - 600));

describe('V2DefenseFx seating and resting loop', () => {
  it('adopts the v2 idle master: published anchor, fitted world scale, idle at its own fps', () => {
    const { sprite, ticker, scene } = tower();
    const idle = clip('v2_bld_cannon_t1_idle');
    const [ax, ay] = idle.anchorPx!;
    // The anchor is a FRACTION of the cell, from the pack — (56,104) of 112×120,
    // which is the footprint CENTRE for these two units (ART_V2).
    expect(sprite.origin[0]).toBeCloseTo(ax / idle.cellW, 6);
    expect(sprite.origin[1]).toBeCloseTo(ay / idle.cellH, 6);
    // @1x pack in an @2x world (V2_DRAW_SCALE), TIMES the Cannon's published
    // world fit. This used to be the bare pack conversion; that is the value
    // that let the Cannon out-size the Keep on the base (owner 2026-08-30), and
    // adopting a tower for a raid must not resurrect it — the same building has
    // to be the same size in the base view, the battle and the deed.
    expect(sprite.scale).toBe(v2BldDrawScale('cannon'));
    expect(sprite.scale).toBeLessThan(V2_DRAW_SCALE);
    // Resting on the idle LOOP, at the manifest's 3fps rather than the legacy
    // global 260ms clock.
    expect(sprite.writes).toEqual(['v2bld_cannon_t1/v2_bld_cannon_t1_idle_d0_f1']);
    ticker.tick(1000 / idle.fps! - 1);
    expect(sprite.writes).toHaveLength(1); // not yet
    ticker.tick(2);
    expect(sprite.writes.at(-1)).toBe('v2bld_cannon_t1/v2_bld_cannon_t1_idle_d0_f2');
    ticker.tick(1000 / idle.fps!);
    expect(sprite.writes.at(-1)).toBe('v2bld_cannon_t1/v2_bld_cannon_t1_idle_d0_f1'); // loops
    expect(scene.images).toEqual([]); // an idle tower emits no fx
  });
});

describe('V2DefenseFx directional fire → reload', () => {
  it('lays the turret on the target row and RESTS there, not back on row 0', () => {
    const { sprite, ticker, fx } = tower();
    const mark = sprite.writes.length;
    fx.fire(WEST.ix, WEST.iy);
    const fire = clip('v2_bld_cannon_t1_fire');
    const reload = clip('v2_bld_cannon_t1_reload');
    ticker.tick(runMs(fire));
    ticker.tick(runMs(reload));
    ticker.tick(1);
    const played = since(sprite, mark);
    // The whole authoritative run happened, in order, all on the WEST row…
    expect(played[0]).toBe(`v2_bld_cannon_t1_fire_d${WEST_ROW}_f1`);
    expect(played.some((f) => f === `v2_bld_cannon_t1_fire_d${WEST_ROW}_f1`)).toBe(true);
    expect(played.some((f) => f === `v2_bld_cannon_t1_reload_d${WEST_ROW}_f1`)).toBe(true);
    expect(played.every((f) => f.includes(`_d${WEST_ROW}_`)), played.join(' ')).toBe(true);
    // …and the resting idle keeps the barrel pointing where it shot. Resting on
    // row 0 would swing the turret back to south between every shot.
    expect(played.at(-1)).toMatch(new RegExp(`^v2_bld_cannon_t1_idle_d${WEST_ROW}_f\\d$`));
    expect(WEST_ROW).not.toBe(0); // the assertion above means something
  });

  it('never inserts a pre-aim delay into the authoritative 143ms release clock', () => {
    // D-034 publishes fire@2 as the release. A separate aim clip would move a
    // newly acquired heading's visible impact behind the damage event.
    const { sprite, ticker, fx } = tower();
    fx.fire(WEST.ix, WEST.iy);
    ticker.tick(runMs(clip('v2_bld_cannon_t1_fire')));
    ticker.tick(runMs(clip('v2_bld_cannon_t1_reload')) + 1);
    const mark = sprite.writes.length;
    fx.fire(WEST.ix, WEST.iy); // same target, same row
    ticker.tick(1);
    expect(since(sprite, mark).filter((f) => f.includes('_aim_'))).toEqual([]);
    expect(since(sprite, mark)[0]).toBe(`v2_bld_cannon_t1_fire_d${WEST_ROW}_f1`);
  });
});

describe('V2DefenseFx shot FX (the manifest fxAt schedule)', () => {
  const IGNITION = parseFxAt(clip('v2_bld_cannon_t1_fire').fxAt).find((e) => e.fx === 'muzzle')!.frames[0]!;

  it('flashes at the PUBLISHED emitter pixel, scaled into world px and rotated to the axis', () => {
    const { scene, sprite, ticker, fx } = tower();
    fx.fire(WEST.ix, WEST.iy);
    const fire = clip('v2_bld_cannon_t1_fire');
    // Step to the ignition frame only — the flash must land on THAT frame.
    ticker.tick((1000 / fire.fps!) * (IGNITION - 1) + 1);
    const flash = scene.images.find((i) => i.writes[0]!.includes('v2_fx_muzzle_t1'));
    expect(flash, 'muzzle flash spawned at the ignition frame').toBeDefined();
    // Derived independently of emitterWorld: the emitter table is in CELL px and
    // the sprite's position IS its anchor, so the offset is a pack-px vector and
    // has to be scaled like the art around it. Unscaled, the flash lands halfway
    // down the barrel.
    const [ex, ey] = emitterPoint(fire, 'muzzle', WEST_ROW, IGNITION - 1);
    const [ax, ay] = fire.anchorPx!;
    // …and it rides the body's FITTED scale, not the raw pack conversion: a
    // refitted tower whose muzzle table still used ×2 would fire from beside
    // itself (the detachment the WARE towers already hit once).
    expect(flash!.x).toBeCloseTo(sprite.x + (ex - ax) * v2BldDrawScale('cannon'), 6);
    expect(flash!.y).toBeCloseTo(sprite.y + (ey - ay) * v2BldDrawScale('cannon'), 6);
    // Axis degrees go in UNNEGATED (both the labs and Phaser are clockwise-
    // positive). Negating it mirrored every flash about the horizon.
    const axisDeg = emitterAxis(fire, WEST_ROW, IGNITION - 1);
    expect(flash!.rotation).toBeCloseTo((axisDeg * Math.PI) / 180, 6);
    expect(Math.abs(axisDeg)).toBeGreaterThan(1); // a real angle, not a no-op
  });

  it('launches exactly ONE cannonball per shot, from the muzzle, on the travel heading', () => {
    const { scene, sprite, ticker, fx } = tower();
    fx.fire(WEST.ix, WEST.iy);
    ticker.tick(runMs(clip('v2_bld_cannon_t1_fire')));
    const balls = scene.images.filter((i) => i.writes[0]!.includes('v2_fx_cannonball_t1'));
    expect(balls).toHaveLength(1);
    const fire = clip('v2_bld_cannon_t1_fire');
    const [ex, ey] = emitterPoint(fire, 'muzzle', WEST_ROW, IGNITION - 1);
    const [ax, ay] = fire.anchorPx!;
    expect(balls[0]!.x).toBeCloseTo(sprite.x + (ex - ax) * v2BldDrawScale('cannon'), 6);
    expect(balls[0]!.y).toBeCloseTo(sprite.y + (ey - ay) * v2BldDrawScale('cannon'), 6);
    // Travel sets are pre-baked per HEADING (a rotated pixel sprite shears its
    // dither), and this shot flies LEFT — row 4. A hardcoded +x row would fly the
    // ball backwards out of its own muzzle.
    const row = headingRow(WEST.ix - balls[0]!.x, WEST.iy - balls[0]!.y);
    expect(row).toBe(4);
    expect(balls[0]!.writes[0]).toBe(`${V2FX_ATLAS}/v2_fx_cannonball_t1_d${row}_f1`);
    // REWRITTEN 2026-08-30. This used to assert the bare V2_DRAW_SCALE — every
    // shot in the game drawn at a flat ×2 regardless of what fired it, which is
    // what the owner reported on the troop side ("arrows can't be the same size
    // as the archer"). A defence tower is not a troop, so it does NOT inherit
    // BATTLE_SCALE.troop; it inherits the same rule — the round is the size of
    // the gun. Asserted as the identical product `v2BldArtFit` hands the muzzle
    // above, so a refit of the Cannon can never move the barrel without the ball.
    expect(balls[0]!.scale).toBe(V2_DRAW_SCALE * v2BldArtFit('cannon'));
    expect(balls[0]!.scale).toBeLessThan(V2_DRAW_SCALE);
  });

  it('fires each keyed effect ONCE even when the whole clip catches up in one tick', () => {
    // V2Ticker deliberately catches up frame-by-frame so a GC pause cannot skip
    // an fxAt frame. That is also the path that would fire a keyed effect twice
    // (or spawn two cannonballs from one shot) without the per-shot dedupe.
    const { scene, ticker, fx } = tower();
    fx.fire(WEST.ix, WEST.iy);
    ticker.tick(10_000); // the ENTIRE fire clip inside one monstrous frame
    const named = (s: string): number =>
      scene.images.filter((i) => i.writes[0]!.includes(s)).length;
    expect(named('v2_fx_cannonball_t1')).toBe(1);
    expect(named('v2_fx_muzzle_t1')).toBe(1);
    expect(named('v2_fx_smoke_t1')).toBe(1);
  });

  it('gives the mortar its own authored fx: a mortarflash and a SHELL, never a cannonball', () => {
    const { scene, ticker, fx } = tower('mortar');
    expect(parseFxAt(clip('v2_bld_mortar_t1_fire').fxAt).map((e) => e.fx))
      .toEqual(['mortarflash', 'shell']);
    fx.fire(WEST.ix, WEST.iy);
    ticker.tick(runMs(clip('v2_bld_mortar_t1_fire')));
    const kinds = scene.images.map((i) => i.writes[0]!);
    expect(kinds.some((k) => k.includes('v2_fx_mortarflash_t1'))).toBe(true);
    expect(kinds.filter((k) => k.includes('v2_fx_shell_t1'))).toHaveLength(1);
    expect(kinds.some((k) => k.includes('cannonball'))).toBe(false);
    // The shell's landing IS the explosion (the sim emits no event for it), and
    // it spends the §3.10 keg/mortar budget: shake + the crater impact.
    scene.landAll();
    expect(scene.shakes).toEqual([150]);
    expect(scene.images.some((i) => i.writes[0]!.includes('v2_fx_impact_crater_t1'))).toBe(true);
    scene.advanceTo(scene.now + 1000); // release juice.ts's concurrent-shake budget
  });
});

describe('V2DefenseFx damaged state', () => {
  it('swaps the resting loop to the authored damaged clip, and back', () => {
    const { sprite, ticker, fx } = tower();
    let mark = sprite.writes.length;
    fx.setDamaged(true);
    expect(since(sprite, mark)[0]).toBe('v2_bld_cannon_t1_damaged_d0_f1');
    ticker.tick(runMs(clip('v2_bld_cannon_t1_damaged')));
    expect(since(sprite, mark).every((f) => f.includes('_damaged_'))).toBe(true);
    // A replay rebase can heal a building (the HP mirror is the sim's, and a
    // scrubbed replay walks it backwards), so the flip has to work both ways.
    mark = sprite.writes.length;
    fx.setDamaged(false);
    expect(since(sprite, mark)[0]).toBe('v2_bld_cannon_t1_idle_d0_f1');
  });

  it('DEFERS the swap when it lands mid-shot, then rests damaged', () => {
    // The HP mirror crosses half whenever a hit lands, which is routinely in the
    // middle of a shot. Swapping there would cut the fire clip — its muzzle flash
    // and its cannonball are scheduled on later frames of that same clip, so the
    // shot would silently lose them.
    const { scene, sprite, ticker, fx } = tower();
    fx.fire(WEST.ix, WEST.iy);
    ticker.tick(1000 / clip('v2_bld_cannon_t1_fire').fps!); // remain mid-shot
    const mark = sprite.writes.length;
    fx.setDamaged(true); // a hit lands mid-shot
    ticker.tick(1);
    expect(since(sprite, mark).some((f) => f.includes('_damaged_')), 'not mid-shot').toBe(false);
    ticker.tick(runMs(clip('v2_bld_cannon_t1_fire')));
    // The shot still produced its full fx…
    expect(scene.images.some((i) => i.writes[0]!.includes('v2_fx_cannonball_t1'))).toBe(true);
    ticker.tick(runMs(clip('v2_bld_cannon_t1_reload')) + 1);
    // …and the deferred state lands when the sequence finally rests, on the row
    // it was firing from.
    expect(sprite.writes.at(-1)).toBe(
      `v2bld_cannon_t1/v2_bld_cannon_t1_damaged_d${WEST_ROW}_f1`,
    );
  });

  it('ignores a repeat of the state it is already in', () => {
    // setDamaged is called on EVERY hit event; re-issuing the same value must not
    // restart the 2-frame loop (a loop that restarts every hit never animates).
    const { sprite, ticker, fx } = tower();
    fx.setDamaged(true);
    ticker.tick(1000 / clip('v2_bld_cannon_t1_damaged').fps!);
    const mark = sprite.writes.length;
    fx.setDamaged(true);
    fx.setDamaged(true);
    expect(since(sprite, mark)).toEqual([]);
  });
});

describe('V2DefenseFx collapse', () => {
  it('plays the building\'s OWN collapse clip and HOLDS its final rubble frame', () => {
    const { sprite, ticker, fx } = tower();
    const mark = sprite.writes.length;
    fx.collapse();
    const c = clip('v2_bld_cannon_t1_collapse');
    ticker.tick(runMs(c, 4));
    // Single-row clip: no `_d` token — a fabricated `_d0` names a frame the
    // packer never emitted, i.e. an invisible collapse.
    expect(since(sprite, mark)).toEqual(
      Array.from({ length: c.frames }, (_, i) => `v2_bld_cannon_t1_collapse_f${i + 1}`),
    );
    // The held last frame IS the rubble: these two types must NEVER be repainted
    // by BattleScene's generic fx_rubble path (which is what every other
    // building still gets — see muzzle.test.ts for that side).
    expect(sprite.writes.every((w) => !w.includes('fx_rubble'))).toBe(true);
    const settled = sprite.writes.length;
    ticker.tick(10_000);
    expect(sprite.writes).toHaveLength(settled); // nothing after the hold
  });

  it('strands a shot in flight, so no late reload frame repaints the rubble as a tower', () => {
    // The v2 counterpart of cancelDefenceFire (muzzle.test.ts: "cancels a shot in
    // flight so it cannot repaint rubble as a tower"). Here the continuation is
    // the fire clip's onComplete → reload → rest chain, and the shot token is
    // what strands it.
    const { sprite, ticker, fx } = tower();
    fx.fire(WEST.ix, WEST.iy);
    ticker.tick(1000 / clip('v2_bld_cannon_t1_fire').fps!); // mid-shot
    fx.collapse();
    ticker.tick(10_000);
    const last = sprite.writes.at(-1)!;
    expect(last).toBe(
      `v2bld_cannon_t1/v2_bld_cannon_t1_collapse_f${clip('v2_bld_cannon_t1_collapse').frames}`,
    );
    // Neither a reload frame nor a resting idle/damaged frame may appear AFTER
    // the collapse started.
    const afterCollapse = sprite.writes.slice(sprite.writes.findIndex((w) => w.includes('_collapse_')));
    expect(afterCollapse.filter((w) => /_(reload|idle|damaged|aim|fire)_/.test(w))).toEqual([]);
  });

  /**
   * THE SHOT TOKEN'S one observable job. Every OTHER cancellation path is
   * covered by V2Ticker.play replacing the sprite's entry outright (the collapse
   * clip evicts the fire clip, callbacks and all), so the token only becomes
   * load-bearing where that replacement does not happen: a collapse whose
   * authored clip is absent. All eight collapse clips ship today (pinned in
   * clips.test.ts), so this is the rollback clause rather than a live path — but
   * without the token the fire clip's own onComplete would then run, chain into
   * reload and rest the tower back on its IDLE loop: a destroyed cannon
   * swivelling happily, which is precisely the "repaint rubble as a tower" bug
   * cancelDefenceFire exists for on the legacy side.
   */
  it('never resurrects itself into idle when the collapse clip is missing', () => {
    const noCollapse: V2ClipMap = { ...CLIPS };
    delete noCollapse['v2_bld_cannon_t1_collapse'];
    const scene = new FakeScene();
    const sprite = new FakeSprite(500, 600);
    const ticker = new V2Ticker();
    const fx = new V2DefenseFx(
      scene as never, { ticker, clips: noCollapse, unit: 'cannon', tier: 1 }, sprite as never,
    );
    fx.fire(WEST.ix, WEST.iy);
    ticker.tick(1000 / clip('v2_bld_cannon_t1_fire').fps!); // mid-shot
    const mark = sprite.writes.length;
    fx.collapse();
    ticker.tick(10_000);
    const after = since(sprite, mark);
    expect(after.filter((f) => /_(reload|idle|damaged)_/.test(f)), after.join(' ')).toEqual([]);
  });

  it('is final: a later fire() or damaged flip cannot bring the tower back', () => {
    const { scene, sprite, ticker, fx } = tower();
    fx.collapse();
    ticker.tick(10_000);
    const settled = sprite.writes.length;
    fx.fire(WEST.ix, WEST.iy);
    fx.setDamaged(true);
    ticker.tick(10_000);
    expect(sprite.writes).toHaveLength(settled);
    expect(scene.images.filter((i) => i.writes[0]!.includes('cannonball'))).toEqual([]);
  });
});

/**
 * THE ROLLBACK CLAUSE, and the one documented return value nothing checks.
 *
 * `launchV2Projectile` returns false when the v2fx group or the clip is missing,
 * and BOTH rich-controller callers ignore it. That is safe only because a v2
 * controller cannot exist without v2fx, and each of the two callers is gated by a
 * DIFFERENT mechanism:
 *  - troops: BattleScene sets v2TroopTiers only when the unit's tier atlas AND
 *    V2FX_ATLAS are both registered (an explicit conjunction);
 *  - defences: adoptV2Defenses runs only when `ensureV2Atlases` RESOLVES, and
 *    V2FX_ATLAS is always in that request set — a set that is all-or-nothing
 *    (pinned in world/atlasLoader.test.ts).
 * So the tests below pin the DEGRADE (what an un-gated build would look like):
 * no crash, the tower still animates,
 * and — the part that matters — nothing half-drawn is left on the field.
 */
describe('V2DefenseFx without the shared v2fx atlas (an ungated build)', () => {
  it('still animates the whole shot and draws NO half-shot', () => {
    const { scene, sprite, ticker, fx } = tower();
    scene.loaded.delete(V2FX_ATLAS);
    const mark = sprite.writes.length;
    expect(() => {
      fx.fire(WEST.ix, WEST.iy);
      ticker.tick(runMs(clip('v2_bld_cannon_t1_fire')));
      ticker.tick(runMs(clip('v2_bld_cannon_t1_reload')) + 1);
    }).not.toThrow();
    const played = since(sprite, mark);
    expect(played.some((f) => f.includes('_fire_'))).toBe(true);
    expect(played.some((f) => f.includes('_reload_'))).toBe(true);
    // No projectile, no flash, no shadow, no impact — and no ORPHAN image either
    // (an image added and never stepped is a sprite frozen on the battlefield).
    expect(scene.images).toEqual([]);
    expect(scene.counters).toEqual([]);
  });
});
