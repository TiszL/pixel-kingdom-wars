import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { webcrypto, createHash } from 'node:crypto';
import type Phaser from 'phaser';
import type { LayeredGroundManifest, LayeredGroundManifestV4 } from '@shardkeep/shared/layeredGround';
import { LayeredGround, type LayeredGroundProgress } from './layeredGround';
import { downloadGround } from './groundDownload';
vi.mock('./groundDownload', () => ({ downloadGround: vi.fn() }));
const bytes = new Uint8Array([1, 2, 3, 4]);
const sha = createHash('sha256').update(bytes).digest('hex');
function manifest(): LayeredGroundManifest {
  return { schemaVersion: 1, groundRevision: 3, realmId: 'thornwake', status: 'accepted', tilePixels: 32,
    field: { x: -1088, y: -1088, width: 3136, height: 3136 }, protectedFrame: { x: -320, y: -320, width: 1600, height: 1600 },
    ground: { asset: 'ground', sampling: 'world' }, placements: [], assets: [{ id: 'ground', path: `atlas/fantasy/layered-ground/assets/${sha}.webp`,
      sha256: sha, size: bytes.length, width: 98, height: 98, frameWidth: 98, frameHeight: 98, frameCount: 1, frameDurationMs: 100,
      anchor: { x: 0, y: 0 }, reducedMotionFrame: 0 }] };
}
function scene() {
  return { events: new EventEmitter(), textures: { addSpriteSheet: vi.fn(), remove: vi.fn() } };
}
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  vi.stubGlobal('Image', class { naturalWidth = 98; naturalHeight = 98; decode = vi.fn(async () => {}); });
  vi.mocked(downloadGround).mockImplementation(async (_url, _signal, report) => {
    for (const completed of [0, 2, 4]) report({ completed, total: 4, loadAttempt: 1, loadReason: 'complete', loadProtocol: 'unknown' });
    return bytes;
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('reports real streaming and preparation phases before ready so a healthy slow transfer remains observable', async () => {
  const host = scene(), reports: LayeredGroundProgress[] = [];
  const ground = await LayeredGround.prepare(host as unknown as Phaser.Scene, manifest(), 64, new AbortController().signal, p => reports.push(p));
  expect(reports.filter(p => p.phase === 'download').map(p => p.completed)).toEqual([0, 2, 4]);
  expect(reports.map(p => p.phase)).toEqual(['download', 'download', 'download', 'verify', 'decode', 'upload', 'ready']);
  expect(reports.at(-1)).toEqual({ phase: 'ready', completed: 4, total: 4 });
  expect(host.events.listenerCount('shutdown')).toBe(1);
  ground.destroy(); ground.destroy();
  expect(host.events.listenerCount('shutdown')).toBe(0); expect(host.textures.remove).toHaveBeenCalledTimes(1);
});
it('releases failed preparation listeners and residency without uploading corrupt pages', async () => {
  const host = scene(), bad = manifest(); bad.assets[0]!.sha256 = 'a'.repeat(64); bad.assets[0]!.path = `atlas/fantasy/layered-ground/assets/${'a'.repeat(64)}.webp`;
  for (let attempt = 0; attempt < 3; attempt++) await expect(LayeredGround.prepare(host as unknown as Phaser.Scene, bad, 64, new AbortController().signal)).rejects.toThrow('integrity');
  expect(host.events.listenerCount('shutdown')).toBe(0); expect(host.textures.addSpriteSheet).not.toHaveBeenCalled();
});
it('reuses bounded clean-material images and source frames while moving over every field edge', async () => {
  const host = scene(), images: any[] = [], frames = new Set<string>();
  const texture = { key: 'prepared-ground', has: (key: string) => frames.has(key), add: vi.fn((key: string) => frames.add(key)) };
  Object.assign(host.textures, { get: () => texture });
  Object.assign(host, { add: { image: vi.fn(() => {
    const image: any = { visible: true };
    for (const method of ['setOrigin', 'setDepth', 'setPosition', 'setDisplaySize', 'setFrame', 'setFlip']) image[method] = vi.fn(() => image);
    image.setVisible = vi.fn((v: boolean) => { image.visible = v; return image; }); image.destroy = vi.fn(); images.push(image); return image;
  }) } });
  const ground = await LayeredGround.prepare(host as unknown as Phaser.Scene, manifest(), 64, new AbortController().signal);
  ground.update({ x: -2400, y: -2400, width: 7000, height: 7000 }, 0, true);
  const count = images.length; expect(count).toBeLessThanOrEqual(25);
  expect(images.some(i => i.setFlip.mock.calls.some(([x, y]: boolean[]) => x || y))).toBe(false);
  for (const x of [-10000, 10000, -9000, 9000]) ground.update({ x, y: -2400, width: 700, height: 700 }, 16, true);
  expect(images).toHaveLength(count); expect(frames.size).toBeLessThanOrEqual(10); // Fixed source cuts cannot accumulate frames.
  ground.update({ x: 0, y: 0, width: 700, height: 700 }, 16, true, true);
  expect(images.every(i => !i.visible)).toBe(true);
  ground.destroy(); expect(images.every(i => i.destroy.mock.calls.length === 1)).toBe(true);
});

it('draws revision4 with a fixed world phase and at most three floor objects across repeated pans', async () => {
  const m: LayeredGroundManifestV4 = { ...manifest(), schemaVersion: 2, groundRevision: 4,
    ground: { asset: 'center', sampling: 'world', centerRect: { x: -1200, y: -1200, width: 3360, height: 3360 },
      exterior: { asset: 'outer', rect: { x: -4320, y: -4320, width: 9600, height: 9600 } },
      far: { asset: 'far', origin: { x: -4320, y: -4320 }, period: { width: 864, height: 864 } } } };
  const payloads = ['center', 'outer', 'far'].map((id, index) => {
    const data = new Uint8Array([1, 2, 3, index]);
    const hash = createHash('sha256').update(data).digest('hex');
    return { data, asset: { ...m.assets[0]!, id, path: `atlas/fantasy/layered-ground/assets/${hash}.webp`,
      sha256: hash, width: 128, height: 128, frameWidth: 128, frameHeight: 128 } };
  });
  m.assets = payloads.map(p => p.asset);
  vi.stubGlobal('Image', class { naturalWidth = 128; naturalHeight = 128; decode = vi.fn(async () => {}); });
  vi.mocked(downloadGround).mockImplementation(async url => payloads.find(p => url.includes(p.asset.sha256))!.data);
  const host = scene(), images: any[] = [], tiles: any[] = [], textures = new Map<string, any>();
  host.textures.addSpriteSheet.mockImplementation(key => { const frames = new Set(); textures.set(key, {
    key, has: (f: string) => frames.has(f), add: (f: string) => frames.add(f) }); });
  Object.assign(host.textures, { get: (key: string) => textures.get(key) });
  function object(list: any[]) {
    const result: any = { visible: false };
    for (const name of ['setOrigin', 'setDepth', 'setPosition', 'setDisplaySize', 'setFrame', 'setTexture', 'setFlip', 'setSize', 'setScale', 'setTileScale']) result[name] = vi.fn(() => result);
    result.setVisible = vi.fn((v: boolean) => { result.visible = v; return result; }); result.destroy = vi.fn(); list.push(result); return result;
  }
  Object.assign(host, { add: { image: () => object(images), tileSprite: () => object(tiles) } });
  const ground = await LayeredGround.prepare(host as unknown as Phaser.Scene, m, 64, new AbortController().signal);
  try {
    const fixedWorld = { x: -2401, y: -2101 };
    for (const x of [-2500, -2460, -2440]) {
      ground.update({ x, y: -2300, width: 1000, height: 1000 }, 16, false);
      expect(images).toHaveLength(2); expect(tiles).toHaveLength(1);
      const tile = tiles[0];
      const [sx, sy] = tile.setTileScale.mock.calls.at(-1);
      // Independent world address: moving the camera cannot move a texel at a
      // fixed ground point. This catches tilePosition in world instead of texels.
      expect(tile.tilePositionX + (fixedWorld.x - x) / sx).toBeCloseTo((fixedWorld.x + 8640) * 128 / 1728);
      expect(tile.tilePositionY + (fixedWorld.y + 2300) / sy).toBeCloseTo((fixedWorld.y + 8640) * 128 / 1728);
    }
    ground.update({ x: -8000, y: -8000, width: 100, height: 100 }, 16, false); // Exterior, no centre.
    expect(images[0].setTexture.mock.calls.at(-1)?.[0]).toContain(payloads[1]!.asset.sha256);
    expect(images[1].visible).toBe(false);
    ground.update({ x: 0, y: 0, width: 100, height: 100 }, 16, true);
    expect(images[1].setTexture.mock.calls.at(-1)?.[0]).toContain(payloads[0]!.asset.sha256);
    ground.update({ x: -60000, y: -60000, width: 120000, height: 120000 }, 16, true);
    expect(images).toHaveLength(2); expect(tiles).toHaveLength(1);
    ground.update({ x: 0, y: 0, width: 100, height: 100 }, 16, true, true);
    expect([...images, ...tiles].every(i => !i.visible)).toBe(true);
  } finally { ground.destroy(); }
  expect([...images, ...tiles].every(i => i.destroy.mock.calls.length === 1)).toBe(true);
  expect(host.textures.remove).toHaveBeenCalledTimes(3);
});
