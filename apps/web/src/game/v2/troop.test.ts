/**
 * Profile-to-pack contract. Phaser fails soft on a missing frame, so a typo in
 * one verb otherwise produces an invisible troop with no test failure.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ART_V2, BATTLE_SCALE,
  V2_FALLBACK_ATLAS, V2_FALLBACK_LOCOMOTION_STATES, V2_FALLBACK_STAND_STATES,
  atlasGroupFor, v2FallbackFrameKey, v2LocomotionAtlasGroup,
  v2CompactCombatAtlasGroup,
  v2GloamfangCombatAtlasGroup,
  WORLD_DEPTH,
  type V2FallbackUnit,
} from '@shardkeep/shared';
import {
  clipKey, facingRow, parseFxAt, V2_DRAW_SCALE,
  type Facing8, type V2ClipMap,
} from './clips';
import {
  optionalV2TroopAtlasGroups, requiredV2FallbackLocomotionAtlasGroups,
  requiredV2TroopAtlasGroups,
  v2FallbackSpec, v2TroopDrawScale, V2TroopFx, V2_TROOP_PROFILES,
  type V2TroopDeps, type V2TroopProfile, type V2TroopUnit,
} from './troop';
import { V2Ticker } from './ticker';

interface ManifestEntry {
  file: string;
  unit?: string;
  state?: string;
  tier?: number;
  variants?: number;
  variantStride?: number;
  fxAt?: string | null;
  emitters?: Record<string, unknown>;
  frames?: number;
  fps?: number;
  loop?: boolean;
  anchor?: [number, number];
  atlas?: {
    cellW: number;
    cellH: number;
    rows: number;
    rowOrder?: string[];
  };
}

const manifest = JSON.parse(readFileSync(
  new URL('../../../../../art/source/troops-rework-expanded/manifest.json', import.meta.url),
  'utf8',
)) as { atlases: ManifestEntry[] };

function states(profile: V2TroopProfile): string[] {
  return [
    profile.move, profile.battleMove, profile.stand, ...profile.attack, ...(profile.abilities ?? []),
    profile.spawn, profile.hit, profile.damaged, profile.death,
    profile.burrow?.enter, profile.burrow?.tunnel, profile.burrow?.surface, profile.detonate,
    profile.melee?.troop, profile.melee?.building,
  ].filter((state): state is string => state !== undefined);
}

class FakeSprite {
  active = true;
  depth = 0;
  readonly writes: string[] = [];
  originX = 0;
  originY = 0;
  rotation = 0;
  scale = 1;

  constructor(public x: number, public y: number, atlas: string, frame: string) {
    this.writes.push(`${atlas}/${frame}`);
  }

  setTexture(atlas: string, frame: string): this {
    this.writes.push(`${atlas}/${frame}`);
    return this;
  }
  setOrigin(x: number, y: number): this { this.originX = x; this.originY = y; return this; }
  setDepth(depth: number): this { this.depth = depth; return this; }
  setPosition(x: number, y: number): this { this.x = x; this.y = y; return this; }
  setScale(scale: number): this { this.scale = scale; return this; }
  setVisible(): this { return this; }
  setAlpha(): this { return this; }
  setRotation(rotation: number): this { this.rotation = rotation; return this; }
  once(): this { return this; }
  destroy(): void { this.active = false; }
}

class FakeScene {
  readonly sprites: FakeSprite[] = [];
  readonly images: FakeSprite[] = [];
  readonly tweenConfigs: Array<{ onComplete?: () => void }> = [];
  readonly counterConfigs: Array<{
    onUpdate?: (tw: { getValue: () => number }) => void;
    onComplete?: () => void;
  }> = [];
  readonly delayedConfigs: Array<{
    delay: number;
    callback: () => void;
    removed: boolean;
    remove: () => void;
  }> = [];
  readonly killedTweens: unknown[] = [];
  readonly textures = { exists: (_atlas?: string): boolean => true };
  readonly add = {
    sprite: (x: number, y: number, atlas: string, frame: string): FakeSprite => {
      const sprite = new FakeSprite(x, y, atlas, frame);
      this.sprites.push(sprite);
      return sprite;
    },
    image: (x: number, y: number, atlas: string, frame: string): FakeSprite => {
      const image = new FakeSprite(x, y, atlas, frame);
      this.images.push(image);
      return image;
    },
  };
  readonly time = {
    delayedCall: (delay: number, callback: () => void): object => {
      const timer = {
        delay, callback, removed: false,
        remove(): void { this.removed = true; },
      };
      this.delayedConfigs.push(timer);
      return timer;
    },
  };
  readonly tweens = {
    add: (config: { onComplete?: () => void }): object => {
      this.tweenConfigs.push(config);
      return {};
    },
    addCounter: (config: {
      onUpdate?: (tw: { getValue: () => number }) => void;
      onComplete?: () => void;
    }): object => {
      this.counterConfigs.push(config);
      return {};
    },
    killTweensOf: (target: unknown): void => { this.killedTweens.push(target); },
  };
}

function grid(frames: number, fps: number, extra: object = {}) {
  return {
    frames, rows: 8, cellW: 96, cellH: 96,
    rowOrder: ['s', 'sw', 'w', 'nw', 'n', 'ne', 'e', 'se'],
    anchorPx: [48, 86] as [number, number], fps, loop: false, ...extra,
  };
}

function runtimeDeps(unit: 'bowman' | 'mage' | 'kegrunner'): V2TroopDeps {
  const ticker = new V2Ticker();
  const base = `v2_trp_${unit}_t1_`;
  const clips: V2TroopDeps['clips'] = {
    [`${base}spawn`]: grid(4, 10),
    [`${base}walk`]: { ...grid(6, 10), loop: true },
    [`${base}idle`]: { ...grid(4, 7), loop: true },
    [`${base}hit`]: grid(2, 12),
  };
  if (unit === 'bowman') {
    clips[`${base}draw`] = grid(6, 14);
    clips[`${base}loose`] = grid(4, 20, {
      fxAt: 'arrow@0', emitters: { nock: [[[60, 50]]] },
    });
    clips[`${base}death`] = grid(6, 9);
  } else if (unit === 'mage') {
    clips[`${base}cast`] = grid(8, 13, {
      fxAt: 'castflash@4 + bolt@4', emitters: { staff: [[[60, 50]]] },
    });
    clips[`${base}death`] = grid(6, 9);
  } else {
    clips[`${base}run`] = { ...grid(6, 12), loop: true };
    clips[`${base}prime`] = { ...grid(6, 14), loop: true };
    clips[`${base}detonate`] = grid(6, 13, {
      fxAt: 'keg_blast@1 at the KEG emitter', emitters: { keg: [[[48, 80], [48, 80]]] },
    });
    clips.v2_fx_keg_blast_t1 = {
      frames: 6, rows: 1, cellW: 96, cellH: 96, fps: 16, loop: false,
    };
  }
  return { ticker, clips, breath: null, unit: unit as V2TroopUnit, tier: 1 };
}

function runtime(unit: 'bowman' | 'mage' | 'kegrunner') {
  const deps = runtimeDeps(unit);
  const scene = new FakeScene();
  const fx = new V2TroopFx(scene as never, deps, 10, 20, 20);
  deps.ticker.tick(1000); // spawn completes; the unit is ready for an event.
  return { deps, scene, fx, sprite: scene.sprites[0]! };
}

function manifestDeps(unit: V2TroopUnit): V2TroopDeps {
  const profile = V2_TROOP_PROFILES[unit] as V2TroopProfile;
  const clips: Record<string, unknown> = {};
  for (const entry of manifest.atlases) {
    if (entry.unit !== unit || entry.tier !== 1 || !entry.state || !entry.atlas) continue;
    clips[clipKey(profile.kind, unit, 1, entry.state)] = {
      frames: entry.frames ?? 1,
      rows: entry.atlas.rows,
      cellW: entry.atlas.cellW,
      cellH: entry.atlas.cellH,
      rowOrder: entry.atlas.rowOrder,
      anchorPx: entry.anchor,
      fps: entry.fps,
      loop: entry.loop,
      fxAt: entry.fxAt,
      emitters: entry.emitters,
      variants: entry.variants,
      variantStride: entry.variantStride,
    };
  }
  return {
    ticker: new V2Ticker(), clips: clips as V2ClipMap,
    breath: null, unit, tier: 1,
  };
}

describe('V2 troop visual profiles', () => {
  it('derives eager fallback geometry for every deployable or spawned v2 profile', () => {
    const fallbackUnits = Object.keys(V2_FALLBACK_STAND_STATES) as V2FallbackUnit[];
    expect(fallbackUnits).toHaveLength(15);
    for (const unit of fallbackUnits) {
      expect(V2_TROOP_PROFILES[unit].stand).toBe(V2_FALLBACK_STAND_STATES[unit]);
      const deps = manifestDeps(unit);
      const spec = v2FallbackSpec(deps.clips, unit, 1);
      expect(spec, unit).toMatchObject({
        atlas: V2_FALLBACK_ATLAS,
        frame: v2FallbackFrameKey(unit, 1),
        scale: v2TroopDrawScale(unit),
      });
      expect(spec!.origin.every(Number.isFinite), unit).toBe(true);
    }
    expect(v2FallbackSpec({}, 'wyrmling', 1)).toBeNull();
  });

  /**
   * REWRITTEN 2026-08-30 (owner, playing their own base: "troops are very big").
   * This case used to pin the OPPOSITE rule — that every root except the Mage
   * drew at the bare `V2_DRAW_SCALE`, with the Mage's owner-ordered halving
   * carried as a `drawScale: 0.5` on its visual profile.
   *
   * That rule was the bug, twice over: a game number outside constants.ts, and
   * a whole art pack with no published world fit, so every reworked troop drew
   * at full authored size while every building around it had been fitted down
   * (the identical shape to the v2-tower defect fixed the same day). The Mage's
   * correction survives — as ART_V2.troopSourceScale.mage — because its INTENT
   * survives ("the mage must not tower"); what does not survive is the idea
   * that halving one unit was the answer to a pack that was ~2.5x over.
   *
   * What is pinned now is the composition, not any single number: every root
   * publishes a fit, the fit is what reaches the sprite, and no root is left on
   * the raw pack conversion.
   */
  it('draws every root at the pack conversion times its published world fit', () => {
    for (const unit of Object.keys(V2_TROOP_PROFILES)) {
      const fit: Record<string, number> = ART_V2.troopSourceScale;
      expect(Object.prototype.hasOwnProperty.call(fit, unit), `${unit} publishes a fit`)
        .toBe(true);
      expect(v2TroopDrawScale(unit), unit).toBe(V2_DRAW_SCALE * fit[unit]!);
      // Every root was over-scale; none may quietly return to the raw pack
      // conversion, which is the exact regression this file used to enforce.
      expect(v2TroopDrawScale(unit), unit).toBeLessThan(V2_DRAW_SCALE);
    }
    // The relationships the old rule protected are still there — they just live
    // in the fit table now instead of in the artist's cell sizes.
    expect(v2TroopDrawScale('giant')).toBeGreaterThan(v2TroopDrawScale('highlander'));
    expect(v2TroopDrawScale('mage')).toBeLessThan(v2TroopDrawScale('highlander'));

    const mageDeps = manifestDeps('mage');
    const dragonDeps = manifestDeps('dragon');
    const mageScene = new FakeScene();
    const dragonScene = new FakeScene();
    new V2TroopFx(mageScene as never, mageDeps, 10, 20, 20);
    new V2TroopFx(dragonScene as never, dragonDeps, 10, 20, 20);
    // The battle body is the fit TIMES BATTLE_SCALE.troop — the pre-rework
    // contract the reworked units were the only actors not honouring.
    expect(mageScene.sprites[0]!.scale)
      .toBe(v2TroopDrawScale('mage') * BATTLE_SCALE.troop);
    expect(dragonScene.sprites[0]!.scale)
      .toBe(v2TroopDrawScale('dragon') * BATTLE_SCALE.troop);
  });

  it('keeps a complete compact locomotion contract for every rendered v2 root', () => {
    const active = Object.keys(V2_FALLBACK_LOCOMOTION_STATES) as V2FallbackUnit[];
    expect(new Set(active)).toEqual(new Set(Object.keys(V2_FALLBACK_STAND_STATES)));
    for (const unit of active) {
      const profile = V2_TROOP_PROFILES[unit] as V2TroopProfile;
      expect(new Set(V2_FALLBACK_LOCOMOTION_STATES[unit])).toEqual(
        new Set([profile.move, profile.battleMove].filter(Boolean)),
      );
      const deps = manifestDeps(unit);
      expect(requiredV2FallbackLocomotionAtlasGroups(deps.clips, unit, 1), unit)
        .toEqual(unit === 'gloamfang'
          ? [v2LocomotionAtlasGroup(unit, 1), v2GloamfangCombatAtlasGroup(1)]
          : [v2LocomotionAtlasGroup(unit, 1)]);
      const kind = profile.kind;
      for (const state of V2_FALLBACK_LOCOMOTION_STATES[unit]) {
        expect(atlasGroupFor(`v2_${kind}_${unit}_t1_${state}_d0_f1`), `${unit} ${state}`)
          .toBe(v2LocomotionAtlasGroup(unit, 1));
      }
    }
    expect(requiredV2FallbackLocomotionAtlasGroups({}, 'wyrmling', 1)).toEqual([]);
  });

  it('renders uninterrupted rich and compact locomotion in all eight headings', () => {
    const headings: Array<[Facing8, number, number]> = [
      ['s', 0, 100], ['sw', -100, 100], ['w', -100, 0], ['nw', -100, -100],
      ['n', 0, -100], ['ne', 100, -100], ['e', 100, 0], ['se', 100, 100],
    ];
    for (const unit of Object.keys(V2_TROOP_PROFILES) as V2TroopUnit[]) {
      for (const compact of [false, true]) {
        const deps = { ...manifestDeps(unit), compact };
        const scene = new FakeScene();
        const fx = new V2TroopFx(scene as never, deps, 10, 20, 20);
        deps.ticker.tick(5_000);
        const profile = V2_TROOP_PROFILES[unit] as V2TroopProfile;
        const state = profile.battleMove ?? profile.move;
        const clip = deps.clips[clipKey(profile.kind, unit, 1, state)]!;
        for (const [heading, dx, dy] of headings) {
          fx.onPos(fx.sprite.x + dx, fx.sprite.y + dy, 500);
          const write = scene.sprites[0]!.writes.at(-1)!;
          expect(write, `${unit} ${compact ? 'compact' : 'rich'} ${heading}`)
            .toContain(`_d${facingRow(clip, heading)}_`);
          if (compact) expect(write.startsWith(`${v2CompactCombatAtlasGroup(unit, 1)}/`)).toBe(true);
        }
      }
    }
  });

  it('aims every direct rich and compact attack body in all eight headings', () => {
    const headings: Array<[Facing8, number, number]> = [
      ['s', 0, 100], ['sw', -100, 100], ['w', -100, 0], ['nw', -100, -100],
      ['n', 0, -100], ['ne', 100, -100], ['e', 100, 0], ['se', 100, 100],
    ];
    const melee = new Set([
      'highlander', 'tunneler', 'turrider', 'plunderer', 'giant', 'troll',
      'bilgewraith', 'gloamfang', 'barrowling',
    ]);
    for (const unit of Object.keys(V2_TROOP_PROFILES) as V2TroopUnit[]) {
      for (const compact of [false, true]) {
        for (const [heading, dx, dy] of headings) {
          const deps = { ...manifestDeps(unit), compact, meleeDriven: true };
          if (unit === 'direwyvern') deps.clips.v2_fx_firestorm_t1 = {
            frames: 8, rows: 1, cellW: 176, cellH: 128,
            anchorPx: [10, 64], fps: 11, loop: false,
          };
          const scene = new FakeScene();
          const fx = new V2TroopFx(scene as never, deps, 10, 20, 20);
          deps.ticker.tick(5_000);
          const tx = fx.sprite.x + dx;
          const ty = fx.sprite.y + dy;
          if (melee.has(unit)) {
            fx.onMeleeAttack('building', tx, ty,
              unit === 'troll' ? 'slam' : unit === 'gloamfang' ? 'rend' : 'strike');
          } else if (unit === 'bowman' || unit === 'mage' || unit === 'hexbarrow') {
            fx.onRangedAttack(tx, ty, () => undefined);
          } else if (unit === 'dragon') {
            fx.onBreath(tx, ty);
          } else if (unit === 'direwyvern') {
            fx.onAbility('firestorm', fx.sprite.x, fx.sprite.y, tx, ty);
          } else if (unit === 'kegrunner') {
            fx.onPos(tx, ty, 500);
            fx.onDetonate();
          }
          const profile = V2_TROOP_PROFILES[unit] as V2TroopProfile;
          const state = unit === 'dragon' ? 'breath'
            : unit === 'direwyvern' ? 'firestorm'
              : unit === 'kegrunner' ? 'detonate'
                : melee.has(unit) ? profile.melee!.building : profile.attack[0]!;
          const clip = deps.clips[clipKey(profile.kind, unit, 1, state)]!;
          const write = scene.sprites[0]!.writes.at(-1)!;
          expect(write, `${unit} ${compact ? 'compact' : 'rich'} ${heading}`)
            .toContain(`_d${facingRow(clip, heading)}_`);
          if (compact) expect(write.startsWith(`${v2CompactCombatAtlasGroup(unit, 1)}/`)).toBe(true);
        }
      }
    }
  });

  it('names only states that the owner manifest ships at every tier', () => {
    const files = new Set(manifest.atlases.map((entry) => entry.file));
    for (const [unit, profile] of Object.entries(V2_TROOP_PROFILES)) {
      for (let tier = 1; tier <= 4; tier++) {
        for (const state of states(profile)) {
          expect(
            files.has(`assets/${profile.kind}_${unit}_t${tier}_${state}.svg`),
            `${unit} t${tier} ${state}`,
          ).toBe(true);
        }
      }
    }
  });

  it('accounts explicitly for every delivered non-protected troop state', () => {
    // WHY: the forward profile test above proves configured verbs exist, but it
    // cannot notice a delivered verb that nobody configured. These are the
    // states not represented anywhere in a profile, named one-by-one so a new
    // orphan fails loud. Reachable synthetic verbs such as Kegrunner `prime`
    // are configured here; only the explicitly enumerated states stay dormant.
    const intentionallyDormant: Readonly<Record<string, readonly string[]>> = {
      highlander: ['whirl'],
      bowman: [],
      kegrunner: [],
      tunneler: [],
      turrider: ['rear'],
      plunderer: ['loot', 'walkfull'],
      troll: [],
      mage: ['channel'],
      bilgewraith: [],
      gloamfang: [],
      direwyvern: [],
      hexbarrow: [],
      barrowling: [],
    };
    for (const [unit, dormant] of Object.entries(intentionallyDormant)) {
      const profile = V2_TROOP_PROFILES[unit as V2TroopUnit] as V2TroopProfile;
      const configured = new Set(states(profile));
      const delivered = [...new Set(manifest.atlases
        .filter((entry) => entry.unit === unit && entry.state)
        .map((entry) => entry.state!))].sort();
      const unconfigured = delivered.filter((state) => !configured.has(state));
      expect(unconfigured, unit).toEqual([...dormant].sort());
    }
  });

  it('keeps every non-protected troop clip on its published ground-line anchor', () => {
    const anchors: Readonly<Record<string, readonly [number, number]>> = {
      highlander: [48, 86], bowman: [48, 86], kegrunner: [48, 86],
      tunneler: [48, 86], turrider: [56, 100], plunderer: [48, 86],
      troll: [56, 100], mage: [48, 86], bilgewraith: [48, 84],
      gloamfang: [80, 136], direwyvern: [152, 190],
      hexbarrow: [64, 100], barrowling: [32, 56],
    };
    for (const [unit, anchor] of Object.entries(anchors)) {
      const clips = manifest.atlases.filter((entry) => entry.unit === unit && entry.state);
      expect(clips.length, unit).toBeGreaterThan(0);
      for (const clip of clips) {
        expect((clip as ManifestEntry & { anchor?: [number, number] }).anchor, clip.file)
          .toEqual(anchor);
      }
    }
  });

  it('keeps the protected giant and dragon verb semantics', () => {
    expect(V2_TROOP_PROFILES.giant).toMatchObject({
      kind: 'trp', move: 'walk', stand: 'idle', attack: ['attack'], death: 'death',
    });
    expect(V2_TROOP_PROFILES.dragon).toMatchObject({
      kind: 'trp', move: 'fly', stand: 'hover', attack: ['breath'],
      death: 'death', flying: true, autoAttack: false,
    });
  });

  it('publishes burrow cycles and Hexbarrow\'s authored bld key root', () => {
    expect(V2_TROOP_PROFILES.tunneler.burrow).toEqual({
      enter: 'burrow', tunnel: 'tunnel', surface: 'surface',
    });
    expect(V2_TROOP_PROFILES.bilgewraith.burrow).toEqual(
      V2_TROOP_PROFILES.tunneler.burrow,
    );
    expect(V2_TROOP_PROFILES.hexbarrow.kind).toBe('bld');
  });

  it('maps Troll troop contact to sweep and structure contact to pound', () => {
    expect(V2_TROOP_PROFILES.troll.melee).toEqual({
      troop: 'attack', building: 'pound',
    });
    for (let tier = 1; tier <= 4; tier++) {
      const sweep = manifest.atlases.find((entry) =>
        entry.file === `assets/trp_troll_t${tier}_attack.svg`,
      );
      const pound = manifest.atlases.find((entry) =>
        entry.file === `assets/trp_troll_t${tier}_pound.svg`,
      );
      expect(parseFxAt(sweep?.fxAt)).toContainEqual({ fx: 'sweep', frames: [5] });
      expect(parseFxAt(pound?.fxAt)).toEqual(expect.arrayContaining([
        { fx: 'impact_slam', frames: [4] }, { fx: 'dust', frames: [4] },
      ]));
      expect(pound?.emitters?.fist).toBeDefined();
    }
  });

  it('plays one authored attack state for every event-driven melee profile', () => {
    const meleeUnits = (Object.entries(V2_TROOP_PROFILES) as Array<
      [V2TroopUnit, V2TroopProfile]
    >).filter(([, profile]) => profile.melee !== undefined).map(([unit]) => unit);
    expect(meleeUnits).toEqual([
      'highlander', 'tunneler', 'turrider', 'plunderer', 'giant',
      'troll', 'bilgewraith', 'gloamfang', 'barrowling',
    ]);
    for (const unit of meleeUnits) {
      const deps = manifestDeps(unit);
      deps.meleeDriven = true;
      const scene = new FakeScene();
      const fx = new V2TroopFx(scene as never, deps, 10, 20, 20);
      deps.ticker.tick(2_000);
      const mark = scene.sprites[0]!.writes.length;
      const technique = unit === 'troll' ? 'slam' : unit === 'gloamfang' ? 'rend' : 'strike';
      fx.onMeleeAttack('building', 200, 20, technique);
      deps.ticker.tick(100);
      const state = (V2_TROOP_PROFILES[unit] as V2TroopProfile).melee!.building;
      expect(scene.sprites[0]!.writes.slice(mark).some(
        (frame) => frame.includes(`_${state}_`),
      ), unit).toBe(true);
    }
  });

  it('uses Tur Rider charge only as battle locomotion and keeps base walk distinct', () => {
    expect(V2_TROOP_PROFILES.turrider).toMatchObject({
      move: 'walk', battleMove: 'charge',
    });
    for (let tier = 1; tier <= 4; tier++) {
      expect(manifest.atlases.some((entry) =>
        entry.file === `assets/trp_turrider_t${tier}_charge.svg`,
      )).toBe(true);
    }
  });

  it('keeps charge active when an older position tween completes after the next starts', () => {
    const deps = manifestDeps('turrider');
    const scene = new FakeScene();
    const fx = new V2TroopFx(scene as never, deps, 10, 20, 20);
    deps.ticker.tick(2000);

    fx.onPos(100, 20, 500);
    const first = scene.tweenConfigs.at(-1)!;
    fx.onPos(200, 20, 500);
    const mark = scene.sprites[0]!.writes.length;
    first.onComplete?.();
    deps.ticker.tick(100);

    expect(scene.sprites[0]!.writes.slice(mark).some((frame) => frame.includes('_attack_'))).toBe(false);
    expect(scene.sprites[0]!.writes.at(-1)).toContain('_charge_');
  });

  it('preserves spawn when deploy and the first position keyframe share a tick', () => {
    const deps = manifestDeps('turrider');
    const scene = new FakeScene();
    const fx = new V2TroopFx(scene as never, deps, 10, 20, 20);
    const mark = scene.sprites[0]!.writes.length;

    fx.onPos(100, 20, 500);
    deps.ticker.tick(100);

    const firstFrames = scene.sprites[0]!.writes.slice(mark);
    expect(firstFrames.some((frame) => frame.includes('_spawn_'))).toBe(true);
    expect(firstFrames.some((frame) => frame.includes('_charge_'))).toBe(false);
  });

  it('grounds every ranged release in its authored cue and attachment table', () => {
    for (const unit of ['bowman', 'mage', 'hexbarrow'] as const) {
      const ranged = V2_TROOP_PROFILES[unit].ranged;
      for (let tier = 1; tier <= 4; tier++) {
        const entry = manifest.atlases.find((atlas) =>
          atlas.file === `assets/${V2_TROOP_PROFILES[unit].kind}_${unit}_t${tier}_${ranged.state}.svg`,
        );
        expect(entry, `${unit} t${tier} ${ranged.state}`).toBeDefined();
        expect(entry!.emitters?.[ranged.emitter], `${unit} ${ranged.emitter}`).toBeDefined();
        expect(parseFxAt(entry!.fxAt).some((cue) => cue.fx === ranged.fx)).toBe(true);
        if ('flash' in ranged && ranged.flash) {
          expect(parseFxAt(entry!.fxAt).some((cue) => cue.fx === ranged.flash)).toBe(true);
        }
      }
    }
  });

  it('preloads a state-split atlas and derives Barrowling variant geometry', () => {
    expect(requiredV2TroopAtlasGroups('direwyvern', 2)).toEqual([
      'v2trp_direwyvern_t2_locomotion',
      'v2trp_direwyvern_t2_maul', 'v2trp_direwyvern_t2_firestorm',
      'v2trp_direwyvern_t2_fx',
    ]);
    expect(optionalV2TroopAtlasGroups('direwyvern', 2)).toEqual([
      'v2trp_direwyvern_t2', 'v2trp_direwyvern_t2_lifecycle',
    ]);
    expect(requiredV2TroopAtlasGroups('giant', 2)).toEqual([
      v2LocomotionAtlasGroup('giant', 2), 'v2trp_giant_t2',
    ]);
    const scurry = manifest.atlases.find((entry) =>
      entry.unit === 'barrowling' && entry.tier === 1 && entry.state === 'scurry',
    );
    expect(scurry).toMatchObject({ variants: 4, variantStride: 6 });
  });
});

describe('V2 troop event lifecycle', () => {
  it.each(Object.keys(V2_TROOP_PROFILES) as V2TroopUnit[])(
    '%s starts authored battle locomotion on its first visible movement segment',
    (unit) => {
      // WHY: sparse replay endpoints may be 30 ticks apart. Every deployable or
      // spawned attacker must enter its real move loop as soon as that segment
      // starts, rather than displaying a frozen stand frame until the endpoint.
      const deps = manifestDeps(unit);
      const scene = new FakeScene();
      const fx = new V2TroopFx(scene as never, deps, 10, 20, 20);
      deps.ticker.tick(2000);
      const mark = scene.sprites[0]!.writes.length;

      fx.onPos(200, 20, 3000);
      deps.ticker.tick(100);

      const profile = V2_TROOP_PROFILES[unit] as V2TroopProfile;
      const state = profile.battleMove ?? profile.move;
      expect(scene.sprites[0]!.writes.slice(mark).some(
        (frame) => frame.includes(`_${state}_`),
      ), unit).toBe(true);
    },
  );

  it('keeps Dire visible on directional current art when hover/lifecycle enhancement is rejected', () => {
    const deps = manifestDeps('direwyvern');
    const scene = new FakeScene();
    scene.textures.exists = (atlas?: string): boolean =>
      atlas !== 'v2trp_direwyvern_t1'
      && atlas !== 'v2trp_direwyvern_t1_lifecycle';

    const fx = new V2TroopFx(scene as never, deps, 10, 20, 20);
    deps.ticker.tick(1000);

    expect(fx.initialAtlas).toBe('v2trp_direwyvern_t1_locomotion');
    expect(scene.sprites[0]!.writes.some((frame) =>
      frame.includes('v2_locomotion_stand_direwyvern_t1'),
    )).toBe(true);
    expect(scene.sprites[0]!.writes.some((frame) => frame.includes('_spawn_'))).toBe(false);
  });

  it('renders Gloamfang howl once and snaps the authoritative lunge landing', () => {
    const deps = manifestDeps('gloamfang');
    deps.clips.v2_fx_howl_t1 = {
      frames: 4, rows: 1, cellW: 96, cellH: 96,
      anchorPx: [48, 48], fps: 12, loop: false,
    };
    const scene = new FakeScene();
    const fx = new V2TroopFx(scene as never, deps, 10, 20, 20);
    deps.ticker.tick(2000);

    fx.onAbility('howl', 50, 70);
    deps.ticker.tick(250); // authored howl@2 is metadata frame 2 → runtime frame 3.
    expect(fx.sprite).toMatchObject({ x: 50, y: 70 });
    expect(scene.images.filter((image) =>
      image.writes[0] === 'v2fx/v2_fx_howl_t1_f1',
    )).toHaveLength(1);
    deps.ticker.tick(1000);
    expect(scene.images.filter((image) =>
      image.writes[0] === 'v2fx/v2_fx_howl_t1_f1',
    )).toHaveLength(1);

    const tweenCount = scene.tweenConfigs.length;
    fx.onAbility('lunge', 50, 70, 180, 90);
    fx.onPos(180, 90, 500);
    expect(fx.sprite).toMatchObject({ x: 180, y: 90, depth: WORLD_DEPTH.actor + 90 });
    expect(scene.tweenConfigs).toHaveLength(tweenCount);
  });

  it('uses the shared Gloamfang leap duration but only event-authored endpoints', () => {
    const deps = manifestDeps('gloamfang');
    const scene = new FakeScene();
    const fx = new V2TroopFx(scene as never, deps, 10, 20, 20);
    deps.ticker.tick(2000);

    fx.onAbility('leap', 40, 60, 240, 100);
    const counter = scene.counterConfigs.at(-1)!;
    counter.onUpdate?.({ getValue: () => 0.5 });
    expect(fx.sprite.x).toBe(140);
    expect(fx.sprite.y).toBeLessThan(80); // cosmetic arc rises above the ground lerp.
    counter.onComplete?.();
    expect(fx.sprite).toMatchObject({ x: 240, y: 100, depth: WORLD_DEPTH.actor + 100 });
  });

  it('pins one Direwyvern firestorm fan to its published maw per sim cue', () => {
    const deps = manifestDeps('direwyvern');
    deps.clips.v2_fx_firestorm_t1 = {
      frames: 8, rows: 1, cellW: 176, cellH: 128,
      anchorPx: [10, 64], fps: 11, loop: false,
    };
    const scene = new FakeScene();
    const fx = new V2TroopFx(scene as never, deps, 10, 20, 20);
    deps.ticker.tick(2000);

    fx.onAbility('firestorm', 80, 90, 300, 120);
    deps.ticker.tick(120); // enter authored firestorm@1 / runtime frame 2.
    const fans = scene.sprites.filter((sprite) =>
      sprite.writes[0] === 'v2trp_direwyvern_t1_fx/v2_direwyvern_fx_firestorm_t1_f1',
    );
    expect(fans).toHaveLength(1);
    expect(fans[0]).toMatchObject({ active: true });
    expect(Number.isFinite(fans[0]!.rotation)).toBe(true);
    deps.ticker.tick(400);
    expect(scene.sprites.filter((sprite) =>
      sprite.writes[0] === 'v2trp_direwyvern_t1_fx/v2_direwyvern_fx_firestorm_t1_f1',
    )).toHaveLength(1);
  });

  it('renders both authored Direwyvern maul wing impacts from one cue', () => {
    const deps = manifestDeps('direwyvern');
    deps.clips.v2_fx_impact_slam_t1 = {
      frames: 4, rows: 1, cellW: 48, cellH: 48,
      anchorPx: [24, 24], fps: 16, loop: false,
    };
    const scene = new FakeScene();
    const fx = new V2TroopFx(scene as never, deps, 10, 20, 20);
    deps.ticker.tick(2000);

    fx.onAbility('maul', 80, 90);
    deps.ticker.tick(180); // authored impact_slam@2 → runtime frame 3.
    expect(scene.images.filter((image) =>
      image.writes[0] === 'v2trp_direwyvern_t1_fx/v2_direwyvern_fx_impact_slam_t1_f1',
    )).toHaveLength(1);
    const secondWing = scene.delayedConfigs.find((timer) =>
      Math.abs(timer.delay - (1000 / 12)) < 0.001,
    );
    expect(secondWing).toBeDefined();
    secondWing!.callback();
    expect(scene.images.filter((image) =>
      image.writes[0] === 'v2trp_direwyvern_t1_fx/v2_direwyvern_fx_impact_slam_t1_f1',
    )).toHaveLength(2);
  });

  it('cancels Direwyvern maul transients when a replay stream is replaced', () => {
    const deps = manifestDeps('direwyvern');
    deps.clips.v2_fx_impact_slam_t1 = {
      frames: 4, rows: 1, cellW: 48, cellH: 48,
      anchorPx: [24, 24], fps: 16, loop: false,
    };
    const scene = new FakeScene();
    const fx = new V2TroopFx(scene as never, deps, 10, 20, 20);
    deps.ticker.tick(2000);

    fx.onAbility('maul', 80, 90);
    deps.ticker.tick(180);
    const firstImpact = scene.images.find((image) =>
      image.writes[0] === 'v2trp_direwyvern_t1_fx/v2_direwyvern_fx_impact_slam_t1_f1',
    )!;
    const secondWing = scene.delayedConfigs.find((timer) =>
      Math.abs(timer.delay - (1000 / 12)) < 0.001,
    )!;

    fx.cancelReplayAction();

    expect(secondWing.removed).toBe(true);
    expect(firstImpact.active).toBe(false);
    if (!secondWing.removed) secondWing.callback();
    expect(scene.images.filter((image) =>
      image.writes[0] === 'v2trp_direwyvern_t1_fx/v2_direwyvern_fx_impact_slam_t1_f1',
    )).toHaveLength(1);
  });

  it('switches Hexbarrow to damaged art and releases hexshot from its muzzle once', () => {
    const deps = manifestDeps('hexbarrow');
    const scene = new FakeScene();
    const fx = new V2TroopFx(scene as never, deps, 10, 20, 20);
    deps.ticker.tick(2000);

    fx.onHit(0.49);
    deps.ticker.tick(400);
    expect(scene.sprites[0]!.writes.at(-1)).toContain('_damaged_');
    expect(fx.rangedProjectile).toBe('hexshot');

    const releases: Array<{ x: number; y: number }> = [];
    fx.onRangedAttack(200, 20, (at) => releases.push(at));
    deps.ticker.tick(250);
    expect(releases).toHaveLength(1);
    expect(releases[0]).not.toEqual({ x: fx.sprite.x, y: fx.sprite.y });
    deps.ticker.tick(2000);
    expect(releases).toHaveLength(1);
  });

  it('restores Hexbarrow damage at exactly half HP without a hit flinch and retains it after healing', () => {
    const deps = manifestDeps('hexbarrow');
    const scene = new FakeScene();
    const fx = new V2TroopFx(scene as never, deps, 10, 20, 20);
    deps.ticker.tick(2000);
    fx.syncHealth(0.5);
    deps.ticker.tick(400);
    expect(scene.sprites[0]!.writes.at(-1)).toContain('_damaged_');
    fx.syncHealth(1);
    deps.ticker.tick(400);
    expect(scene.sprites[0]!.writes.at(-1)).toContain('_damaged_');
    expect(scene.delayedConfigs).toHaveLength(0);
  });

  it('persistent health hydration cannot flinch an ordinary troop or interrupt Hexbarrow fire', () => {
    const ordinaryDeps = manifestDeps('bowman');
    const ordinaryScene = new FakeScene();
    const ordinary = new V2TroopFx(ordinaryScene as never, ordinaryDeps, 10, 20, 20);
    ordinaryDeps.ticker.tick(2000);
    ordinary.syncHealth(0.1);
    ordinaryDeps.ticker.tick(50);
    expect(ordinaryScene.sprites[0]!.writes.at(-1)).not.toContain('_hit_');
    const deps = manifestDeps('hexbarrow');
    const scene = new FakeScene();
    const fx = new V2TroopFx(scene as never, deps, 10, 20, 20);
    deps.ticker.tick(2000);
    let releases = 0;
    fx.onRangedAttack(200, 20, () => { releases++; });
    fx.syncHealth(0.49);
    deps.ticker.tick(250);
    expect(releases).toBe(1);
    deps.ticker.tick(2000);
    expect(scene.sprites[0]!.writes.at(-1)).toContain('_damaged_');
    expect(releases).toBe(1);
  });

  it('selects the deterministic Barrowling variant column block', () => {
    const deps = manifestDeps('barrowling');
    deps.variant = 3;
    const scene = new FakeScene();

    new V2TroopFx(scene as never, deps, 10, 20, 20);

    expect(scene.sprites[0]!.writes[0]).toContain('_spawn_d0_f13');
  });

  it('uses the protected current-pack one-piece breath at point-blank range', () => {
    const deps = manifestDeps('dragon');
    deps.clips.v2_fx_breath_t1 = {
      frames: 4, rows: 1, cellW: 96, cellH: 72,
      anchorPx: [10, 36], fps: 12, loop: true,
    };
    const scene = new FakeScene();
    const fx = new V2TroopFx(scene as never, deps, 10, 20, 20);
    deps.ticker.tick(2000);
    const bodyMark = scene.sprites[0]!.writes.length;

    fx.onBreath(85, 20); // 75px from the actor ground point: below minRange 80.
    deps.ticker.tick(350); // enter authored breath frame 4 / first breath cue.

    expect(scene.sprites[0]!.writes.slice(bodyMark).some((frame) => frame.includes('_breath_')))
      .toBe(true);
    const breath = scene.images.find((image) =>
      image.writes[0] === 'v2fx/v2_fx_breath_t1_f1',
    );
    expect(breath).toBeDefined();
    expect([breath!.originX, breath!.originY]).toEqual([10 / 96, 36 / 72]);
    expect(Number.isFinite(breath!.rotation)).toBe(true);
    expect(scene.images.some((image) =>
      image.writes.some((frame) => frame.startsWith('fx/fx_breath_dragon')),
    )).toBe(false);
  });

  it.each([
    'highlander', 'bowman', 'kegrunner', 'tunneler', 'turrider',
    'plunderer', 'troll', 'mage', 'bilgewraith',
  ] as const)('%s reaches its authored battle locomotion, hit, and death sheets', (unit) => {
    const moveDeps = manifestDeps(unit);
    const moveScene = new FakeScene();
    const moving = new V2TroopFx(moveScene as never, moveDeps, 10, 20, 20);
    moveDeps.ticker.tick(2000); // optional spawn → standing
    const moveMark = moveScene.sprites[0]!.writes.length;
    moving.onPos(200, 20, 500);
    moveDeps.ticker.tick(100);
    const profile = V2_TROOP_PROFILES[unit] as V2TroopProfile;
    const moveState = profile.battleMove ?? profile.move;
    expect(moveScene.sprites[0]!.writes.slice(moveMark)
      .some((frame) => frame.includes(`_${moveState}_`))).toBe(true);
    moving.onDeath();
    moveDeps.ticker.tick(2000);
    expect(moveScene.sprites[0]!.writes.some((frame) =>
      frame.includes(`_${profile.death}_`),
    )).toBe(true);

    const hitDeps = manifestDeps(unit);
    const hitScene = new FakeScene();
    const hit = new V2TroopFx(hitScene as never, hitDeps, 10, 20, 20);
    hitDeps.ticker.tick(2000);
    hit.onHit();
    hitDeps.ticker.tick(500);
    expect(hitScene.sprites[0]!.writes.some((frame) => frame.includes('_hit_'))).toBe(true);
  });

  it('does not turn an ordinary early Kegrunner death into a detonation', () => {
    const ordinary = runtime('kegrunner');
    ordinary.fx.onDeath();
    ordinary.deps.ticker.tick(5000);
    // The pack has no separate body-death sheet, so the detonate body frames
    // may provide the collapse. The gameplay-significant blast must not fire.
    expect(ordinary.sprite.writes.some((frame) => frame.includes('_detonate_'))).toBe(true);
    expect(ordinary.scene.images.some((image) =>
      image.writes[0]!.includes('v2_fx_keg_blast_t1'),
    )).toBe(false);

    const explicit = runtime('kegrunner');
    let callbacks = 0;
    explicit.fx.onDetonate(() => { callbacks++; });
    explicit.deps.ticker.tick(5000);
    expect(callbacks).toBe(1);
    expect(explicit.scene.images.some((image) =>
      image.writes[0]!.includes('v2_fx_keg_blast_t1'),
    )).toBe(true);
  });

  it('plays the authored Keg Runner prime loop before an explicit detonation', () => {
    const h = runtime('kegrunner');
    const mark = h.sprite.writes.length;

    h.fx.onPrime();
    h.deps.ticker.tick(250);

    expect(h.sprite.writes.slice(mark).some((frame) => frame.includes('_prime_'))).toBe(true);
  });

  it('cancels Keg Runner anticipation when a replacement replay stream arrives', () => {
    const h = runtime('kegrunner');
    h.fx.onPrime();
    const primeMark = h.sprite.writes.length;

    h.fx.cancelPrime();
    h.fx.onPos(80, 20, 100);
    h.deps.ticker.tick(100);

    expect(h.sprite.writes.slice(primeMark).some((frame) => frame.includes('_run_'))).toBe(true);
  });

  it('plays Troll sweep for troop cues and pound plus impact for structure cues', () => {
    const deps = manifestDeps('troll');
    deps.clips.v2_fx_sweep_t1 = {
      frames: 2, rows: 1, cellW: 64, cellH: 64,
      anchorPx: [32, 32], fps: 12, loop: false,
    };
    deps.clips.v2_fx_impact_slam_t1 = {
      frames: 2, rows: 1, cellW: 64, cellH: 64,
      anchorPx: [32, 32], fps: 12, loop: false,
    };
    const scene = new FakeScene();
    const fx = new V2TroopFx(scene as never, deps, 10, 20, 20);
    deps.ticker.tick(2000);

    fx.onMeleeAttack('troop', 200, 20);
    deps.ticker.tick(350);
    expect(scene.sprites[0]!.writes.some((frame) => frame.includes('_attack_'))).toBe(true);
    expect(scene.images.some((image) => image.writes[0]!.includes('v2_fx_sweep_t1'))).toBe(true);

    fx.onMeleeAttack('building', 220, 20);
    deps.ticker.tick(300);
    expect(scene.sprites[0]!.writes.some((frame) => frame.includes('_pound_'))).toBe(true);
    expect(scene.images.some((image) =>
      image.writes[0]!.includes('v2_fx_impact_slam_t1'),
    )).toBe(true);

    // A target can fall less than one authored pound later. The next server
    // position must interrupt this cosmetic verb instead of being discarded.
    fx.onPos(260, 20, 500);
    deps.ticker.tick(100);
    expect(scene.sprites[0]!.writes.at(-1)).toContain('_pound_');
    deps.ticker.tick(1000);
    expect(scene.sprites[0]!.writes.at(-1)).toContain('_walk_');
  });

  it('keeps a pre-armed v5 Troll idle until its first target-aware cue', () => {
    const currentDeps = manifestDeps('troll');
    currentDeps.meleeDriven = true;
    const currentScene = new FakeScene();
    const current = new V2TroopFx(currentScene as never, currentDeps, 10, 20, 20);
    current.setNearestBuildingFn(() => ({ x: 200, y: 20 }));
    currentDeps.ticker.tick(2000);
    expect(currentScene.sprites[0]!.writes.some((frame) => frame.includes('_attack_'))).toBe(false);
    expect(currentScene.sprites[0]!.writes.some((frame) => frame.includes('_pound_'))).toBe(false);

    const oldDeps = manifestDeps('troll');
    const oldScene = new FakeScene();
    const old = new V2TroopFx(oldScene as never, oldDeps, 10, 20, 20);
    old.setNearestBuildingFn(() => ({ x: 200, y: 20 }));
    oldDeps.ticker.tick(2000);
    expect(oldScene.sprites[0]!.writes.some((frame) => frame.includes('_attack_'))).toBe(true);

    const replacementMark = oldScene.sprites[0]!.writes.length;
    old.setMeleeDriven();
    expect(oldScene.sprites[0]!.writes.at(-1)).toContain('_idle_');
    oldDeps.ticker.tick(2000);
    expect(oldScene.sprites[0]!.writes.slice(replacementMark)
      .some((frame) => frame.includes('_attack_') || frame.includes('_pound_'))).toBe(false);
  });

  it('cancels the terminal burrow tween and surfaces at the exact v5 exit point', () => {
    const deps = manifestDeps('tunneler');
    const scene = new FakeScene();
    const fx = new V2TroopFx(scene as never, deps, 10, 20, 20);
    deps.ticker.tick(2000);
    fx.onBurrow();
    deps.ticker.tick(2000);
    fx.onPos(90, 120, 500);

    fx.onEmerge(90, 120);

    expect(scene.killedTweens).toContain(fx.sprite);
    expect(fx.sprite).toMatchObject({ x: 90, y: 120, depth: WORLD_DEPTH.actor + 120 });
    deps.ticker.tick(100);
    expect(scene.sprites[0]!.writes.at(-1)).toContain('_surface_');
  });

  it('materializes persisted burrow and emerge states without replaying old transitions', () => {
    const deps = manifestDeps('tunneler');
    const scene = new FakeScene();
    const fx = new V2TroopFx(scene as never, deps, 10, 20, 20);
    deps.ticker.tick(2_000);
    const before = scene.tweenConfigs.length;

    fx.seekBurrowed();
    expect(scene.sprites[0]!.writes.at(-1)).toContain('_tunnel_');
    fx.snapPosition(90, 120);
    fx.seekEmerged(90, 120);

    expect(scene.tweenConfigs).toHaveLength(before);
    expect(scene.sprites[0]!.writes.at(-1)).toContain('_idle_');
    expect(fx.sprite).toMatchObject({ x: 90, y: 120 });
  });

  it('snaps a moving Dragon to a seek endpoint without scheduling a zero-duration tween', () => {
    const deps = manifestDeps('dragon');
    const scene = new FakeScene();
    const fx = new V2TroopFx(scene as never, deps, 10, 20, 20);
    deps.ticker.tick(2_000);
    fx.onPos(90, 120, 500);
    const beforeSeek = scene.tweenConfigs.length;

    fx.snapPosition(240, 180);

    expect(scene.tweenConfigs).toHaveLength(beforeSeek);
    expect(scene.killedTweens.at(-1)).toBe(fx.sprite);
    expect(fx.sprite).toMatchObject({ x: 240, y: 180, depth: WORLD_DEPTH.actor + 180 });
  });

  it('settles an elapsed cold-seek Dragon deploy on hover instead of replaying spawn', () => {
    const deps = manifestDeps('dragon');
    const scene = new FakeScene();
    const fx = new V2TroopFx(scene as never, deps, 10, 20, 20);
    expect(scene.sprites[0]!.writes.at(-1)).toContain('_spawn_');
    fx.finishSeek();
    expect(scene.sprites[0]!.writes.at(-1)).toContain('_hover_');
  });

  it('queues an overlapping legacy Mage cue until the first complete cast ends', () => {
    const h = runtime('mage');
    let first = 0;
    let second = 0;

    h.fx.onRangedAttack(200, 20, () => { first++; });
    h.deps.ticker.tick(500);
    expect({ first, second }).toEqual({ first: 1, second: 0 });

    const restartMark = h.sprite.writes.length;
    h.fx.onRangedAttack(210, 20, () => { second++; });
    expect(h.sprite.writes.slice(restartMark)).toEqual([]);
    h.deps.ticker.tick(200);
    expect(h.sprite.writes.slice(restartMark).at(-1)).toContain('_cast_');
    expect(h.sprite.writes.slice(restartMark).at(-1)).toContain('_f1');
    h.deps.ticker.tick(500);

    // No third cue is needed to settle an orphaned callback, and completing
    // the restarted cast cannot release either authoritative shot again.
    expect({ first, second }).toEqual({ first: 1, second: 1 });
    h.deps.ticker.tick(10_000);
    expect({ first, second }).toEqual({ first: 1, second: 1 });
  });

  it('cancels an interrupted queued Mage cast before its release frame', () => {
    const h = runtime('mage');
    let first = 0;
    let second = 0;

    h.fx.onRangedAttack(200, 20, () => { first++; });
    h.deps.ticker.tick(500);
    h.fx.onRangedAttack(210, 20, () => { second++; });
    h.deps.ticker.tick(200); // before runtime frame 5 / the authored bolt cue.
    h.fx.onDeath();
    h.deps.ticker.tick(10_000);

    expect({ first, second }).toEqual({ first: 1, second: 0 });
  });

  it('cancels an unfinished second Mage cast during teardown without a late shot', () => {
    const h = runtime('mage');
    let first = 0;
    let second = 0;

    h.fx.onRangedAttack(200, 20, () => { first++; });
    h.deps.ticker.tick(500);
    h.fx.onRangedAttack(210, 20, () => { second++; });
    h.deps.ticker.tick(200);
    h.fx.destroy();
    h.deps.ticker.tick(10_000);

    expect({ first, second }).toEqual({ first: 1, second: 0 });
  });

  it.each(['bowman', 'mage'] as const)(
    'cancels %s ranged fire when death interrupts before release',
    (unit) => {
      const h = runtime(unit);
      const releases: Array<{ x: number; y: number }> = [];
      h.fx.onRangedAttack(200, 20, (at) => { releases.push(at); });
      expect(releases).toEqual([]); // draw/cast has started; cue has not fired.
      h.fx.onDeath();
      expect(releases).toEqual([]);
      h.deps.ticker.tick(10_000);
      expect(releases).toHaveLength(0); // interrupted ticker cannot release later.
    },
  );

  it.each(['bowman', 'mage'] as const)(
    'cancels %s ranged fire when scene teardown interrupts before release',
    (unit) => {
      const h = runtime(unit);
      const releases: Array<{ x: number; y: number }> = [];
      h.fx.onRangedAttack(200, 20, (at) => { releases.push(at); });

      h.fx.destroy();
      h.deps.ticker.tick(10_000);

      expect(releases).toEqual([]);
    },
  );
});

describe('destroyed controller callbacks', () => {
  it('cancels movement before destroying a replaced/catch-up actor and fences an already queued completion', () => {
    const scene = new FakeScene();
    const deps = runtimeDeps('mage');
    const fx = new V2TroopFx(scene as never, deps, 0, 0, 0);
    deps.ticker.tick(1_000); // finish spawn before the first moving segment
    fx.onPos(100, 100, 500);
    const completion = scene.tweenConfigs.at(-1)?.onComplete;
    expect(completion).toBeDefined();
    const sprite = fx.sprite as unknown as FakeSprite;
    const setTexture = sprite.setTexture.bind(sprite);
    sprite.setTexture = (atlas, frame) => {
      // Phaser clears sprite.scene during destroy. This reproduces the real
      // setTexture failure rather than letting a permissive fake hide it.
      if (!sprite.active) throw new TypeError("Cannot read properties of undefined (reading 'sys')");
      return setTexture(atlas, frame);
    };
    fx.destroy();
    expect(() => completion!()).not.toThrow();
    expect(fx.alive).toBe(false);
    expect(scene.killedTweens.at(-1)).toBe(fx.sprite);
    expect(deps.ticker.size).toBe(0);
  });
});
