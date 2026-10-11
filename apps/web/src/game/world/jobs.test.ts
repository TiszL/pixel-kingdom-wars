import {
  AMBIENCE, ART_V2,
} from '@shardkeep/shared';
import type Phaser from 'phaser';
import { describe, expect, it, vi } from 'vitest';
import { type V2ClipMap } from '../v2/clips';
import { JobLayer, requiredBuilderAtlasGroups } from './jobs';

vi.mock('../scenes/BootScene', async () => {
  const { atlasGroupFor } = await import('@shardkeep/shared');
  return { atlasFor: atlasGroupFor };
});

const ROWS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'] as const;

function clips(): V2ClipMap {
  return Object.fromEntries(['idle', 'walk', 'work'].map(state => [`builder_${state}`, {
    frames: state === 'idle' ? 1 : state === 'walk' ? 8 : 6,
    rows: 8, cellW: 84, cellH: 84,
    rowOrder: ROWS, anchorPx: [42, 70],
    fps: state === 'walk' ? 10 : state === 'work' ? 8 : 1,
  }]));
}

interface Req { atlas: string; frame: string; sprite: FakeDisplay }

class FakeDisplay {
  active = true;
  x = 0;
  y = 0;
  width = 80;
  height = 20;
  originX = 0;
  originY = 0;
  scale = 0;
  text = '';
  setTextCalls = 0;
  setSizeCalls = 0;
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
  setOrigin(x: number, y: number): this { this.originX = x; this.originY = y; return this; }
  setScale(scale: number): this { this.scale = scale; return this; }
  setDepth(): this { return this; }
  setDisplaySize(): this { return this; }
  setStrokeStyle(): this { return this; }
  setPosition(x: number, y: number): this { this.x = x; this.y = y; return this; }
  setSize(width: number, height: number): this {
    this.setSizeCalls++;
    this.width = width; this.height = height;
    return this;
  }
  setText(text: string): this {
    this.setTextCalls++;
    this.text = text; this.width = text.length * 8;
    return this;
  }
  destroy(): void { this.active = false; }
}

function setup(v2clips: V2ClipMap, tilePx = 64): {
  layer: JobLayer;
  reqs: Req[];
  register: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
  unregisterV2: ReturnType<typeof vi.fn>;
  loaded: Set<string>;
  texts: FakeDisplay[];
} {
  const reqs: Req[] = [];
  const texts: FakeDisplay[] = [];
  const loaded = new Set<string>();
  const scene = {
    registry: { get: (key: string) => key === 'builderClips' ? v2clips : undefined },
    textures: { exists: (group: string) => loaded.has(group) },
    add: {
      sprite: (x: number, y: number, atlas: string, frame: string) => {
        const sprite = new FakeDisplay(x, y);
        reqs.push({ atlas, frame, sprite });
        return sprite;
      },
      rectangle: (x: number, y: number) => new FakeDisplay(x, y),
      text: (x: number, y: number) => { const display = new FakeDisplay(x, y); texts.push(display); return display; },
    },
  } as never as Phaser.Scene;
  const register = vi.fn();
  const ticker = { register, unregister: vi.fn() };
  const play = vi.fn();
  const unregisterV2 = vi.fn();
  const v2Ticker = { play, unregister: unregisterV2 };
  return {
    layer: new JobLayer(scene, ticker as never, v2Ticker as never, {}, tilePx),
    reqs, register, play, unregisterV2, loaded, texts,
  };
}

const job = {
  id: 'job', kind: 'upgrade', buildingId: 'target', obstacleId: null,
  startedAt: new Date(0).toISOString(), finishesAt: new Date(10_000).toISOString(),
};
const keep = { id: 'keep', type: 'keep', level: 6, tx: 4, ty: 4, underConstruction: false };
const target = { id: 'target', type: 'mine', level: 2, tx: 8, ty: 8, underConstruction: false };
const fp = (): { fw: number; fh: number } => ({ fw: 2, fh: 2 });
const key = (b: typeof keep): string => `bld_${b.type}`;

describe('accepted Workman builder', () => {
  it.each([[32, 6], [64, 12]])('keeps the hammer within reach of the scaffold at tile size %i', (tilePx, gap) => {
    const { layer, reqs, play, loaded } = setup(clips(), tilePx);
    loaded.add('builder');
    layer.sync([job] as never, [keep, target] as never, [], keep as never,
      () => ({ fw: 2, fh: 4 }), key as never);
    layer.update(2_000);
    const worker = reqs.find(r => r.atlas === 'builder')!.sprite;
    const scaffold = reqs.find(r => r.frame === 'fx_scaffold_f1')!.sprite;
    expect(scaffold.x - worker.x).toBe(gap);
    expect(worker.originY).toBe(70 / 84);
    expect(play).toHaveBeenLastCalledWith(worker, expect.objectContaining({
      seq: Array.from({ length: 6 }, (_, i) => `builder_work_d3_f${i + 1}`),
    })); // the hammer faces northeast toward the tall site's center
  });

  it('walks toward the site then works, using the shared foot anchor and authored frame cadence', () => {
    const { layer, reqs, register, play, loaded } = setup(clips());
    loaded.add('builder');
    layer.sync([job] as never, [keep, target] as never, [], keep as never, fp, key as never);
    const builder = reqs.find(r => r.atlas === 'builder')!;
    expect(builder.frame).toBe('builder_walk_d1_f1'); // southeast in PixelLab order
    expect(builder.sprite.originX).toBe(42 / 84);
    expect(builder.sprite.originY).toBe(70 / 84);
    expect(builder.sprite.scale).toBe(AMBIENCE.builderScale * 64 / 32);
    expect(play).toHaveBeenLastCalledWith(builder.sprite, expect.objectContaining({
      atlas: 'builder', base: 'builder_walk',
      seq: Array.from({ length: 8 }, (_, i) => `builder_walk_d1_f${i + 1}`), fps: 10, loop: true,
    }));
    layer.update(2_000);
    expect(play).toHaveBeenLastCalledWith(builder.sprite, expect.objectContaining({
      base: 'builder_work',
      seq: Array.from({ length: 6 }, (_, i) => `builder_work_d2_f${i + 1}`), fps: 8, loop: true,
    }));
    expect(reqs.every(r => r.frame.startsWith('builder_') || r.frame.startsWith('fx_scaffold_'))).toBe(true);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]?.[2]).toEqual(['fx_scaffold_f1', 'fx_scaffold_f2']);
  });

  it('keeps scaffold and timing while the dedicated atlas is unavailable, without an old-character fallback', () => {
    const { layer, reqs, play, texts } = setup(clips());
    layer.sync([job] as never, [keep, target] as never, [], keep as never, fp, key as never);
    layer.update(2_000);
    expect(reqs.map(r => r.frame)).toEqual(['fx_scaffold_f1']);
    expect(texts[0]!.text).toBe('⚒ 8s');
    expect(play).not.toHaveBeenCalled();
    expect(requiredBuilderAtlasGroups(clips())).toEqual(['builder']);
  });

  it('adopts a late atlas at the current work site without restarting the walk or job', () => {
    const { layer, reqs, play, loaded } = setup(clips());
    layer.sync([job] as never, [keep, target] as never, [], keep as never, fp, key as never);
    layer.update(2_000);
    loaded.add('builder');
    layer.sync([job] as never, [keep, target] as never, [], keep as never, fp, key as never);
    const worker = reqs.find(r => r.atlas === 'builder')!;
    expect(worker.sprite.x).toBe(8 * 64 - 12);
    expect(worker.sprite.y).toBe(10 * 64 - 52);
    expect(play).toHaveBeenLastCalledWith(worker.sprite, expect.objectContaining({ base: 'builder_work' }));
    expect(reqs.filter(r => r.atlas === 'builder')).toHaveLength(1);
  });

  it('keeps the same civilian through Keep upgrades and unregisters once on job removal or disposal', () => {
    const { layer, reqs, unregisterV2, loaded } = setup(clips());
    loaded.add('builder');
    layer.sync([job] as never, [keep, target] as never, [], keep as never, fp, key as never);
    const worker = reqs.find(r => r.atlas === 'builder')!.sprite;
    const upgradedKeep = { ...keep, level: 20 };
    layer.sync([job] as never, [upgradedKeep, target] as never, [], upgradedKeep as never, fp, key as never);
    expect(reqs.filter(r => r.atlas === 'builder')).toHaveLength(1);
    expect(worker.active).toBe(true);
    layer.sync([], [upgradedKeep, target] as never, [], upgradedKeep as never, fp, key as never);
    layer.destroy();
    expect(worker.active).toBe(false);
    expect(unregisterV2).toHaveBeenCalledExactlyOnceWith(worker);
    layer.sync([job] as never, [keep, target] as never, [], keep as never, fp, key as never);
    const next = reqs.filter(r => r.atlas === 'builder').at(-1)!.sprite;
    layer.destroy();
    expect(next.active).toBe(false);
    expect(unregisterV2).toHaveBeenCalledTimes(2);
  });

  it('omits the worker when complete directional metadata is unavailable', () => {
    const { layer, reqs, play, loaded } = setup({});
    loaded.add('builder');
    layer.sync([job] as never, [keep, target] as never, [], keep as never, fp, key as never);
    layer.update(2_000);
    expect(reqs.map(r => r.frame)).toEqual(['fx_scaffold_f1']);
    expect(play).not.toHaveBeenCalled();
    expect(requiredBuilderAtlasGroups({})).toEqual([]);
    const missingDirection = clips();
    missingDirection.builder_work!.rowOrder = ['s'];
    expect(requiredBuilderAtlasGroups(missingDirection)).toEqual([]);
  });

  it('faces the real center of a tall target instead of hardcoding an east-facing hammer', () => {
    const { layer, reqs, play, loaded } = setup(clips());
    loaded.add('builder');
    layer.sync([job] as never, [keep, target] as never, [], keep as never,
      () => ({ fw: 2, fh: 4 }), key as never);
    layer.update(2_000);
    const worker = reqs.find(r => r.atlas === 'builder')!.sprite;
    expect(play).toHaveBeenLastCalledWith(worker, expect.objectContaining({
      seq: Array.from({ length: 6 }, (_, i) => `builder_work_d3_f${i + 1}`),
    })); // northeast toward the center, rather than east past its southern edge
  });

  it('does not create a worker without a real job', () => {
    const { layer, reqs, play, loaded } = setup(clips());
    loaded.add('builder');
    layer.sync([], [keep, target] as never, [], keep as never, fp, key as never);
    expect(reqs).toEqual([]);
    expect(play).not.toHaveBeenCalled();
  });
});

/**
 * Owner 2026-08-23: a six-day Keep upgrade rendered as "⚒ 8796:31" — thousands
 * of minutes a player cannot reason about. The chip must name days and hours.
 */
describe('builder job chip countdown', () => {
  const longJob = {
    id: 'long', kind: 'upgrade', buildingId: 'target', obstacleId: null,
    startedAt: new Date(0).toISOString(),
    finishesAt: new Date(6 * 86_400_000 + 2 * 3_600_000 + 31_000).toISOString(),
  };
  const chip = (texts: FakeDisplay[]): string | undefined =>
    texts.map((t) => t.text).find((t) => t.startsWith('⚒'));

  it('labels a multi-day upgrade in days and hours, never bare minutes', () => {
    const { layer, texts } = setup(clips());
    layer.sync([longJob] as never, [keep, target] as never, [], keep as never, fp, key as never);
    layer.update(0);
    expect(chip(texts)).toBe('⚒ 6d 2h');
    layer.update(6 * 86_400_000 + 31_000);
    expect(chip(texts)).toBe('⚒ 2h');
  });

  it('falls to minutes and seconds only inside the last hour', () => {
    const { layer, texts } = setup(clips());
    layer.sync([longJob] as never, [keep, target] as never, [], keep as never, fp, key as never);
    layer.update(6 * 86_400_000 + 1 * 3_600_000 + 20 * 60_000 + 31_000);
    expect(chip(texts)).toBe('⚒ 40m');
  });
});

/**
 * Owner 2026-08-30, from a screenshot of their own base: the builder stood
 * taller than the Keep he was upgrading. He is an NPC in a base of buildings —
 * if he does not read as a PERSON beside one, the base stops reading as a town.
 *
 * INK heights are opaque-body measurements in authored pack px, taken off the
 * accepted Workman pack and the Keep at L1 (its smallest, tightest case). ⚠ ART FACTS:
 * re-measure them if either pack is re-authored.
 */
describe('builder reads as a person beside a building', () => {
  const WORKMAN_BODY_INK = 58;
  const KEEP_L1_INK = 86;
  const KEEP_L1_FIT = 0.625; // WARE_WORLD_PRESENTATION.keep.sourceScale
  /** A patrolling Highlander's body, at the garrison scale the base draws it:
   *  76 authored px x 1.32 x its published world fit / V2_DRAW_SCALE. The
   *  soldiers ARE the human scale of this world, so they are what "reads as a
   *  person" is measured against — and since 2026-08-30 both sides of that
   *  comparison carry a fit, so the ORDERING is what this pins, not a height. */
  const TROOP_BODY = 76 * 1.32 * ART_V2.troopSourceScale.highlander / 2;

  it('renders the builder shorter than the troops, who are shorter than the Keep', () => {
    // All three in authored game px: the V2_DRAW_SCALE the @2x world applies to
    // everything cancels out of a comparison between things inside that world.
    const builder = AMBIENCE.builderScale * WORKMAN_BODY_INK;
    expect(builder * 2).toBeCloseTo(31.9);
    const keep = KEEP_L1_FIT * KEEP_L1_INK;
    // The ordering is the whole point, and it is the ordering that was INVERTED:
    // at the old villager number the builder was the tallest of the three, over
    // the Keep he was upgrading. A workman is smaller than a soldier (the same
    // civilian-reads-smaller rule as AMBIENCE.villagerScale) and both are
    // smaller than the smallest Keep in the game.
    expect(builder).toBeLessThan(TROOP_BODY);
    expect(TROOP_BODY).toBeLessThan(keep);
  });
});

/**
 * Owner 2026-08-30: "on idle keep, clock is jumping". The countdown chip floats
 * over a building whose art animates underneath it, so nothing about where it
 * sits may be derived from that building's live sprite — an idle loop changes a
 * sprite's frame (and can change its displayHeight) every frame, and a chip
 * seated off it would bob for the whole build.
 *
 * The two halves of that guarantee, pinned here:
 *  - JobLayer is never given a way to reach a building sprite (its sync() takes
 *    rows and resolvers, never the scene's sprite map), so the chip is anchored
 *    off the job's FOOTPRINT rect and cannot follow art; and
 *  - the label is measured against its widest form once at creation, so the bar
 *    and the chip edge hold still as the countdown shortens and changes shape
 *    (D-070's "6d 2h" / "59m 59s" / "9s" forms are all different lengths).
 */
describe('builder job chip holds still while it counts', () => {
  const hourJob = {
    id: 'hour', kind: 'upgrade', buildingId: 'target', obstacleId: null,
    startedAt: new Date(0).toISOString(),
    finishesAt: new Date(6 * 86_400_000).toISOString(),
  };

  it('never moves the chip, its bar or its panel as the countdown re-shapes', () => {
    const { layer } = setup(clips());
    layer.sync([hourJob] as never, [keep, target] as never, [], keep as never, fp, key as never);
    const vis = (layer as unknown as {
      vis: Map<string, {
        chipText: { x: number; y: number; text: string };
        chipBg: { x: number; y: number; width: number; height: number };
        barBg: { x: number; y: number };
        barFill: { x: number; y: number; width: number };
      }>;
    }).vis.get('hour')!;
    // Every fmtDur shape the six-day countdown passes through, plus four
    // consecutive 60fps ticks, so both a per-frame re-seat and a label re-flow
    // would show up without waiting six days for the boundaries to arrive.
    const stamps = [
      0, 16, 33, 50,
      5 * 86_400_000, 6 * 86_400_000 - 3_600_000, 6 * 86_400_000 - 61_000,
      6 * 86_400_000 - 59_000, 6 * 86_400_000 - 999, 6 * 86_400_000,
    ];
    const geometry = new Set<string>();
    const labels = new Set<string>();
    const fills = new Set<number>();
    for (const t of stamps) {
      layer.update(t);
      labels.add(vis.chipText.text);
      fills.add(vis.barFill.width);
      geometry.add(JSON.stringify([
        vis.chipText.x, vis.chipText.y,
        vis.chipBg.x, vis.chipBg.y, vis.chipBg.width, vis.chipBg.height,
        vis.barBg.x, vis.barBg.y, vis.barFill.x, vis.barFill.y,
      ]));
    }
    // The countdown really did change shape across those samples…
    expect(labels.size).toBeGreaterThan(4);
    // …and the only thing that moved was the progress fill.
    expect(geometry.size).toBe(1);
    expect(fills.size).toBeGreaterThan(1);
  });

  it('takes no building sprite, so no animation frame can re-seat the chip', () => {
    // sync(jobs, buildings, obstacles, keep, footprintOf, spriteKeyFor) — six
    // parameters, none of which is a sprite or a sprite lookup. This is the
    // structural half of the guarantee: the chip CANNOT read displayHeight.
    expect(JobLayer.prototype.sync.length).toBe(6);
  });
});

/**
 * M33 package D (D-101): Text.setText rasterises a canvas and every
 * Rectangle.setSize/setPosition is a layout write. Issued per job per frame
 * they were the remaining per-frame CPU cost of an idle base on the Seeker,
 * for a label whose value can only change once a second. The builder walk
 * lerp is deliberately NOT on this cadence — it is the one thing that must
 * move every frame.
 */
describe('builder job chip cadence', () => {
  type ChipVis = {
    chipText: FakeDisplay; chipBg: FakeDisplay; barBg: FakeDisplay; barFill: FakeDisplay;
    builder: FakeDisplay | null;
  };
  const visOf = (layer: JobLayer, id: string): ChipVis =>
    (layer as unknown as { vis: Map<string, ChipVis> }).vis.get(id)!;
  const writes = (v: ChipVis): number[] => [
    v.chipText.setTextCalls, v.chipBg.setSizeCalls, v.barBg.setSizeCalls, v.barFill.setSizeCalls,
  ];

  it('writes the label and the three rectangles once per wall-clock second', () => {
    const { layer } = setup(clips());
    layer.sync([job] as never, [keep, target] as never, [], keep as never, fp, key as never);
    const v = visOf(layer, 'job');
    // Creation measures the widest label ("⚒ 59m 59s") then clears it: two
    // setText calls that belong to sync(), not to the per-frame path.
    const baseline = writes(v);

    // Sixty frames inside second 1 — 60 fps of an idle base.
    for (let frame = 0; frame < 60; frame++) layer.update(1_000 + frame * 16);
    expect(writes(v).map((n, i) => n - baseline[i]!)).toEqual([1, 1, 1, 1]);
    expect(v.chipText.text).toBe('⚒ 9s');

    // The second boundary is exactly one more write per object, with the new value.
    layer.update(2_000);
    expect(writes(v).map((n, i) => n - baseline[i]!)).toEqual([2, 2, 2, 2]);
    expect(v.chipText.text).toBe('⚒ 8s');
  });

  it('keeps the builder walk lerp per frame while the chip waits for the boundary', () => {
    const { layer, loaded } = setup(clips());
    loaded.add('builder');
    layer.sync([job] as never, [keep, target] as never, [], keep as never, fp, key as never);
    const v = visOf(layer, 'job');
    layer.update(100);
    const x0 = v.builder!.x;
    layer.update(116);
    expect(v.builder!.x).not.toBe(x0);
  });

  it('re-lays the chip on the next frame after a sync moved its target, not a second later', () => {
    const { layer } = setup(clips());
    layer.sync([job] as never, [keep, target] as never, [], keep as never, fp, key as never);
    layer.update(1_000);
    const v = visOf(layer, 'job');
    const barX = v.barBg.x;
    // Same wall-clock second: the target building was re-placed one tile east.
    layer.sync(
      [job] as never, [keep, { ...target, tx: 9 }] as never, [], keep as never, fp, key as never,
    );
    layer.update(1_500);
    expect(v.barBg.x).toBe(barX + 64);
  });
});
