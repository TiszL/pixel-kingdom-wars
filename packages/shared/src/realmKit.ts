/** Revision 5 realm environment kit: the shared contract for tile-based realm
 * ground (docs/REALM-KIT-PLAN.md §2–§3, D-173). Every function here is pure and
 * integer-safe — web, the Kotlin mirror and the deed renderer run the same rule,
 * so one kingdom looks identical everywhere. Coordinates are source-art pixels
 * (32 px per tile) or plot tiles, never simulation units or collision data.
 * Subpath export only, never the barrel: cell tables do not belong in first paint. */
import { isRealmId, type RealmId } from './baseVisual';
import { GRID, LAYERED_GROUND_LIMITS_R5, OBSTACLES, REALM_KIT } from './constants';
import { layeredIntersects, layeredPlacementBounds,
  type LayeredAsset, type LayeredDraw, type LayeredPixels, type LayeredPlacement, type LayeredRect } from './layeredGround';

export type RealmKitLayerId = 'water' | 'base' | 'overlay';
export const REALM_KIT_LAYER_IDS: readonly RealmKitLayerId[] = Object.freeze(['water', 'base', 'overlay']);
/** One 32-px cell of the tileset; animated cells lay their frames left→right, 32 px apart. */
export interface RealmKitCell { asset: string; x: number; y: number; frames?: number; frameDurationMs?: number }
export interface RealmKitLayer { id: RealmKitLayerId; rle: string }
export interface RealmKitSpriteStates { intact: string; clearing?: string; remnant: string }
/** An animated prop's loop: `frames` consecutive sheet cells starting at the placement's `frame`. */
export interface RealmKitClip { frames: number; frameDurationMs: number }
/** REALM-KIT-PLAN §7: props are packed by canvas size into uniform-cell sheets, so a
 * placement names its cell. `frame` is the still (default 0); `clip` is present iff
 * `animated`, and reduced motion draws `frame`. The r4 `phaseFrame` is accepted for
 * shape compatibility but must be 0: the loop start is `frame`, never a phase.
 * E-11 (D-173 expansion obstacles): `prop` is the kit prop id the builder placed
 * (dashed; the id prefix when absent) and `footprint` its tile footprint [w, h]
 * (1×1 when absent) — what realmKitObstacles.ts reads to turn a prop the claim
 * reached into a clearable server row of the same species. */
export interface RealmKitPlacement extends LayeredPlacement {
  states?: RealmKitSpriteStates; frame?: number; clip?: RealmKitClip; prop?: string; footprint?: [number, number];
}
/** The eight server obstacle sprite keys (constants OBSTACLES.tiers), the only
 * keys `obstacleSprites` may map; the server row's spriteKey is the join. */
export type ObstacleSpriteKey = typeof OBSTACLES.tiers[keyof typeof OBSTACLES.tiers]['kinds'][number];
export const OBSTACLE_SPRITE_KEYS: readonly ObstacleSpriteKey[] = Object.freeze(Object.values(OBSTACLES.tiers).flatMap(t => t.kinds));
export type RealmKitObstacleState = 'intact' | 'clearing' | 'remnant';
/** A creature's facing: the sheet ROW of a `directions: 4` asset in this order
 * ([down, left, right, up] = south, west, east, north; the art files are named so). */
export type RealmKitFacing = 'down' | 'left' | 'right' | 'up';
export const REALM_KIT_FACINGS: readonly RealmKitFacing[] = Object.freeze(['down', 'left', 'right', 'up']);
/** Render-only ambient route outside the frame: a polyline in art pixels walked at
 * `speed` art px/s. Never an economy or collision object. D-173 creature paths (owner
 * 2026-09-21, "animals … animated and moving to all sides"): a roaming animal is a path
 * whose sheet carries one walk loop per facing —
 *   directions 4: frameCount = 4 × frames, rows in REALM_KIT_FACINGS order;
 *   directions 2: rows [left, right] (a segment moving up/down takes left when dx < 0 else right);
 *   directions 1: one row (birds, smoke), the r5 default.
 * `frames` is the loop length per facing (default frameCount / directions), `frameDurationMs`
 * the walk frame time (default the asset's), `dwellMs` a pause at every vertex showing frame 0
 * of the facing ahead (default 0), `loop` 'cycle' (default: after the last point it is back at
 * the first — a closed loop when they coincide, else a teleport) or 'pingpong' (walks the points
 * back to the start). `layer` sorts it with the props of the ground band by its anchor's y
 * (default 1: among the trees; 2 for anything that flies or rises over them). */
export interface RealmKitPath {
  id: string; asset: string; points: { x: number; y: number }[]; speed: number;
  directions?: 1 | 2 | 4; frames?: number; frameDurationMs?: number; dwellMs?: number; loop?: 'cycle' | 'pingpong'; layer?: number;
}
/** `RealmKitPath` with every default applied (what realmKitPathPlan walks). */
export interface RealmKitPathResolved { path: RealmKitPath; asset: LayeredAsset; directions: 1 | 2 | 4; frames: number; frameDurationMs: number; dwellMs: number; loop: 'cycle' | 'pingpong'; layer: number }
/** REALM-KIT-PLAN §2 ring variants (D-173; K-177 "road end"): the ring cells the builder
 * baked for ONE base cell — a road, a yard, any in-frame ground that is not the boundary
 * wild terrain — under each corner-Wang mask, so the claim's ring crosses it through a
 * three-way composite (turf on the kingdom corners, the cell's own corners elsewhere)
 * instead of the default turf↔wild tile that left the road stopping in the meadow.
 * `cell` is the base cell id as the layers reference it; `cells[mask]` is the ring cell
 * for that mask, 0 where none was baked (the default `edge.cells[mask]` draws). Additive:
 * a manifest without `variants` draws the default ring everywhere, as before. */
export interface RealmKitEdgeVariant { cell: number; cells: number[] }
export interface RealmKitManifest {
  schemaVersion: 3; groundRevision: 5; realmId: RealmId; status: 'preview-only' | 'accepted'; tilePixels: 32;
  field: LayeredRect; protectedFrame: LayeredRect;
  ground: {
    kind: 'tiles';
    /** The kingdom turf tone; fills the claim rect on the overview LOD and thumbnails. */
    paddingColor: string;
    /** Global cell table, id = index + 1, 0 = empty. Every cell addresses one POT tileset. */
    cells: RealmKitCell[];
    /** Draw layers in REALM_KIT_LAYER_IDS order (water below base below overlay, any
     * may be absent), each a run-length grid over the 98×98 field (row-major from
     * tile −34,−34). The base layer has no holes, so a base cell over open water is a
     * shore/bed cell whose water texels are transparent: the surface loop underneath
     * shows through it. Nothing but this order lets water animate under a solid base. */
    layers: RealmKitLayer[];
    state: { turf: number[]; edge: { cells: number[]; variants?: RealmKitEdgeVariant[] }; clearInside: true };
    far: { asset: string; origin: { x: number; y: number }; period: { width: number; height: number } };
    overview?: { asset: string; pxPerTile: number };
  };
  assets: LayeredAsset[]; placements: RealmKitPlacement[];
  obstacleSprites: Partial<Record<ObstacleSpriteKey, RealmKitSpriteStates>>;
  paths: RealmKitPath[];
}
/** Server claim in plot tiles, half-open: kingdom tiles are [min,max)². */
export interface RealmKitClaim { min: number; max: number }
export type RealmKitTileState = 'kingdom' | 'edge' | 'wilderness' | 'exterior';

const L = LAYERED_GROUND_LIMITS_R5, TILE = REALM_KIT.tilePixels;
const FIELD_ORIGIN = REALM_KIT.fieldOriginTiles, FIELD_TILES = REALM_KIT.fieldTiles, FIELD_END = FIELD_ORIGIN + FIELD_TILES;
const FIELD_CELLS = FIELD_TILES * FIELD_TILES;
export const REALM_KIT_FIELD: Readonly<LayeredRect> = Object.freeze({
  x: FIELD_ORIGIN * TILE, y: FIELD_ORIGIN * TILE, width: FIELD_TILES * TILE, height: FIELD_TILES * TILE });
export const REALM_KIT_PROTECTED_FRAME: Readonly<LayeredRect> = Object.freeze({
  x: REALM_KIT.frameMinTile * TILE, y: REALM_KIT.frameMinTile * TILE,
  width: (REALM_KIT.frameMaxTile - REALM_KIT.frameMinTile) * TILE, height: (REALM_KIT.frameMaxTile - REALM_KIT.frameMinTile) * TILE });
/** The claim every base starts with (footprints.claimRect centres GRID.claimTiles on
 * the legacy plot): a prop seated inside it or its ring could never be seen, so the
 * validator refuses one — the builder keeps baked props off the whole legacy plot,
 * where the server's clearable obstacle rows stand instead. */
export const REALM_KIT_SMALLEST_KINGDOM: Readonly<RealmKitClaim> = Object.freeze({
  min: (GRID.plotTiles - GRID.claimTiles) / 2, max: (GRID.plotTiles - GRID.claimTiles) / 2 + GRID.claimTiles });
function fail(): never { throw new Error('Invalid realm kit manifest'); }
const integer = (v: unknown, lo: number, hi: number): v is number => Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi;
const coordinate = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const powerOfTwo = (n: number) => n > 0 && (n & (n - 1)) === 0;
const contains = (a: Readonly<LayeredRect>, b: LayeredRect) => a.x <= b.x && a.y <= b.y
  && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;
const rectEquals = (a: unknown, b: Readonly<LayeredRect>) => object(a) && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const ID = /^[a-z][a-z0-9-]{0,63}$/;

/** Run-length grid codec, shared verbatim with the Kotlin mirror.
 *
 *   rle   := run (';' run)*          runs in row-major order; '' encodes length 0
 *   run   := value | value ':' count count omitted when it is 1
 *   value := base-36 integer 0..65535 (cell id, 0 = empty), lowercase, no leading zeros
 *   count := base-36 integer ≥ 2, lowercase, no leading zeros
 *
 * Comma-free so a manifest can never be misread as CSV. The form is CANONICAL:
 * adjacent runs differ, `:1` and leading zeros are rejected, and the decoder
 * demands the exact expected length — one grid has exactly one string, so a
 * hash-addressed manifest cannot drift by re-encoding. */
export function encodeRealmKitRle(cells: Uint16Array): string {
  const out: string[] = [];
  for (let i = 0; i < cells.length;) {
    const v = cells[i]!;
    let run = 1;
    while (i + run < cells.length && cells[i + run] === v) run++;
    out.push(run === 1 ? v.toString(36) : `${v.toString(36)}:${run.toString(36)}`);
    i += run;
  }
  return out.join(';');
}
export function decodeRealmKitRle(rle: string, length: number): Uint16Array {
  if (typeof rle !== 'string' || !integer(length, 0, FIELD_CELLS)) fail();
  const out = new Uint16Array(length);
  if (rle === '') { if (length !== 0) fail(); return out; }
  let i = 0;
  for (const token of rle.split(';')) {
    const match = /^([0-9a-z]+)(?::([0-9a-z]+))?$/.exec(token);
    if (!match) fail();
    const value = parseInt(match[1]!, 36), run = match[2] === undefined ? 1 : parseInt(match[2], 36);
    if (value > 0xffff || match[1] !== value.toString(36) || run < 1 || i + run > length
      || (match[2] !== undefined && (run === 1 || match[2] !== run.toString(36)))
      || (i > 0 && out[i - 1] === value)) fail();
    out.fill(value, i, i + run);
    i += run;
  }
  if (i !== length) fail();
  return out;
}

/** Closed segment p→q against the OPEN rect r (separating-axis test on the two
 * rect normals and the segment normal, all integer products). Touching the
 * boundary is not entering: a route may hug the frame, never cross it. */
function segmentEntersOpenRect(p: { x: number; y: number }, q: { x: number; y: number }, r: LayeredRect): boolean {
  const x0 = r.x, x1 = r.x + r.width, y0 = r.y, y1 = r.y + r.height;
  if (Math.max(p.x, q.x) <= x0 || Math.min(p.x, q.x) >= x1 || Math.max(p.y, q.y) <= y0 || Math.min(p.y, q.y) >= y1) return false;
  const nx = p.y - q.y, ny = q.x - p.x;
  if (nx === 0 && ny === 0) return true;
  const c = nx * p.x + ny * p.y;
  const corners = [nx * x0 + ny * y0, nx * x1 + ny * y0, nx * x0 + ny * y1, nx * x1 + ny * y1];
  return c > Math.min(...corners) && c < Math.max(...corners);
}

/** Validate before opening files, allocating pixels, or admitting upload work.
 * Rules beyond the r4 validator, each from REALM-KIT-PLAN: the field and frame
 * are pinned to REALM_KIT; every cell addresses ONE power-of-two tileset on the
 * 32-px grid (E-7/E-8 draw one tileset texture); layers come in draw order; the
 * base layer has no holes (the far repeat never shows inside the field); water
 * never enters the frame (E-6) nor the meadow rings around it (§5: a full claim's
 * boundary ring must never meet water); the manifest JSON fits the E-5 download
 * cap; the baked non-empty tile total fits the floor cap (a claim can only lower
 * it); placements and ambient paths never intersect the protected frame; a
 * placement's `frame` and `clip` address cells that exist in its sheet (§7); ring
 * variant rows are unique per base cell, 16 masks each, and address the table. */
export function assertRealmKitManifest(value: unknown): asserts value is RealmKitManifest {
  if (!object(value) || value.schemaVersion !== 3 || value.groundRevision !== 5 || !isRealmId(value.realmId)
    || !['preview-only', 'accepted'].includes(value.status as string) || value.tilePixels !== TILE) fail();
  const m = value as unknown as RealmKitManifest, g = m.ground;
  if (!rectEquals(m.field, REALM_KIT_FIELD) || !rectEquals(m.protectedFrame, REALM_KIT_PROTECTED_FRAME)
    || !object(g) || g.kind !== 'tiles' || typeof g.paddingColor !== 'string' || !/^#[0-9a-f]{6}$/.test(g.paddingColor)
    || !Array.isArray(g.cells) || !Array.isArray(g.layers) || !object(g.state) || !object(g.far)
    || !Array.isArray(m.assets) || !Array.isArray(m.placements) || !object(m.obstacleSprites) || !Array.isArray(m.paths)
    || !m.assets.length || m.assets.length > L.assets || m.placements.length > L.placements
    || !g.cells.length || g.cells.length > L.cells || !g.layers.length || g.layers.length > L.layers || m.paths.length > L.paths) fail();
  const assets = new Map<string, LayeredAsset>();
  let size = 0, rgba = 0;
  for (const a of m.assets) {
    if (!object(a) || typeof a.id !== 'string' || !ID.test(a.id) || assets.has(a.id)
      || typeof a.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(a.sha256)
      || (a.path !== `atlas/fantasy/layered-ground/assets/${a.sha256}.png` && a.path !== `atlas/fantasy/layered-ground/assets/${a.sha256}.webp`)
      || !integer(a.size, 1, L.compressedBytes)
      || ![a.width, a.height, a.frameWidth, a.frameHeight].every(n => integer(n, 1, L.dimension))
      || !integer(a.frameCount, 1, 64) || !integer(a.frameDurationMs, 50, 10000)
      || a.width % a.frameWidth || a.height % a.frameHeight || a.width / a.frameWidth * (a.height / a.frameHeight) !== a.frameCount
      || !object(a.anchor) || !integer(a.anchor.x, 0, a.frameWidth) || !integer(a.anchor.y, 0, a.frameHeight)
      || a.reducedMotionFrame !== 0) fail();
    assets.set(a.id, a); size += a.size; rgba += a.width * a.height * 4;
  }
  const manifestBytes = new TextEncoder().encode(JSON.stringify(m) + '\n').byteLength;
  if (size > L.compressedBytes || rgba > L.rgbaBytes || new Set(m.assets.map(a => a.path)).size !== m.assets.length
    || manifestBytes > L.manifestBytes || size + manifestBytes > L.compressedBytes) fail();
  const far = assets.get(g.far.asset);
  if (!far || far.frameCount !== 1 || !powerOfTwo(far.width) || !powerOfTwo(far.height)
    || !object(g.far.origin) || !object(g.far.period)
    || ![g.far.origin.x, g.far.origin.y].every(n => coordinate(n, -16384, 16384))
    || ![g.far.period.width, g.far.period.height].every(n => coordinate(n, TILE, 16384))) fail();
  let overview: LayeredAsset | undefined;
  if (g.overview !== undefined) {
    if (!object(g.overview) || !integer(g.overview.pxPerTile, 1, TILE)) fail();
    overview = assets.get(g.overview.asset);
    if (!overview || overview === far || overview.frameCount !== 1
      || overview.width !== g.overview.pxPerTile * FIELD_TILES || overview.height !== g.overview.pxPerTile * FIELD_TILES) fail();
  }
  const tileset = object(g.cells[0]) ? assets.get(g.cells[0].asset as string) : undefined;
  if (!tileset || tileset === far || tileset === overview || tileset.frameCount !== 1 || !powerOfTwo(tileset.width) || !powerOfTwo(tileset.height)) fail();
  for (const c of g.cells) {
    if (!object(c) || c.asset !== tileset.id || !integer(c.x, 0, L.dimension) || !integer(c.y, 0, L.dimension) || c.x % TILE || c.y % TILE) fail();
    const frames = c.frames === undefined ? 1 : c.frames;
    if (!integer(frames, 1, 64) || (c.frameDurationMs !== undefined && !integer(c.frameDurationMs, 50, 10000))
      || (frames > 1 && c.frameDurationMs === undefined) || c.x + frames * TILE > tileset.width || c.y + TILE > tileset.height) fail();
  }
  const cellId = (v: unknown) => integer(v, 1, g.cells.length);
  const s = g.state;
  if (!Array.isArray(s.turf) || !s.turf.length || s.turf.length > L.cells || !s.turf.every(cellId)
    || !object(s.edge) || !Array.isArray(s.edge.cells) || s.edge.cells.length !== 16 || !s.edge.cells.every(cellId)
    || s.clearInside !== true) fail();
  // §2 ring variants (optional): ≤ L.edgeVariants rows, one per base cell (unique), 16 masks each,
  // every non-zero entry a cell id — a row addressing a cell outside the table would draw garbage
  // on the ring of one client and be refused by the other.
  if (s.edge.variants !== undefined) {
    if (!Array.isArray(s.edge.variants) || s.edge.variants.length > L.edgeVariants) fail();
    const rows = new Set<number>();
    for (const v of s.edge.variants) {
      if (!object(v) || !cellId(v.cell) || rows.has(v.cell) || !Array.isArray(v.cells) || v.cells.length !== 16
        || !v.cells.every(c => integer(c, 0, g.cells.length))) fail();
      rows.add(v.cell);
    }
  }
  const grids = new Map<RealmKitLayerId, Uint16Array>();
  let baked = 0, order = -1;
  for (const layer of g.layers) {
    // Strictly increasing position in REALM_KIT_LAYER_IDS: known ids, no repeats, draw order fixed.
    const position = object(layer) ? REALM_KIT_LAYER_IDS.indexOf(layer.id as RealmKitLayerId) : -1;
    if (position <= order || typeof layer.rle !== 'string') fail();
    order = position;
    const grid = decodeRealmKitRle(layer.rle, FIELD_CELLS);
    for (const id of grid) { if (id > g.cells.length) fail(); if (id) baked++; }
    grids.set(layer.id as RealmKitLayerId, grid);
  }
  const base = grids.get('base'), water = grids.get('water');
  if (!base || base.includes(0) || baked > L.bakedTiles) fail();
  const dryMin = REALM_KIT.frameMinTile - REALM_KIT.meadowRingsOutsideFrame, dryMax = REALM_KIT.frameMaxTile + REALM_KIT.meadowRingsOutsideFrame;
  if (water) for (let ty = dryMin; ty < dryMax; ty++) for (let tx = dryMin; tx < dryMax; tx++) {
    if (water[(ty - FIELD_ORIGIN) * FIELD_TILES + (tx - FIELD_ORIGIN)] !== 0) fail();
  }
  const sprite = (id: unknown): LayeredAsset | undefined => {
    const a = typeof id === 'string' ? assets.get(id) : undefined;
    return a && a !== far && a !== overview && a !== tileset ? a : undefined;
  };
  const states = (v: unknown): v is RealmKitSpriteStates => object(v) && !!sprite(v.intact) && !!sprite(v.remnant)
    && (v.clearing === undefined || !!sprite(v.clearing));
  const ids = new Set<string>();
  for (const p of m.placements) {
    if (!object(p) || typeof p.id !== 'string' || !ID.test(p.id) || ids.has(p.id)
      || ![p.x, p.y].every(n => coordinate(n, -4096, 4096)) || ![p.width, p.height].every(n => coordinate(n, 1, 2048))
      || !integer(p.layer, 0, 15) || typeof p.animated !== 'boolean' || p.interactive !== false) fail();
    const a = sprite(p.asset), frame = p.frame ?? 0;
    // §7: the still cell exists; a clip is ≥2 consecutive cells that fit the sheet;
    // `animated` and `clip` agree; phaseFrame is 0 (the loop starts at `frame`).
    if (!a || p.phaseFrame !== 0 || !integer(frame, 0, a.frameCount - 1) || p.animated !== (p.clip !== undefined)
      || (p.clip !== undefined && (!object(p.clip) || !integer(p.clip.frames, 2, a.frameCount - frame) || !integer(p.clip.frameDurationMs, 50, 10000)))
      || (p.states !== undefined && (!states(p.states) || p.states.intact !== p.asset))
      || (p.prop !== undefined && (typeof p.prop !== 'string' || !ID.test(p.prop)))
      || (p.footprint !== undefined && (!Array.isArray(p.footprint) || p.footprint.length !== 2
        || !p.footprint.every(n => integer(n, 1, L.footprintTiles))))) fail();
    // E-6 (amended 2026-09-21): props may stand inside the protected frame; the
    // claim hides them at draw time. One seated where the smallest claim's ring
    // already hides it would never show, so it is a layout mistake.
    if (!contains(m.field, layeredPlacementBounds(p, a)) || realmKitPlacementHidden(p, REALM_KIT_SMALLEST_KINGDOM)) fail();
    ids.add(p.id);
  }
  for (const [key, v] of Object.entries(m.obstacleSprites)) if (!OBSTACLE_SPRITE_KEYS.includes(key as ObstacleSpriteKey) || !states(v)) fail();
  const pathIds = new Set<string>();
  for (const path of m.paths) {
    if (!object(path) || typeof path.id !== 'string' || !ID.test(path.id) || pathIds.has(path.id)
      || !Array.isArray(path.points) || path.points.length < 2 || path.points.length > L.pathPoints || !integer(path.speed, 1, 4096)) fail();
    const a = sprite(path.asset);
    if (!a) fail();
    // D-173 creature paths: the facing rows tile the sheet exactly (directions × frames = frameCount),
    // the walk frame time and the vertex dwell are bounded like every other clock, the loop is named.
    const directions = path.directions ?? 1, frames = path.frames ?? a.frameCount / directions;
    if (![1, 2, 4].includes(directions) || !integer(frames, 1, 64) || frames * directions !== a.frameCount
      || (path.frameDurationMs !== undefined && !integer(path.frameDurationMs, 50, 10000))
      || (path.dwellMs !== undefined && !integer(path.dwellMs, 0, 60000))
      || (path.loop !== undefined && path.loop !== 'cycle' && path.loop !== 'pingpong')
      || (path.layer !== undefined && !integer(path.layer, 0, 15))) fail();
    // The sprite's bounds touch the frame exactly when its anchor enters this open rect.
    const clear = { x: m.protectedFrame.x + a.anchor.x - a.frameWidth, y: m.protectedFrame.y + a.anchor.y - a.frameHeight,
      width: m.protectedFrame.width + a.frameWidth, height: m.protectedFrame.height + a.frameHeight };
    for (const [i, pt] of path.points.entries()) {
      if (!object(pt) || !integer(pt.x, -4096, 4096) || !integer(pt.y, -4096, 4096)
        || !contains(m.field, { x: pt.x - a.anchor.x, y: pt.y - a.anchor.y, width: a.frameWidth, height: a.frameHeight })
        || (i > 0 && segmentEntersOpenRect(path.points[i - 1]!, pt, clear))) fail();
    }
    pathIds.add(path.id);
  }
}

function assertClaim(claim: RealmKitClaim): void {
  if (!object(claim) || !integer(claim.min, REALM_KIT.frameMinTile, REALM_KIT.frameMaxTile - 1)
    || !integer(claim.max, claim.min + 1, REALM_KIT.frameMaxTile)) fail();
}
function tileState(claim: RealmKitClaim, tx: number, ty: number): RealmKitTileState {
  const inside = (lo: number, hi: number) => tx >= lo && tx < hi && ty >= lo && ty < hi;
  if (inside(claim.min, claim.max)) return 'kingdom';
  if (inside(claim.min - REALM_KIT.edgeRingTiles, claim.max + REALM_KIT.edgeRingTiles)) return 'edge';
  if (inside(REALM_KIT.frameMinTile, REALM_KIT.frameMaxTile)) return 'wilderness';
  return 'exterior';
}
/** REALM-KIT-PLAN §3: the only runtime terrain decision, from the server claim
 * rect that raids stamp and deeds crop. The ring outranks the frame test so a
 * 50×50 claim still gets its boundary in the (meadow-guaranteed) exterior ring. */
export function realmKitTileState(claim: RealmKitClaim, tx: number, ty: number): RealmKitTileState {
  assertClaim(claim);
  if (!Number.isSafeInteger(tx) || !Number.isSafeInteger(ty)) fail();
  return tileState(claim, tx, ty);
}
/** Corner-Wang mask of an edge-ring tile: NW·8 + NE·4 + SW·2 + SE·1, a bit set when
 * that vertex lies inside the CLOSED claim rect [min,max]² in tile-edge coordinates
 * (kingdom turf is the upper terrain). Ring tiles reach the four straight masks
 * {3 N, 12 S, 5 W, 10 E} and four corners {1 NW, 2 NE, 4 SW, 8 SE}; the other eight
 * entries of edge.cells keep the family a complete 16-tile set for bake-time reuse. */
export function realmKitEdgeMask(claim: RealmKitClaim, tx: number, ty: number): number {
  const upper = (vx: number, vy: number) => vx >= claim.min && vx <= claim.max && vy >= claim.min && vy <= claim.max ? 1 : 0;
  return upper(tx, ty) * 8 + upper(tx + 1, ty) * 4 + upper(tx, ty + 1) * 2 + upper(tx + 1, ty + 1);
}
/** 32-bit integer mix of absolute tile coordinates (Kotlin: Int wrapping `*`,
 * `xor`, `ushr`; the result is read unsigned via `toLong() and 0xffffffff`):
 *   h = (tx·0x27d4eb2d) ^ (ty·0x165667b1) ^ 0x5bd1e995
 *   h ^= h>>>15; h *= 0x2c1b3c6d; h ^= h>>>12; h *= 0x297a2d39; h ^= h>>>15
 * Every multiplier fits a signed 32-bit literal. Absolute coordinates on purpose:
 * buying an expansion must never reshuffle turf a player already looks at. */
export function realmKitTileHash(tx: number, ty: number): number {
  let h = Math.imul(tx, 0x27d4eb2d) ^ Math.imul(ty, 0x165667b1) ^ 0x5bd1e995;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}
const gridCache = new WeakMap<RealmKitLayer, { rle: string; grid: Uint16Array }>();
/** Decoded once per layer object; a mutated rle re-decodes (content is the key). */
function layerGrid(layer: RealmKitLayer): Uint16Array {
  const hit = gridCache.get(layer);
  if (hit && hit.rle === layer.rle) return hit.grid;
  const grid = decodeRealmKitRle(layer.rle, FIELD_CELLS);
  gridCache.set(layer, { rle: layer.rle, grid });
  return grid;
}
const EXTEND = REALM_KIT.edgeExtendTiles, EXTENT_ORIGIN = FIELD_ORIGIN - EXTEND, EXTENT_END = FIELD_END + EXTEND;
/** The drawable extent: the field plus its edge-clamped margin (REALM_KIT.edgeExtendTiles). */
export const REALM_KIT_EXTENT: Readonly<LayeredRect> = Object.freeze({
  x: EXTENT_ORIGIN * TILE, y: EXTENT_ORIGIN * TILE, width: (EXTENT_END - EXTENT_ORIGIN) * TILE, height: (EXTENT_END - EXTENT_ORIGIN) * TILE });
const clampTile = (t: number) => t < FIELD_ORIGIN ? FIELD_ORIGIN : t >= FIELD_END ? FIELD_END - 1 : t;
function cellAt(m: RealmKitManifest, grid: Uint16Array | undefined, layerId: RealmKitLayerId, claim: RealmKitClaim, tx: number, ty: number): number {
  const state = tileState(claim, tx, ty);
  if (state === 'kingdom') {
    if (layerId !== 'base') return 0;
    const turf = m.ground.state.turf;
    return turf[realmKitTileHash(tx, ty) % turf.length]!;
  }
  if (state === 'edge') {
    if (layerId !== 'base') return 0;
    // §2 ring variants: over a baked base cell the builder gave a row (a road, a yard) the ring
    // takes that cell's own composite for this mask; 0 or no row → the default turf↔wild cell.
    // The ring is always inside the field (assertClaim keeps claims in the frame), so the base
    // grid — `grid` here, the base layer's — is read directly, never clamped.
    const mask = realmKitEdgeMask(claim, tx, ty);
    const baked = grid ? grid[(ty - FIELD_ORIGIN) * FIELD_TILES + (tx - FIELD_ORIGIN)]! : 0;
    const variant = baked ? m.ground.state.edge.variants?.find(v => v.cell === baked)?.cells[mask] : undefined;
    return variant || m.ground.state.edge.cells[mask]!;
  }
  if (!grid) return 0;
  if (tx < FIELD_ORIGIN || ty < FIELD_ORIGIN || tx >= FIELD_END || ty >= FIELD_END) {
    // Edge clamp (REALM_KIT.edgeExtendTiles): beyond the field the nearest field tile's
    // water and base cells continue to the world's end; decals do not repeat outward.
    if (layerId === 'overlay' || tx < EXTENT_ORIGIN || ty < EXTENT_ORIGIN || tx >= EXTENT_END || ty >= EXTENT_END) return 0;
    return grid[(clampTile(ty) - FIELD_ORIGIN) * FIELD_TILES + (clampTile(tx) - FIELD_ORIGIN)]!;
  }
  return grid[(ty - FIELD_ORIGIN) * FIELD_TILES + (tx - FIELD_ORIGIN)]!;
}
/** Cell id (0 = nothing) of one tile on one layer under a claim: kingdom tiles
 * take a turf variant on `base` and clear `overlay`/`water`; the ring takes its
 * Wang cell (the baked cell's §2 ring variant for the mask when the builder made one,
 * else the default) and clears the other layers; everything else is the baked layer — edge-clamped for
 * REALM_KIT.edgeExtendTiles beyond the field (water and base only), 0 farther out
 * (far repeat). */
export function realmKitCell(m: RealmKitManifest, claim: RealmKitClaim, layerId: RealmKitLayerId, tx: number, ty: number): number {
  assertClaim(claim);
  if (!REALM_KIT_LAYER_IDS.includes(layerId) || !Number.isSafeInteger(tx) || !Number.isSafeInteger(ty)) fail();
  const layer = m.ground.layers.find(l => l.id === layerId);
  return cellAt(m, layer && layerGrid(layer), layerId, claim, tx, ty);
}
/** Tileset source rect of a cell frame: frames step 32 px to the right. */
export function realmKitCellSource(m: RealmKitManifest, cell: number, frame: number): { asset: LayeredAsset; source: LayeredRect } {
  const c = m.ground.cells[cell - 1];
  if (!c || !integer(cell, 1, m.ground.cells.length) || !integer(frame, 0, (c.frames ?? 1) - 1)) fail();
  const asset = m.assets.find(a => a.id === c.asset);
  if (!asset) fail();
  return { asset, source: { x: c.x + frame * TILE, y: c.y, width: TILE, height: TILE } };
}
export interface RealmKitTileDraw { layer: RealmKitLayerId; tx: number; ty: number; cell: number; frame: number; destination: LayeredRect }
export interface RealmKitFloorPlan { tiles: RealmKitTileDraw[]; far: LayeredDraw }
function farDraw(m: RealmKitManifest, scale: number, view: LayeredRect): LayeredDraw {
  const g = m.ground, far = m.assets.find(a => a.id === g.far.asset)!;
  return { id: 'floor-far', asset: far, frame: 0, source: { x: 0, y: 0, width: far.width, height: far.height }, destination: { ...view },
    repeat: { origin: { x: g.far.origin.x * scale, y: g.far.origin.y * scale },
      period: { width: g.far.period.width * scale, height: g.far.period.height * scale } } };
}
/** Tiles intersecting the view (renderer world units, `tilePixels` per tile), in
 * layer order then row-major, plus the same far repeat primitive as revision 4.
 * frame = reducedMotion ? 0 : ⌊elapsed / frameDurationMs⌋ mod frames, so frame 0
 * is always the still. The cap is a hard wall: a valid manifest cannot reach it. */
export function realmKitFloorPlan(m: RealmKitManifest, tilePixels: number, view: LayeredRect, claim: RealmKitClaim,
  elapsedMs: number, reducedMotion: boolean): RealmKitFloorPlan {
  if (![tilePixels, view.x, view.y, view.width, view.height, elapsedMs].every(Number.isFinite)
    || tilePixels <= 0 || view.width <= 0 || view.height <= 0 || elapsedMs < 0) fail();
  assertClaim(claim);
  const tx0 = Math.max(EXTENT_ORIGIN, Math.floor(view.x / tilePixels)), tx1 = Math.min(EXTENT_END, Math.ceil((view.x + view.width) / tilePixels));
  const ty0 = Math.max(EXTENT_ORIGIN, Math.floor(view.y / tilePixels)), ty1 = Math.min(EXTENT_END, Math.ceil((view.y + view.height) / tilePixels));
  const tiles: RealmKitTileDraw[] = [];
  for (const layer of m.ground.layers) {
    const grid = layerGrid(layer);
    for (let ty = ty0; ty < ty1; ty++) for (let tx = tx0; tx < tx1; tx++) {
      const cell = cellAt(m, grid, layer.id, claim, tx, ty);
      if (!cell) continue;
      const c = m.ground.cells[cell - 1]!, frames = c.frames ?? 1;
      const frame = reducedMotion || frames === 1 ? 0 : Math.floor(elapsedMs / c.frameDurationMs!) % frames;
      tiles.push({ layer: layer.id, tx, ty, cell, frame,
        destination: { x: tx * tilePixels, y: ty * tilePixels, width: tilePixels, height: tilePixels } });
      if (tiles.length > L.floorTiles) fail();
    }
  }
  return { tiles, far: farDraw(m, tilePixels / m.tilePixels, view) };
}
/** Source rect of one cell of a prop sheet: cells are `frameWidth`×`frameHeight`,
 * row-major, `width / frameWidth` per row — the same walk for a placement, an
 * obstacle sprite and a path sprite on every client. */
export function realmKitSpriteSource(a: LayeredAsset, frame: number): LayeredRect {
  if (!integer(frame, 0, a.frameCount - 1)) fail();
  const columns = a.width / a.frameWidth;
  return { x: (frame % columns) * a.frameWidth, y: Math.floor(frame / columns) * a.frameHeight, width: a.frameWidth, height: a.frameHeight };
}
/** §7 frame rule: a still draws `frame`; a clip draws
 * `frame + ⌊elapsed / clip.frameDurationMs⌋ mod clip.frames`; reduced motion or a
 * backgrounded scene draws the still, which is what the deed renderer draws too. */
export function realmKitPlacementFrame(p: RealmKitPlacement, elapsedMs: number, still: boolean): number {
  const frame = p.frame ?? 0;
  if (still || !p.clip) return frame;
  return frame + Math.floor(elapsedMs / p.clip.frameDurationMs) % p.clip.frames;
}
/** The draw band of a ground-band layer (REALM_KIT.airLayer): every layer below it is one
 * painter's band ordered by the anchor row; airLayer and above stack over it by layer. */
export function realmKitDrawBand(layer: number): number { return layer < REALM_KIT.airLayer ? 0 : layer; }
/** The tile a placement stands on: its anchor point (bottom-centre for props) in
 * source-art pixels, so a 1-wide prop seated at (tx·32 + 16, (ty + 1)·32) maps back
 * to (tx, ty) and a 2-wide footprint to its right-hand tile. */
export function realmKitPlacementSeat(p: LayeredPlacement): { tx: number; ty: number } {
  return { tx: Math.floor(p.x / TILE), ty: Math.ceil(p.y / TILE) - 1 };
}
/** E-6 (amended): a baked prop is hidden while its seat tile lies inside the claim
 * or its edge ring — the land the player owns is cleared land. Web, native and the
 * deed renderer all ask this one function, so an expansion clears the same trees
 * everywhere. */
export function realmKitPlacementHidden(p: LayeredPlacement, claim: RealmKitClaim): boolean {
  const { tx, ty } = realmKitPlacementSeat(p), lo = claim.min - REALM_KIT.edgeRingTiles, hi = claim.max + REALM_KIT.edgeRingTiles;
  return tx >= lo && tx < hi && ty >= lo && ty < hi;
}
/** Placements in draw order: the draw band (realmKitDrawBand), then the anchor row (bottom-
 * seated props stack like a painter: the one further south is in front), then manifest
 * order — a stable key both clients and the rasterizer share, and the order roaming
 * creatures merge into (realmKitGroundBandPlan). */
function orderedPlacements(m: RealmKitManifest): RealmKitPlacement[] {
  return m.placements.map((p, order) => ({ p, order })).sort((a, b) => realmKitDrawBand(a.p.layer) - realmKitDrawBand(b.p.layer) || a.p.y - b.p.y || a.order - b.order).map(({ p }) => p);
}
/** Culled, band-sorted prop draws with the §7 frame rule, minus every prop the
 * claim hides (realmKitPlacementHidden). Culls before selecting frames; elapsed
 * time is the caller's foreground clock. Unlike r4, a backgrounded scene still
 * lists its props (pinned to the still) — a hidden client simply does not advance
 * the clock, and the list is what a paused surface would show. */
export function realmKitPropPlan(m: RealmKitManifest, tilePixels: number, view: LayeredRect, claim: RealmKitClaim,
  elapsedMs: number, reducedMotion: boolean, background = false): LayeredDraw[] {
  assertClaim(claim);
  if (![tilePixels, view.x, view.y, view.width, view.height, elapsedMs].every(Number.isFinite)
    || tilePixels <= 0 || view.width <= 0 || view.height <= 0 || elapsedMs < 0) fail();
  const scale = tilePixels / m.tilePixels, still = reducedMotion || background;
  const assets = new Map(m.assets.map(a => [a.id, a]));
  return orderedPlacements(m).flatMap(p => {
    const a = assets.get(p.asset);
    if (!a) fail();
    if (realmKitPlacementHidden(p, claim)) return [];
    const b = layeredPlacementBounds(p, a);
    const destination = { x: b.x * scale, y: b.y * scale, width: b.width * scale, height: b.height * scale };
    if (!layeredIntersects(destination, view)) return [];
    const frame = realmKitPlacementFrame(p, elapsedMs, still);
    return [{ id: p.id, asset: a, frame, destination, source: realmKitSpriteSource(a, frame) }];
  });
}
/** ⌊√n⌋ of a non-negative safe integer by integer Newton steps — no Math.sqrt, so the
 * Kotlin mirror (Long arithmetic) lands on the same segment lengths to the pixel. */
export function realmKitIsqrt(n: number): number {
  if (!integer(n, 0, Number.MAX_SAFE_INTEGER)) fail();
  if (n < 2) return n;
  let x = n, y = Math.floor((x + 1) / 2);
  while (y < x) { x = y; y = Math.floor((x + Math.floor(n / x)) / 2); }
  return x;
}
/** The path with every default applied; the asset is one of the sprite sheets. */
export function realmKitResolvePath(m: RealmKitManifest, path: RealmKitPath): RealmKitPathResolved {
  const asset = m.assets.find(a => a.id === path.asset);
  if (!asset) fail();
  const directions = path.directions ?? 1;
  return { path, asset, directions, frames: path.frames ?? asset.frameCount / directions, frameDurationMs: path.frameDurationMs ?? asset.frameDurationMs,
    dwellMs: path.dwellMs ?? 0, loop: path.loop ?? 'cycle', layer: path.layer ?? 1 };
}
/** The facing a segment walks: its dominant axis (|dx| ≥ |dy| → left/right, else up/down);
 * a zero segment faces right. */
export function realmKitSegmentFacing(dx: number, dy: number): RealmKitFacing {
  return Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
}
/** The sheet row a facing selects: 4 rows in REALM_KIT_FACINGS order; 2 rows [left, right]
 * (up/down borrow the side the x component leans to); 1 row for everything. */
export function realmKitFacingRow(directions: 1 | 2 | 4, facing: RealmKitFacing, dx: number): number {
  if (directions === 4) return REALM_KIT_FACINGS.indexOf(facing);
  if (directions === 2) return facing === 'left' || (facing !== 'right' && dx < 0) ? 0 : 1;
  return 0;
}
/** One creature's pose at `elapsedMs`: anchor point (art px), facing, the segment it is on
 * and whether it is dwelling. Deterministic in elapsedMs and integer-safe (+ − × ÷ ⌊⌋ only):
 * the polyline is walked at `speed` art px/s, segment i taking ⌊Li · 1000 / speed⌋ ms with
 * Li = ⌊√(dx² + dy²)⌋, pausing `dwellMs` at every vertex before leaving it; the period is the
 * sum. 'pingpong' unfolds the points there and back (Pn−1 … P1) and cycles that. */
export function realmKitPathPose(r: RealmKitPathResolved, elapsedMs: number, still: boolean): { x: number; y: number; facing: RealmKitFacing; dx: number; dy: number; dwelling: boolean } {
  const points = r.loop === 'pingpong' && r.path.points.length > 2 ? [...r.path.points, ...r.path.points.slice(1, -1).reverse()] : r.path.points;
  const vertices = r.loop === 'pingpong' ? [...points, points[0]!] : points;
  const segments = vertices.length - 1;
  const seg = (i: number) => { const p = vertices[i]!, q = vertices[i + 1]!; return { p, q, dx: q.x - p.x, dy: q.y - p.y }; };
  const travel = (i: number) => { const { dx, dy } = seg(i); return Math.floor(realmKitIsqrt(dx * dx + dy * dy) * 1000 / r.path.speed); };
  const first = seg(0);
  if (still) return { x: first.p.x, y: first.p.y, facing: realmKitSegmentFacing(first.dx, first.dy), dx: first.dx, dy: first.dy, dwelling: true };
  let period = 0;
  for (let i = 0; i < segments; i++) period += r.dwellMs + travel(i);
  let t = period > 0 ? elapsedMs % period : 0;
  for (let i = 0; i < segments; i++) {
    const { p, dx, dy } = seg(i), facing = realmKitSegmentFacing(dx, dy);
    if (t < r.dwellMs) return { x: p.x, y: p.y, facing, dx, dy, dwelling: true };
    t -= r.dwellMs;
    const T = travel(i);
    if (t < T) return { x: p.x + Math.floor(dx * t / T), y: p.y + Math.floor(dy * t / T), facing, dx, dy, dwelling: false };
    t -= T;
  }
  return { x: first.p.x, y: first.p.y, facing: realmKitSegmentFacing(first.dx, first.dy), dx: first.dx, dy: first.dy, dwelling: true };
}
export interface RealmKitPathDraw extends LayeredDraw { facing: RealmKitFacing; layer: number; anchor: { x: number; y: number } }
/** Culled draws of every ambient path at `elapsedMs`, manifest order: the pose from
 * realmKitPathPose, the sheet cell = row(facing) × frames + walk frame, where the walk
 * frame is 0 while dwelling and ⌊elapsed / frameDurationMs⌋ mod frames on the move; the
 * destination is anchored like a prop (asset.anchor) and culled by its scaled bounds.
 * Reduced motion or a backgrounded scene draws the first vertex, the first segment's
 * facing and frame 0 — the deed's still and the paused surface's picture. */
export function realmKitPathPlan(m: RealmKitManifest, tilePixels: number, view: LayeredRect, elapsedMs: number, reducedMotion: boolean, background = false): RealmKitPathDraw[] {
  if (![tilePixels, view.x, view.y, view.width, view.height, elapsedMs].every(Number.isFinite)
    || tilePixels <= 0 || view.width <= 0 || view.height <= 0 || elapsedMs < 0) fail();
  const scale = tilePixels / m.tilePixels, still = reducedMotion || background;
  return m.paths.flatMap(path => {
    const r = realmKitResolvePath(m, path), a = r.asset, pose = realmKitPathPose(r, elapsedMs, still);
    const destination = { x: (pose.x - a.anchor.x) * scale, y: (pose.y - a.anchor.y) * scale, width: a.frameWidth * scale, height: a.frameHeight * scale };
    if (!layeredIntersects(destination, view)) return [];
    const walk = still || pose.dwelling ? 0 : Math.floor(elapsedMs / r.frameDurationMs) % r.frames;
    const frame = realmKitFacingRow(r.directions, pose.facing, pose.dx) * r.frames + walk;
    return [{ id: path.id, asset: a, frame, source: realmKitSpriteSource(a, frame), destination, facing: pose.facing, layer: r.layer, anchor: { x: pose.x, y: pose.y } }];
  });
}
export interface RealmKitBandDraw extends LayeredDraw { layer: number; bottom: number; facing?: RealmKitFacing }
/** The ground band in ONE draw order for props and creatures alike: the draw band
 * (realmKitDrawBand: everything under REALM_KIT.airLayer is one band, birds and smoke
 * above it), then the anchor's y in art px (a prop's seat row, a creature's feet), ties in
 * manifest order with props before paths — so a deer south of a tree's seat walks in front
 * of it and behind it once north of the seat, and a hen behind the hay bale it passes, on
 * web (depth = 1 + band + bottom · 1e-6, creatures a sub-row tie above the props of their row
 * by manifest index — Phaser sorts equal depths by the LAST frame's order, not creation order),
 * native (this list) and the builder preview alike. */
export function realmKitGroundBandPlan(m: RealmKitManifest, tilePixels: number, view: LayeredRect, claim: RealmKitClaim,
  elapsedMs: number, reducedMotion: boolean, background = false): RealmKitBandDraw[] {
  const byId = new Map(m.placements.map(p => [p.id, p]));
  const props: RealmKitBandDraw[] = realmKitPropPlan(m, tilePixels, view, claim, elapsedMs, reducedMotion, background)
    .map(d => { const p = byId.get(d.id)!; return { ...d, layer: p.layer, bottom: p.y }; });
  const paths: RealmKitBandDraw[] = realmKitPathPlan(m, tilePixels, view, elapsedMs, reducedMotion, background)
    .map(d => ({ id: d.id, asset: d.asset, frame: d.frame, source: d.source, destination: d.destination, layer: d.layer, bottom: d.anchor.y, facing: d.facing }));
  return [...props, ...paths].map((d, order) => ({ d, order })).sort((a, b) => realmKitDrawBand(a.d.layer) - realmKitDrawBand(b.d.layer) || a.d.bottom - b.d.bottom || a.order - b.order).map(({ d }) => d);
}
/** Kit sprite for a server obstacle row. `clearing` falls back to the intact sprite
 * (the clear timer is client FX above it, E-11). An unmapped key returns undefined
 * so the renderer keeps the frozen `dec_` master (O-7); an unknown key is a bug. */
export function realmKitObstacleSprite(m: RealmKitManifest, spriteKey: string, state: RealmKitObstacleState): LayeredAsset | undefined {
  if (!OBSTACLE_SPRITE_KEYS.includes(spriteKey as ObstacleSpriteKey) || !['intact', 'clearing', 'remnant'].includes(state)) fail();
  const states = m.obstacleSprites[spriteKey as ObstacleSpriteKey];
  if (!states) return undefined;
  const id = state === 'remnant' ? states.remnant : state === 'clearing' ? states.clearing ?? states.intact : states.intact;
  const asset = m.assets.find(a => a.id === id);
  if (!asset) fail();
  return asset;
}
export interface RealmKitOverviewPlan {
  far: LayeredDraw;
  /** The published still over the whole field, absent when the view misses it. The
   * builder bakes only the tile layers into it (no props): a claim hides props at draw
   * time, so realmKitPropPlan draws every visible prop over the still at any zoom. */
  overview: LayeredDraw | undefined;
  /** The edge-clamped margin (REALM_KIT.edgeExtendTiles) below the zoom floor: the
   * still's outer tile row or column (pxPerTile texels deep) stretched over each of
   * the eight margin rects (four sides, four corners), culled to the view, in row-major
   * order. Tile for tile this is the clamp realmKitCell applies (a margin tile draws
   * its nearest field tile's block; the field's edge tiles are plain, so stretching
   * the block is the repeat), so a river leaving the field runs on at every zoom
   * instead of stopping at the far repeat once the still replaces the tiles. */
  margin: LayeredDraw[];
  /** The claim rect filled with paddingColor (the overview is claim-independent). */
  kingdom: { destination: LayeredRect; color: string } | undefined;
}
/** Below REALM_KIT.overviewMaxZoom (native) and for thumbnails: one still plus a
 * flat kingdom fill instead of thousands of quads. Requires a published overview. */
export function realmKitOverviewPlan(m: RealmKitManifest, tilePixels: number, view: LayeredRect, claim: RealmKitClaim): RealmKitOverviewPlan {
  if (![tilePixels, view.x, view.y, view.width, view.height].every(Number.isFinite) || tilePixels <= 0 || view.width <= 0 || view.height <= 0) fail();
  assertClaim(claim);
  const o = m.ground.overview, asset = o && m.assets.find(a => a.id === o.asset);
  if (!o || !asset) fail();
  const scale = tilePixels / m.tilePixels;
  const field = { x: m.field.x * scale, y: m.field.y * scale, width: m.field.width * scale, height: m.field.height * scale };
  const kingdom = { x: claim.min * tilePixels, y: claim.min * tilePixels, width: (claim.max - claim.min) * tilePixels, height: (claim.max - claim.min) * tilePixels };
  const margin: LayeredDraw[] = [];
  if (EXTEND > 0) {
    const px = o.pxPerTile, still = asset.width;
    // Per axis: -1 = the margin before the field, 0 = the field itself, +1 = the margin after it.
    const tiles = (s: number): [number, number] => s < 0 ? [EXTENT_ORIGIN, FIELD_ORIGIN] : s > 0 ? [FIELD_END, EXTENT_END] : [FIELD_ORIGIN, FIELD_END];
    const texels = (s: number): [number, number] => s < 0 ? [0, px] : s > 0 ? [still - px, still] : [0, still];
    for (let sy = -1; sy <= 1; sy++) for (let sx = -1; sx <= 1; sx++) {
      if (sx === 0 && sy === 0) continue;
      const [tx0, tx1] = tiles(sx), [ty0, ty1] = tiles(sy), [u0, u1] = texels(sx), [v0, v1] = texels(sy);
      const destination = { x: tx0 * tilePixels, y: ty0 * tilePixels, width: (tx1 - tx0) * tilePixels, height: (ty1 - ty0) * tilePixels };
      if (!layeredIntersects(destination, view)) continue;
      margin.push({ id: `floor-margin-${['n', '', 's'][sy + 1]}${['w', '', 'e'][sx + 1]}`, asset, frame: 0,
        source: { x: u0, y: v0, width: u1 - u0, height: v1 - v0 }, destination });
    }
  }
  return { far: farDraw(m, scale, view),
    overview: layeredIntersects(field, view) ? { id: 'floor-overview', asset, frame: 0,
      source: { x: 0, y: 0, width: asset.width, height: asset.height }, destination: field } : undefined,
    margin,
    kingdom: layeredIntersects(kingdom, view) ? { destination: kingdom, color: m.ground.paddingColor } : undefined };
}
/** Validate decoded admission too, the counterpart of assertLayeredGroundAssetPixels:
 * every sheet has binary alpha (E-13: 1 art px = 1 texel, nothing to filter); the
 * far repeat and the overview still are fully opaque (the floor of last resort
 * beyond the field and below the zoom floor); and in the tileset, wherever a
 * water-layer cell is opaque the base cell baked above it on the same tile is
 * transparent, in every frame of both (§7: base never covers open water, so the
 * surface loop underneath shows through a bed or a keyed shore). */
export function assertRealmKitAssetPixels(m: RealmKitManifest, a: LayeredAsset, p: LayeredPixels): void {
  if (p.width !== a.width || p.height !== a.height || p.data.length !== a.width * a.height * 4) fail();
  const g = m.ground, opaque = a.id === g.far.asset || a.id === g.overview?.asset;
  for (let i = 3; i < p.data.length; i += 4) {
    const alpha = p.data[i];
    if ((alpha !== 0 && alpha !== 255) || (opaque && alpha !== 255)) fail();
  }
  const water = g.layers.find(l => l.id === 'water'), base = g.layers.find(l => l.id === 'base');
  if (a.id !== g.cells[0]?.asset || !water || !base) return;
  const waterGrid = layerGrid(water), baseGrid = layerGrid(base), checked = new Set<number>();
  for (let i = 0; i < FIELD_CELLS; i++) {
    const w = waterGrid[i]!, b = baseGrid[i]!, pair = w * 65536 + b;
    if (!w || !b || checked.has(pair)) continue;
    checked.add(pair);
    const wc = g.cells[w - 1], bc = g.cells[b - 1];
    if (!wc || !bc) fail();
    for (let wf = 0; wf < (wc.frames ?? 1); wf++) for (let bf = 0; bf < (bc.frames ?? 1); bf++) {
      for (let v = 0; v < TILE; v++) for (let u = 0; u < TILE; u++) {
        if (p.data[((wc.y + v) * a.width + wc.x + wf * TILE + u) * 4 + 3] === 255
          && p.data[((bc.y + v) * a.width + bc.x + bf * TILE + u) * 4 + 3] !== 0) fail();
      }
    }
  }
}
/** Canonical frame-0 rasterizer at the kit's own 32 px/tile, for the deed renderer
 * and the builder preview: paddingColor, then the far repeat at its fixed world
 * phase (the r4 rule at scale 1), then every layer's frame-0 cell under `claim`
 * (water → base → overlay, exactly the cells realmKitFloorPlan lists), then the
 * placements in prop-plan order at their still cell — straight RGBA composited
 * with the r4 integer formula. Clipped to the requested rect; pure and
 * deterministic, so a deed fingerprint may include the claim and stay honest. */
export function renderRealmKitPixels(m: RealmKitManifest, pixels: ReadonlyMap<string, LayeredPixels>, claim: RealmKitClaim,
  width: number, height: number, originX = 0, originY = 0): Uint8ClampedArray {
  assertRealmKitManifest(m);
  assertClaim(claim);
  if (![width, height].every(n => integer(n, 1, 4096)) || ![originX, originY].every(n => integer(n, -(1 << 20), 1 << 20))) fail();
  for (const a of m.assets) {
    const p = pixels.get(a.id);
    if (!p || p.width !== a.width || p.height !== a.height || p.data.length !== a.width * a.height * 4) fail();
  }
  const out = new Uint8ClampedArray(width * height * 4), g = m.ground;
  const rgb = [1, 3, 5].map(i => parseInt(g.paddingColor.slice(i, i + 2), 16));
  for (let i = 0; i < out.length; i += 4) { out[i] = rgb[0]!; out[i + 1] = rgb[1]!; out[i + 2] = rgb[2]!; out[i + 3] = 255; }
  const mod = (n: number, size: number) => ((n % size) + size) % size;
  const blend = (p: LayeredPixels, src: number, dst: number) => {
    const alpha = p.data[src + 3]!;
    for (let c = 0; c < 3; c++) out[dst + c] = Math.floor((p.data[src + c]! * alpha + out[dst + c]! * (255 - alpha) + 127) / 255);
    out[dst + 3] = alpha + Math.floor((out[dst + 3]! * (255 - alpha) + 127) / 255);
  };
  const far = pixels.get(g.far.asset)!;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = mod(Math.floor((originX + x - g.far.origin.x) * far.width / g.far.period.width), far.width);
    const sy = mod(Math.floor((originY + y - g.far.origin.y) * far.height / g.far.period.height), far.height);
    blend(far, (sy * far.width + sx) * 4, (y * width + x) * 4);
  }
  const tiles = pixels.get(g.cells[0]!.asset)!;
  const tx0 = Math.max(EXTENT_ORIGIN, Math.floor(originX / TILE)), tx1 = Math.min(EXTENT_END, Math.ceil((originX + width) / TILE));
  const ty0 = Math.max(EXTENT_ORIGIN, Math.floor(originY / TILE)), ty1 = Math.min(EXTENT_END, Math.ceil((originY + height) / TILE));
  for (const layer of g.layers) {
    const grid = layerGrid(layer);
    for (let ty = ty0; ty < ty1; ty++) for (let tx = tx0; tx < tx1; tx++) {
      const cell = cellAt(m, grid, layer.id, claim, tx, ty);
      if (!cell) continue;
      const c = g.cells[cell - 1]!;
      const x0 = Math.max(0, tx * TILE - originX), x1 = Math.min(width, (tx + 1) * TILE - originX);
      const y0 = Math.max(0, ty * TILE - originY), y1 = Math.min(height, (ty + 1) * TILE - originY);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        blend(tiles, ((c.y + originY + y - ty * TILE) * tiles.width + c.x + originX + x - tx * TILE) * 4, (y * width + x) * 4);
      }
    }
  }
  for (const draw of realmKitPropPlan(m, m.tilePixels, { x: originX, y: originY, width, height }, claim, 0, true)) {
    const p = pixels.get(draw.asset.id)!, b = draw.destination;
    for (let y = Math.max(0, Math.ceil(b.y - originY)); y < Math.min(height, Math.ceil(b.y + b.height - originY)); y++) {
      for (let x = Math.max(0, Math.ceil(b.x - originX)); x < Math.min(width, Math.ceil(b.x + b.width - originX)); x++) {
        const sx = Math.floor((originX + x - b.x) * draw.source.width / b.width), sy = Math.floor((originY + y - b.y) * draw.source.height / b.height);
        blend(p, ((sy + draw.source.y) * p.width + sx + draw.source.x) * 4, (y * width + x) * 4);
      }
    }
  }
  return out;
}
