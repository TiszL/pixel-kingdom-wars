/** Revision 3 layered presentation; historical painted-ground readers stay separate.
 * Coordinates are source-art pixels, never simulation units or collision data.
 * Keep this module on its own subpath: manifests do not belong in first paint. */
import { isRealmId, type RealmId } from './baseVisual';

export const LAYERED_GROUND_LIMITS = Object.freeze({
  compressedBytes: 2 * 1024 * 1024, rgbaBytes: 16 * 1024 * 1024,
  residentRealms: 2, assets: 16, placements: 1024, dimension: 2048,
});
export interface LayeredRect { x: number; y: number; width: number; height: number }
export interface LayeredAsset {
  id: string; path: string; sha256: string; size: number; width: number; height: number;
  frameWidth: number; frameHeight: number; frameCount: number; frameDurationMs: number;
  anchor: { x: number; y: number }; reducedMotionFrame: 0;
}
export interface LayeredPlacement {
  id: string; asset: string; x: number; y: number; width: number; height: number;
  layer: number; phaseFrame: number; animated: boolean; interactive: false;
}
interface LayeredGroundCommon { realmId: RealmId; status: 'preview-only' | 'accepted'; tilePixels: 32;
  field: LayeredRect; protectedFrame: LayeredRect;
  assets: LayeredAsset[]; placements: LayeredPlacement[];
}
export interface LayeredGroundManifestV3 extends LayeredGroundCommon {
  schemaVersion: 1; groundRevision: 3;
  ground: { asset: string; sampling: 'repeat' | 'world' };
}
export interface LayeredGroundManifestV4 extends LayeredGroundCommon {
  schemaVersion: 2; groundRevision: 4;
  ground: {
    asset: string; sampling: 'world'; centerRect: LayeredRect;
    exterior: { asset: string; rect: LayeredRect };
    far: { asset: string; origin: { x: number; y: number }; period: { width: number; height: number } };
  };
}
export type LayeredGroundManifest = LayeredGroundManifestV3 | LayeredGroundManifestV4;
function fail(): never { throw new Error('Invalid layered ground manifest'); }
const integer = (v: unknown, lo: number, hi: number): v is number => Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi;
const coordinate = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function layeredIntersects(a: LayeredRect, b: LayeredRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
export function layeredPlacementBounds(p: LayeredPlacement, a: LayeredAsset): LayeredRect {
  return { x: p.x - a.anchor.x * p.width / a.frameWidth, y: p.y - a.anchor.y * p.height / a.frameHeight, width: p.width, height: p.height };
}
/** Validate before opening files, allocating pixels, or admitting upload work. */
export function assertLayeredGroundManifest(value: unknown): asserts value is LayeredGroundManifest {
  if (!object(value) || !((value.schemaVersion === 1 && value.groundRevision === 3) || (value.schemaVersion === 2 && value.groundRevision === 4)) || !isRealmId(value.realmId)
    || !['preview-only', 'accepted'].includes(value.status as string) || value.tilePixels !== 32) fail();
  const m = value as unknown as LayeredGroundManifest;
  if (!object(m.field) || !object(m.protectedFrame) || !object(m.ground)
    || m.field.x !== -1088 || m.field.y !== -1088 || m.field.width !== 3136 || m.field.height !== 3136
    || !integer(m.protectedFrame.width, 1472, m.field.width) || m.protectedFrame.width % m.tilePixels !== 0
    || m.protectedFrame.height !== m.protectedFrame.width
    || m.protectedFrame.x !== (960 - m.protectedFrame.width) / 2 || m.protectedFrame.y !== m.protectedFrame.x
    || !['repeat', 'world'].includes(m.ground.sampling) || !Array.isArray(m.assets) || !Array.isArray(m.placements)
    || !m.assets.length || m.assets.length > LAYERED_GROUND_LIMITS.assets || m.placements.length > LAYERED_GROUND_LIMITS.placements) fail();
  // A declared centered clean frame can grow without moving historical artwork.
  // This is visual exclusion metadata, not unlocked land or deployment policy.
  const assets = new Map<string, LayeredAsset>();
  let size = 0, rgba = 0;
  for (const a of m.assets) {
    if (!object(a) || typeof a.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(a.id) || assets.has(a.id)
      || typeof a.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(a.sha256)
      || (a.path !== `atlas/fantasy/layered-ground/assets/${a.sha256}.png` && a.path !== `atlas/fantasy/layered-ground/assets/${a.sha256}.webp`)
      || !integer(a.size, 1, LAYERED_GROUND_LIMITS.compressedBytes)
      || ![a.width, a.height, a.frameWidth, a.frameHeight].every(n => integer(n, 1, LAYERED_GROUND_LIMITS.dimension))
      || !integer(a.frameCount, 1, 64) || !integer(a.frameDurationMs, 50, 10000)
      || a.width % a.frameWidth || a.height % a.frameHeight || a.width / a.frameWidth * (a.height / a.frameHeight) !== a.frameCount
      || !object(a.anchor) || !integer(a.anchor.x, 0, a.frameWidth) || !integer(a.anchor.y, 0, a.frameHeight)
      || a.reducedMotionFrame !== 0) fail();
    assets.set(a.id, a); size += a.size; rgba += a.width * a.height * 4;
  }
  if (size > LAYERED_GROUND_LIMITS.compressedBytes || rgba > LAYERED_GROUND_LIMITS.rgbaBytes
    || new Set(m.assets.map(a => a.path)).size !== m.assets.length || assets.get(m.ground.asset)?.frameCount !== 1) fail();
  if (m.groundRevision === 4) {
    const g = m.ground;
    const far = assets.get(g.far?.asset);
    const powerOfTwo = (n: number) => (n & (n - 1)) === 0;
    const rect = (r: unknown): r is LayeredRect => object(r)
      && coordinate(r.x, -16384, 16384) && coordinate(r.y, -16384, 16384)
      && coordinate(r.width, 1, 16384) && coordinate(r.height, 1, 16384);
    const contains = (a: LayeredRect, b: LayeredRect) => a.x <= b.x && a.y <= b.y
      && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;
    if (g.sampling !== 'world' || !rect(g.centerRect) || !contains(g.centerRect, m.field)
      || !object(g.exterior) || !rect(g.exterior.rect) || !contains(g.exterior.rect, g.centerRect)
      || !object(g.far) || !object(g.far.origin) || !object(g.far.period)
      || ![g.far.origin.x, g.far.origin.y].every(n => coordinate(n, -16384, 16384))
      || ![g.far.period.width, g.far.period.height].every(n => coordinate(n, 32, 16384))
      || new Set([g.asset, g.exterior.asset, g.far.asset]).size !== 3
      || assets.get(g.exterior.asset)?.frameCount !== 1 || far?.frameCount !== 1
      || !powerOfTwo(far.width) || !powerOfTwo(far.height)
      || m.protectedFrame.x !== -320 || m.protectedFrame.y !== -320
      || m.protectedFrame.width !== 1600 || m.protectedFrame.height !== 1600
      || size + new TextEncoder().encode(JSON.stringify(m) + '\n').byteLength > LAYERED_GROUND_LIMITS.compressedBytes) fail();
  }
  const ids = new Set<string>();
  for (const p of m.placements) {
    if (!object(p) || typeof p.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(p.id) || ids.has(p.id)
      || ![p.x, p.y].every(n => coordinate(n, -4096, 4096)) || ![p.width, p.height].every(n => coordinate(n, 1, 2048))
      || !integer(p.layer, 0, 15) || typeof p.animated !== 'boolean' || p.interactive !== false) fail();
    const a = assets.get(p.asset);
    if (!a || a.id === m.ground.asset || (m.groundRevision === 4 && [m.ground.exterior.asset, m.ground.far.asset].includes(a.id)) || !integer(p.phaseFrame, 0, a.frameCount - 1)) fail();
    const b = layeredPlacementBounds(p, a);
    if (b.x < m.field.x || b.y < m.field.y || b.x + b.width > m.field.x + m.field.width
      || b.y + b.height > m.field.y + m.field.height || layeredIntersects(b, m.protectedFrame)) fail();
    ids.add(p.id);
  }
}
export interface LayeredDraw { id: string; asset: LayeredAsset; frame: number; source: LayeredRect; destination: LayeredRect;
  flipX?: boolean; flipY?: boolean;
  /** One repeated-material primitive; origin/period are renderer-world units. */
  repeat?: { origin: { x: number; y: number }; period: { width: number; height: number } };
}
/** Only complete texels within the declared clean frame may repeat outside the
 * painting. Inward rounding keeps scenery out at noninteger art/world scales. */
export function layeredCleanGroundCrop(m: LayeredGroundManifest): LayeredRect {
  const a = m.assets.find(a => a.id === m.ground.asset)!, f = m.groundRevision === 4 ? m.ground.centerRect : m.field, p = m.protectedFrame;
  const x = Math.ceil((p.x - f.x) * a.width / f.width), y = Math.ceil((p.y - f.y) * a.height / f.height);
  const width = Math.floor((p.x + p.width - f.x) * a.width / f.width) - x;
  const height = Math.floor((p.y + p.height - f.y) * a.height / f.height) - y;
  if (width < 1 || height < 1) fail();
  return { x, y, width, height };
}
/** Reuse clean material at its authored pixel scale and fixed world phase.
 * Exterior quads stop at the field (not the viewport), keeping source frames
 * integer and finite while panning. The approved painting is one unchanged draw. */
export function layeredFloorPlan(m: LayeredGroundManifest, tilePixels: number, view: LayeredRect): LayeredDraw[] {
  if (![tilePixels, view.x, view.y, view.width, view.height].every(Number.isFinite)
    || tilePixels <= 0 || view.width <= 0 || view.height <= 0) fail();
  if (m.groundRevision === 4) {
    const g = m.ground, scale = tilePixels / m.tilePixels;
    const asset = (id: string) => m.assets.find(a => a.id === id)!;
    const far = asset(g.far.asset);
    const out: LayeredDraw[] = [{ id: 'floor-far', asset: far, frame: 0,
      source: { x: 0, y: 0, width: far.width, height: far.height }, destination: { ...view },
      repeat: { origin: { x: g.far.origin.x * scale, y: g.far.origin.y * scale },
        period: { width: g.far.period.width * scale, height: g.far.period.height * scale } } }];
    for (const [id, key, rect] of [['floor-exterior', g.exterior.asset, g.exterior.rect],
      ['floor-center', g.asset, g.centerRect]] as const) {
      const a = asset(key), destination = { x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale };
      if (layeredIntersects(destination, view)) out.push({ id, asset: a, frame: 0,
        source: { x: 0, y: 0, width: a.width, height: a.height }, destination });
    }
    return out;
  }
  const a = m.assets.find(a => a.id === m.ground.asset)!, f = m.field, scale = tilePixels / m.tilePixels;
  const crop = layeredCleanGroundCrop(m), ux = f.width * scale / a.width, uy = f.height * scale / a.height;
  const x0 = Math.floor(((view.x - f.x * scale) / ux - crop.x) / crop.width);
  const y0 = Math.floor(((view.y - f.y * scale) / uy - crop.y) / crop.height);
  const x1 = Math.ceil(((view.x + view.width - f.x * scale) / ux - crop.x) / crop.width);
  const y1 = Math.ceil(((view.y + view.height - f.y * scale) / uy - crop.y) / crop.height);
  if (![x0, y0, x1, y1].every(Number.isSafeInteger) || (x1 - x0) * (y1 - y0) > 1024) fail();
  const out: LayeredDraw[] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const tx = crop.x + x * crop.width, ty = crop.y + y * crop.height;
    const bottom = ty + crop.height, right = tx + crop.width;
    const middle = Math.max(ty, 0), middleEnd = Math.min(bottom, a.height);
    const parts = [
      { x: tx, y: ty, width: crop.width, height: Math.min(bottom, 0) - ty },
      { x: tx, y: Math.max(ty, a.height), width: crop.width, height: bottom - Math.max(ty, a.height) },
      { x: tx, y: middle, width: Math.min(right, 0) - tx, height: middleEnd - middle },
      { x: Math.max(tx, a.width), y: middle, width: right - Math.max(tx, a.width), height: middleEnd - middle },
    ];
    parts.forEach((p, part) => {
      if (p.width <= 0 || p.height <= 0) return;
      const destination = { x: f.x * scale + p.x * ux, y: f.y * scale + p.y * uy, width: p.width * ux, height: p.height * uy };
      if (!layeredIntersects(destination, view)) return;
      out.push({ id: `floor-${x}-${y}-${part}`, asset: a, frame: 0,
        source: { x: crop.x + p.x - tx, y: crop.y + p.y - ty, width: p.width, height: p.height }, destination });
      if (out.length > 1024) fail();
    });
  }
  const destination = { x: f.x * scale, y: f.y * scale, width: f.width * scale, height: f.height * scale };
  if (layeredIntersects(destination, view)) out.push({ id: 'floor-c-c', asset: a, frame: 0,
    source: { x: 0, y: 0, width: a.width, height: a.height }, destination });
  if (out.length > 1024) fail();
  return out;
}
/** Both axes must select clean material when either coordinate is outside the
 * painting; retaining an in-field scenic axis repeats trees along long edges. */
function cleanGroundIndex(index: number, start: number, size: number): number {
  return start + ((index - start) % size + size) % size;
}
/** Culls before selecting frames. Elapsed time advances only while foregrounded;
 * callers retain the last valid scene during bounded preparation of a replacement. */
export function layeredDrawPlan(m: LayeredGroundManifest, tilePixels: number, view: LayeredRect,
  elapsedMs: number, reducedMotion: boolean, background = false): LayeredDraw[] {
  if (background) return [];
  if (!Number.isFinite(tilePixels) || tilePixels <= 0 || !Number.isFinite(elapsedMs) || elapsedMs < 0) fail();
  const scale = tilePixels / m.tilePixels;
  const assets = new Map(m.assets.map(a => [a.id, a]));
  return m.placements.map((p, order) => ({ p, order })).sort((a, b) => a.p.layer - b.p.layer || a.order - b.order).flatMap(({ p }) => {
    const a = assets.get(p.asset)!; const b = layeredPlacementBounds(p, a);
    const destination = { x: b.x * scale, y: b.y * scale, width: b.width * scale, height: b.height * scale };
    if (!layeredIntersects(destination, view)) return [];
    const frame = reducedMotion || !p.animated ? 0 : (Math.floor(elapsedMs / a.frameDurationMs) + p.phaseFrame) % a.frameCount;
    const columns = a.width / a.frameWidth;
    return [{ id: p.id, asset: a, frame, destination, source: { x: (frame % columns) * a.frameWidth,
      y: Math.floor(frame / columns) * a.frameHeight, width: a.frameWidth, height: a.frameHeight } }];
  });
}
export interface LayeredPixels { width: number; height: number; data: Uint8Array | Uint8ClampedArray }
/** Validate decoded admission too: the far floor is opaque, collars are clear,
 * and transparent exterior scenery cannot show through the approved centre. */
export function assertLayeredGroundAssetPixels(m: LayeredGroundManifest, a: LayeredAsset, p: LayeredPixels): void {
  if (p.width !== a.width || p.height !== a.height || p.data.length !== a.width * a.height * 4) fail();
  if (m.groundRevision === 3) {
    if (a.id === m.ground.asset) for (let i = 3; i < p.data.length; i += 4) if (p.data[i] !== 255) fail();
    return;
  }
  const g = m.ground;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const alpha = p.data[(y * a.width + x) * 4 + 3];
    if (a.id === g.far.asset && alpha !== 255) fail();
    if ((a.id === g.asset || a.id === g.exterior.asset)
      && (x === 0 || y === 0 || x === a.width - 1 || y === a.height - 1) && alpha !== 0) fail();
    if (a.id === g.asset) {
      const wx = g.centerRect.x + (x + .5) * g.centerRect.width / a.width;
      const wy = g.centerRect.y + (y + .5) * g.centerRect.height / a.height;
      if (wx >= m.field.x && wy >= m.field.y && wx < m.field.x + m.field.width && wy < m.field.y + m.field.height && alpha !== 255) fail();
    }
  }
}
/** Canonical static thumbnail/deed crop. Frame zero and the same anchor math as
 * both clients; this does not mutate or route historical ground crop readers. */
export function renderLayeredGroundPixels(m: LayeredGroundManifest, pixels: ReadonlyMap<string, LayeredPixels>,
  width: number, height: number, originX = 0, originY = 0): Uint8ClampedArray {
  assertLayeredGroundManifest(m);
  if (![width, height].every(n => integer(n, 1, 4096)) || ![originX, originY].every(Number.isFinite)) fail();
  for (const a of m.assets) {
    const p = pixels.get(a.id);
    if (!p || p.width !== a.width || p.height !== a.height || p.data.length !== a.width * a.height * 4) fail();
  }
  const result = new Uint8ClampedArray(width * height * 4), ground = pixels.get(m.ground.asset)!;
  const mod = (n: number, size: number) => ((n % size) + size) % size;
  const crop = m.groundRevision === 3 && m.ground.sampling === 'world' ? layeredCleanGroundCrop(m) : undefined;
  if (m.groundRevision === 3) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const wx = originX + x, wy = originY + y, f = m.field;
    const ix = Math.floor((wx - f.x) * ground.width / f.width), iy = Math.floor((wy - f.y) * ground.height / f.height);
    const outside = ix < 0 || iy < 0 || ix >= ground.width || iy >= ground.height;
    const sx = !crop ? mod(Math.floor(wx), ground.width) : outside ? cleanGroundIndex(ix, crop.x, crop.width) : ix;
    const sy = !crop ? mod(Math.floor(wy), ground.height) : outside ? cleanGroundIndex(iy, crop.y, crop.height) : iy;
    const src = (sy * ground.width + sx) * 4, dst = (y * width + x) * 4;
    result.set(ground.data.subarray(src, src + 4), dst);
  }
  const view = { x: originX, y: originY, width, height };
  const floors = m.groundRevision === 4 ? layeredFloorPlan(m, m.tilePixels, view) : [];
  for (const draw of [...floors, ...layeredDrawPlan(m, m.tilePixels, view, 0, true)]) {
    const p = pixels.get(draw.asset.id)!, b = draw.destination;
    for (let y = Math.max(0, Math.ceil(b.y - originY)); y < Math.min(height, Math.ceil(b.y + b.height - originY)); y++) {
      for (let x = Math.max(0, Math.ceil(b.x - originX)); x < Math.min(width, Math.ceil(b.x + b.width - originX)); x++) {
        const sx = draw.repeat ? mod(Math.floor((originX + x - draw.repeat.origin.x) * p.width / draw.repeat.period.width), p.width)
          : Math.floor((originX + x - b.x) * draw.source.width / b.width);
        const sy = draw.repeat ? mod(Math.floor((originY + y - draw.repeat.origin.y) * p.height / draw.repeat.period.height), p.height)
          : Math.floor((originY + y - b.y) * draw.source.height / b.height);
        const src = ((sy + draw.source.y) * p.width + sx + draw.source.x) * 4, dst = (y * width + x) * 4;
        const alpha = p.data[src + 3]!;
        for (let c = 0; c < 3; c++) result[dst + c] = Math.floor((p.data[src + c]! * alpha + result[dst + c]! * (255 - alpha) + 127) / 255);
        result[dst + 3] = alpha + Math.floor((result[dst + 3]! * (255 - alpha) + 127) / 255);
      }
    }
  }
  return result;
}
