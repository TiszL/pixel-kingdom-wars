/**
 * The base view's legacy ambience boundary. M22's WARE controllers own the
 * full Mine/Gold Forge/Alchemy Lab/Archer/Tesla/Mage/Laser/Dragon Nest bodies,
 * so AmbienceLayer must never add their superseded work-frame copies. Cannon
 * retains its legacy swap and Mortar retains its protected V2 pair; altars keep
 * their independent pulse. Missing-frame requests fail silently in Phaser, so
 * this boundary is pinned against both behavior and generated metadata.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  ATLAS_PREFIXES, B13_DEFENCES, V2_BUILDING_FALLBACKS, isRetiredRuntimeSpriteKey,
  wareBuildingAliasKey, wareBuildingIdleFrameKey, v2BuildingFallbackFrameKey,
  structureDepth, WORLD_DEPTH,
} from '@shardkeep/shared';
import { describe, expect, it, vi } from 'vitest';
import { AnimTicker } from '../anim';
import { v2BldSeat, type V2ClipMap } from '../v2/clips';
import { AmbienceLayer } from './ambience';
import type { MetaMap } from '../scenes/BootScene';
import type { BaseStateDto } from '../../state/store';

/**
 * ambience.ts reaches the atlas rule through BootScene's thin re-export, and
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

/** These historical ambience owners moved wholly to WARE controllers. */
type B13Defence = (typeof B13_DEFENCES)[number];
const WARE_RETIRED_DEFENCES = B13_DEFENCES.filter(
  (type): type is Exclude<B13Defence, 'cannon' | 'mortar'> => type !== 'cannon' && type !== 'mortar',
);
const WARE_RETIRED_AMBIENCE = [
  ...WARE_RETIRED_DEFENCES,
  'mine', 'goldforge', 'forge',
] as const;

/** No retired family is offered to idleSeq's legacy metadata probe. */
const FIXTURE_META: MetaMap = {};

/**
 * Mirror of the v2 building clips this layer seats from — the cell + anchor every
 * cannon/mortar atlas in the pack ships (112×120 at (56,104), pinned against the
 * real meta.json in v2/clips.test.ts). Handwritten so the behavioural half stays
 * runnable without generated output, exactly like FIXTURE_META.
 */
const V2_CLIPS: V2ClipMap = Object.fromEntries(
  ['cannon', 'mortar'].flatMap((u) => [1, 2, 3, 4].map((t) => [
    `v2_bld_${u}_t${t}_idle`,
    { frames: 2, rows: 8, cellW: 112, cellH: 120, anchorPx: [56, 104] as [number, number], fps: 3, loop: true },
  ])),
);

type Building = BaseStateDto['buildings'][number];
interface Registered { atlas: string; seq: string[] }

/** Just enough of the Phaser sprite surface for the layer to run, recording the
 *  atlas/frame each sprite was created against and its live visibility (the
 *  D3 hide/show seam below is bookkeeping on exactly this flag). */
class FakeSprite {
  active = true;
  visible = true;
  /** Cell height of the fixture clips (112×120); every v2 building in the pack
   *  ships the same cell. The seat is the sprite's BOTTOM EDGE on the
   *  footprint's south edge, so a fake with no drawn height cannot be seated. */
  height = 120;
  get displayHeight(): number { return this.height * this.scale; }
  /** Geometry the layer applied — the F3 seam is that the animated COPY must
   *  land exactly where BaseScene puts the static sprite. */
  origin: [number, number] = [0.5, 1];
  pos: [number, number] = [0, 0];
  scale = 1;
  depth = 0;
  textureWrites: Array<[string, string]> = [];
  texture: { key: string };
  frame: { name: string };
  constructor(public atlas: string, frame: string) {
    this.texture = { key: atlas };
    this.frame = { name: frame };
  }
  setOrigin(x: number, y: number): this { this.origin = [x, y]; return this; }
  setPosition(x: number, y: number): this { this.pos = [x, y]; return this; }
  setDepth(d: number): this { this.depth = d; return this; }
  setScale(s: number): this { this.scale = s; return this; }
  setAlpha(): this { return this; }
  setTexture(atlas: string, frame: string): this {
    this.textureWrites.push([atlas, frame]);
    this.atlas = atlas;
    this.texture.key = atlas;
    this.frame.name = frame;
    return this;
  }
  setVisible(v: boolean): this { this.visible = v; return this; }
  once(): this { return this; }
  destroy(): void { this.active = false; }
}

const bld = (id: string, type: string, level: number, underConstruction = false): Building =>
  ({ id, type, level, tx: 10, ty: 10, underConstruction });

/** Mirrors BaseScene.spriteKeyFor for the types these fixtures use. */
const keyOf = (b: Building): string =>
  (b.type === 'heroaltar' || b.type === 'siegestool')
    ? `bld_${b.type}`
    : `bld_${b.type}_l${Math.min(20, b.level)}`;

function syncBase(buildings: Building[], busyIds: ReadonlySet<string> = new Set()): {
  added: FakeSprite[];
  registered: Registered[];
  layer: AmbienceLayer;
  resync: () => void;
} {
  const added: FakeSprite[] = [];
  const registered: Registered[] = [];
  const scene = {
    add: {
      sprite: (_x: number, _y: number, atlas: string, frame: string) => {
        const sp = new FakeSprite(atlas, frame);
        added.push(sp);
        return sp;
      },
    },
  } as never as Phaser.Scene;
  const ticker = new AnimTicker();
  vi.spyOn(ticker, 'register').mockImplementation((_sp, atlas, seq) => {
    registered.push({ atlas, seq });
  });
  const layer = new AmbienceLayer(scene, ticker, FIXTURE_META, T);
  const resync = (): void =>
    layer.sync(buildings, () => ({ fw: 1, fh: 1 }), keyOf, () => undefined, busyIds);
  resync();
  return { added, registered, layer, resync };
}

/** One of every ownership case: Cannon legacy, all retired WARE ambience types,
 * an under-construction Cannon, the altar, and buildings with no ambience. */
const FIXTURE: Building[] = [
  ...B13_DEFENCES.filter((d) => d !== 'mortar').map((d, i) => bld(`d${i}`, d, 20)),
  bld('scaffolded', 'cannon', 20, true),
  bld('e1', 'electrictower', 5),
  bld('m1', 'mine', 7),
  bld('g1', 'goldforge', 7),
  bld('f1', 'forge', 7),
  bld('a1', 'heroaltar', 1),
  bld('k1', 'keep', 3),
  bld('c1', 'camp', 2),
  bld('w1', 'wall', 1),
];

describe('base ambience idle loop', () => {
  const { added, registered } = syncBase(FIXTURE);

  it('splits WARE-owned visuals from Cannon legacy and Mortar V2 ambience', () => {
    expect(WARE_RETIRED_DEFENCES).toEqual([
      'archertower', 'magetower', 'lasertower', 'dragonnest', 'electrictower',
    ]);
    expect(WARE_RETIRED_AMBIENCE).toHaveLength(8);
    expect(B13_DEFENCES).toContain('cannon');
    expect(B13_DEFENCES).toContain('mortar');
  });

  it('animates exactly the legacy owners that remain in this layer', () => {
    // Exact equality catches an omitted current owner, an atlas drift, and any
    // accidental reintroduction of a superseded WARE work-frame copy.
    expect(registered).toEqual([
      {
        atlas: 'blddef',
        seq: ['bld_cannon_l20', 'bld_cannon_l20_work_f1'],
      },
      {
        atlas: 'bld',
        seq: ['bld_heroaltar', 'bld_heroaltar_work_f1'],
      },
    ]);
  });

  it('never registers superseded work-frame swaps for a WARE-owned building', () => {
    const frames = registered.flatMap((entry) => entry.seq);
    for (const type of WARE_RETIRED_AMBIENCE) {
      expect(frames.some((frame) => frame.startsWith(`bld_${type}_`)), type).toBe(false);
    }
  });

  it('leaves Tesla animation wholly to its WARE controller at every represented level', () => {
    for (const l of [5, 20]) {
      const key = `bld_electrictower_l${l}`;
      expect(registered.flatMap((entry) => entry.seq).some((frame) => frame.startsWith(key))).toBe(false);
    }
    expect(added.some((sprite) => sprite.frame.name.startsWith('bld_electrictower'))).toBe(false);
  });

  it('leaves Mine, Gold Forge, and Alchemy presentation to WARE controllers', () => {
    const frames = registered.flatMap((entry) => entry.seq);
    for (const t of ['mine', 'goldforge', 'forge']) {
      expect(frames.some((frame) => frame.startsWith(`bld_${t}_`)), t).toBe(false);
      expect(added.some((sprite) => sprite.frame.name.startsWith(`bld_${t}_`)), t).toBe(false);
    }
  });

  it('skips a legacy defence that is still under construction', () => {
    // The fixture holds two L20 Cannons; only the finished one may animate,
    // or the idle loop would play over its own scaffold.
    expect(registered.filter((entry) => entry.seq[0] === 'bld_cannon_l20')).toHaveLength(1);
  });

  it('plays the rework-v2 cannon/mortar idle pair once BaseScene keys them by v2 frames', () => {
    // BaseScene.spriteKeyFor swaps to `v2_bld_<unit>_t<n>_idle_d0_f1` ONLY
    // when the tier atlas is loaded, so this layer never gates — it just must
    // build the pair (idle is 2 frames at every tier, pinned in the v2
    // clips.test ground-truth block) instead of probing meta for a
    // `_work_f1` sibling that exists nowhere and would blink the tower out.
    const added: FakeSprite[] = [];
    const registered: Registered[] = [];
    const scene = {
      add: {
        sprite: (_x: number, _y: number, atlas: string, frame: string) => {
          const sp = new FakeSprite(atlas, frame);
          added.push(sp);
          return sp;
        },
      },
    } as never as Phaser.Scene;
    const ticker = new AnimTicker();
    vi.spyOn(ticker, 'register').mockImplementation((_sp, atlas, seq) => {
      registered.push({ atlas, seq });
    });
    const layer = new AmbienceLayer(scene, ticker, FIXTURE_META, T, V2_CLIPS);
    const v2KeyOf = (b: Building): string =>
      (b.type === 'cannon' ? 'v2_bld_cannon_t2_idle_d0_f1' : 'v2_bld_mortar_t4_idle_d0_f1');
    layer.sync(
      [bld('c9', 'cannon', 7), bld('m9', 'mortar', 20)],
      () => ({ fw: 1, fh: 1 }), v2KeyOf, () => undefined,
    );
    expect(registered).toEqual([
      { atlas: 'v2bld_cannon_t2', seq: ['v2_bld_cannon_t2_idle_d0_f1', 'v2_bld_cannon_t2_idle_d0_f2'] },
      { atlas: 'v2bld_mortar_t4', seq: ['v2_bld_mortar_t4_idle_d0_f1', 'v2_bld_mortar_t4_idle_d0_f2'] },
    ]);
    // …and the sprites themselves were created against the per-tier groups
    // (the shared grouping rule), never against `blddef`.
    expect(added.map((s) => s.atlas)).toEqual(['v2bld_cannon_t2', 'v2bld_mortar_t4']);
  });

  it('animates every eager Mortar tier from the exact-current fallback pair', () => {
    const added: FakeSprite[] = [];
    const registered: Registered[] = [];
    const scene = {
      add: {
        sprite: (_x: number, _y: number, atlas: string, frame: string) => {
          const sp = new FakeSprite(atlas, frame);
          added.push(sp);
          return sp;
        },
      },
    } as never as Phaser.Scene;
    const ticker = new AnimTicker();
    vi.spyOn(ticker, 'register').mockImplementation((_sp, atlas, seq) => {
      registered.push({ atlas, seq });
    });
    const layer = new AmbienceLayer(scene, ticker, FIXTURE_META, T, V2_CLIPS);
    const tiers = [1, 2, 3, 4];
    layer.sync(
      tiers.map((tier) => bld(`m${tier}`, 'mortar', (tier - 1) * 5 + 1)),
      () => ({ fw: 2, fh: 2 }),
      (building) => v2BuildingFallbackFrameKey(
        'mortar', Math.floor((building.level - 1) / 5) + 1, 1,
      ),
      () => undefined,
    );

    expect(registered).toEqual(tiers.map((tier) => ({
      atlas: 'v2fallback',
      seq: [
        v2BuildingFallbackFrameKey('mortar', tier, 1),
        v2BuildingFallbackFrameKey('mortar', tier, 2),
      ],
    })));
    expect(added.every((sprite) => sprite.atlas === 'v2fallback')).toBe(true);
    expect(added.every((sprite) => !/^bld_mortar_/.test(sprite.frame.name))).toBe(true);
  });

  /**
   * K-031 (owner 2026-08-16: untrained wyverns blink on base load). When
   * idleSeq's eager-fallback branch matched Mortar ALONE, Cannon's fallback key
   * fell through to the `_work_f1` house swap, fabricating a sibling frame the
   * v2fallback atlas does not contain. Phaser 4 resolves a missing frame to the
   * texture's FIRST frame — `v2_fallback_direwyvern_t1` in that atlas — so the
   * cannon's animated copy alternated cannon ⇄ Direwyvern at the shared 260ms
   * tick until the rich atlas landed (cold start AND post-battle wake, when
   * releaseV2DefenseArtForBattle re-keys towers to this same fallback). The
   * eager pair must register for EVERY fallback unit, not one.
   */
  it('animates every eager Cannon tier from the exact-current fallback pair (K-031)', () => {
    const added: FakeSprite[] = [];
    const registered: Registered[] = [];
    const scene = {
      add: {
        sprite: (_x: number, _y: number, atlas: string, frame: string) => {
          const sp = new FakeSprite(atlas, frame);
          added.push(sp);
          return sp;
        },
      },
    } as never as Phaser.Scene;
    const ticker = new AnimTicker();
    vi.spyOn(ticker, 'register').mockImplementation((_sp, atlas, seq) => {
      registered.push({ atlas, seq });
    });
    const layer = new AmbienceLayer(scene, ticker, FIXTURE_META, T, V2_CLIPS);
    const tiers = [1, 2, 3, 4];
    layer.sync(
      tiers.map((tier) => bld(`c${tier}`, 'cannon', (tier - 1) * 5 + 1)),
      () => ({ fw: 1, fh: 1 }),
      (building) => v2BuildingFallbackFrameKey(
        'cannon', Math.floor((building.level - 1) / 5) + 1, 1,
      ),
      () => undefined,
    );

    expect(registered).toEqual(tiers.map((tier) => ({
      atlas: 'v2fallback',
      seq: [
        v2BuildingFallbackFrameKey('cannon', tier, 1),
        v2BuildingFallbackFrameKey('cannon', tier, 2),
      ],
    })));
    // The exact defect shape: no fabricated `_work_f1` sibling may ever be
    // asked of the v2fallback texture — that request RENDERS A DIREWYVERN.
    const frames = registered.flatMap((entry) => entry.seq);
    expect(frames.some((frame) => frame.includes('_work_'))).toBe(false);
  });

  /**
   * THE K-031 INVARIANT, pinned at the layer boundary: no frame may ever be
   * handed to a sprite or the AnimTicker unless the texture it will be drawn
   * from actually contains it — because Phaser 4 substitutes the texture's
   * first frame (here deliberately a Direwyvern still, mirroring the real
   * v2fallback pack order) for any miss. A loop whose fabricated sibling is
   * missing must degrade to the truthful still, loudly, never to another unit.
   */
  it('never asks a texture for a frame it does not contain (K-031 guard)', () => {
    const cannonStill = v2BuildingFallbackFrameKey('cannon', 2, 1);
    // f2 deliberately absent: the texture ships ONLY the still + wyvern bait.
    const textureFrames: Record<string, readonly string[]> = {
      v2fallback: ['v2_fallback_direwyvern_t1', cannonStill],
    };
    const added: FakeSprite[] = [];
    const registered: Registered[] = [];
    const scene = {
      add: {
        sprite: (_x: number, _y: number, atlas: string, frame: string) => {
          const sp = new FakeSprite(atlas, frame);
          added.push(sp);
          return sp;
        },
      },
      textures: {
        exists: (key: string) => key in textureFrames,
        get: (key: string) => ({ has: (f: string) => textureFrames[key]!.includes(f) }),
      },
    } as never as Phaser.Scene;
    const ticker = new AnimTicker();
    vi.spyOn(ticker, 'register').mockImplementation((_sp, atlas, seq) => {
      registered.push({ atlas, seq });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const layer = new AmbienceLayer(scene, ticker, FIXTURE_META, T, V2_CLIPS);
      layer.sync([bld('c1', 'cannon', 7)], () => ({ fw: 1, fh: 1 }), () => cannonStill, () => undefined);

      // Truthful still — the missing f2 was dropped, not substituted.
      expect(registered).toEqual([{ atlas: 'v2fallback', seq: [cannonStill] }]);
      // The invariant proper: every frame asked of a texture exists in it, so
      // Phaser's first-frame substitution (the phantom wyvern) is unreachable.
      const asked = [
        ...added.map((sprite) => [sprite.atlas, sprite.frame.name] as const),
        ...added.flatMap((sprite) => sprite.textureWrites.map(([a, f]) => [a, f] as const)),
        ...registered.flatMap((entry) => entry.seq.map((f) => [entry.atlas, f] as const)),
      ];
      for (const [atlas, frame] of asked) {
        expect(textureFrames[atlas], atlas).toBeDefined();
        expect(textureFrames[atlas]!.includes(frame), `${atlas}:${frame}`).toBe(true);
      }
      expect(asked.some(([, frame]) => frame.includes('direwyvern'))).toBe(false);
      // Fail loud (CLAUDE.md rule 12): the degradation is a console line, once.
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('re-keys a pooled same-ID Mortar through upgrade fallback and rich completion', () => {
    // WHY: AmbienceLayer pools by stable building id. Before this regression,
    // ensure() returned that pooled sprite without checking its texture, so an
    // upgrade/load transition could leave the previous tier visible until some
    // later animation write. Capture every real AnimTicker texture write: old
    // rich tier → exact-current next-tier fallback → rich next tier, never
    // the retired `bld_mortar_l<N>` family.
    const added: FakeSprite[] = [];
    const scene = {
      add: {
        sprite: (_x: number, _y: number, atlas: string, frame: string) => {
          const sp = new FakeSprite(atlas, frame);
          added.push(sp);
          return sp;
        },
      },
    } as never as Phaser.Scene;
    const ticker = new AnimTicker();
    const layer = new AmbienceLayer(scene, ticker, FIXTURE_META, T, V2_CLIPS);
    const mortar = bld('stable-id', 'mortar', 11);
    const richTiers = new Set([3]);
    const keyOfMortar = (building: Building): string => {
      const tier = Math.floor((building.level - 1) / 5) + 1;
      return richTiers.has(tier)
        ? `v2_bld_mortar_t${tier}_idle_d0_f1`
        : v2BuildingFallbackFrameKey('mortar', tier, 1);
    };
    const sync = (): void => layer.sync(
      [mortar], () => ({ fw: 2, fh: 2 }), keyOfMortar, () => undefined,
    );

    sync();
    mortar.level = 16;
    richTiers.delete(3);
    sync(); // t4 rich atlas absent: exact-current eager t4
    richTiers.add(3);
    sync(); // stale t3 completion is irrelevant to the now-t4 row
    richTiers.add(4);
    sync();

    expect(added).toHaveLength(1); // same id really exercised the pool
    const writes = added[0]!.textureWrites;
    expect(writes.map(([, frame]) => frame)).toEqual([
      'v2_bld_mortar_t3_idle_d0_f1',
      v2BuildingFallbackFrameKey('mortar', 4, 1),
      v2BuildingFallbackFrameKey('mortar', 4, 1),
      'v2_bld_mortar_t4_idle_d0_f1',
      'v2_bld_mortar_t4_idle_d0_f1',
    ]);
    expect(writes.every(([, frame]) => !isRetiredRuntimeSpriteKey(frame))).toBe(true);
    expect(added[0]!.atlas).toBe('v2bld_mortar_t4');
    expect(added[0]!.frame.name).toBe('v2_bld_mortar_t4_idle_d0_f1');
  });

  /**
   * THE GHOST SEAM. This copy is a FULL-SIZE overlay of the building sprite, so
   * any disagreement about where or how big that sprite is shows up as a doubled,
   * offset tower. v2 keys are absent from meta.sprites, and the old fallback
   * `meta[key]?.anchor ?? [0.5,1]` was therefore taken for every v2 building:
   * (0.5,1) instead of the published (56/112, 104/120), and scale 1 instead of
   * the tower's fitted ×1.25. Both invisible to a typecheck.
   *
   * Pinned against v2BldSeat — the SAME resolver BaseScene.positionBuilding
   * calls — rather than against re-typed numbers, because "one place decides" is
   * the actual invariant. Re-typing them here would let the two drift apart
   * again while this test kept passing.
   */
  it('seats the v2 idle copy exactly where BaseScene seats the static sprite', () => {
    const added: FakeSprite[] = [];
    const scene = {
      add: {
        sprite: (_x: number, _y: number, atlas: string, frame: string) => {
          const sp = new FakeSprite(atlas, frame);
          added.push(sp);
          return sp;
        },
      },
    } as never as Phaser.Scene;
    const ticker = new AnimTicker();
    vi.spyOn(ticker, 'register').mockImplementation(() => undefined);
    const layer = new AmbienceLayer(scene, ticker, FIXTURE_META, T, V2_CLIPS);
    const key = 'v2_bld_mortar_t4_idle_d0_f1';
    const fp = { fw: 2, fh: 2 };
    layer.sync([bld('m9', 'mortar', 20)], () => fp, () => key, () => undefined);

    const seat = v2BldSeat(V2_CLIPS, key)!;
    const sp = added[0]!;
    expect(sp.origin).toEqual([seat.origin[0], seat.origin[1]]);
    expect(sp.scale).toBe(seat.scale);
    // THE SEAT: the copy's drawn BOTTOM EDGE on the footprint's south edge —
    // ty=10, fh=2 → (10+2)×64 — less the 16 authored px of cell below the
    // (56,104) anchor, at the tower's fit. Never the footprint's middle row:
    // that was the seat that floated every pixel-anchored building above its
    // plot (owner 2026-08-30), and it would put this copy 64 px higher.
    expect(sp.pos).toEqual([
      (10 + fp.fw / 2) * T, (10 + fp.fh) * T - (120 - 104) * seat.scale,
    ]);
    expect(sp.pos[1]).toBeLessThan((10 + fp.fh) * T); // never vacuous: it IS lifted
    expect((10 + fp.fh) * T - sp.pos[1]).toBeLessThan(T / 2); // …but not by a row
    // Depth still rides the SOUTH edge (+1 to sit over the building), or the
    // copy would sort in front of whatever stands south of the tower — inside
    // the BUILDING band, because an animated work copy is still a building and
    // must not out-sort the troops walking past it (this copy re-added on every
    // sync is the exact reason the old walker bias existed).
    expect(sp.depth).toBe(structureDepth('building', (10 + fp.fh) * T) + 1);
    expect(sp.depth).toBeLessThan(WORLD_DEPTH.actor);
  });

  /** The retained Cannon legacy path stays bottom-anchored, unscaled, and
   * seated on the south edge. WARE Mine no longer creates a copy here. */
  it('leaves retained legacy Cannon ambience bottom-anchored at scale 1', () => {
    const { added } = syncBase([bld('c1', 'cannon', 5)]);
    const sp = added[0]!;
    expect(sp.origin).toEqual([0.5, 1]);
    expect(sp.scale).toBe(1);
    expect(sp.pos).toEqual([(10 + 0.5) * T, (10 + 1) * T]);
  });

  it('asks only for textures the boot loader actually fetches', () => {
    const eager = new Set<string>(ATLAS_PREFIXES);
    const asked = [...added.map((a) => a.atlas), ...registered.map((r) => r.atlas)];
    expect([...new Set(asked)].filter((a) => !eager.has(a))).toEqual([]);
  });
});

/**
 * D3 drag-ghost seam: BaseScene hides a building's ambience copies while its
 * hold-to-lift drag carries the static sprite (batch-13 review: "pre-existing
 * defect, amplified"; owner hit it live 2026-08-03 and read it as server lag).
 * These tests pin the layer's hide/show BOOKKEEPING — which sprites a building
 * id owns, exact-id matching, and the reveal-on-resync that the drop-confirm
 * path depends on. The drag wiring itself (pointermove/pointerup/pointercancel
 * /SLEEP in BaseScene) is Phaser input and is not unit-tested here.
 */
describe('drag-lift hide/show (D3)', () => {
  it('hides and shows the retained ambience owner — and only that owner', () => {
    // WARE buildings no longer mint loose ambience copies. Cannon and altar
    // remain useful sentinels for the drag bookkeeping that still exists.
    const { added, layer } = syncBase([bld('c1', 'cannon', 7), bld('a1', 'heroaltar', 1)]);
    layer.hide('c1');
    expect(added.map((s) => [s.frame.name, s.visible])).toEqual([
      ['bld_cannon_l7', false],
      ['bld_heroaltar', true],
    ]);
    layer.show('c1');
    expect(added.every((s) => s.visible)).toBe(true);
  });

  it('matches the owning id exactly — hiding id "1" must not hide id "11"', () => {
    // Keys are `amb:<tag>:<id>`; a suffix test would confuse these two.
    // Creation order follows building order, so added[0] is id "1".
    const { added, layer } = syncBase([bld('1', 'cannon', 7), bld('11', 'cannon', 7)]);
    layer.hide('1');
    expect(added.map((s) => s.visible)).toEqual([false, true]);
    layer.hide('11');
    expect(added.map((s) => s.visible)).toEqual([false, false]);
  });

  it('treats an id with no copies as a no-op (wall line drags call show too)', () => {
    const { added, layer } = syncBase([bld('c1', 'cannon', 7)]);
    layer.hide('some-wall');
    layer.show('some-wall');
    expect(added[0]!.visible).toBe(true);
  });

  it('reveals hidden copies on resync — the drop-confirm path has NO show() call', () => {
    // WHY: a confirmed move gets its truth from base:refresh. BaseScene leaves
    // the copy hidden across the whole server round trip (showing early would
    // repaint it at the OLD tile — the exact D3 ghost) and relies on sync()
    // to reposition AND reveal in one pass.
    const { added, layer, resync } = syncBase([bld('c1', 'cannon', 7)]);
    layer.hide('c1');
    expect(added[0]!.visible).toBe(false);
    resync();
    expect(added[0]!.visible).toBe(true);
    // The reveal only lands flicker-free because ensure() POOLED the sprite:
    // the resync reused the hidden instance rather than minting a fresh one.
    expect(added).toHaveLength(1);
  });
});

/** Generated ground truth for the M22 ownership split. This block deliberately
 * fails loudly when assets were not built: stale art routing is a release bug. */
describe('meta.json ground truth (requires built assets)', () => {
  const metaUrl = new URL('../../../public/atlas/meta.json', import.meta.url);
  if (!existsSync(metaUrl)) {
    throw new Error(
      'apps/web/public/atlas/meta.json is not built — run `pnpm assets` first. ' +
      'The ambience idle loop derives its frame sequences from this file, so ' +
      'these tests refuse to pass without it (deliberately loud, not skipped).',
    );
  }
  const meta = JSON.parse(readFileSync(metaUrl, 'utf8')) as {
    sprites: Record<string, unknown>;
    families: Record<string, { frames: string[]; pingpong: boolean; sequence: string[] }>;
    wareClips: Record<string, { frames: number; loop: boolean }>;
    currentArtAliases: Record<string, string>;
  };

  it('ships looping WARE idle clips for every retired ambience owner and level', () => {
    for (const type of WARE_RETIRED_AMBIENCE) {
      for (let level = 1; level <= 20; level++) {
        const frame = wareBuildingIdleFrameKey(type, level);
        const clipKey = frame.replace(/(?:_d0)?_f1$/, '');
        const clip = meta.wareClips[clipKey];
        expect(clip, clipKey).toBeDefined();
        expect(clip!.frames, `${clipKey} frames`).toBeGreaterThan(0);
        expect(clip!.loop, `${clipKey} loop`).toBe(true);
      }
    }
  });

  it('backs every legacy building key with an exact-current WARE eager alias', () => {
    for (const type of WARE_RETIRED_AMBIENCE) {
      for (let level = 1; level <= 20; level++) {
        const alias = wareBuildingAliasKey(type, level);
        expect(meta.currentArtAliases[alias], alias).toBe(wareBuildingIdleFrameKey(type, level));
        expect(meta.sprites[alias], `${alias} eager sprite`).toBeDefined();
      }
    }
  });

  it('removes obsolete WARE work/idle families while retaining current legacy owners', () => {
    for (const type of WARE_RETIRED_AMBIENCE) {
      for (let level = 1; level <= 20; level++) {
        const alias = wareBuildingAliasKey(type, level);
        expect(meta.sprites[`${alias}_work_f1`], `${alias}_work_f1`).toBeUndefined();
        expect(meta.sprites[`${alias}_f1`], `${alias}_f1`).toBeUndefined();
        expect(meta.families[alias], `${alias} family`).toBeUndefined();
      }
    }
    for (const key of ['bld_cannon_l20', 'bld_heroaltar', 'bld_siegestool']) {
      expect(meta.sprites[`${key}_work_f1`], `${key}_work_f1`).toBeDefined();
    }
  });

  /**
   * K-031 ground truth: idleSeq FABRICATES `..._idle_d0_f1/f2` names for every
   * eager building fallback, so both frames must actually be packed for every
   * unit and tier — a fabricated name the v2fallback atlas does not contain is
   * not invisible, it renders the atlas's first-packed frame, and this atlas
   * really does pack Direwyvern stills (the phantom the owner saw). Pinned
   * against the generated atlas JSON so a pipeline change that drops a frame
   * (or ships a 1-frame unit) fails here instead of on a live base.
   */
  it('packs both fabricated idle frames for every eager building fallback unit and tier', () => {
    const atlasUrl = new URL('../../../public/atlas/v2fallback@1x.json', import.meta.url);
    expect(existsSync(atlasUrl), 'v2fallback@1x.json missing — run `pnpm assets`').toBe(true);
    const atlas = JSON.parse(readFileSync(atlasUrl, 'utf8')) as {
      textures?: Array<{ frames: Array<{ filename: string }> }>;
      frames?: Record<string, unknown>;
    };
    const packed = new Set(
      atlas.textures?.[0]?.frames.map((frame) => frame.filename)
        ?? Object.keys(atlas.frames ?? {}),
    );
    for (const unit of Object.keys(V2_BUILDING_FALLBACKS) as Array<keyof typeof V2_BUILDING_FALLBACKS>) {
      for (let tier = 1; tier <= 4; tier++) {
        for (let frame = 1; frame <= V2_BUILDING_FALLBACKS[unit].frames; frame++) {
          const key = v2BuildingFallbackFrameKey(unit, tier, frame);
          expect(packed.has(key), key).toBe(true);
        }
      }
    }
    // The hazard is not hypothetical: the sheet the substitution would come
    // from packs wyvern stills, which is what "untrained wyverns blinking"
    // actually was.
    expect(packed.has('v2_fallback_direwyvern_t1')).toBe(true);
  });
});
