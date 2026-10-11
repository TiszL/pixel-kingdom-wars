import { readFileSync } from 'node:fs';
import type Phaser from 'phaser';
import { afterEach, expect, it, vi } from 'vitest';
import { useApp, type BaseStateDto } from '../../state/store';
import { ensureV2Atlases, onDemandAtlasState } from '../world/atlasLoader';
import { BaseScene } from './BaseScene';
import { WallLayer } from '../world/walls';

vi.mock('phaser', () => ({ default: {
  Scene: class {}, Display: { Color: class {} },
  Scenes: { Events: { SHUTDOWN: 'shutdown' } }, Scale: { Events: { RESIZE: 'resize' } },
  Math: { Clamp: (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n)) },
} }));

const atlasRoot = new URL('../../../public/atlas/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('meta.json', atlasRoot), 'utf8'));
const priorBase = useApp.getState().base;
afterEach(() => {
  useApp.setState({ base: priorBase });
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('keeps contextual home walls without reloading successfully swept optional sheets', async () => {
  // Real render, admission, queue, loader completion, contextual walls and global
  // sweep. Only renderer/DOM collaborators are replaced: a mocked rerender
  // cannot expose the successful-load -> eviction -> fresh-load feedback loop.
  const scene = new BaseScene() as unknown as Record<string, any>;
  const entries = new Map<string, { key: string; source: Array<{ width: number; height: number }> }>();
  const removed: string[] = [];
  const textures = {
    exists: (key: string) => entries.has(key),
    get: (key: string) => entries.get(key) ?? { key: '__MISSING', source: [] },
    addAtlas: (key: string, image: { width: number; height: number }) => {
      entries.set(key, { key, source: [{ width: image.width, height: image.height }] });
    },
    remove: (key: string) => { removed.push(key); entries.delete(key); },
    createCanvas: (key: string, width: number, height: number) => {
      entries.set(key, { key, source: [{ width, height }] });
      return {
        context: { createImageData: () => ({ data: new Uint8ClampedArray(width * height * 4) }), putImageData: vi.fn() },
        add: vi.fn(), setFilter: vi.fn(), refresh: vi.fn(),
      };
    },
  };
  const children: any[] = [];
  const sprite = (key: string, frame: string): Record<string, any> => {
    const data = new Map();
    const s: Record<string, any> = { active: true, texture: { key }, frame: { name: frame },
      getData: (name: string) => data.get(name),
      setData: (name: string, value: unknown) => { data.set(name, value); return s; },
      setTexture: (nextKey: string, nextFrame: string) => {
        s.texture = { key: nextKey }; s.frame = { name: nextFrame }; return s;
      },
    };
    for (const method of ['setVisible', 'setAlpha', 'setScale', 'setOrigin', 'clearTint']) {
      s[method] = () => s;
    }
    children.push(s); return s;
  };
  Object.assign(scene, {
    textures, game: { scene: { scenes: [scene] }, renderer: {} }, children: { list: children },
    events: { once: vi.fn(), off: vi.fn() }, registry: { get: () => undefined },
    cache: { json: { remove: vi.fn() } }, scene: { isActive: () => true },
    time: { now: 0, delayedCall: vi.fn(() => ({ remove: vi.fn() })) },
    meta: meta.sprites, v2meta: { clips: {}, atlasBytes: meta.atlasBytes },
    // This fixture starts after initial claim/camera setup for this base and plot.
    waremeta: { clips: meta.wareClips }, lastClaimKey: 'wallet:1:4,16',
    ticker: { unregister: vi.fn() }, wareTicker: { unregister: vi.fn() },
    positionBuilding: vi.fn(), attachBuildingInput: vi.fn(),
    footprintOf: () => ({ fw: 1, fh: 1 }),
    occ: { rebuild: vi.fn() }, ambience: { sync: vi.fn() },
    heroRecovery: { sync: vi.fn(), update: vi.fn() }, patrol: { sync: vi.fn(), update: vi.fn() }, jobs: { sync: () => [], update: vi.fn() },
    keepClock: { sync: vi.fn(), remove: vi.fn(), update: vi.fn() },
    add: { sprite: (_x: number, _y: number, key: string, frame: string) => sprite(key, frame) },
  });
  const requests: string[] = [];
  const dimensions = new Map<string, { w: number; h: number }>();
  const blobs = new WeakMap<Blob, string>();
  vi.stubGlobal('fetch', async (input: string) => {
    requests.push(input);
    // Bound the OLD broken implementation so the regression fails with counts
    // instead of producing an infinite successful microtask chain.
    if (requests.length > 12) throw new Error('unexpected repeat atlas load');
    const [, group, part] = /\/([^/]+)@1x\.(png|json)/.exec(input)!;
    const json = readFileSync(new URL(`${group}@1x.json`, atlasRoot), 'utf8');
    dimensions.set(`blob:${group}`, JSON.parse(json).textures[0].size);
    const blob = new Blob([part === 'json' ? json : group!]);
    blobs.set(blob, group!);
    return { ok: true, blob: async () => blob };
  });
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => `blob:${blobs.get(blob as Blob)}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.stubGlobal('Image', class {
    width = 0; height = 0;
    set src(value: string) {
      const size = dimensions.get(value); if (!size) return;
      this.width = size.w; this.height = size.h;
    }
    async decode(): Promise<void> {}
  });
  useApp.setState({ base: {
    buildings: [{ id: 'wall', type: 'wall', level: 1, tx: 6, ty: 6, underConstruction: false }],
    obstacles: [], jobs: [], heroes: [], army: [], player: { wallet: 'wallet' }, claim: { min: 4, max: 16 },
  } as unknown as BaseStateDto });

  scene.wallArt = new WallLayer(scene as Phaser.Scene);
  await ensureV2Atlases(scene as Phaser.Scene, ['ware_mine_1']);
  expect(entries.has('ware_mine_1')).toBe(true);
  scene.renderFromStore();
  for (let pass = 0; pass < 12; pass++) {
    await scene.richArtLoadTail;
    await Promise.resolve();
    scene.renderFromStore();
  }
  expect(requests).toHaveLength(2); // one successful image/JSON pair, never reloaded
  expect(removed).toEqual(['ware_mine_1']);
  expect(onDemandAtlasState(scene as Phaser.Scene).bytes).toBe(0);
  expect(children[0].texture.key).toBe('wall5');
  expect(children[0].frame.name).toBe('wall5_t1_post_intact_f1');
  const sync = vi.spyOn(scene.wallArt, 'sync');
  scene.update();
  while (scene.wallArt.preparing) scene.wallArt.update();
  expect(children[0].frame.name).toMatch(/^wallctx_/);
  const originalTexture = children[0].texture.key;
  expect(scene.time.delayedCall).not.toHaveBeenCalled();
  for (let i = 0; i < 60; i++) scene.update();
  expect(sync).toHaveBeenCalledOnce(); // idle frames never rebuild occupancy/signatures
  expect(scene.patrol.update).toHaveBeenCalledTimes(61); // cosmetic motion still runs

  // Authoritative connectivity changes still recompose the home wall after
  // optional art is swept; excluding old rich sheets must not freeze the pixels.
  const base = useApp.getState().base!;
  useApp.setState({ base: { ...base, buildings: [...base.buildings,
    { ...base.buildings[0]!, id: 'neighbor', tx: 7 },
  ] } });
  scene.renderFromStore();
  await scene.richArtLoadTail;
  expect(requests).toHaveLength(2);
  scene.update();
  while (scene.wallArt.preparing) scene.wallArt.update();
  expect(children.every((child) => child.texture.key.startsWith('wallctx_'))).toBe(true);
  expect(children[0].texture.key).not.toBe(originalTexture);
  expect(scene.wallArt.diagnostics.textureCount).toBe(2);
  expect(sync).toHaveBeenCalledTimes(2);
  scene.wallArt.destroy();
});

it('invalidates home wall inputs for lift/drop, settling release and ghost cancellation without polling idle frames', () => {
  const scene = new BaseScene() as unknown as Record<string, any>;
  const data = new Map<string, unknown>();
  const sprite: Record<string, any> = { frame: { name: 'wall5_t1_post_intact_f1' }, displayHeight: 88,
    getData: (key: string) => data.get(key), setData: (key: string, value: unknown) => { data.set(key, value); return sprite; },
    setX: () => sprite, setY: () => sprite, setScale: () => sprite, setOrigin: () => sprite, setDepth: () => sprite,
    destroy: vi.fn(),
  };
  Object.assign(scene, { syncWallArt: vi.fn(), wallArt: { update: vi.fn() },
    refreshFootprintHitArea: vi.fn(), buildingSeat: () => ({ origin: [0.5, 1], scale: 2, offsetGamePx: [0, 0] }),
    clearPlacementGrid: vi.fn(), clearFootprintTint: vi.fn(),
  });
  const flush = (): void => {
    scene.update(); const calls = scene.syncWallArt.mock.calls.length;
    for (let i = 0; i < 5; i++) scene.update();
    expect(scene.syncWallArt).toHaveBeenCalledTimes(calls);
  };
  flush(); expect(scene.syncWallArt).toHaveBeenCalledOnce();
  scene.positionLiftedBuilding(sprite, 8, 7, { fw: 1, fh: 1 });
  flush(); expect(scene.syncWallArt).toHaveBeenCalledTimes(2);
  scene.positionBuilding(sprite, 8, 7, { fw: 1, fh: 1 });
  scene.holdSettlingMove([{ id: 'wall', tx: 8, ty: 7 }], { fw: 1, fh: 1 });
  flush(); expect(scene.syncWallArt).toHaveBeenCalledTimes(3);
  scene.releaseSettlingMoves(['wall']);
  flush(); expect(scene.syncWallArt).toHaveBeenCalledTimes(4);
  scene.ghost = { type: 'wall', sprite, ring: null };
  scene.endGhost(); flush(); expect(scene.syncWallArt).toHaveBeenCalledTimes(5);
  expect(sprite.destroy).toHaveBeenCalledOnce();
});
