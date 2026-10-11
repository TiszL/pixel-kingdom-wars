/**
 * TroopFx — the batch-13 per-level art path.
 *
 * WHAT MAKES THIS WORTH TESTING: asking a texture for a frame it does not hold
 * draws NOTHING in Phaser, and raises nothing. The levelled dragon/giant masters
 * live in their own `trpdg_l<N>` texture, so a sprite created against the
 * historical `trp` atlas with a levelled frame name — or the other way round —
 * is an invisible unit walking through a raid, and the only symptom is that the
 * player says their dragon "didn't show up". These tests assert the exact atlas
 * and the exact frame names, against the same grouping rule the packer used.
 */
import {
  ART_V2, atlasGroupFor, BATTLE_SCALE, V2_FALLBACK_ATLAS,
  WARE_FALLBACK_ATLAS, v2FallbackFrameKey, v2LocomotionAtlasGroup,
  v2TroopFallbackFxAtlasGroups, v2TroopFallbackFxBaseKey,
  wareHatchlingFallbackKey, WORLD_DEPTH,
} from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import { AnimTicker } from '../anim';
import { toWorldPx, V2_DRAW_SCALE } from '../v2/clips';

/**
 * The world scale a battle body — and therefore every pack-px offset measured
 * off it — is drawn at, since the troop pack started publishing a world fit
 * (ART_V2.troopSourceScale, owner 2026-08-30 "troops are very big").
 *
 * Written as the composition rather than as numbers on purpose: these cases
 * exist to pin that an emitter point tracks THE SAME scale as the body it hangs
 * off. A literal would pass just as happily with the two detached, which is the
 * bug — a fitted bowman firing from where his unfitted hand used to be.
 */
const bodyScaleOf = (unit: keyof typeof ART_V2.troopSourceScale): number =>
  ART_V2.troopSourceScale[unit] * BATTLE_SCALE.troop;
import { launchV2Projectile, playV2Fx, V2FX_ATLAS } from '../v2/projectiles';
import { V2Ticker } from '../v2/ticker';
import { advanceCombatEffects } from '../v2/effects';
import type { WareHatchlingDeps } from '../ware/hatchling';
import { PROJ_ART } from './projectiles';
import {
  V2_TROOP_PROFILES,
  type V2TroopDeps, type V2TroopFallbackDeps, type V2TroopUnit,
} from '../v2/troop';
import { TroopFx } from './troop';

class FakeSprite {
  active = true;
  visible = true;
  alpha = 1;
  depth = 0;
  flipX = false;
  /** Every texture the sprite has shown: `atlas/frame`, first one from add(). */
  readonly writes: string[] = [];
  constructor(public x: number, public y: number, atlas: string, frame: string) {
    this.writes.push(`${atlas}/${frame}`);
  }
  setTexture(atlas: string, frame: string): this {
    this.writes.push(`${atlas}/${frame}`);
    return this;
  }
  originX = 0;
  originY = 0;
  setOrigin(x: number, y: number): this { this.originX = x; this.originY = y; return this; }
  setDepth(d: number): this { this.depth = d; return this; }
  scale = 1;
  setScale(s: number): this { this.scale = s; return this; }
  setVisible(v: boolean): this { this.visible = v; return this; }
  setAlpha(a: number): this { this.alpha = a; return this; }
  setFlipX(v: boolean): this { this.flipX = v; return this; }
  rotation = 0;
  setRotation(r: number): this { this.rotation = r; return this; }
  setPosition(x: number, y: number): this { this.x = x; this.y = y; return this; }
  once(): this { return this; }
  destroy(): void { this.active = false; }
}

/** A flight tween's config (Phaser's tweens.addCounter), so a test can land it. */
interface Counter {
  onUpdate?: ((tw: { getValue: () => number }) => void) | undefined;
  onComplete?: (() => void) | undefined;
}

class FakeScene {
  now = 0;
  private timers: Array<{ at: number; fn: () => void }> = [];
  readonly sprites: FakeSprite[] = [];
  /** add.image() calls — v2 projectiles, their altitude shadow, impacts, fx. */
  readonly images: FakeSprite[] = [];
  readonly counters: Counter[] = [];
  readonly shakes: number[] = [];
  readonly killedTweens: unknown[] = [];
  readonly tweenConfigs: Array<Record<string, unknown>> = [];
  /** Atlas groups the game has registered — what the v2 rollback gate reads. */
  readonly loaded = new Set<string>([V2FX_ATLAS]);
  readonly textures = { exists: (key: string): boolean => this.loaded.has(key) };
  readonly cameras = { main: { shake: (ms: number): void => { this.shakes.push(ms); } } };
  readonly tweens = {
    add: (config: Record<string, unknown>): unknown => {
      this.tweenConfigs.push(config);
      return {};
    },
    addCounter: (cfg: Counter): unknown => { this.counters.push(cfg); return {}; },
    killTweensOf: (target: unknown): void => { this.killedTweens.push(target); },
  };
  readonly time = {
    delayedCall: (ms: number, fn: () => void): unknown => {
      this.timers.push({ at: this.now + ms, fn });
      return {};
    },
    addEvent: (): { remove: () => void } => ({ remove: (): void => undefined }),
  };
  readonly add = {
    sprite: (x: number, y: number, atlas: string, frame: string): FakeSprite => {
      const s = new FakeSprite(x, y, atlas, frame);
      this.sprites.push(s);
      return s;
    },
    image: (x: number, y: number, atlas: string, frame: string): FakeSprite => {
      const s = new FakeSprite(x, y, atlas, frame);
      this.images.push(s);
      return s;
    },
  };
  /** Land every projectile in flight (drives the flight counter to its end). */
  landAll(): void {
    advanceCombatEffects(this as never, 10_000);
  }
  /** Fire everything due at or before `ms`, in order. */
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
}

function make(
  troop: string,
  opts: {
    level?: number; skin?: 'hero_vex' | 'hero_theo'; v2?: V2TroopDeps;
    fallback?: V2TroopFallbackDeps; hatchling?: WareHatchlingDeps;
  } = {},
) {
  const scene = new FakeScene();
  const anim = new AnimTicker();
  const fx = new TroopFx(
    scene as never, anim, troop as never, 10, 20, 20,
    opts.skin, opts.level, opts.v2, opts.fallback, opts.hatchling,
  );
  return { scene, anim, fx, sprite: scene.sprites[0]!, first: scene.sprites[0]!.writes[0]! };
}

function hatchlingDeps(level: number): WareHatchlingDeps {
  return { ticker: new V2Ticker(), clips: {}, level, rich: false };
}

function fallbackDeps(unit: 'dragon' | 'turrider', tier = 2): V2TroopFallbackDeps {
  const state = unit === 'dragon' ? 'hover' : 'idle';
  return {
    unit, tier,
    clips: {
      [`v2_trp_${unit}_t${tier}_${state}`]: {
        frames: 4, rows: 8, cellW: unit === 'dragon' ? 160 : 128,
        cellH: unit === 'dragon' ? 120 : 104,
        rowOrder: ['s', 'sw', 'w', 'nw', 'n', 'ne', 'e', 'se'],
        anchorPx: unit === 'dragon' ? [80, 110] : [64, 94],
      },
    },
  };
}

function locomotionFallbackDeps(
  unit: 'bowman' | 'troll' | 'plunderer',
  tier = 1,
): V2TroopFallbackDeps {
  const ticker = new V2Ticker();
  const large = unit === 'troll';
  const cellW = large ? 112 : 96;
  const cellH = large ? 112 : 96;
  const anchorPx: [number, number] = large ? [56, 100] : [48, 86];
  const clip = (frames: number, fps: number) => ({
    frames, rows: 8, cellW, cellH,
    rowOrder: ['s', 'sw', 'w', 'nw', 'n', 'ne', 'e', 'se'],
    anchorPx, fps, loop: true,
  });
  return {
    unit, tier, ticker,
    clips: {
      [`v2_trp_${unit}_t${tier}_walk`]: clip(8, 11),
      [`v2_trp_${unit}_t${tier}_idle`]: clip(6, 7),
    },
  };
}

function currentStaticFallbackDeps(unit: V2TroopUnit, tier = 1): V2TroopFallbackDeps {
  const profile = V2_TROOP_PROFILES[unit];
  const base = `v2_${profile.kind}_${unit}_t${tier}_${profile.stand}`;
  return {
    unit, tier,
    clips: {
      [base]: {
        frames: 2, rows: 8, cellW: 96, cellH: 96,
        rowOrder: ['s', 'sw', 'w', 'nw', 'n', 'ne', 'e', 'se'],
        anchorPx: [48, 86], fps: 8, loop: true,
      },
    },
  };
}

/** Minimal v2 clip shapes for the giant — the REAL manifest counts (pinned by
 *  the clips.test ground-truth block), so the frame keys here are the ones a
 *  live raid asks for. */
function giantV2Deps(): V2TroopDeps {
  const grid = (frames: number, fps: number, loop: boolean) => ({
    frames, rows: 8, cellW: 112, cellH: 112,
    rowOrder: ['s', 'sw', 'w', 'nw', 'n', 'ne', 'e', 'se'],
    anchorPx: [56, 100] as [number, number], fps, loop,
  });
  return {
    ticker: new V2Ticker(),
    clips: {
      v2_trp_giant_t2_spawn: grid(6, 10, false),
      v2_trp_giant_t2_walk: grid(8, 10, true),
      v2_trp_giant_t2_idle: grid(4, 6, true),
      v2_trp_giant_t2_attack: grid(8, 11, false),
      // The throw carries the manifest's own `boulder@3` — the release frame,
      // 0-based at source (clips.test.ts pins the string against the real pack).
      v2_trp_giant_t2_throw: { ...grid(6, 12, false), fxAt: 'boulder@3' },
      v2_trp_giant_t2_hit: grid(3, 16, false),
      v2_trp_giant_t2_death: grid(6, 9, false),
      // The shared fx group the boulder flies out of (travel set: 8 HEADING
      // rows, centred cells), plus its altitude shadow and landing impact.
      v2_fx_boulder_t2: {
        frames: 4, rows: 8, cellW: 28, cellH: 28, anchorPx: [14, 14], fps: 12,
        loop: true, travel: true,
      },
      v2_fx_shadow: { frames: 3, rows: 1, cellW: 20, cellH: 12, anchorPx: [10, 6] },
      v2_fx_impact_rubble_t2: {
        frames: 6, rows: 1, cellW: 76, cellH: 76, anchorPx: [38, 52], fps: 18, loop: false,
      },
    },
    breath: null,
    unit: 'giant',
    tier: 2,
  };
}

function gridClip(frames: number, fps: number, loop: boolean, extra: object = {}) {
  return {
    frames, rows: 8, cellW: 96, cellH: 96,
    rowOrder: ['s', 'sw', 'w', 'nw', 'n', 'ne', 'e', 'se'],
    anchorPx: [48, 86] as [number, number], fps, loop, ...extra,
  };
}

function tunnelerV2Deps(): V2TroopDeps {
  return {
    ticker: new V2Ticker(), breath: null, unit: 'tunneler', tier: 1,
    clips: {
      v2_trp_tunneler_t1_walk: gridClip(8, 11, true),
      v2_trp_tunneler_t1_idle: gridClip(6, 7, true),
      v2_trp_tunneler_t1_attack: gridClip(6, 13, false),
      v2_trp_tunneler_t1_burrow: gridClip(6, 11, false, { fxAt: 'soil@2' }),
      v2_trp_tunneler_t1_tunnel: gridClip(6, 8, true),
      v2_trp_tunneler_t1_surface: gridClip(6, 12, false, { fxAt: 'soil@1' }),
      v2_trp_tunneler_t1_hit: gridClip(3, 15, false),
      v2_trp_tunneler_t1_death: gridClip(6, 9, false),
      v2_fx_soil_t1: {
        frames: 5, rows: 1, cellW: 56, cellH: 56, anchorPx: [28, 40],
        fps: 14, loop: false,
      },
    },
  };
}

function bowmanV2Deps(): V2TroopDeps {
  const nock = Array.from({ length: 8 }, (_, row) =>
    Array.from({ length: 4 }, () => [40 + row * 5, 50 + row]),
  );
  return {
    ticker: new V2Ticker(), breath: null, unit: 'bowman', tier: 1,
    clips: {
      v2_trp_bowman_t1_spawn: gridClip(6, 11, false),
      v2_trp_bowman_t1_walk: gridClip(8, 11, true),
      v2_trp_bowman_t1_idle: gridClip(6, 7, true),
      v2_trp_bowman_t1_draw: gridClip(6, 14, false),
      v2_trp_bowman_t1_loose: gridClip(4, 20, false, {
        fxAt: 'arrow@0', emitters: { nock },
      }),
      v2_trp_bowman_t1_hit: gridClip(3, 15, false),
      v2_trp_bowman_t1_death: gridClip(6, 9, false),
    },
  };
}

function mageV2Deps(): V2TroopDeps {
  const staff = Array.from({ length: 8 }, (_, row) =>
    Array.from({ length: 8 }, (_, frame) => [50 + row * 2 + frame, 40 + row]),
  );
  return {
    ticker: new V2Ticker(), breath: null, unit: 'mage', tier: 2,
    clips: {
      v2_trp_mage_t2_spawn: gridClip(6, 10, false),
      v2_trp_mage_t2_walk: gridClip(8, 10, true),
      v2_trp_mage_t2_idle: gridClip(6, 7, true),
      v2_trp_mage_t2_cast: gridClip(8, 13, false, {
        fxAt: 'castflash@4 + bolt@4', emitters: { staff },
      }),
      v2_trp_mage_t2_hit: gridClip(3, 16, false),
      v2_trp_mage_t2_death: gridClip(6, 9, false),
      v2_fx_castflash_t2: {
        frames: 3, rows: 1, cellW: 36, cellH: 36, anchorPx: [18, 18], fps: 20,
        loop: false,
      },
    },
  };
}

function meleeV2Deps(
  unit: V2TroopUnit,
  fx: 'sweep' | 'slash' | 'pick_hit' | 'lance_hit',
  emitter: 'blade' | 'fist' | 'pick' | 'lance',
): V2TroopDeps {
  const attachment = Array.from({ length: 8 }, (_, row) =>
    Array.from({ length: 6 }, (_, frame) => [40 + row, 50 + frame]),
  );
  const base = `v2_trp_${unit}_t1_`;
  const clips: V2TroopDeps['clips'] = {
    [`${base}walk`]: gridClip(8, 11, true),
    [`${base}idle`]: gridClip(6, 7, true),
    [`${base}attack`]: gridClip(6, 13, false, {
      fxAt: `${fx}@2`, emitters: { [emitter]: attachment },
    }),
    [`${base}hit`]: gridClip(2, 15, false),
    [`${base}death`]: gridClip(6, 9, false),
    [`v2_fx_${fx}_t1`]: {
      frames: 4, rows: 1, cellW: 48, cellH: 48, anchorPx: [6, 24],
      fps: 19, loop: false,
    },
  };
  if (unit !== 'tunneler' && unit !== 'bilgewraith') {
    clips[`${base}spawn`] = gridClip(4, 10, false);
  }
  return { ticker: new V2Ticker(), breath: null, unit, tier: 1, clips };
}

function direV2Deps(): V2TroopDeps {
  const maw = Array.from({ length: 8 }, () =>
    Array.from({ length: 8 }, () => [76, 44] as [number, number]));
  return {
    ticker: new V2Ticker(), breath: null, unit: 'direwyvern', tier: 1,
    clips: {
      v2_trp_direwyvern_t1_spawn: gridClip(4, 10, false),
      v2_trp_direwyvern_t1_glide: gridClip(6, 11, true),
      v2_trp_direwyvern_t1_hover: gridClip(4, 8, true),
      v2_trp_direwyvern_t1_firestorm: gridClip(8, 12, false, {
        fxAt: 'firestorm@1..6', emitters: { maw },
      }),
      v2_trp_direwyvern_t1_maul: gridClip(6, 12, false),
      v2_trp_direwyvern_t1_hit: gridClip(2, 15, false),
      v2_trp_direwyvern_t1_death: gridClip(6, 9, false),
      v2_fx_firestorm_t1: {
        frames: 8, rows: 1, cellW: 176, cellH: 128,
        anchorPx: [10, 64], fps: 11, loop: false,
      },
    },
  };
}

describe('TroopFx art selection', () => {
  it('settles a live Dire firestorm fan before the verdict', () => {
    // WHY: V2Ticker.settle freezes the last frame; it does not destroy
    // controller-owned fan sprites. The facade must cancel the replay action
    // before the verdict or the flame fan remains painted behind it forever.
    const deps = direV2Deps();
    const h = make('direwyvern', { v2: deps });
    deps.ticker.tick(2_000);
    h.fx.v2!.onAbility('firestorm', 10, 20, 200, 40);
    deps.ticker.tick(120);
    const fan = h.scene.sprites.find((sprite) =>
      sprite.writes[0]!.includes('v2_direwyvern_fx_firestorm_t1_f1'))!;
    expect(fan.active).toBe(true);

    h.fx.settle();

    expect(fan.active).toBe(false);
  });

  it('destroys a compact Gloam rend contact before the shared ticker settles', () => {
    // WHY: the contact is a separate one-shot sprite. V2Ticker.settle holds a
    // one-shot's current frame and clears its callback, so the TroopFx facade
    // must own this sprite or it remains painted behind the verdict forever.
    const deps = currentStaticFallbackDeps('gloamfang');
    deps.ticker = new V2Ticker();
    deps.clips.v2_trp_gloamfang_t1_rend = gridClip(4, 10, false, { fxAt: 'rend@0' });
    deps.clips.v2_fx_rend_t1 = {
      frames: 3, rows: 1, cellW: 48, cellH: 48,
      anchorPx: [8, 24], fps: 12, loop: false,
    };
    const h = make('gloamfang', { fallback: deps });

    h.fx.onMeleeAttack('building', 120, 20, 'rend');
    const contact = h.scene.sprites.find((sprite) =>
      sprite.writes[0]!.includes('v2_fx_rend_t1_f1'))!;
    expect(contact.active).toBe(true);

    h.fx.settle();
    deps.ticker.settle();

    expect(contact.active).toBe(false);
  });

  it('settles a hero travel at its authoritative endpoint', () => {
    const h = make('giant', { skin: 'hero_theo' });
    h.fx.onHeroTravel(160, 90, 800);

    h.fx.settle();

    expect(h.sprite).toMatchObject({ x: 160, y: 90, depth: WORLD_DEPTH.actor + 90 });
  });

  it('does not snap a surfaced troop back to its stale pre-emerge target', () => {
    const h = make('tunneler');
    h.fx.onPos(200, 180, 500);
    h.fx.onEmerge(90, 120);

    h.fx.settle();

    expect(h.sprite).toMatchObject({ x: 90, y: 120, depth: WORLD_DEPTH.actor + 120 });
  });

  it('normalizes a compact survivor frozen mid-lunge when the verdict kills its tween', () => {
    const h = make('troll', { fallback: currentStaticFallbackDeps('troll') });
    h.fx.onMeleeAttack('building', 120, 20, 'slam');
    h.sprite.alpha = 0.72; // midpoint written by Phaser before killAll()

    h.fx.settle();

    expect(h.sprite).toMatchObject({ active: true, visible: true, alpha: 1 });
  });

  it('normalizes a surfaced emerge blink but preserves authoritative burrow invisibility', () => {
    const emerged = make('tunneler');
    emerged.fx.onBurrow();
    emerged.fx.onEmerge(90, 120);
    emerged.sprite.alpha = 0.4; // midpoint of the live yoyo blink
    emerged.fx.settle();
    expect(emerged.sprite).toMatchObject({ visible: true, alpha: 1 });

    const burrowed = make('tunneler');
    burrowed.fx.onBurrow();
    burrowed.fx.settle();
    expect(burrowed.sprite.visible).toBe(false);
  });

  it('holds eager current Dragon and Tur Rider art across the legacy lifecycle', () => {
    for (const unit of ['dragon', 'turrider'] as const) {
      const fallback = fallbackDeps(unit);
      const { scene, fx, sprite, first } = make(unit, { level: 7, fallback });
      const expected = `${V2_FALLBACK_ATLAS}/${v2FallbackFrameKey(unit, 2)}`;
      expect(first, unit).toBe(expected);
      // The eager still is a BODY, so it carries the unit's published world fit
      // and the battle shrink, exactly as the full v2 controller does. It used
      // to sit at the bare pack conversion, which made the same unit two
      // different sizes depending on which art path the residency budget
      // admitted — a size that moved with a download.
      expect(sprite.scale).toBe(V2_DRAW_SCALE * bodyScaleOf(unit));
      fx.onPos(40, 50, 100);
      fx.onEmerge();
      fx.onDeath();
      scene.advanceTo(10_000);
      expect(new Set(sprite.writes), unit).toEqual(new Set([expected]));
      expect(sprite.writes.some((write) => write.includes('trp_'))).toBe(false);
    }
  });

  it.each(['bowman', 'troll', 'plunderer'] as const)(
    'animates %s from compact current locomotion when the full controller is budget-rejected',
    (unit) => {
      const fallback = locomotionFallbackDeps(unit);
      const { fx, sprite } = make(unit, { fallback });
      const mark = sprite.writes.length;

      // No `v2` delegate was passed: this is the exact runtime shape after the
      // complete profile loses admission but the compact priority class lands.
      expect(fx.v2).toBeNull();
      fx.onPos(140, 20, 500);
      fallback.ticker!.tick(500);

      const group = v2LocomotionAtlasGroup(unit, 1);
      const walkWrites = sprite.writes.slice(mark)
        .filter((write) => write.startsWith(`${group}/v2_trp_${unit}_t1_walk_`));
      expect(new Set(walkWrites).size, unit).toBeGreaterThan(1);
      expect(walkWrites.some((write) => write.startsWith('trp/'))).toBe(false);
    },
  );

  it('keeps every ART_V2 body on a current alias when rich admission is rejected', () => {
    expect(ART_V2.troops).toHaveLength(15); // reverse guard grows with the routed roster
    for (const unit of ART_V2.troops) {
      const h = make(unit, { fallback: currentStaticFallbackDeps(unit) });
      expect(h.fx.v2, unit).toBeNull();
      expect(h.fx.usesCurrentV2Art, unit).toBe(true);
      h.fx.onPos(140, 24, 500);
      h.fx.tickAttack();
      h.fx.onHit();
      h.fx.onDeath();
      h.scene.advanceTo(2_000);

      // The rejected rich body may hold a static current pose, but it must
      // never ask Phaser for a historical `trp_*`/`trpdg` frame mid-lifecycle.
      expect(h.sprite.writes.length, unit).toBeGreaterThan(0);
      expect(h.sprite.writes.every(
        (write) => write.startsWith(`${V2_FALLBACK_ATLAS}/v2_fallback_${unit}_t1`),
      ), `${unit}: ${h.sprite.writes.join(', ')}`).toBe(true);
    }
  });

  it('snaps a one-frame current fallback to authoritative positions instead of gliding it', () => {
    const h = make('bowman', { fallback: currentStaticFallbackDeps('bowman') });

    h.fx.onPos(140, 24, 500);

    expect(h.sprite).toMatchObject({ x: 140, y: 24, depth: WORLD_DEPTH.actor + 24 });
    expect(h.scene.tweenConfigs.some((config) => config.targets === h.sprite)).toBe(false);
    expect(new Set(h.sprite.writes)).toEqual(new Set([
      `${V2_FALLBACK_ATLAS}/v2_fallback_bowman_t1`,
    ]));
  });

  it('aims a current-sprite lunge/pulse for every compact melee profile', () => {
    const meleeUnits = (Object.entries(V2_TROOP_PROFILES) as Array<
      [V2TroopUnit, (typeof V2_TROOP_PROFILES)[V2TroopUnit]]
    >).filter(([, profile]) => 'melee' in profile).map(([unit]) => unit);
    expect(meleeUnits).toEqual([
      'highlander', 'tunneler', 'turrider', 'plunderer', 'giant',
      'troll', 'bilgewraith', 'gloamfang', 'barrowling',
    ]);
    for (const unit of meleeUnits) {
      const h = make(unit, { fallback: currentStaticFallbackDeps(unit) });
      const technique = unit === 'troll' ? 'slam' : unit === 'gloamfang' ? 'rend' : 'strike';
      h.fx.onMeleeAttack('building', 110, 20, technique);
      const tween = h.scene.tweenConfigs.at(-1)!;
      expect(tween.targets, unit).toBe(h.sprite);
      expect(tween.x, unit).toBeGreaterThan(h.sprite.x);
      expect(tween.y, unit).toBe(h.sprite.y);
      expect(tween.alpha, unit).toBeLessThan(1);
      expect(tween.yoyo, unit).toBe(true);
      expect(h.sprite.writes.every(
        (write) => write.startsWith(`${V2_FALLBACK_ATLAS}/v2_fallback_${unit}_t1`),
      ), unit).toBe(true);
    }
  });

  it.each(['tunneler', 'bilgewraith'] as const)(
    'suppresses the historical dust mound for compact-current %s burrow fallback',
    (unit) => {
      const h = make(unit, { fallback: currentStaticFallbackDeps(unit) });
      h.fx.onBurrow();
      h.fx.onPos(120, 40, 500);
      h.fx.onEmerge(120, 40);

      expect(h.scene.sprites).toHaveLength(1);
      expect(h.scene.sprites[0]!.writes.every(
        (write) => write.startsWith(`${V2_FALLBACK_ATLAS}/v2_fallback_${unit}_t1`),
      )).toBe(true);
    },
  );

  it('keeps hero skins protected and rejects an unadapted Wyrmling', () => {
    expect(make('giant', { skin: 'hero_theo', fallback: fallbackDeps('dragon') }).first)
      .toBe('hero/hero_theo_walk_s_f1');
    expect(() => make('wyrmling', { level: 7 }))
      .toThrow(/M22 WARE Hatchling adapter/);
  });

  it('builds a levelled dragon out of its own on-demand atlas', () => {
    const { first } = make('dragon', { level: 7 });
    expect(first).toBe('trpdg_l7/trp_dragon_l7_fly_s_f1');
  });

  it('builds a levelled giant out of the same per-level group', () => {
    // One group holds BOTH troops of a level — that is why the loader fetches
    // per level rather than per troop.
    const { first } = make('giant', { level: 7 });
    expect(first).toBe('trpdg_l7/trp_giant_l7_walk_s_f1');
  });

  it('falls back to the legacy atlas when the scene passes no level', () => {
    // The scene withholds the level when the on-demand atlas has not arrived, so
    // this is the "art did not load" path — it must still draw something.
    expect(make('dragon').first).toBe('trp/trp_dragon_walk_s_f1');
  });

  it('leaves every other troop exactly where it was', () => {
    for (const troop of ['highlander', 'bowman', 'mage', 'troll']) {
      expect(make(troop).first, troop).toBe(`trp/trp_${troop}_walk_s_f1`);
      // ...even if a level is handed over: armyLevels carries one for every
      // troop, and only dragon/giant have per-level masters.
      expect(make(troop, { level: 12 }).first, troop).toBe(`trp/trp_${troop}_walk_s_f1`);
    }
  });

  it('renders every Nest defender through the mandatory current WARE adapter', () => {
    for (const level of [1, 20]) {
      const h = make('wyrmling', { hatchling: hatchlingDeps(level) });
      expect(h.first).toBe(`${WARE_FALLBACK_ATLAS}/${wareHatchlingFallbackKey(level === 1 ? 1 : 4)}`);
      expect(h.fx.hatchling).not.toBeNull();
      expect(h.fx.usesCurrentV2Art).toBe(true);
      expect(h.sprite.writes.every((write) => !write.startsWith('trp/'))).toBe(true);
    }
  });

  it('draws a hero from the hero atlas whatever level is passed', () => {
    expect(make('highlander', { skin: 'hero_vex', level: 9 }).first)
      .toBe('hero/hero_vex_walk_s_f1');
  });

  it('never names a frame that lives in a different texture', () => {
    // The one rule that makes the whole thing work: the atlas a sprite is
    // created against must be the group its frames were PACKED into. Checked
    // against the packer's own rule rather than a copy of it.
    for (const [troop, level] of [['dragon', 3], ['giant', 20], ['highlander', undefined]] as const) {
      const { sprite } = make(troop, level === undefined ? {} : { level });
      for (const write of sprite.writes) {
        const [atlas, frame] = write.split('/') as [string, string];
        expect(atlasGroupFor(frame), write).toBe(atlas);
      }
    }
    const hatchling = make('wyrmling', { hatchling: hatchlingDeps(12) });
    expect(hatchling.first).toBe(
      `${WARE_FALLBACK_ATLAS}/${wareHatchlingFallbackKey(3)}`,
    );
  });
});

/**
 * Rework-v2 delegation (Phase D). The scene hands TroopFx a v2 context ONLY
 * when the unit's tier atlas actually loaded; everything below pins the three
 * outcomes that matter — v2 frames when granted, hero art when skinned (the
 * Theodor-isolation rule made visual), and byte-identical legacy otherwise
 * (the rollback clause).
 */
describe('TroopFx rework-v2 delegation', () => {
  it('a granted giant spawns out of its v2trp tier atlas with the authored spawn clip', () => {
    const { fx, first } = make('giant', { v2: giantV2Deps() });
    expect(first).toBe('v2trp_giant_t2/v2_trp_giant_t2_spawn_d0_f1');
    expect(fx.v2).not.toBeNull();
  });

  it('a hero skin outranks the v2 context — Theodor rides the giant STATS, never its art', () => {
    const { fx, first } = make('giant', { skin: 'hero_theo', v2: giantV2Deps() });
    expect(first).toBe('hero/hero_theo_walk_s_f1');
    expect(fx.v2).toBeNull();
  });

  it('no v2 context → the untouched legacy paths (level or not)', () => {
    expect(make('giant', { level: 7 }).first).toBe('trpdg_l7/trp_giant_l7_walk_s_f1');
    expect(make('giant').first).toBe('trp/trp_giant_walk_s_f1');
    expect(make('giant').fx.v2).toBeNull();
    // `fx.v2 === null` IS the condition BattleScene.onTroopFire branches on when a
    // `proj:'boulder'` cue arrives: with no v2 controller there is no throw clip
    // and no boulder travel set, so the cue flies the legacy CANNONBALL pair —
    // the only round sprite the legacy kit has, because no legacy boulder was
    // ever authored. (The branch itself lives in BattleScene, which no node test
    // can import; what is pinnable here is the null it keys off and the art it
    // falls back to actually existing.)
    expect(Object.keys(PROJ_ART)).toContain('cannonball');
    expect(Object.keys(PROJ_ART)).not.toContain('boulder');
  });

  it('every v2 frame the delegate asks for routes to the group it was packed into', () => {
    // Same invariant as the legacy test above, against the packer's own rule:
    // a v2 frame drawn against the wrong texture is an invisible unit.
    const deps = giantV2Deps();
    const { scene, fx, sprite } = make('giant', { v2: deps });
    deps.ticker.tick(2000); // play the spawn one-shot through (stand() follows)
    fx.onDeath();
    deps.ticker.tick(2000);
    scene.advanceTo(10_000);
    for (const write of sprite.writes) {
      const [atlas, frame] = write.split('/') as [string, string];
      expect(atlasGroupFor(frame), write).toBe(atlas);
    }
  });

  /**
   * The @1x-pack / @2x-world factor. The pack is authored at 32 game px per tile
   * and packed @1x only (the 4096² cap), while the world is 64 world px per tile
   * and every legacy atlas is @2x — so an unscaled v2 giant draws at HALF the
   * size of the legacy troop beside it, which is the opposite of the rework's
   * stated point ("bigger, more readable"). Asserted against the constant rather
   * than the number 2, since re-packing the pack @2x is what would change it.
   */
  it('draws the v2 giant at the pack conversion times its published fit', () => {
    const { sprite } = make('giant', { v2: giantV2Deps() });
    expect(sprite.scale).toBe(V2_DRAW_SCALE * bodyScaleOf('giant'));
    // REWRITTEN 2026-08-30. This used to assert the bare V2_DRAW_SCALE and that
    // BATTLE_SCALE.troop did NOT apply. Both halves of that expectation were the
    // defect the owner reported ("troops are very big"): unfitted, the giant's
    // body rendered 210 world px in a raid against a 154-px Keep at L20, and
    // skipping the battle shrink made the reworked troops the only actors that
    // grew by half again on entering one. The rule that replaces it, and the
    // reason a blanket shrink is now safe, is that the Giant/Dragon/dark-family
    // size relationships live in ART_V2.troopSourceScale — a uniform battle
    // factor preserves them instead of flattening them.
    expect(sprite.scale).toBeLessThan(V2_DRAW_SCALE);
    expect(sprite.scale).toBeGreaterThan(0);
  });

  /**
   * Missing art must degrade, never crash. `playOnce` invokes its completion
   * callback SYNCHRONOUSLY when the clip is absent, and stand() re-arms the
   * attack on completion — so a giant with a target but no packed attack clip
   * recursed stand → playOnce → stand until the stack blew. Every other v2
   * fallback holds a frame instead; this one took the whole scene down.
   */
  it('survives a missing attack clip instead of blowing the stack', () => {
    const deps = giantV2Deps();
    delete deps.clips['v2_trp_giant_t2_attack'];
    const { fx, sprite } = make('giant', { v2: deps });
    fx.setNearestBuildingFn(() => ({ x: 400, y: 400 }));
    expect(() => deps.ticker.tick(2000)).not.toThrow(); // spawn → stand()
    // Degraded to the idle loop — a held/looping frame, which is what a v2
    // fallback is supposed to look like.
    expect(sprite.writes.some((w) => w.includes('_idle_'))).toBe(true);
  });

  /**
   * THE BOULDER THROW — the giant's v2-only verb (sim `troopFire` proj:'boulder',
   * siege reach vs defences, owner 2026-08-08). Three separate silent failures
   * live in these few lines:
   *  - the rock spawning at the sprite's ANCHOR (his feet) instead of the cell
   *    centre the manifest documents as his emitter, or spawning at the unscaled
   *    pack offset — a boulder that leaves his knees;
   *  - firing on the wrong frame, i.e. releasing at wind-up (the 0-based fxAt
   *    trap parseFxAt exists for);
   *  - firing TWICE, which V2Ticker's deliberate frame-by-frame catch-up makes
   *    reachable on any long frame.
   */
  describe('the giant\'s boulder throw', () => {
    const THROW_MS = 1000 / 12; // the throw clip's authored fps

    /** A giant standing at (10,20), spawn played out, ready to act. */
    const readyGiant = () => {
      const deps = giantV2Deps();
      const h = make('giant', { v2: deps });
      deps.ticker.tick(2000); // spawn one-shot → stand()
      return { ...h, deps };
    };
    const boulders = (scene: FakeScene): FakeSprite[] =>
      scene.images.filter((i) => i.writes[0]!.includes('v2_fx_boulder_t2'));

    it('leaves the CELL CENTRE in world px, not the sprite anchor', () => {
      const { scene, fx, sprite, deps } = readyGiant();
      fx.v2!.onSiegeThrow(400, 20);
      deps.ticker.tick(THROW_MS * 6); // through the release frame
      const [rock] = boulders(scene);
      expect(rock, 'a boulder was launched').toBeDefined();
      // anchor (56,100) of a 112×112 cell → the centre is 44 PACK px above the
      // anchor, and a pack-px vector scales into world px like the art it
      // measures. Unscaled it would be 44 world px — the rock would leave his
      // knees; at the bare anchor it would leave the ground under him.
      expect(rock!.x).toBe(sprite.x + toWorldPx(56 - 56) * bodyScaleOf('giant'));
      expect(rock!.y).toBe(sprite.y + toWorldPx(56 - 100) * bodyScaleOf('giant'));
      // …and that offset now rides the giant's published world fit. Before it
      // did, this launch point was one of the two places in the controller that
      // reached past the emitter table straight to toWorldPx — at the fitted
      // body size the unscaled −88 put the rock a clear body-height above his
      // own head.
      expect(rock!.y).toBe(20 - 88 * bodyScaleOf('giant'));
      // REWRITTEN 2026-08-30. This used to assert the PROJECTILE art stayed at
      // the bare pack scale while only its launch POINT was fitted. That split
      // was the defect the owner then reported — "arrows can't be the same size
      // as the archer" — because it is what let a 20-px arrow render 40 world px
      // beside a 40-px bowman. The rule that replaces it: a shot is drawn at the
      // fit of whatever fired it, which is the SAME number that placed it, so
      // the rock leaves the fist AND is a giant's rock. Asserted as the product
      // rather than a literal so a retune of the giant's fit moves both together.
      expect(rock!.scale).toBe(V2_DRAW_SCALE * bodyScaleOf('giant'));
      expect(rock!.scale).toBeLessThan(V2_DRAW_SCALE);
    });

    it('releases on the authored frame — not at wind-up, and exactly once', () => {
      const { scene, fx, deps } = readyGiant();
      fx.v2!.onSiegeThrow(400, 20);
      // `boulder@3` is 0-based at source → frame number 4. Nothing may fly
      // before it (a release at wind-up reads as the rock teleporting out of him).
      deps.ticker.tick(THROW_MS * 2 + 1);
      expect(boulders(scene)).toHaveLength(0);
      deps.ticker.tick(THROW_MS);
      expect(boulders(scene)).toHaveLength(1);
      // …and the rest of the clip cannot throw a second one.
      deps.ticker.tick(THROW_MS * 4);
      expect(boulders(scene)).toHaveLength(1);
    });

    it('throws ONE rock even when the whole clip catches up inside one frame', () => {
      // V2Ticker steps frame-by-frame through a long dt precisely so an fxAt
      // frame is never skipped; without the per-throw dedupe that same path is
      // what fires the launch on every caught-up frame at once.
      const { scene, fx, deps } = readyGiant();
      fx.v2!.onSiegeThrow(400, 20);
      deps.ticker.tick(10_000);
      expect(boulders(scene)).toHaveLength(1);
      // The landing spends the shell budget (a rock this size lands like one)
      // and craters the ground at the contact point.
      scene.landAll();
      expect(scene.shakes).toEqual([150]);
      expect(scene.images.some((i) => i.writes[0]!.includes('v2_fx_impact_rubble_t2'))).toBe(true);
      scene.advanceTo(scene.now + 1000); // release juice.ts's shake budget
    });

    it('is ONE rock per throw, even if the release is keyed on several frames', () => {
      // `dust@1,5` proves the pack does author multi-frame fx keys, so a release
      // table of more than one frame is a re-authoring away — and the launch is
      // driven straight off that list. One throw animation must still put exactly
      // one rock in the air; two boulders from one swing is a visual bug the sim
      // cannot explain (it only sent one troopFire).
      const deps = giantV2Deps();
      deps.clips['v2_trp_giant_t2_throw'] = {
        ...deps.clips['v2_trp_giant_t2_throw']!, fxAt: 'boulder@3,4',
      };
      const h = make('giant', { v2: deps });
      deps.ticker.tick(2000);
      h.fx.v2!.onSiegeThrow(400, 20);
      deps.ticker.tick(10_000);
      expect(boulders(h.scene)).toHaveLength(1);
    });

    it('returns to standing after the throw, so he keeps swinging', () => {
      const { scene, fx, deps, sprite } = readyGiant();
      fx.setNearestBuildingFn(() => ({ x: 400, y: 20 }));
      fx.v2!.onSiegeThrow(400, 20);
      deps.ticker.tick(THROW_MS * 7);
      expect(sprite.writes.at(-1)).toMatch(/_(attack|idle)_d\d_f\d$/);
      expect(scene.images.length).toBeGreaterThan(0);
    });

    /** `launchV2Projectile` reports a missing current texture instead of
     * guessing another generation. A rich controller is normally protected by
     * its admission gate; if that invariant is broken, it degrades to no shot.
     * BattleScene's rejected-rich path separately uses the compact alias tested
     * below, never a legacy projectile. */
    it('reports false — and draws nothing at all — when the shared v2fx group is absent', () => {
      const { scene, fx, deps, sprite } = readyGiant();
      scene.loaded.delete(V2FX_ATLAS);
      const mark = sprite.writes.length;
      expect(() => {
        fx.v2!.onSiegeThrow(400, 20);
        deps.ticker.tick(10_000);
      }).not.toThrow();
      expect(sprite.writes.slice(mark).some((w) => w.includes('_throw_'))).toBe(true);
      expect(scene.images).toEqual([]);   // no rock, no shadow, no impact
      expect(scene.counters).toEqual([]); // and no orphan flight tween
      // The documented return value itself, at the seam the callers ignore.
      expect(launchV2Projectile(
        scene as never, deps.clips, 'boulder', 2, 0, 0, 100, 0,
      )).toBe(false);
      scene.loaded.add(V2FX_ATLAS);
      expect(launchV2Projectile(
        scene as never, deps.clips, 'boulder', 2, 0, 0, 100, 0,
      )).toBe(true);
      // …and false again when the ATLAS is there but the clip is not (a packing
      // failure), which is the other half of the same guard.
      const noClip = { ...deps.clips };
      delete noClip['v2_fx_boulder_t2'];
      expect(launchV2Projectile(
        scene as never, noClip, 'boulder', 2, 0, 0, 100, 0,
      )).toBe(false);
    });
  });

  it('plays ALL SIX authored death frames at the clip fps', () => {
    const deps = giantV2Deps();
    const { fx, sprite } = make('giant', { v2: deps });
    fx.onDeath();
    deps.ticker.tick(5000);
    const death = sprite.writes.filter((w) => w.includes('_death_'));
    expect(death).toEqual([1, 2, 3, 4, 5, 6].map(
      (f) => `v2trp_giant_t2/v2_trp_giant_t2_death_d0_f${f}`,
    ));
    expect(fx.alive).toBe(false);
  });
});

describe('TroopFx all-troop grid profiles', () => {
  it('plays Tur Rider charge during battle movement without replacing its base walk verb', () => {
    const deps = meleeV2Deps('turrider', 'lance_hit', 'lance');
    deps.clips.v2_trp_turrider_t1_charge = gridClip(8, 16, true, { fxAt: 'dust@0,4' });
    deps.clips.v2_fx_dust = gridClip(2, 12, false);
    const h = make('turrider', { v2: deps });
    deps.ticker.tick(2000); // spawn → stand

    h.fx.onPos(200, 20, 500);
    deps.ticker.tick(100);

    expect(h.sprite.writes.some((write) => write.includes('_charge_'))).toBe(true);
    expect(V2_TROOP_PROFILES.turrider.move).toBe('walk');
  });

  it('uses authored arrow/bolt flights and their owner-lab contact effects', () => {
    const scene = new FakeScene();
    const travel = (frames: number) => ({
      frames, rows: 8, cellW: 32, cellH: 32, anchorPx: [16, 16] as [number, number],
      fps: 16, loop: true, travel: true,
    });
    const clips = {
      v2_fx_arrow_t1: travel(3),
      v2_fx_bolt_t1: travel(4),
      v2_fx_shadow: { frames: 3, rows: 1, cellW: 20, cellH: 12 },
      v2_fx_impact_burn_t1: {
        frames: 4, rows: 1, cellW: 40, cellH: 40, anchorPx: [20, 26] as [number, number],
        fps: 18, loop: false,
      },
      v2_fx_bolt_hit_t1: {
        frames: 4, rows: 1, cellW: 40, cellH: 40, anchorPx: [20, 26] as [number, number],
        fps: 18, loop: false,
      },
    };
    expect(launchV2Projectile(scene as never, clips, 'arrow', 1, 0, 0, 100, 0)).toBe(true);
    expect(launchV2Projectile(scene as never, clips, 'bolt', 1, 0, 10, 100, 10)).toBe(true);
    // The Bowman lab pairs its shallow arc with a shadow; Mage explicitly does not.
    expect(scene.images.filter((image) => image.writes[0]!.includes('v2_fx_shadow')))
      .toHaveLength(1);
    scene.landAll();
    expect(scene.images.filter((image) => image.writes[0]!.includes('v2_fx_bolt_hit_t1')))
      .toHaveLength(1);
    expect(scene.images.filter((image) => image.writes[0]!.includes('v2_fx_impact_burn_t1')))
      .toHaveLength(1);
  });

  it('routes every essential rich-rejection shot through its admitted compact-current shard', () => {
    const cases = [
      { unit: 'giant', kind: 'boulder', impact: 'impact_rubble', shadow: true },
      { unit: 'bowman', kind: 'arrow', impact: 'impact_burn', shadow: true },
      { unit: 'mage', kind: 'bolt', impact: 'bolt_hit', shadow: false },
      { unit: 'hexbarrow', kind: 'hexshot', impact: 'impact_crater', shadow: true },
    ] as const;

    for (const test of cases) {
      const scene = new FakeScene();
      const group = v2TroopFallbackFxAtlasGroups(test.unit, 1)[0]!;
      scene.loaded.add(group);
      const metaBase = `v2_fx_${test.kind}_t1`;
      const impactMeta = `v2_fx_${test.impact}_t1`;
      const clips = {
        [metaBase]: {
          frames: 3, rows: 8, cellW: 32, cellH: 32,
          anchorPx: [16, 16] as [number, number], fps: 14, loop: true, travel: true,
        },
        ...(test.shadow ? {
          v2_fx_shadow: {
            frames: 3, rows: 1, cellW: 20, cellH: 12,
            anchorPx: [10, 6] as [number, number],
          },
        } : {}),
        [impactMeta]: {
          frames: 4, rows: 1, cellW: 40, cellH: 40,
          anchorPx: [20, 26] as [number, number], fps: 18, loop: false,
        },
      };
      const art = {
        baseFor: (base: string) => v2TroopFallbackFxBaseKey(test.unit, 1, base),
      };

      expect(launchV2Projectile(
        scene as never, clips, test.kind, 1, 0, 0, 100, 0, undefined, art,
      ), test.unit).toBe(true);
      scene.landAll();

      expect(scene.images.length, test.unit).toBeGreaterThanOrEqual(2);
      expect(scene.images.every((image) => image.writes.every(
        (write) => write.startsWith(`${group}/v2_compact_fx_${test.unit}_t1_`),
      )), `${test.unit}: ${scene.images.flatMap((image) => image.writes).join(', ')}`).toBe(true);
    }
  });

  it('uses compact-current Dragon breath/impact aliases and fails closed without admission', () => {
    const scene = new FakeScene();
    const group = v2TroopFallbackFxAtlasGroups('dragon', 1)[0]!;
    scene.loaded.add(group);
    const clips = {
      v2_fx_breath_t1: {
        frames: 4, rows: 1, cellW: 80, cellH: 40,
        anchorPx: [8, 20] as [number, number], fps: 18, loop: false,
      },
      v2_fx_impact_burn_t1: {
        frames: 4, rows: 1, cellW: 40, cellH: 40,
        anchorPx: [20, 26] as [number, number], fps: 18, loop: false,
      },
    };
    for (const metaBase of ['v2_fx_breath_t1', 'v2_fx_impact_burn_t1']) {
      const base = v2TroopFallbackFxBaseKey('dragon', 1, metaBase)!;
      expect(playV2Fx(scene as never, clips, base, 20, 30, { metaBase })).not.toBeNull();
    }
    expect(scene.images.every((image) => image.writes.every(
      (write) => write.startsWith(`${group}/v2_compact_fx_dragon_t1_`),
    ))).toBe(true);

    const noAdmission = new FakeScene();
    expect(playV2Fx(
      noAdmission as never, clips,
      v2TroopFallbackFxBaseKey('dragon', 1, 'v2_fx_breath_t1')!,
      20, 30, { metaBase: 'v2_fx_breath_t1' },
    )).toBeNull();
    expect(noAdmission.images).toEqual([]);
  });

  it('plays the authored burrow → tunnel → surface cycle in the same sprite', () => {
    const deps = tunnelerV2Deps();
    const { scene, fx, sprite } = make('tunneler', { v2: deps });
    fx.onBurrow();
    deps.ticker.tick(1000);
    expect(sprite.writes.some((write) => write.includes('_burrow_'))).toBe(true);
    expect(sprite.writes.at(-1)).toContain('_tunnel_');
    fx.onEmerge();
    deps.ticker.tick(1000);
    expect(sprite.writes.some((write) => write.includes('_surface_'))).toBe(true);
    expect(sprite.writes.at(-1)).toContain('_idle_');
    expect(scene.images.filter((image) => image.writes[0]!.includes('v2_fx_soil_t1')))
      .toHaveLength(2);
  });

  it('snaps the legacy burrow fallback before revealing it at emergence', () => {
    const { scene, fx, sprite } = make('tunneler');
    fx.onBurrow();
    const mound = scene.sprites[1]!;
    fx.onPos(90, 120, 500);

    fx.onEmerge(90, 120);

    expect(scene.killedTweens).toEqual(expect.arrayContaining([sprite, mound]));
    // Depth is the feet Y in the ACTOR band — a surfacing tunneler must come
    // up IN FRONT of whatever he burrowed under, at any Y.
    expect(sprite).toMatchObject({
      x: 90, y: 120, depth: WORLD_DEPTH.actor + 120, visible: true,
    });
    expect(mound.active).toBe(false);
  });

  it('defers Bowman\'s projectile until loose@0 becomes runtime frame 1', () => {
    const deps = bowmanV2Deps();
    const { fx, sprite } = make('bowman', { v2: deps });
    deps.ticker.tick(1000); // spawn → idle
    const releases: Array<{ x: number; y: number }> = [];
    fx.onRangedAttack(200, 20, (at) => { releases.push(at); });
    expect(releases).toHaveLength(0); // draw starts first
    deps.ticker.tick(1000); // draw completes; loose frame 1 is entered
    expect(releases).toHaveLength(1);
    // Facing east is row 6. Published nock row 6 frame 0 = [70,56]; the
    // sprite is seated at anchor [48,86] and pack vectors scale into world px.
    expect(releases[0]).toEqual({
      x: sprite.x + toWorldPx(70 - 48) * bodyScaleOf('bowman'),
      y: sprite.y + toWorldPx(56 - 86) * bodyScaleOf('bowman'),
    });
    expect(sprite.writes.at(-1)).toContain('_loose_');
    deps.ticker.tick(1000);
    expect(releases).toHaveLength(1);
  });

  it('runs Bowman draw, loose and idle from the compact combat core on a cold-cache grant', () => {
    const deps = bowmanV2Deps();
    deps.compact = true;
    deps.fxBaseFor = (base) => base === 'v2_fx_arrow_t1'
      ? 'v2_compact_fx_bowman_t1_arrow'
      : null;
    const { fx, sprite } = make('bowman', { v2: deps });
    deps.ticker.tick(1000); // compact spawn → compact idle
    const releases: Array<{ x: number; y: number }> = [];

    fx.onRangedAttack(200, 20, (at) => { releases.push(at); });
    deps.ticker.tick(1000); // draw → loose@0/release
    deps.ticker.tick(1000); // loose → idle

    expect(releases).toHaveLength(1);
    expect(sprite.writes.some((write) => write.includes('_bowman_t1_draw_'))).toBe(true);
    expect(sprite.writes.some((write) => write.includes('_bowman_t1_loose_'))).toBe(true);
    expect(sprite.writes.at(-1)).toContain('_bowman_t1_idle_');
    expect(sprite.writes.every((write) => write.startsWith('v2trp_bowman_t1_combatcore/')))
      .toBe(true);
  });

  it('pins Mage castflash and bolt release to the published staff point', () => {
    const deps = mageV2Deps();
    const { scene, fx, sprite } = make('mage', { v2: deps });
    deps.ticker.tick(1000); // spawn → idle
    const releases: Array<{ x: number; y: number }> = [];
    fx.onRangedAttack(200, 20, (at) => { releases.push(at); });
    // bolt@4 is source frame 4 → runtime frame 5.
    deps.ticker.tick((1000 / 13) * 3);
    expect(releases).toHaveLength(0);
    deps.ticker.tick(1000 / 13);
    expect(releases).toHaveLength(1);
    // East row 6, frame index 4 = [66,46]. The `/2` this used to divide by was
    // the Mage's bare `drawScale: 0.5` living on the visual profile; it is now
    // ART_V2.troopSourceScale.mage, read through the same helper as every other
    // root, so the staff point cannot drift away from the body again.
    expect(releases[0]).toEqual({
      x: sprite.x + toWorldPx(66 - 48) * bodyScaleOf('mage'),
      y: sprite.y + toWorldPx(46 - 86) * bodyScaleOf('mage'),
    });
    const flashes = scene.images.filter((image) =>
      image.writes[0]!.includes('v2_fx_castflash_t2'),
    );
    expect(flashes).toHaveLength(1);
    expect({ x: flashes[0]!.x, y: flashes[0]!.y }).toEqual(releases[0]);
  });

  it('hands the scene one fallback release when ranged art is absent', () => {
    const legacy = make('bowman');
    const legacyReleases: Array<{ x: number; y: number }> = [];
    legacy.fx.onRangedAttack(200, 20, (at) => { legacyReleases.push(at); });
    expect(legacyReleases).toEqual([{ x: 10, y: 20 }]);

    const deps = bowmanV2Deps();
    delete deps.clips.v2_trp_bowman_t1_loose;
    const v2 = make('bowman', { v2: deps });
    deps.ticker.tick(1000);
    const missingReleases: Array<{ x: number; y: number }> = [];
    v2.fx.onRangedAttack(200, 20, (at) => { missingReleases.push(at); });
    deps.ticker.tick(5000);
    expect(missingReleases).toEqual([{ x: 10, y: 20 }]);
  });

  it.each([
    ['highlander', 'sweep', 'blade'],
    ['troll', 'sweep', 'fist'],
    ['tunneler', 'pick_hit', 'pick'],
    ['turrider', 'lance_hit', 'lance'],
    ['bilgewraith', 'slash', 'blade'],
  ] as const)(
    'pins %s ordinary contact FX to its published %s attachment',
    (unit, fxName, emitter) => {
      const deps = meleeV2Deps(unit, fxName, emitter);
      const h = make(unit, { v2: deps });
      deps.ticker.tick(2000); // optional spawn → stand
      h.fx.setNearestBuildingFn(() => ({ x: -200, y: 20 }));
      h.fx.onHit();
      deps.ticker.tick(1000); // hit → west-facing attack frame 1
      deps.ticker.tick(1000); // through fx@2 (runtime frame 3)
      const contacts = h.scene.images.filter((image) =>
        image.writes[0]!.includes(`v2_fx_${fxName}_t1`),
      );
      expect(contacts.length).toBeGreaterThan(0);
      const contact = contacts[0]!;
      // West is row 2; published row 2 frame 2 = [42,52], scaled by the body
      // it is measured off (see bodyScaleOf).
      expect({ x: contact.x, y: contact.y }).toEqual({
        x: h.sprite.x + toWorldPx(42 - 48) * bodyScaleOf(unit),
        y: h.sprite.y + toWorldPx(52 - 86) * bodyScaleOf(unit),
      });
      expect(contact.rotation).toBeCloseTo(Math.PI);
    },
  );

  it('uses Barrowling variantStride with deterministic variant zero', () => {
    const clip = gridClip(4, 10, false, { variants: 4, variantStride: 4 });
    const deps: V2TroopDeps = {
      ticker: new V2Ticker(), breath: null, unit: 'barrowling', tier: 1,
      clips: {
        v2_trp_barrowling_t1_spawn: clip,
        v2_trp_barrowling_t1_scurry: gridClip(6, 15, true, { variants: 4, variantStride: 6 }),
        v2_trp_barrowling_t1_claw: clip,
        v2_trp_barrowling_t1_hit: gridClip(2, 8, false, { variants: 4, variantStride: 2 }),
        v2_trp_barrowling_t1_death: clip,
      },
    };
    expect(make('barrowling', { v2: deps }).first)
      .toBe('v2trp_barrowling_t1/v2_trp_barrowling_t1_spawn_d0_f1');
    expect(make('barrowling', { v2: { ...deps, ticker: new V2Ticker(), variant: 2 } }).first)
      .toBe('v2trp_barrowling_t1/v2_trp_barrowling_t1_spawn_d0_f9');
  });

  it('fires Kegrunner detonation once at keg_blast@1 → runtime frame 2', () => {
    const detonate = gridClip(6, 13, false, {
      fxAt: 'keg_blast@1 at the KEG emitter',
      emitters: { keg: Array.from({ length: 8 }, () => Array.from({ length: 6 }, () => [48, 80])) },
    });
    const deps: V2TroopDeps = {
      ticker: new V2Ticker(), breath: null, unit: 'kegrunner', tier: 1,
      clips: {
        v2_trp_kegrunner_t1_spawn: gridClip(4, 8, false),
        v2_trp_kegrunner_t1_run: gridClip(6, 12, true),
        v2_trp_kegrunner_t1_idle: gridClip(4, 6, true),
        v2_trp_kegrunner_t1_prime: gridClip(6, 14, true),
        v2_trp_kegrunner_t1_detonate: detonate,
        v2_trp_kegrunner_t1_hit: gridClip(2, 8, false),
        v2_fx_keg_blast_t1: { frames: 6, rows: 1, cellW: 96, cellH: 96, fps: 16, loop: false },
      },
    };
    const h = make('kegrunner', { v2: deps });
    let blasts = 0;
    h.fx.onDetonate(() => { blasts++; });
    deps.ticker.tick(70);
    expect(blasts).toBe(0);
    deps.ticker.tick(10);
    expect(blasts).toBe(1);
    deps.ticker.tick(1000);
    expect(blasts).toBe(1);
    expect(h.scene.images.filter((image) => image.writes[0]!.includes('v2_fx_keg_blast_t1')))
      .toHaveLength(1);
  });

  it('hands detonation feedback back exactly once when clip or fx atlas is missing', () => {
    const deps: V2TroopDeps = {
      ticker: new V2Ticker(), breath: null, unit: 'kegrunner', tier: 1,
      clips: {
        v2_trp_kegrunner_t1_spawn: gridClip(4, 8, false),
        v2_trp_kegrunner_t1_run: gridClip(6, 12, true),
        v2_trp_kegrunner_t1_idle: gridClip(4, 6, true),
        v2_trp_kegrunner_t1_prime: gridClip(6, 14, true),
        v2_trp_kegrunner_t1_hit: gridClip(2, 8, false),
      },
    };
    const missing = make('kegrunner', { v2: deps });
    const calls: Array<{ x: number; y: number }> = [];
    missing.fx.onDetonate((at) => { calls.push(at); });
    expect(calls).toEqual([{ x: 10, y: 20 }]);

    const noCueDeps: V2TroopDeps = {
      ...deps, ticker: new V2Ticker(), clips: {
        ...deps.clips,
        v2_trp_kegrunner_t1_detonate: gridClip(2, 10, false),
      },
    };
    const noCue = make('kegrunner', { v2: noCueDeps });
    let cueCalls = 0;
    noCue.fx.onDetonate(() => { cueCalls++; });
    noCueDeps.ticker.tick(1000);
    expect(cueCalls).toBe(1);

    const clipDeps = { ...deps, ticker: new V2Ticker(), clips: { ...deps.clips } };
    clipDeps.clips.v2_trp_kegrunner_t1_detonate = gridClip(2, 10, false, {
      fxAt: 'keg_blast@0', emitters: { keg: [[[48, 80], [48, 80]]] },
    });
    clipDeps.clips.v2_fx_keg_blast_t1 = gridClip(2, 10, false);
    const noAtlas = make('kegrunner', { v2: clipDeps });
    noAtlas.scene.loaded.delete(V2FX_ATLAS);
    let atlasCalls = 0;
    noAtlas.fx.onDetonate(() => { atlasCalls++; });
    clipDeps.ticker.tick(1000);
    expect(atlasCalls).toBe(1);
    expect(noAtlas.scene.images).toEqual([]);
  });
});

describe('TroopFx death', () => {
  /** Frames shown from onDeath() onwards, in order. */
  function deathFrames(troop: string, opts: Parameters<typeof make>[1] = {}): string[] {
    const { scene, fx, sprite } = make(troop, opts);
    const before = sprite.writes.length;
    fx.onDeath();
    scene.advanceTo(10_000);
    return sprite.writes.slice(before);
  }

  it('steps all four frames of a levelled dragon', () => {
    // The batch-13 masters ship 4. The old schedule was hardcoded to f1 + f2, so
    // half of the new death animation would never have rendered.
    expect(deathFrames('dragon', { level: 7 })).toEqual([
      'trpdg_l7/trp_dragon_l7_death_f1',
      'trpdg_l7/trp_dragon_l7_death_f2',
      'trpdg_l7/trp_dragon_l7_death_f3',
      'trpdg_l7/trp_dragon_l7_death_f4',
    ]);
  });

  it('still plays legacy troops as the two frames they ship', () => {
    expect(deathFrames('highlander')).toEqual([
      'trp/trp_highlander_death_f1',
      'trp/trp_highlander_death_f2',
    ]);
  });

  it('fails before allocating any generic death sprite for an unadapted Wyrmling', () => {
    const scene = new FakeScene();
    expect(() => new TroopFx(
      scene as never, new AnimTicker(), 'wyrmling', 10, 20, 20,
      undefined, 12,
    )).toThrow(/M22 WARE Hatchling adapter/);
    expect(scene.sprites).toEqual([]);
  });

  it('plays every authored hero defeat frame (Vex 3, Theodor 4)', () => {
    expect(deathFrames('highlander', { skin: 'hero_vex' })).toEqual([
      'hero/hero_vex_defeat_f1',
      'hero/hero_vex_defeat_f2',
      'hero/hero_vex_defeat_f3',
    ]);
    expect(deathFrames('highlander', { skin: 'hero_theo' })).toEqual([
      'hero/hero_theo_defeat_f1',
      'hero/hero_theo_defeat_f2',
      'hero/hero_theo_defeat_f3',
      'hero/hero_theo_defeat_f4',
    ]);
  });

  it('holds the LAST frame before fading, however many there are', () => {
    // A fixed total would play a 4-frame death at double speed and then fade
    // over the top of it. Two frames must still land on the schedule this has
    // always run (f2 at 200ms, fade at 600ms).
    const legacy = make('highlander');
    legacy.fx.onDeath();
    legacy.scene.advanceTo(199);
    expect(legacy.sprite.writes.at(-1)).toBe('trp/trp_highlander_death_f1');
    legacy.scene.advanceTo(200);
    expect(legacy.sprite.writes.at(-1)).toBe('trp/trp_highlander_death_f2');

    const levelled = make('dragon', { level: 2 });
    levelled.fx.onDeath();
    levelled.scene.advanceTo(599);
    expect(levelled.sprite.writes.at(-1)).toBe('trpdg_l2/trp_dragon_l2_death_f3');
    levelled.scene.advanceTo(600);
    expect(levelled.sprite.writes.at(-1)).toBe('trpdg_l2/trp_dragon_l2_death_f4');
  });
});

describe('hero basic swings under the SIM13 wall-chew cadence', () => {
  // WHY (tester report, build cee3869/SIM13, 2026-09-04): "the hero attack
  // animation is missing … the hero looks completely idle even though damage
  // is being applied". A hero chewing a committed wall receives a heroAttack
  // cue every 100 ms sim tick, but the attack loop only advances on the 260 ms
  // AnimTicker. Re-registering the six-frame loop on every cue put the sprite
  // back on frame 1 before the ticker ever moved it, so the body never left
  // its first pose. Continuing the already-registered loop lets every frame
  // ship while the recovery lock is still re-armed by each cue.
  const tick = (anim: AnimTicker): void => { (anim as unknown as { tick(): void }).tick(); };
  const swingFrames = (writes: readonly string[]): string[] => writes
    .filter((write) => write.includes('_attack_e_f'))
    .map((write) => write.slice(write.lastIndexOf('_') + 1));

  it('cues every 100 ms keep the six-frame swing advancing on the 260 ms clock instead of pinning frame 1', () => {
    const { scene, anim, fx, sprite } = make('giant', { skin: 'hero_theo' });
    expect(sprite.writes.at(-1), 'a resting hero already loops its swing').toBe('hero/hero_theo_attack_e_f1');
    const before = sprite.writes.length;
    const schedule: Array<[number, 'cue' | 'tick']> = [];
    for (let t = 0; t <= 1_600; t += 100) schedule.push([t, 'cue']);
    for (let t = 260; t <= 1_600; t += 260) schedule.push([t, 'tick']);
    schedule.sort((a, b) => a[0] - b[0] || (a[1] === 'cue' ? -1 : 1));
    for (const [t, kind] of schedule) {
      scene.advanceTo(t);
      if (kind === 'cue') fx.onHeroAttack(100, 20, 100);
      else tick(anim);
    }
    // Six ticker steps walk the whole loop and wrap; no cue ever re-wrote f1.
    expect(swingFrames(sprite.writes.slice(before))).toEqual(['f2', 'f3', 'f4', 'f5', 'f6', 'f1']);
  });

  it('a cue arriving mid-swing re-arms the recovery lock, so the earlier expiry cannot release the body early', () => {
    const { scene, fx, sprite } = make('giant', { skin: 'hero_theo' });
    fx.onHeroAttack(100, 20, 300);
    const before = sprite.writes.length; // the spawn frame itself is a walk pose
    const walked = (): boolean => sprite.writes.slice(before).some((write) => write.includes('_walk_'));
    scene.advanceTo(200);
    fx.onHeroAttack(100, 20, 300); // recovery now runs to 500
    scene.advanceTo(300); // the first cue's release fires here and must be inert
    fx.onPos(80, 90, 100);
    expect(walked(), 'still swinging: the keyframe waits').toBe(false);
    scene.advanceTo(500);
    expect(walked(), 'released on the re-armed expiry').toBe(true);
  });

  it('a swing that interrupts a walk still starts from frame 1 — only the identical loop continues', () => {
    const { fx, sprite } = make('giant', { skin: 'hero_theo' });
    fx.onPos(80, 20, 100);
    expect(sprite.writes.at(-1)).toContain('_walk_');
    fx.onHeroAttack(100, 20, 300);
    expect(sprite.writes.at(-1)).toBe('hero/hero_theo_attack_e_f1');
  });
});

describe('HeroFx authoritative event map', () => {
  it.each(['hero_vex', 'hero_theo'] as const)('%s cannot resume a queued move after destruction during catch-up', (skin) => {
    // WHY: a hidden-tab archived prefix destroys an old hero before Clock.update
    // drains its skill-unlock timer. Phaser setTexture then has no scene.sys.
    const { scene, fx, sprite } = make(skin === 'hero_vex' ? 'highlander' : 'giant', { skin });
    const setTexture = sprite.setTexture.bind(sprite);
    sprite.setTexture = (atlas, frame) => {
      if (!sprite.active) throw new Error('destroyed sprite has no scene.sys');
      return setTexture(atlas, frame);
    };
    fx.onHeroAttack(80, 90, 500);
    fx.onPos(80, 90, 500);
    fx.destroy();
    const writes = sprite.writes.length;
    expect(() => scene.advanceTo(501)).not.toThrow();
    expect(sprite.writes).toHaveLength(writes);
    expect(fx.alive).toBe(false);
  });

  it('verdict settlement invalidates the hero unlock without restarting animation', () => {
    // WHY: settling leaves the survivor visible, but advancing an already-due
    // timer must not resume its pending move or register another idle loop.
    const { scene, fx, sprite } = make('giant', { skin: 'hero_theo' });
    fx.onHeroSkill('silentButDeadly', 'windup', 8_000);
    fx.onPos(80, 90, 500);
    fx.settle();
    const writes = sprite.writes.length;
    scene.advanceTo(8_001);
    expect(sprite.writes).toHaveLength(writes);
    expect([sprite.x, sprite.y]).toEqual([80, 90]);
  });

  it.each([
    ['hero_vex', 'crimsonDash', 'impact', 'hero_vex_dash_e_f1'],
    ['hero_vex', 'moonsunderWave', 'impact', 'hero_vex_cast_e_f1'],
    ['hero_vex', 'degenAwakening', 'active', 'hero_vex_awaken_f1'],
    ['hero_vex', 'doubleOrNothingHeads', 'heads', 'hero_vex_revive_f1'],
    ['hero_vex', 'doubleOrNothingTails', 'tails', 'hero_vex_taunt_f1'],
    ['hero_vex', 'omegaShardstorm', 'impact', 'hero_vex_awaken_f1'],
    ['hero_theo', 'cheekQuake', 'impact', 'hero_theo_slam_f1'],
    ['hero_theo', 'snotRocket', 'impact', 'hero_theo_snot_f1'],
    ['hero_theo', 'cannonball', 'impact', 'hero_theo_leap_f1'],
    ['hero_theo', 'skillIssue', 'active', 'hero_theo_airtaunt_f1'],
    ['hero_theo', 'bellyBounce', 'reflect', 'hero_theo_bounce_f1'],
    ['hero_theo', 'brownNote', 'impact', 'hero_theo_gaswall_f1'],
    ['hero_theo', 'rageQuit', 'fakeDeath', 'hero_theo_playdead_f1'],
    ['hero_theo', 'rageQuitWake', 'revive', 'hero_theo_getup_f1'],
    ['hero_theo', 'silentButDeadly', 'windup', 'hero_theo_eat_f1'],
  ] as const)('%s %s/%s reaches %s', (skin, skill, phase, frame) => {
    const { fx, sprite } = make(skin === 'hero_vex' ? 'highlander' : 'giant', { skin });
    fx.onHeroSkill(skill, phase, 500);
    expect(sprite.writes.at(-1)).toBe(`hero/${frame}`);
  });

  it('skill lock defers a same-tick position until the skill completes', () => {
    const { scene, fx, sprite } = make('giant', { skin: 'hero_theo' });
    fx.onHeroSkill('cannonball', 'impact', 500);
    fx.onPos(80, 90, 500);
    expect([sprite.x, sprite.y]).toEqual([10, 20]);
    scene.advanceTo(500);
    expect(sprite.writes.at(-1)).toContain('hero_theo_');
  });

  it.each([
    ['cheekQuake', 'impact', 'hero_theo_slam', 8, 500],
    ['snotRocket', 'impact', 'hero_theo_snot', 6, 500],
    ['cannonball', 'impact', 'hero_theo_leap', 8, 800],
    ['skillIssue', 'active', 'hero_theo_airtaunt', 3, 500],
    ['bellyBounce', 'reflect', 'hero_theo_bounce', 4, 500],
    ['brownNote', 'impact', 'hero_theo_gaswall', 6, 500],
    ['rageQuit', 'fakeDeath', 'hero_theo_playdead', 5, 3_000],
    ['rageQuitWake', 'revive', 'hero_theo_getup', 4, 500],
    ['silentButDeadly', 'impact', 'hero_theo_blast', 4, 500],
  ] as const)('%s plays its complete dedicated body once, then holds', (
    skill, phase, base, frames, lockMs,
  ) => {
    // WHY: the old aliases either showed a generic mock or named frames that do
    // not exist. Phaser fails silently, so coverage must assert every literal.
    const { scene, fx, sprite } = make('giant', { skin: 'hero_theo' });
    fx.onHeroSkill(skill, phase, lockMs);
    scene.advanceTo(lockMs - 1);
    expect(sprite.writes.filter((write) => write.includes(`${base}_f`))).toEqual(
      Array.from({ length: frames }, (_, i) => `hero/${base}_f${i + 1}`),
    );
  });

  it.each([
    ['crimsonDash', 'impact', 'hero_vex_dash_e', 3],
    ['moonsunderWave', 'impact', 'hero_vex_cast_e', 3],
    ['degenAwakening', 'active', 'hero_vex_awaken', 3],
    ['omegaShardstorm', 'impact', 'hero_vex_awaken', 3],
    ['doubleOrNothingHeads', 'heads', 'hero_vex_revive', 2],
    ['doubleOrNothingTails', 'tails', 'hero_vex_taunt', 3],
  ] as const)('%s plays every Vex skill-body frame inside its visual lock', (
    skill, phase, base, frames,
  ) => {
    // WHY: the normal ticker advances every 260ms while the common hero-skill
    // lock is 500ms. Without bounded playback, a three-frame action silently
    // resolves after frame two and the final contact/recovery pose never ships.
    const { scene, fx, sprite } = make('highlander', { skin: 'hero_vex' });
    fx.onHeroSkill(skill, phase, 500);
    scene.advanceTo(499);
    expect(sprite.writes.filter((write) => write.includes(`${base}_f`))).toEqual(
      Array.from({ length: frames }, (_, i) => `hero/${base}_f${i + 1}`),
    );
  });

  it('uses the authoritative five-second eat then three-second swell wind-up', () => {
    // WHY: one bogus four-frame bloated-leap alias made seven of the eight
    // authored wind-up seconds invisible. The sim lock remains exactly 8s.
    const { scene, fx, sprite } = make('giant', { skin: 'hero_theo' });
    fx.onHeroSkill('silentButDeadly', 'windup', 8_000);
    expect(sprite.writes.at(-1)).toBe('hero/hero_theo_eat_f1');

    scene.advanceTo(4_999);
    expect(sprite.writes.some((write) => write.includes('hero_theo_bloat_'))).toBe(false);
    scene.advanceTo(5_000);
    expect(sprite.writes.at(-1)).toBe('hero/hero_theo_bloat_f1');
    scene.advanceTo(6_040);
    expect(sprite.writes.filter((write) => write.includes('hero_theo_bloat_f'))).toEqual([
      'hero/hero_theo_bloat_f1',
      'hero/hero_theo_bloat_f2',
      'hero/hero_theo_bloat_f3',
      'hero/hero_theo_bloat_f4',
      'hero/hero_theo_bloat_f5',
    ]);
  });

  it('rehydrates Rage Quit as already fake-dead for only the remaining lock', () => {
    const { scene, fx, sprite } = make('giant', { skin: 'hero_theo' });
    fx.finishSeek();
    fx.onHeroSkill('rageQuit', 'fakeDeath', 400, 2_600);

    expect(sprite.writes.at(-1)).toBe('hero/hero_theo_playdead_f5');
    expect((fx as unknown as { state: string }).state).toBe('skill');
    scene.advanceTo(399);
    expect((fx as unknown as { state: string }).state).toBe('skill');
    scene.advanceTo(400);
    expect((fx as unknown as { state: string }).state).toBe('idle');
  });

  it('rehydrates Silent But Deadly in its elapsed swell stage, not a fresh eat loop', () => {
    const { scene, fx, sprite } = make('giant', { skin: 'hero_theo' });
    fx.finishSeek();
    fx.onHeroSkill('silentButDeadly', 'windup', 2_000, 6_000);

    expect(sprite.writes.at(-1)).toBe('hero/hero_theo_bloat_f1');
    expect(sprite.writes.some((write) => write.includes('hero_theo_eat_'))).toBe(false);
    scene.advanceTo(1_999);
    expect((fx as unknown as { state: string }).state).toBe('skill');
    scene.advanceTo(2_000);
    expect((fx as unknown as { state: string }).state).toBe('idle');
  });
});
