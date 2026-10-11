import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ART_V2, WALL_ART, artTierOfLevel } from './constants';
import {
  COLLAPSE_DURATION, CONTEXT_FRAME_HEIGHT, WallRenderCache, buildField,
  captureCollapse, commandsToRgba, composeCollapse, composeWall, drawWall,
  wallDamageStage, wallFrameKey, wallRenderKey, wallTierOfLevel,
  type PixelCommand, type PixelSink, type WallCell, type WallGrid,
} from './wallRender';

const offsets = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;
function neighborhood(tier: number, mask: number, damage = false, damageStage: 1 | 2 = 1): Map<string, WallCell> {
  const grid = new Map<string, WallCell>([['0,0', { tier, damage, damageStage }]]);
  offsets.forEach(([x, y], i) => { if (mask & (1 << i)) grid.set(`${x},${y}`, { tier, damage, damageStage }); });
  return grid;
}
const digest = (data: Uint8ClampedArray) => createHash('sha256').update(data).digest('hex');

it('maps all 20 levels and every visual upgrade boundary without changing other structures', () => {
  expect(Array.from({ length: 20 }, (_, i) => wallTierOfLevel(i + 1))).toEqual([
    1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5,
  ]);
  for (const level of [4, 8, 12, 16]) expect(wallTierOfLevel(level + 1)).toBe(wallTierOfLevel(level) + 1);
  expect(ART_V2.tiers).toBe(4);
  expect([4, 5, 16, 17, 20].map(artTierOfLevel)).toEqual([1, 1, 4, 4, 4]);
  expect([0, -4, NaN, Infinity, 90].map(wallTierOfLevel)).toEqual([1, 1, 1, 5, 5]);
});

it('uses one canonical namespace for all 80 baseline pieces and five-tier portraits', () => {
  for (let level = 1; level <= 20; level++) expect(wallFrameKey(level)).toBe(`wall5_t${wallTierOfLevel(level)}_post_intact_f1`);
  expect(wallFrameKey(17, 'corner_sw', 'damaged', 2)).toBe('wall5_t5_corner_sw_damaged_f2');
  expect(wallFrameKey(16, 'cross', 'collapse', 4)).toBe('wall5_t4_cross_collapse_f4');
});

it('applies cosmetic damage exactly at 50/25/0 percent without changing authoritative health', () => {
  expect([100, 50, 49, 25, 24, 1, 0, -1].map(hp => wallDamageStage(hp, 100))).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  expect(wallDamageStage(1, 0)).toBe(0);
  expect(wallDamageStage(NaN, 100)).toBe(0);
});

/** These hashes were captured from the accepted local walls.mjs before the port,
 * not from this implementation. They pin materials, damage, global phase and
 * painter commands so an apparently successful port cannot quietly redraw art. */
describe('accepted concept pixel-command golden masters', () => {
  const hashes = {
    uniform: '65d6edef08b5310eb3489abcd49bde824a1ea72c41229da406b8ef30d4c6c55d',
    mixed: '623ab7887de7ef7d642e26ea9baeff1b11f8e66995ee1fcb4f104a88f70d047a',
    damaged: '9ad60d22508ff26984f9e1ca14aeecfaec7c9aa5419346eb69285cae56f001bd',
    dense: '164be0c6dfac878a1443bf930eb94870a144ce1abfbc7c8334174449f73eca55',
  };
  for (const name of ['uniform', 'mixed', 'damaged', 'dense'] as const) it(name, () => {
    const hash = createHash('sha256');
    const add = (grid: WallGrid) => {
      const field = buildField(grid);
      for (const k of grid.keys()) {
        const [x, y] = k.split(',').map(Number);
        hash.update(JSON.stringify(captureCollapse(grid, x!, y!, 0, field)!.pixels));
      }
    };
    if (name === 'uniform' || name === 'damaged') {
      for (let tier = 1; tier <= 5; tier++) for (let mask = 0; mask < 16; mask++) {
        for (let stage = 1; stage <= (name === 'damaged' ? 2 : 1); stage++) add(neighborhood(tier, mask, name === 'damaged', stage as 1 | 2));
      }
    }
    if (name === 'mixed') {
      for (let a = 1; a <= 5; a++) for (let b = 1; b <= 5; b++) for (const [dx, dy] of offsets) {
        add(new Map([['-2,3', { tier: a }], [`${-2 + dx},${3 + dy}`, { tier: b }]]));
      }
    }
    if (name === 'dense') for (let shift = 0; shift < 5; shift++) {
      const grid = new Map<string, WallCell>();
      for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) grid.set(`${x},${y}`, { tier: 1 + (x + y * 3 + shift) % 5, damage: (x + y) % 2 === 0, damageStage: 2 });
      add(grid);
    }
    expect(hash.digest('hex')).toBe(hashes[name]);
  });
});

it('renders command sinks and server RGBA at exactly the same native coordinates', () => {
  const grid = new Map<string, WallCell>([['4,7', { tier: 1 }], ['4,6', { tier: 5 }], ['5,7', { tier: 3, damage: true }]]);
  const field = buildField(grid);
  const frame = composeWall(grid, 4, 7, field)!;
  const pixels: PixelCommand[] = [];
  const sink: PixelSink = { fillStyle: '', fillRect(x, y, w, h) { pixels.push([this.fillStyle, x - 128, y - 224 + 28, w, h]); } };
  drawWall(sink, grid, 4, 7, { field });
  expect(frame.commands).toEqual(pixels);
  expect(frame.data).toEqual(commandsToRgba(pixels, 32, 60));
  expect([frame.width, frame.height, frame.anchorX, frame.anchorY]).toEqual([32, 60, 16, 60]);
  expect(frame.data.length).toBe(32 * 60 * 4);
  expect(composeWall(grid, 99, 99, field)).toBeNull();
});

it('keeps all 100 mixed-tier and damage direction frames within the full 32×60 envelope', () => {
  for (let a = 1; a <= 5; a++) for (let b = 1; b <= 5; b++) for (const [dx, dy] of offsets) {
    const grid = new Map<string, WallCell>([['0,0', { tier: a, damage: true, damageStage: 2 }], [`${dx},${dy}`, { tier: b }]]);
    const frame = composeWall(grid, 0, 0)!;
    for (const [, x, y, w, h] of frame.commands) {
      expect(x >= 0 && x + w <= 32 && y >= 0 && y + h <= CONTEXT_FRAME_HEIGHT).toBe(true);
    }
  }
});

it('RGBA retains last-painter wins and transparent padding rather than blending seams', () => {
  expect([...commandsToRgba([['#123456', 0, 0, 2, 1], ['#aabbcc', 1, 0, 1, 1]], 3, 1)]).toEqual([
    18, 52, 86, 255, 170, 187, 204, 255, 0, 0, 0, 0,
  ]);
});

it('freezes collapse geometry before a breach and reconstructs all four collapse frames', () => {
  const grid = neighborhood(1, 15); grid.set('0,-1', { tier: 5 });
  const snapshot = captureCollapse(grid, 0, 0, 100)!;
  const initial = composeCollapse(snapshot, 100);
  expect(initial.data).toEqual(composeWall(grid, 0, 0)!.data);
  grid.delete('0,0'); grid.set('0,-1', { tier: 2 });
  expect(composeCollapse(snapshot, 100).data).toEqual(initial.data);
  const frames = Array.from({ length: WALL_ART.collapseFrames }, (_, i) => composeCollapse(snapshot, 100 + i * COLLAPSE_DURATION / 3));
  expect(new Set(frames.map(frame => digest(frame.data))).size).toBe(4);
  expect(frames[3]!.commands.every(([, , y, , h]) => y >= 48 && y + h <= 60)).toBe(true);
});

it('includes every neighbor state and world material phase in frame identity', () => {
  const grid = neighborhood(2, 15);
  const before = wallRenderKey(grid, 0, 0);
  grid.set('1,1', { tier: 5 }); expect(wallRenderKey(grid, 0, 0)).not.toBe(before);
  const diagonal = wallRenderKey(grid, 0, 0);
  grid.set('1,1', { tier: 5, damage: true, damageStage: 2 }); expect(wallRenderKey(grid, 0, 0)).not.toBe(diagonal);
  const translated = new Map([...grid].map(([k, value]) => { const [x, y] = k.split(',').map(Number); return [`${x! + 32},${y}`, value] as const; }));
  expect(wallRenderKey(translated, 32, 0)).not.toBe(wallRenderKey(grid, 0, 0));
});

it('invalidates exactly the 3×3 union for tier paint, movement, damage, removal and placement', () => {
  const cache = new WallRenderCache();
  const grid = new Map<string, WallCell>([['0,0', { tier: 1 }]]);
  expect(cache.update(grid)).toHaveLength(9);
  expect(cache.update(grid)).toEqual([]);
  grid.get('0,0')!.tier = 5;
  expect(cache.update(grid)).toHaveLength(9); // Same caller Map object must still invalidate.
  grid.get('0,0')!.damage = true;
  expect(cache.update(grid)).toHaveLength(9);
  grid.delete('0,0'); grid.set('1,0', { tier: 5 });
  expect(cache.update(grid)).toHaveLength(12);
  expect(cache.compose(0, 0)).toBeNull();
  grid.delete('1,0'); expect(cache.update(grid)).toHaveLength(9);
  expect(cache.compose(1, 0)).toBeNull();
});

it('incremental 250-wall composition matches a fresh full render after edits and simultaneous breaches', () => {
  const cache = new WallRenderCache();
  const grid = new Map<string, WallCell>();
  for (let y = 0; y < 10; y++) for (let x = 0; x < 25; x++) grid.set(`${x},${y}`, { tier: 1 + (x + y) % 5 });
  cache.update(grid);
  for (const k of grid.keys()) { const [x, y] = k.split(',').map(Number); cache.compose(x!, y!); }
  const mutations = [
    () => { grid.set('11,4', { tier: 1 }); },
    () => { grid.set('11,4', { tier: 5 }); },
    () => { grid.set('12,4', { tier: 3, damage: true, damageStage: 1 }); },
    () => { grid.set('12,4', { tier: 3, damage: true, damageStage: 2 }); },
    () => { grid.delete('11,4'); grid.delete('12,4'); grid.delete('11,5'); },
    () => { grid.delete('10,4'); grid.set('25,4', { tier: 1 }); },
  ];
  for (const mutate of mutations) {
    mutate(); cache.update(grid);
    const field = buildField(grid);
    for (const k of grid.keys()) {
      const [x, y] = k.split(',').map(Number);
      expect(digest(cache.compose(x!, y!)!.data)).toBe(digest(composeWall(grid, x!, y!, field)!.data));
    }
  }
}, 15_000);

it('keeps fields and caches isolated across scenes and releases cached frames on clear', () => {
  const a = new WallRenderCache(), b = new WallRenderCache();
  const timber = neighborhood(1, 3), stone = neighborhood(5, 15);
  a.update(timber); b.update(stone);
  const aFrame = a.compose(0, 0), bFrame = b.compose(0, 0);
  expect(aFrame).not.toEqual(bFrame);
  const oldField = buildField(timber), oldHeight = oldField.at(15, 15)!.body;
  timber.set('0,0', { tier: 5 }); a.update(timber);
  expect(oldField.at(15, 15)!.body).toBe(oldHeight);
  expect(b.compose(0, 0)).toBe(bFrame);
  a.clear(); expect(a.compose(0, 0)).toBeNull();
  expect(b.compose(0, 0)).toBe(bFrame);
});

it('keeps the heavy compositor unreachable from the shared barrel and lightweight mapping', () => {
  const barrel = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const topology = readFileSync(new URL('./wallConnect.ts', import.meta.url), 'utf8');
  const art = readFileSync(new URL('./wallArt.ts', import.meta.url), 'utf8');
  expect(barrel).not.toMatch(/export[^\n]+from ['"]\.\/wallRender/);
  expect(topology + art).not.toMatch(/import[^\n]+from ['"]\.\/wallRender/);
});

it('proves the nine-cell cache key against 800 edits just outside its neighborhood', () => {
  let seed = 41;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let layout = 0; layout < 50; layout++) {
    const grid = new Map<string, WallCell>([['0,0', { tier: 1 + next() % 5 }]]);
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
      if ((x || y) && next() % 3) grid.set(`${x},${y}`, { tier: 1 + next() % 5, damage: next() % 2 === 0, damageStage: 2 });
    }
    const signature = wallRenderKey(grid, 0, 0), before = digest(composeWall(grid, 0, 0)!.data);
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
      if (Math.max(Math.abs(x), Math.abs(y)) !== 2) continue;
      const k = `${x},${y}`, prior = grid.get(k);
      if (prior) grid.delete(k); else grid.set(k, { tier: 1 + next() % 5 });
      expect(wallRenderKey(grid, 0, 0)).toBe(signature);
      expect(digest(composeWall(grid, 0, 0)!.data)).toBe(before);
      if (prior) grid.set(k, prior); else grid.delete(k);
    }
  }
});
