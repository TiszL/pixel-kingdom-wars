import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { webcrypto, createHash } from 'node:crypto';
import type Phaser from 'phaser';
import { LAYERED_GROUND_LIMITS_R5, REALM_KIT, WORLD_DEPTH } from '@shardkeep/shared';
import { realmKitCell, realmKitDrawBand, realmKitGroundBandPlan, realmKitPathPlan, type RealmKitManifest } from '@shardkeep/shared/realmKit';
import * as layeredCatalogue from '@shardkeep/shared/layeredGroundCatalogue';
import { FIXTURE_CELL, FIXTURE_ROAD_ROW, fixtureClaim, realmKitFixture } from '../../../../../packages/shared/src/realmKit.fixture';
import { RealmKitGround, type RealmKitGroundProgress } from './realmKitGround';
import { downloadGround } from './groundDownload';

vi.mock('./groundDownload', () => ({ downloadGround: vi.fn() }));
// realmKitCell keeps its behaviour but counts its calls: a regenerate that walked the whole
// 226² extent on GPU layers (153k calls) was a few-hundred-ms hitch on a phone.
vi.mock('@shardkeep/shared/realmKit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shardkeep/shared/realmKit')>();
  return { ...actual, realmKitCell: vi.fn(actual.realmKitCell) };
});
// The revision-5 pin block does not exist on this branch yet; the test installs
// one exactly the way the builder will (a BASE_LAYERED_GROUND_V5 table).
vi.mock('@shardkeep/shared/layeredGroundCatalogue', () => ({ BASE_LAYERED_GROUND_V5: {} as Record<string, unknown> }));
const pinned = (layeredCatalogue as unknown as { BASE_LAYERED_GROUND_V5: Record<string, unknown> }).BASE_LAYERED_GROUND_V5;
// Only the tilemap data classes and the renderer-type constant are touched by the
// renderer; the scene factories below stand in for the display objects.
vi.mock('phaser', () => ({ default: {
  WEBGL: 2, CANVAS: 1,
  Tilemaps: {
    LayerData: class { name: string; width: number; height: number; data: unknown[][] = [];
      constructor(config: { name: string; width: number; height: number }) { this.name = config.name; this.width = config.width; this.height = config.height; } },
    Tile: class { constructor(public layer: unknown, public index: number, public x: number, public y: number) {} },
  },
} }));

const O = REALM_KIT.fieldOriginTiles, N = REALM_KIT.fieldTiles;
// The tilemap covers the field plus its edge-clamped margin on every side (REALM_KIT.edgeExtendTiles).
const E = REALM_KIT.edgeExtendTiles, MO = O - E, MN = N + 2 * E;
/** The fixture manifest with every asset backed by distinct bytes whose hashes the manifest pins. */
function manifestWithBytes(): { manifest: RealmKitManifest; bytes: Map<string, Uint8Array<ArrayBuffer>> } {
  const manifest = realmKitFixture(), bytes = new Map<string, Uint8Array<ArrayBuffer>>();
  const rewrite = JSON.stringify(manifest);
  manifest.assets.forEach((asset, index) => {
    const data = new Uint8Array([9, 8, 7, index]);
    const sha256 = createHash('sha256').update(data).digest('hex');
    bytes.set(sha256, data);
    asset.sha256 = sha256; asset.path = `atlas/fantasy/layered-ground/assets/${sha256}.png`; asset.size = data.length;
  });
  expect(JSON.stringify(manifest)).not.toBe(rewrite);
  return { manifest, bytes };
}
type Stub = Record<string, any>;
function object(list: Stub[], extra: Record<string, unknown> = {}): Stub {
  const result: Stub = { visible: true, ...extra };
  for (const name of ['setOrigin', 'setDepth', 'setPosition', 'setDisplaySize', 'setFrame', 'setTexture', 'setSize', 'setScale',
    'setTileScale', 'setTimerPaused', 'resetTimer', 'setSkipCull']) result[name] = vi.fn(() => result);
  result.setVisible = vi.fn((v: boolean) => { result.visible = v; return result; }); result.destroy = vi.fn(); list.push(result); return result;
}
function scene(rendererType = 2, gpuFails = false) {
  const images: Stub[] = [], tiles: Stub[] = [], layers: Stub[] = [], maps: Stub[] = [], containers: Stub[] = [];
  const textures = new Map<string, { key: string }>();
  const host = {
    events: new EventEmitter(),
    sys: { renderer: { type: rendererType } },
    textures: { addSpriteSheet: vi.fn((key: string) => { textures.set(key, { key }); }), remove: vi.fn(), get: (key: string) => textures.get(key) },
    add: { image: () => object(images), tileSprite: () => object(tiles),
      container: (x: number, y: number) => { const c = object(containers, { x, y, children: [] as Stub[] }); c.add = vi.fn((child: Stub) => { c.children.push(child); return c; }); return c; } },
    make: { tilemap: vi.fn(() => {
      const map: Stub = { layers: [], tilesets: [], destroy: vi.fn(),
        addTilesetImage: vi.fn((name: string, key: string) => textures.has(key) ? { name, key, tileData: {}, firstgid: 0 } : null),
        createLayer: vi.fn((id: string, _tileset: unknown, x: number, y: number, gpu: boolean) => {
          if (gpu && gpuFails) throw new Error('no data textures');
          const data = map.layers.find((l: Stub) => l.name === id);
          return object(layers, { id, x, y, gpu, layer: data, generateLayerDataTexture: vi.fn() });
        }) };
      maps.push(map); return map;
    }) },
  };
  return { host, images, tiles, layers, maps, containers, textures };
}
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
/** Downloads answer with the bytes the manifest pins; Image.decode reports each asset's own size. */
function serve(manifest: RealmKitManifest, bytes: Map<string, Uint8Array<ArrayBuffer>>) {
  vi.mocked(downloadGround).mockImplementation(async (url, _signal, report) => {
    const hash = /([0-9a-f]{64})\.png/.exec(url)?.[1];
    const data = hash ? bytes.get(hash) : undefined;
    if (!data) throw new Error(`unexpected download ${url}`);
    report({ completed: data.length, total: data.length, loadAttempt: 1, loadReason: 'complete', loadProtocol: 'unknown' });
    return data as Uint8Array<ArrayBuffer>;
  });
  const sizes = new Map(manifest.assets.map(a => [a.sha256, a]));
  vi.stubGlobal('Image', class {
    src = ''; naturalWidth = 0; naturalHeight = 0;
    decode = vi.fn(async () => { const a = sizes.get(this.src)!; this.naturalWidth = a.width; this.naturalHeight = a.height; });
  });
  vi.stubGlobal('URL', Object.assign(class extends globalThis.URL {}, {
    createObjectURL: (blob: Blob & { hash?: string }) => blob.hash ?? '', revokeObjectURL: () => {} }));
  vi.stubGlobal('Blob', class { hash: string; constructor(parts: Uint8Array[]) { this.hash = createHash('sha256').update(parts[0]!).digest('hex'); } });
}
const view = { x: -700, y: -700, width: 2200, height: 2200 };
/** Every placement of the fixture is inside this view (the whole 98-tile field at 64 px). */
const field = { x: O * 64, y: O * 64, width: N * 64, height: N * 64 };

describe('RealmKitGround preparation', () => {
  it('reports download, verify, decode and upload per asset, creates every object hidden and releases residency on destroy', async () => {
    const { manifest, bytes } = manifestWithBytes(); serve(manifest, bytes);
    const s = scene(), reports: RealmKitGroundProgress[] = [];
    const ground = await RealmKitGround.prepare(s.host as unknown as Phaser.Scene, manifest, 64, new AbortController().signal, p => reports.push(p), true);
    expect(reports.map(p => p.phase).filter((p, i, all) => all.indexOf(p) === i)).toEqual(['download', 'verify', 'decode', 'upload', 'ready']);
    expect(reports.at(-1)).toEqual({ phase: 'ready', completed: manifest.assets.length * 4, total: manifest.assets.length * 4 });
    expect(s.host.textures.addSpriteSheet).toHaveBeenCalledTimes(manifest.assets.length);
    // Swap-only-after-valid-draw: nothing is visible before SceneGround's first update. One Image per
    // placement, then one per ambient path (D-173 creature paths), all hidden.
    expect(s.images).toHaveLength(manifest.placements.length + manifest.paths.length);
    expect([...s.images, ...s.layers].every(o => o.visible === false)).toBe(true);
    // Props live in the GROUND band (E-7, below WORLD_DEPTH.structure) on every surface: native draws
    // them with the floor and the deed composites them before any placed sprite. E-6 amended lets a
    // prop share tiles with buildings and troops, so a prop that sorted into the structure band here
    // would stack differently from the deed and the other client. Within the band the depth is the
    // shared painter's order (realmKitDrawBand, then the anchor row): 1 + band + y · 1e-6, so a bush
    // south of a tree's seat covers its trunk here exactly as on the deed and on native.
    const depths = s.images.slice(0, manifest.placements.length).map(i => i.setDepth.mock.calls[0]?.[0] as number);
    expect(depths).toEqual(manifest.placements.map(p => 1 + realmKitDrawBand(p.layer) + p.y * 1e-6));
    expect(depths.every(d => d > 0.5 && d < WORLD_DEPTH.structure)).toBe(true); // a north row dips just under 1, still over the tile layers (≤ 0.3)
    const byDepth = manifest.placements.map((p, i) => ({ id: p.id, depth: depths[i]! })).sort((a, b) => a.depth - b.depth).map(p => p.id);
    const whole = { x: O * 32, y: O * 32, width: N * 32, height: N * 32 };
    expect(byDepth).toEqual(realmKitGroundBandPlan(manifest, 32, whole, fixtureClaim(14), 0, true).map(d => d.id).filter(id => manifest.placements.some(p => p.id === id)));
    // The air layer (gulls) sits a whole band above every ground prop and creature.
    expect(s.images[manifest.placements.length]!.setDepth.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(1 + REALM_KIT.airLayer - 0.01);
    expect(s.layers.map(l => l.id)).toEqual(['water', 'base', 'overlay']);
    // GPU layers sit at (0,0) inside ONE field container that carries the world
    // transform (Phaser 4.1 double-applies a GPU layer's own x/y) and is seated a
    // sub-texel below the field origin (the boundary-seam nudge); draw order is
    // the manifest order.
    expect(s.layers.every(l => l.gpu && l.x === 0 && l.y === 0 && l.setScale.mock.calls.length === 0)).toBe(true);
    expect(s.containers).toHaveLength(1);
    const field = s.containers[0]!;
    expect(field.x).toBe(MO * 64); expect(field.y).toBeGreaterThan(MO * 64); expect(field.y - MO * 64).toBeLessThan(0.5);
    expect(field.setScale).toHaveBeenCalledWith(2); expect(field.visible).toBe(false);
    expect(field.children.map((c: Stub) => c.id)).toEqual(['water', 'base', 'overlay']);
    expect(ground.primitive).toBe('gpu');
    expect(s.host.events.listenerCount('shutdown')).toBe(1);
    ground.destroy(); ground.destroy();
    expect(s.host.events.listenerCount('shutdown')).toBe(0);
    expect(s.host.textures.remove).toHaveBeenCalledTimes(manifest.assets.length);
    expect([...s.images, ...s.layers, ...s.containers].every(o => o.destroy.mock.calls.length === 1)).toBe(true);
    expect(s.maps[0]!.destroy).toHaveBeenCalledOnce();
  });
  it('refuses an unapproved manifest outside a preview host and enforces the resident-realm budget', async () => {
    const { manifest, bytes } = manifestWithBytes(); serve(manifest, bytes);
    const s = scene();
    await expect(RealmKitGround.prepare(s.host as unknown as Phaser.Scene, manifest, 64, new AbortController().signal)).rejects.toThrow('preview host');
    const accepted = { ...manifest, status: 'accepted' as const };
    const held: RealmKitGround[] = [];
    try {
      for (let i = 0; i < LAYERED_GROUND_LIMITS_R5.residentRealms; i++) held.push(await RealmKitGround.prepare(s.host as unknown as Phaser.Scene, accepted, 64, new AbortController().signal));
      await expect(RealmKitGround.prepare(s.host as unknown as Phaser.Scene, accepted, 64, new AbortController().signal)).rejects.toThrow('residency');
    } finally { for (const g of held) g.destroy(); }
  });
  it('rejects a page whose bytes do not hash to the manifest and uploads nothing', async () => {
    const { manifest, bytes } = manifestWithBytes();
    const tiles = manifest.assets[0]!, wrong = 'a'.repeat(64);
    bytes.set(wrong, bytes.get(tiles.sha256)!); tiles.sha256 = wrong; tiles.path = `atlas/fantasy/layered-ground/assets/${wrong}.png`;
    serve(manifest, bytes);
    const s = scene();
    await expect(RealmKitGround.prepare(s.host as unknown as Phaser.Scene, manifest, 64, new AbortController().signal, undefined, true)).rejects.toThrow('integrity');
    expect(s.host.textures.addSpriteSheet).not.toHaveBeenCalled();
    expect(s.host.events.listenerCount('shutdown')).toBe(0);
  });
  it('rejects a decoded page whose dimensions disagree with the manifest', async () => {
    const { manifest, bytes } = manifestWithBytes(); serve(manifest, bytes);
    vi.stubGlobal('Image', class { src = ''; naturalWidth = 256; naturalHeight = 128; decode = vi.fn(async () => {}); });
    const s = scene();
    await expect(RealmKitGround.prepare(s.host as unknown as Phaser.Scene, manifest, 64, new AbortController().signal, undefined, true)).rejects.toThrow('dimensions');
    expect(s.host.textures.addSpriteSheet).not.toHaveBeenCalled();
  });
  it('caps the manifest download at LAYERED_GROUND_LIMITS_R5.manifestBytes and verifies it against the pinned descriptor', async () => {
    const { manifest, bytes } = manifestWithBytes();
    const accepted = { ...manifest, status: 'accepted' as const };
    const json = new TextEncoder().encode(JSON.stringify(accepted) + '\n');
    const sha256 = createHash('sha256').update(json).digest('hex');
    pinned.crownlands = { realmId: 'crownlands', manifestPath: `atlas/fantasy/layered-ground/${sha256}/manifest.json`, sha256, size: json.length };
    serve(accepted, bytes);
    const previous = vi.mocked(downloadGround).getMockImplementation()!;
    vi.mocked(downloadGround).mockImplementation(async (url, signal, report, options) => {
      if (url.includes('/manifest.json')) return json;
      return previous(url, signal, report, options);
    });
    const s = scene(), context = { version: 1 as const, artVersion: 2 as const, realmId: 'crownlands' as const, groundRevision: 5 as const };
    const ground = await RealmKitGround.prepareContext(s.host as unknown as Phaser.Scene, context, 64, new AbortController().signal);
    try {
      const manifestCall = vi.mocked(downloadGround).mock.calls.find(([url]) => url.includes('/manifest.json'))!;
      expect(manifestCall[0]).toContain(`/atlas/fantasy/layered-ground/${sha256}/manifest.json?v=`);
      expect(manifestCall[3]).toEqual({ maxBytes: LAYERED_GROUND_LIMITS_R5.manifestBytes });
    } finally { ground.destroy(); }
    // A descriptor that disagrees with the bytes is an integrity failure before any asset is fetched.
    pinned.crownlands = { realmId: 'crownlands', manifestPath: `atlas/fantasy/layered-ground/${sha256}/manifest.json`, sha256: 'b'.repeat(64), size: json.length };
    vi.mocked(downloadGround).mockClear();
    await expect(RealmKitGround.prepareContext(s.host as unknown as Phaser.Scene, context, 64, new AbortController().signal)).rejects.toThrow('integrity');
    expect(vi.mocked(downloadGround).mock.calls.every(([url]) => url.includes('/manifest.json'))).toBe(true);
    // A preview-only manifest under a frozen production context is refused too.
    const preview = new TextEncoder().encode(JSON.stringify(manifest) + '\n');
    vi.mocked(downloadGround).mockImplementation(async () => preview);
    pinned.crownlands = { realmId: 'crownlands', manifestPath: 'x', sha256: createHash('sha256').update(preview).digest('hex'), size: preview.length };
    await expect(RealmKitGround.prepareContext(s.host as unknown as Phaser.Scene, context, 64, new AbortController().signal)).rejects.toThrow('frozen context');
    // An unpinned realm is unpublished: loud, before any byte is requested.
    delete pinned.crownlands; vi.mocked(downloadGround).mockClear();
    await expect(RealmKitGround.prepareContext(s.host as unknown as Phaser.Scene, context, 64, new AbortController().signal)).rejects.toThrow('not published: crownlands');
    expect(downloadGround).not.toHaveBeenCalled();
  });
  it('previews an unpinned manifest only for the realm its VITE_REALM_KIT_PREVIEW_MANIFESTS entry was keyed by', async () => {
    const { manifest, bytes } = manifestWithBytes();
    const json = new TextEncoder().encode(JSON.stringify(manifest) + '\n');
    serve(manifest, bytes);
    const previous = vi.mocked(downloadGround).getMockImplementation()!;
    vi.mocked(downloadGround).mockImplementation(async (url, signal, report, options) => url.includes('/manifest.json') ? json : previous(url, signal, report, options));
    const s = scene(), url = '/atlas/fantasy/layered-ground/local/manifest.json';
    // A Crownlands kit keyed under frostveil would draw Crownlands under a Frostveil base: refused before any asset is fetched.
    await expect(RealmKitGround.preparePreview(s.host as unknown as Phaser.Scene, url, 64, new AbortController().signal, () => {}, 'frostveil'))
      .rejects.toThrow('Realm kit preview manifest is for crownlands, not frostveil');
    expect(vi.mocked(downloadGround).mock.calls.every(([u]) => u.includes('/manifest.json'))).toBe(true);
    const ground = await RealmKitGround.preparePreview(s.host as unknown as Phaser.Scene, url, 64, new AbortController().signal, () => {}, 'crownlands');
    ground.destroy();
  });
});

describe('RealmKitGround drawing', () => {
  async function prepared(rendererType = 2, gpuFails = false) {
    const { manifest, bytes } = manifestWithBytes(); serve(manifest, bytes);
    const s = scene(rendererType, gpuFails);
    const ground = await RealmKitGround.prepare(s.host as unknown as Phaser.Scene, manifest, 64, new AbortController().signal, undefined, true);
    return { ...s, manifest, ground };
  }
  const tileAt = (layer: Stub, tx: number, ty: number) => layer.layer.data[ty - MO][tx - MO].index as number;
  it('draws a bounded set of floor objects at any view and regenerates tiles only when the claim changes', async () => {
    const s = await prepared();
    try {
      expect(() => s.ground.update(view, 16, false)).toThrow('Realm kit needs the server claim');
      s.ground.setClaim(fixtureClaim(14));
      s.ground.update(view, 16, false);
      // One far TileSprite, one object per manifest layer, one Image per placement and per path, whatever the view.
      expect(s.tiles).toHaveLength(1); expect(s.layers).toHaveLength(3); expect(s.images).toHaveLength(s.manifest.placements.length + s.manifest.paths.length);
      expect(s.layers.every(l => l.visible && l.generateLayerDataTexture.mock.calls.length === 1)).toBe(true);
      for (const x of [-60000, 60000, 0]) s.ground.update({ x, y: x, width: 500, height: 500 }, 16, false);
      expect(s.tiles).toHaveLength(1); expect(s.layers).toHaveLength(3);
      expect(s.layers.every(l => l.generateLayerDataTexture.mock.calls.length === 1)).toBe(true);
      // The tile rule is the shared one: kingdom turf inside the claim, the edge
      // ring outside it, baked layers elsewhere, −1 where the layer is empty.
      const base = s.layers[1]!, overlay = s.layers[2]!, water = s.layers[0]!;
      const cellIndex = (cell: number) => { const c = s.manifest.ground.cells[cell - 1]!; return c.y / 32 * 8 + c.x / 32; };
      const claim = fixtureClaim(14);
      expect(tileAt(base, 15, 15)).toBe(cellIndex(realmKitCell(s.manifest, claim, 'base', 15, 15)));
      expect([FIXTURE_CELL.turf, FIXTURE_CELL.turfAlt].map(cellIndex)).toContain(tileAt(base, 15, 15));
      expect(tileAt(base, claim.min - 1, 15)).toBe(cellIndex(FIXTURE_CELL.edgeFirst + 5)); // W straight run mask 5
      expect(tileAt(overlay, 15, 15)).toBe(-1); // overlay cleared inside the kingdom
      // Edge clamp: the margin repeats the nearest field tile on water/base (a river runs on to the world's end) and carries no overlay.
      expect(tileAt(base, O - 1, 20)).toBe(tileAt(base, O, 20)); expect(tileAt(base, O + N + E - 1, 20)).toBe(tileAt(base, O + N - 1, 20));
      // The fixture's south river arm reaches the field edge, so this pins WATER running on — not an empty −1 against −1.
      expect(tileAt(water, 55, O + N - 1)).toBe(cellIndex(FIXTURE_CELL.water)); expect(tileAt(water, 55, O + N + 3)).toBe(cellIndex(FIXTURE_CELL.water));
      expect(tileAt(water, 55, O + N + E - 1)).toBe(cellIndex(FIXTURE_CELL.water)); expect(tileAt(overlay, O - 1, 45)).toBe(-1);
      // The road reaches the east edge, so this pins the overlay NOT running on — a decal against −1, not −1 against −1.
      expect(tileAt(overlay, O + N - 1, FIXTURE_ROAD_ROW)).toBe(cellIndex(FIXTURE_CELL.road)); expect(tileAt(overlay, O + N, FIXTURE_ROAD_ROW)).toBe(-1);
      expect(base.layer.data).toHaveLength(MN); expect(base.layer.data[0]).toHaveLength(MN);
      expect(tileAt(water, 55, 55)).toBe(cellIndex(FIXTURE_CELL.water)); expect(tileAt(base, 55, 55)).toBe(cellIndex(FIXTURE_CELL.bed));
      // Buying expansions moves the ring outward and turns the old ring into turf; nothing else is touched.
      s.ground.setClaim(fixtureClaim(26)); s.ground.update(view, 16, false);
      expect(s.layers.every(l => l.generateLayerDataTexture.mock.calls.length === 2)).toBe(true);
      expect([FIXTURE_CELL.turf, FIXTURE_CELL.turfAlt].map(cellIndex)).toContain(tileAt(base, claim.min - 1, 15));
      expect(tileAt(base, 1, 15)).toBe(cellIndex(FIXTURE_CELL.edgeFirst + 5));
      expect(tileAt(water, 55, 55)).toBe(cellIndex(FIXTURE_CELL.water));
      s.ground.setClaim({ min: 2, max: 28 }); s.ground.update(view, 16, false); // same rect: no regeneration
      expect(s.layers.every(l => l.generateLayerDataTexture.mock.calls.length === 2)).toBe(true);
      // Far repeat keeps a fixed world phase: the r4 rule, tile position in source
      // texels (period 64 art px over a 64-px asset at 2× → tile scale 2), so a
      // texel at a fixed world point never moves as the camera pans.
      const far = s.tiles[0]!;
      expect(far.setTileScale).toHaveBeenLastCalledWith(2, 2);
      expect(far.tilePositionX).toBe(view.x / 2); expect(far.tilePositionY).toBe(view.y / 2);
      s.ground.update({ ...view, x: view.x + 90 }, 16, false);
      expect(far.tilePositionX).toBe((view.x + 90) / 2);
      expect(far.setPosition).toHaveBeenLastCalledWith(view.x + 90, view.y);
    } finally { s.ground.destroy(); }
  });
  it('pins every animation to frame 0 under reduced motion and advances the shared clock otherwise', async () => {
    const s = await prepared();
    try {
      s.ground.setClaim(fixtureClaim(14));
      s.ground.update(field, 16, true); s.ground.update(field, 500, true);
      // Tile animation runs on the layer timer; reduced motion holds it at 0 (= first frame).
      expect(s.layers.every(l => l.setTimerPaused.mock.calls[0]?.[0] === true && l.resetTimer.mock.calls.at(-1)?.[0] === 0)).toBe(true);
      const oak = s.images[0]!; // 'oak-east' has a two-frame clip from cell 0
      expect(oak.visible).toBe(true); expect(oak.setFrame).toHaveBeenLastCalledWith(0);
      s.ground.update(field, 100, false); s.ground.update(field, 100, false); s.ground.update(field, 100, false); // elapsed 300 (each delta ≤100)
      expect(s.layers.every(l => l.resetTimer.mock.calls.at(-1)?.[0] === 300)).toBe(true);
      expect(oak.setFrame).toHaveBeenLastCalledWith(1); // 300 / 100 mod 2
      s.ground.update(field, 5000, false); // a long stall advances at most 100 ms
      expect(s.layers.every(l => l.resetTimer.mock.calls.at(-1)?.[0] === 400)).toBe(true);
      expect(oak.setFrame).toHaveBeenLastCalledWith(0);
      // A dead oak placement draws its own still cell, never the loop.
      expect(s.images[2]!.setFrame).toHaveBeenLastCalledWith(2);
    } finally { s.ground.destroy(); }
  });
  it('hides everything and does not advance while the tab is hidden or the scene is backgrounded', async () => {
    const s = await prepared();
    try {
      s.ground.setClaim(fixtureClaim(14));
      s.ground.update(view, 100, false); s.ground.update(view, 100, false);
      expect(s.layers[0]!.resetTimer).toHaveBeenLastCalledWith(200);
      (document as unknown as { hidden: boolean }).hidden = true;
      s.ground.update(view, 100, false);
      expect([...s.images, ...s.layers, ...s.tiles, ...s.containers].every(o => !o.visible)).toBe(true);
      (document as unknown as { hidden: boolean }).hidden = false;
      s.ground.update(view, 100, false, true);
      expect([...s.images, ...s.layers, ...s.tiles, ...s.containers].every(o => !o.visible)).toBe(true);
      s.ground.update(view, 100, false);
      expect(s.layers[0]!.resetTimer).toHaveBeenLastCalledWith(300);
      expect([...s.layers, ...s.tiles, ...s.containers].every(o => o.visible)).toBe(true);
    } finally { s.ground.destroy(); }
  });
  it('owns one Tile per field-and-ring cell on a GPU layer, aliases the rest of the margin to the ring and regenerates only that block', async () => {
    const s = await prepared();
    try {
      // A Tile per cell of the 226² extent is 153k objects (~46 MB per realm, 92 with two resident) and a
      // 153k-call regenerate at first paint and on every expansion purchase — a few hundred ms on a phone.
      // The shared rule clamps the margin to the field edge, so on a GPU layer (which Phaser reads only
      // through generateLayerDataTexture, index and flip flags) the field plus its one-tile ring is the
      // whole set of distinct objects and the whole walk; every farther cell IS its nearest ring cell.
      const claim = fixtureClaim(14), block = (N + 2) ** 2;
      s.ground.setClaim(claim); vi.mocked(realmKitCell).mockClear();
      s.ground.update(view, 16, false);
      expect(vi.mocked(realmKitCell)).toHaveBeenCalledTimes(s.layers.length * block);
      const cellIndex = (cell: number) => { if (!cell) return -1; const c = s.manifest.ground.cells[cell - 1]!; return c.y / 32 * 8 + c.x / 32; };
      for (const layer of s.layers) {
        const rows = layer.layer.data as { index: number }[][];
        expect(new Set(rows.flat()).size).toBe(block);
        expect(rows[0]![0]).toBe(rows[E - 1]![E - 1]); expect(rows[MN - 1]![20]).toBe(rows[E + N]![20]); // corner and south strip alias the ring
        expect(rows[E]![E]).not.toBe(rows[E - 1]![E]); // the field owns its own tiles
        // The aliasing must be exactly what the shared clamp answers at EVERY cell of the extent, overlay
        // included (its margin is empty, not a repeat of the field's last decal row).
        let mismatches = 0;
        for (let ty = 0; ty < MN; ty++) for (let tx = 0; tx < MN; tx++) {
          if (rows[ty]![tx]!.index !== cellIndex(realmKitCell(s.manifest, claim, layer.id as 'water' | 'base' | 'overlay', tx + MO, ty + MO))) mismatches++;
        }
        expect(mismatches).toBe(0);
      }
      // An expansion purchase regenerates the same block, never the extent.
      vi.mocked(realmKitCell).mockClear(); s.ground.setClaim(fixtureClaim(26)); s.ground.update(view, 16, false);
      expect(vi.mocked(realmKitCell)).toHaveBeenCalledTimes(s.layers.length * block);
    } finally { s.ground.destroy(); }
  });
  it('falls back to a culled classic TilemapLayer when the renderer is not WebGL or the GPU layer cannot be built', async () => {
    for (const [rendererType, gpuFails] of [[1, false], [2, true]] as const) {
      const s = await prepared(rendererType, gpuFails);
      try {
        expect(s.ground.primitive).toBe('classic');
        // The classic layer culls from its own transform, so it is seated directly at the field origin at 2×.
        expect(s.layers.every(l => l.gpu === false && l.x === MO * 64 && l.y === MO * 64 && l.setScale.mock.calls[0]?.[0] === 2
          && l.setSkipCull.mock.calls[0]?.[0] === false)).toBe(true);
        expect(s.containers).toHaveLength(0);
        s.ground.setClaim(fixtureClaim(14)); s.ground.update(view, 16, false);
        expect(tileAt(s.layers[1]!, 15, 15)).not.toBe(-1);
        expect(s.layers.every(l => l.visible)).toBe(true);
        // Its culler and renderer read each tile's own position, so the classic layer owns every cell of the
        // extent (no aliasing) and the whole extent is walked; the margin is still the shared clamp.
        expect(s.layers.every(l => new Set(l.layer.data.flat()).size === MN * MN)).toBe(true);
        const water = s.manifest.ground.cells[FIXTURE_CELL.water - 1]!;
        expect(tileAt(s.layers[0]!, 55, O + N + 3)).toBe(water.y / 32 * 8 + water.x / 32); expect(tileAt(s.layers[2]!, O - 1, 45)).toBe(-1);
      } finally { s.ground.destroy(); }
    }
  });
  it('registers animated cells as Tiled-shaped tileset animations so the GPU layer loops them from the shared cell table', async () => {
    const s = await prepared();
    try {
      const tileset = s.maps[0]!.addTilesetImage.mock.results[0]!.value;
      const water = s.manifest.ground.cells[FIXTURE_CELL.water - 1]!, first = water.y / 32 * 8 + water.x / 32;
      expect(tileset.tileData[first]).toEqual({ animationDuration: 1000,
        animation: [0, 1, 2, 3].map(f => ({ tileid: first + f, duration: 250, startTime: f * 250 })) });
      expect(Object.keys(tileset.tileData)).toEqual([String(first)]);
    } finally { s.ground.destroy(); }
  });
  it('answers E-11 obstacle lookups from the kit sheet with the sheet seat, and leaves unmapped keys to dec_', async () => {
    const s = await prepared();
    try {
      // A plot row (no kit prop seated on 10,10): the tier twin at frame 0.
      const oak = s.ground.obstacleSprite('tree_old', 'intact', 10, 10);
      expect(oak).toEqual({ key: expect.stringMatching(/^realm-kit-\d+-[0-9a-f]{64}$/), frame: 0, origin: [0.5, 1], scale: 2 });
      expect(s.ground.obstacleSprite('tree_old', 'clearing', 10, 10)).toEqual(oak); // no clearing sprite: intact stands in
      expect(s.ground.obstacleSprite('tree_old', 'remnant', 10, 10)?.key).not.toBe(oak!.key);
      expect(s.ground.obstacleSprite('bush', 'intact', 12, 12)).toBeUndefined();
      expect(s.ground.obstacleSprite('dragon', 'intact', 12, 12)).toBeUndefined(); // unknown key: the scene's dec_rock_s fallback, never a throw mid-render
    } finally { s.ground.destroy(); }
    expect(s.ground.obstacleSprite('tree_old', 'intact', 10, 10)).toBeUndefined();
  });
  it('draws an expansion obstacle as the prop it was: the seated still and its own frame, never the tier twin (E-11 expansion obstacles)', async () => {
    // WHY: the server seats 'oak-frame-east' (sheet cell 3 on tile 30,15) as a pine2 row once the
    // claim owns tile 30. The fixture maps no pine2 twin, so a tile-blind lookup would hand the
    // row to `dec_pine_2` and the tree would change species the moment the land was bought.
    const s = await prepared();
    try {
      const seated = s.ground.obstacleSprite('pine2', 'intact', 30, 15);
      expect(seated).toEqual({ key: expect.stringMatching(/^realm-kit-\d+-[0-9a-f]{64}$/), frame: 3, origin: [0.5, 1], scale: 2 });
      expect(seated!.key).toBe(s.ground.obstacleSprite('tree_old', 'intact', 10, 10)!.key); // the oak sheet, cell 3 not cell 0
      expect(s.ground.obstacleSprite('pine2', 'clearing', 30, 15)).toEqual(seated);
      // The remnant is the tier twin (unmapped here → dec_), and a row of another kind on that seat is not the oak's.
      expect(s.ground.obstacleSprite('pine2', 'remnant', 30, 15)).toBeUndefined();
      expect(s.ground.obstacleSprite('pine1', 'intact', 30, 15)).toBeUndefined();
      expect(s.ground.obstacleSprite('pine2', 'intact', 31, 15)).toBeUndefined();
    } finally { s.ground.destroy(); }
  });
  it('clears a baked frame prop once the claim plus its edge ring reaches its seat tile, whatever the motion mode (E-6 amended)', async () => {
    const s = await prepared();
    try {
      // Images are created in manifest order; 'oak-frame-east' is seated on protected-frame tile (30,15).
      const image = (id: string) => s.images[s.manifest.placements.findIndex(p => p.id === id)]!;
      const frameOak = image('oak-frame-east'), oak = image('oak-east');
      // The 14- and 26-tile claims ([8,22) and [2,28)) end short of tile 30 even with their ring: the oak stands.
      for (const tiles of [14, 26]) {
        s.ground.setClaim(fixtureClaim(tiles)); s.ground.update(field, 16, false);
        expect(frameOak.visible, `claim ${tiles}`).toBe(true); expect(oak.visible).toBe(true);
      }
      // A 30-tile claim is [0,30): its one-tile ring reaches tile 30, so the land under
      // the oak is owned land and the tree is cleared — while 'oak-east' at (46,46) stays.
      s.ground.setClaim(fixtureClaim(30)); s.ground.update(field, 16, false);
      expect(frameOak.setVisible).toHaveBeenLastCalledWith(false); expect(frameOak.visible).toBe(false);
      expect(oak.visible).toBe(true);
      // Reduced motion pins frames; it never decides which props exist.
      s.ground.update(field, 16, true);
      expect(frameOak.visible).toBe(false); expect(oak.visible).toBe(true);
      // Background hides the whole ground; coming back to the foreground gives the same answer.
      s.ground.update(field, 16, false, true);
      expect(frameOak.visible).toBe(false); expect(oak.visible).toBe(false);
      s.ground.update(field, 16, false);
      expect(frameOak.visible).toBe(false); expect(oak.visible).toBe(true);
      // The rule is the claim, not history: a smaller claim shows the oak again.
      s.ground.setClaim(fixtureClaim(26)); s.ground.update(field, 16, false);
      expect(frameOak.visible).toBe(true); expect(oak.visible).toBe(true);
    } finally { s.ground.destroy(); }
  });
  it('walks every creature along its path on the kit clock, facing row by facing row, and hides it with the ground (D-173 creature paths)', async () => {
    // WHY: owner 2026-09-21 — the animals on base were static decals; they must move to all sides. The
    // pose is the shared realmKitPathPlan at the ground's own elapsed clock, so a deer stands where native
    // and the deed put it at the same clock; the sheet cell is the facing row × frames + walk frame.
    const s = await prepared();
    try {
      const image = (id: string) => s.images[s.manifest.placements.length + s.manifest.paths.findIndex(p => p.id === id)]!;
      const hare = image('hare-walk'), pace = image('hare-pace'), gulls = image('gulls');
      s.ground.setClaim(fixtureClaim(14)); s.ground.update(field, 0, false);
      // Clock 0: dwelling at the first corner, facing right (row 2), frame 0 → cell 4, at (1500,−900) art px → 64 px/tile.
      expect(hare.visible).toBe(true); expect(hare.setFrame).toHaveBeenLastCalledWith(4);
      expect(hare.setPosition).toHaveBeenLastCalledWith((1500 - 8) * 2, (-900 - 16) * 2); expect(hare.setDisplaySize).toHaveBeenLastCalledWith(32, 32);
      expect(gulls.visible).toBe(true); expect(gulls.setFrame).toHaveBeenLastCalledWith(0);
      // Seven 100 ms updates: clock 700, the hare has left the corner (500 ms dwell) and walked 20 px east on frame 1.
      for (let i = 0; i < 7; i++) s.ground.update(field, 100, false);
      const plan = realmKitPathPlan(s.manifest, 64, field, 700, false);
      expect(hare.setPosition).toHaveBeenLastCalledWith((1520 - 8) * 2, (-900 - 16) * 2); expect(hare.setFrame).toHaveBeenLastCalledWith(5);
      expect(hare.setPosition).toHaveBeenLastCalledWith(plan.find(d => d.id === 'hare-walk')!.destination.x, plan.find(d => d.id === 'hare-walk')!.destination.y);
      expect(pace.setFrame).toHaveBeenLastCalledWith(plan.find(d => d.id === 'hare-pace')!.frame);
      // Clock 2500: the second corner, facing down (row 0) on frame 0; every corner faces its next side.
      for (let i = 0; i < 18; i++) s.ground.update(field, 100, false);
      expect(hare.setFrame).toHaveBeenLastCalledWith(0); expect(hare.setPosition).toHaveBeenLastCalledWith((1700 - 8) * 2, (-900 - 16) * 2);
      // Reduced motion pins the first vertex and frame 0 of the first facing whatever the clock; the clock does not advance.
      s.ground.update(field, 100, true);
      expect(hare.setFrame).toHaveBeenLastCalledWith(4); expect(hare.setPosition).toHaveBeenLastCalledWith((1500 - 8) * 2, (-900 - 16) * 2);
      s.ground.update(field, 100, false);
      expect(hare.setPosition).toHaveBeenLastCalledWith((1700 - 8) * 2, (-900 - 16) * 2); // still 2600: dwelling at the corner
      // Background or a hidden tab hides the creatures with everything else; culling hides one out of view.
      s.ground.update(field, 100, false, true);
      expect([hare, pace, gulls].every(i => !i.visible)).toBe(true);
      const at = realmKitPathPlan(s.manifest, 64, field, 2700, false).find(d => d.id === 'hare-pace')!.destination; // clock 2700 (background never advanced it)
      s.ground.update({ x: at.x + 5, y: at.y + 5, width: 10, height: 10 }, 100, false);
      expect(pace.visible).toBe(true); expect(hare.visible).toBe(false); expect(gulls.visible).toBe(false);
      expect(pace.setPosition).toHaveBeenLastCalledWith(at.x, at.y);
    } finally { s.ground.destroy(); }
  });
  it('sorts a creature with the props by its feet: behind a tree it walks north of, in front of one it walks south of, never above the birds', async () => {
    // WHY: web depth, native draw order and the deed rasterizer share realmKitGroundBandPlan; a creature that
    // sorted by layer alone would stand on top of the bush it walks behind.
    const s = await prepared();
    try {
      const image = (id: string) => s.images[s.manifest.placements.length + s.manifest.paths.findIndex(p => p.id === id)]!;
      const oakDepth = s.images[0]!.setDepth.mock.calls[0]![0] as number; // oak-east, seat row 1500
      const pace = image('hare-pace'), gulls = image('gulls');
      s.ground.setClaim(fixtureClaim(14)); s.ground.update(field, 0, false);
      // Clock 0: hare-pace at y 1500 = the oak's seat row. The shared plan draws props before paths on an
      // equal row, so the creature's depth is STRICTLY above the oak's and below the next row's (row 1501 =
      // oakDepth + 1e-6) — never equal: Phaser 4.1 depthSort is a StableSort of the LAST frame's list, not
      // creation order, so an equal depth would leave a rabbit that walked south onto the seat under the canopy
      // for its whole dwell on web while native and the deed draw it in front.
      const paceAtSeat = pace.setDepth.mock.calls.at(-1)![0] as number;
      expect(paceAtSeat).toBeGreaterThan(oakDepth); expect(paceAtSeat).toBeLessThan(oakDepth + 1e-6);
      for (let i = 0; i < 7; i++) s.ground.update(field, 100, false); // clock 700: y 1566, south of the seat
      expect(pace.setDepth.mock.calls.at(-1)![0]).toBeGreaterThan(oakDepth);
      expect(pace.setDepth.mock.calls.at(-1)![0]).toBeLessThan(oakDepth + 0.001);
      // The band order the depths express is the shared plan's: props and creatures interleaved by their feet.
      const band = realmKitGroundBandPlan(s.manifest, 64, field, fixtureClaim(14), 700, false).map(d => d.id);
      const depthOf = (id: string) => { const i = s.manifest.placements.findIndex(p => p.id === id); return (i >= 0 ? s.images[i]! : image(id)).setDepth.mock.calls.at(-1)![0] as number; };
      for (let i = 1; i < band.length; i++) expect(depthOf(band[i]!), `${band[i - 1]} before ${band[i]}`).toBeGreaterThanOrEqual(depthOf(band[i - 1]!));
      // The gulls fly a whole band above.
      expect(gulls.setDepth.mock.calls.at(-1)![0]).toBeGreaterThan(oakDepth + 1);
      // A creature north of the tree's seat sinks behind it, and two creatures dwelling on the oak's own row
      // stack in manifest order above it (hare-walk before hare-pace, both under row 1501) — the shared plan's
      // (band, row, order) sort as depths, so the pair never swaps with the direction they arrived from.
      const north = manifestWithBytes(); north.manifest.paths[2]!.points = [{ x: 1500, y: 1490 }, { x: 1500, y: 1400 }];
      north.manifest.paths[1]!.points = [{ x: 1400, y: 1500 }, { x: 1450, y: 1500 }]; north.manifest.paths[3]!.points = [{ x: 1550, y: 1500 }, { x: 1580, y: 1500 }];
      serve(north.manifest, north.bytes);
      const s2 = scene(); const g2 = await RealmKitGround.prepare(s2.host as unknown as Phaser.Scene, north.manifest, 64, new AbortController().signal, undefined, true);
      try {
        g2.setClaim(fixtureClaim(14)); g2.update(field, 0, false);
        const creature = (index: number) => s2.images[north.manifest.placements.length + index]!.setDepth.mock.calls.at(-1)![0] as number;
        const paceNorth = creature(2), oak2 = s2.images[0]!.setDepth.mock.calls[0]![0] as number;
        expect(paceNorth).toBeLessThan(oak2); expect(paceNorth).toBeGreaterThan(oak2 - 0.001);
        const walkAtSeat = creature(1), cornerAtSeat = creature(3);
        expect(walkAtSeat).toBeGreaterThan(oak2); expect(cornerAtSeat).toBeGreaterThan(walkAtSeat); expect(cornerAtSeat).toBeLessThan(oak2 + 1e-6);
        const band2 = realmKitGroundBandPlan(north.manifest, 64, field, fixtureClaim(14), 0, false).map(d => d.id);
        expect(band2.indexOf('oak-east')).toBeLessThan(band2.indexOf('hare-walk')); expect(band2.indexOf('hare-walk')).toBeLessThan(band2.indexOf('hare-corner'));
      } finally { g2.destroy(); }
    } finally { s.ground.destroy(); }
  });
});
