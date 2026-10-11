/** Revision-5 realm environment kit builder (docs/REALM-KIT-PLAN.md §5, §7, §8).
 *
 *   tsx scripts/src/realm-kit.ts build   art/realm-kit-v1/<realm>
 *   tsx scripts/src/realm-kit.ts preview art/realm-kit-v1/<realm> <outDir> [--claim N]
 *
 * `build` reads the authored `kit.json` (inventory: terrains, transition families,
 * props, decals, sprites) and `layout.json` (the seeded scene: vertex ops, scatter,
 * explicit placements, ambient paths), resolves every tile of the 98×98 field to a
 * family tile or a hashed pure-cell variant, packs every USED cell into one
 * power-of-two lossless tileset, packs props by canvas size into uniform-cell
 * sheets seated bottom-centre, derives the water loop and the shore keying, renders
 * the far repeat and the overview still, and writes `layered-manifest.json` +
 * `layered-sources.json` + the sheets under `<realmDir>/built/`. Same inputs give the
 * same bytes (a test builds twice). Nothing here knows today's inventory: every
 * terrain, family, prop and rule comes from the two JSON files; the builder only
 * enforces the plan's invariants and fails loudly, naming the tile or pair.
 *
 * Owner art masters under `sources/` are read, never written. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { isRealmId, type RealmId } from '../../packages/shared/src/baseVisual.js';
import { CAPS, GRID, LAYERED_GROUND_LIMITS_R5, PLOT_GEOMETRY, REALM_KIT } from '../../packages/shared/src/constants.js';
import { layeredPlacementBounds, type LayeredAsset, type LayeredPixels, type LayeredRect } from '../../packages/shared/src/layeredGround.js';
import { assertRealmKitAssetPixels, assertRealmKitManifest, decodeRealmKitRle, encodeRealmKitRle, OBSTACLE_SPRITE_KEYS, realmKitDrawBand, realmKitEdgeMask, realmKitPathPlan, realmKitPlacementSeat, realmKitTileHash, realmKitTileState, renderRealmKitPixels,
  REALM_KIT_FACINGS, REALM_KIT_FIELD, REALM_KIT_PROTECTED_FRAME, REALM_KIT_SMALLEST_KINGDOM, type ObstacleSpriteKey, type RealmKitCell, type RealmKitClaim, type RealmKitEdgeVariant, type RealmKitLayer, type RealmKitLayerId,
  type RealmKitManifest, type RealmKitPath, type RealmKitPlacement, type RealmKitSpriteStates } from '../../packages/shared/src/realmKit.js';

// ---------------------------------------------------------------------------
// Builder tuning (tool numbers, not game numbers — game numbers live in constants.ts)
// ---------------------------------------------------------------------------
export const REALM_KIT_BUILD = Object.freeze({
  /** Canonicalisation band (ART-NOTES): provider texels farther than this from the
   * other terrain class inside a transition tile are replaced by the canonical texel. */
  canonBandPx: 4,
  /** Colours per canonical tile that define a terrain's palette for classification. */
  paletteColours: 16,
  /** A family classified by its own tiles (`classify: 'own'`): a lower-coloured texel with upper texels
   * within this radius on every side is the upper terrain (a flagstone joint), by closing. Measured on
   * Frostveil's road: 126 of its 127 snow-coloured joint texels lie within 1 px of a flagstone. */
  jointPx: 1,
  /** A shore texel is keyed (made transparent) when it is nearer the water palette
   * than the land palette AND within this squared RGB distance of a water colour —
   * dark outlines and foam flecks nearer neither palette stay opaque. */
  waterKeyMaxDistanceSq: 40 * 40,
  /** Mean-colour tolerance (Euclidean RGB) between a terrain's canonical tile and the
   * declared kit palette entry: a regenerated family that drifted in tone fails here. */
  paletteToleranceRgb: 40,
  /** A family's own pure tile may differ from the canonical tile by at most this mean
   * absolute per-channel difference (a rejected orange/busy regen measures far above). */
  familyDriftMax: 40,
  /** Seamless check for the far repeat: the wrap-edge mean difference may exceed the
   * interior adjacent-column mean difference by at most this factor. */
  farSeamFactor: 2.0,
  /** Far repeat is `farTiles`² pure wild cells (256 px = a power of two at 32 px). */
  farTiles: 8,
  /** Overview still at REALM-KIT-PLAN E-8's 4 px/tile. */
  overviewPxPerTile: 4,
  /** Tileset sheet widths tried, smallest area wins (all POT, ≤ LAYERED_GROUND_LIMITS_R5.dimension). */
  sheetWidths: [256, 512, 1024, 2048],
  /** Tone families: noise amplitude added to the bilinear corner weight before thresholding. */
  toneNoise: 0.22,
  /** Organic decal mask (`mask: 'organic'`): a texel survives when its centre distance
   * (1 = the tile's edge midpoints) plus ±coverNoise/2 hash noise stays under coverRadius,
   * so a square ground-cover patch becomes a ragged blob with its corners gone. */
  coverRadius: 0.98,
  coverNoise: 0.5,
  /** Synthesized corner tiles: texels within this distance of the chord take the family's own band. */
  chordBandPx: 5,
  /** A layered asset carries at most 64 frames (assertRealmKitManifest), so a prop canvas
   * size spanning more cells is split into numbered sheets; a clip never straddles two. */
  maxSheetFrames: 64,
  /** Preview crop margin around the protected frame, in tiles. */
  previewMarginTiles: 8,
  /** Ground-band layers the builder writes on ambient paths (D-173 creature paths): a roaming
   * creature sorts with every prop of the painter's band by its feet (REALM_KIT.airLayer); a kit
   * sprite (birds, smoke) rises over them. Placements use 0 (low) / 1 (tall) from the prop kind. */
  creatureLayer: 1,
  ambientLayer: REALM_KIT.airLayer,
  /** Vertex picks per roam vertex before the anchor is abandoned, and anchor picks per creature
   * (× candidate tiles) before the group fails loudly. */
  roamVertexTries: 24,
  roamAnchorTriesPerCandidate: 4,
  /** A roam segment is walked in steps of this many art px when its tiles are checked. */
  roamSegmentStepPx: 8,
} as const);

const TILE = REALM_KIT.tilePixels, FIELD_ORIGIN = REALM_KIT.fieldOriginTiles, FIELD_TILES = REALM_KIT.fieldTiles, FIELD_END = FIELD_ORIGIN + FIELD_TILES;
const VERTICES = FIELD_TILES + 1;
const FRAME_MIN = REALM_KIT.frameMinTile, FRAME_MAX = REALM_KIT.frameMaxTile;
const RING_MIN = FRAME_MIN - REALM_KIT.meadowRingsOutsideFrame, RING_MAX = FRAME_MAX + REALM_KIT.meadowRingsOutsideFrame;
/** The legacy plot [0,30): the server seeds its clearable obstacle rows here (OBSTACLES.generation),
 * so no baked prop is seated on it — the two would stack. Beyond it, baked props stand anywhere
 * in the field, frame included, and the claim hides them at draw time (E-6 amended). */
const PLOT = PLOT_GEOMETRY.boundsByVersion[PLOT_GEOMETRY.legacyVersion];
const L = LAYERED_GROUND_LIMITS_R5;
const ID = /^[a-z][a-z0-9-]{0,63}$/, KEY = /^[a-z][a-z0-9_-]{0,63}$/, HEX = /^#[0-9a-f]{6}$/;
const RELATIVE_SOURCE = /^sources\/(?:[a-z0-9_-]+\/)*[a-z0-9_%.-]+$/;

// ---------------------------------------------------------------------------
// Authoring inputs (REALM-KIT-PLAN §8): typed validators, nothing inferred
// ---------------------------------------------------------------------------
export type TerrainKind = 'ground' | 'water' | 'plateau';
export type FamilyKind = 'wang16' | 'tone' | 'cliff25' | 'derived';
export type PropKind = 'tall' | 'low' | 'decal';
export type Transform = 'identity' | 'mirror-x' | 'mirror-y' | 'rotate-180';
/** HSV grade: value ×, hue +°, saturation × (the `derived` ranges). */
export interface KitTone { value: number; hue: number; saturation: number }
export const TRANSFORMS: readonly Transform[] = Object.freeze(['identity', 'mirror-x', 'mirror-y', 'rotate-180']);
export interface KitTerrain {
  label: string; kind: TerrainKind;
  /** Wild scenery (exterior) rather than kingdom ground. */
  wild: boolean;
  /** May appear inside the protected frame (E-6: ground-level only). */
  inFrame: boolean;
  /** The one texture every pure cell of this terrain uses (ART-NOTES "canonical pure tiles"). */
  canonical?: { family: string; side: 'lower' | 'upper' };
  /** A builder-derived tonal variant of another terrain (ART-NOTES "tonal variation blobs"). */
  derived?: { from: string; value: number; hue: number; saturation: number };
  /** Grade by class (D-174(6), Crownlands rework plan A1): a whole-terrain value/hue/saturation lift of a
   * `canonical` ground terrain. Every texel the UNTONED build classes as this terrain — its pure cells,
   * the canonical fill of every family tile, the provider band texels on its side, a derived family's
   * transferred texels, the verge it paints, the decal texels nearest its colours — is toned by the one
   * `toneTile` rule; nothing that decides a class (palettes, water keying, verges, mask transfer) ever
   * sees the tone, so a tone lifts a terrain and never moves a boundary. Never on water (its loop
   * palette is locked), a derived terrain (it carries its own), or a terrain a derived twin names. */
  tone?: KitTone;
  /** Composite order where three or more terrains meet on one tile: higher draws over lower (default 0). */
  layer?: number;
  /** Where a FIELD tile meets terrains no family joins (a triple junction, or a pair without a
   * family), corners of this terrain collapse to `fallback` until a family can draw the
   * tile. Corner Wang has no three-terrain tiles; the collapse is counted in the stats. A §2
   * ring variant never collapses: a ring tile over this terrain needs a family joining it to
   * the kingdom terrain or the build fails naming the tile (the collapse would be the default
   * ring painted over ground the cell has none of — the K-177 cut-off). */
  fallback?: string;
}
/** `corners: 'provider'` keeps the provider's own single/three-corner tiles instead of the synthesized ones.
 * A `derived` family has no source: its 16 tiles are the `from` family's tiles with every texel of
 * the replaced terrain swapped for the new terrain's canonical texel (mask transfer), so a road
 * meets dirt with exactly the cobbles and edge it meets grass with. `verge` paints the lower
 * terrain's texels within `px` of the boundary as another terrain (a worn dirt fringe along a road),
 * thinning with distance by hash. */
export interface KitFamily { id: string; lower: string; upper: string; kind: FamilyKind; source?: string; corners?: 'provider';
  /** Snap every texel of the transition band to its class's canonical palette (a family whose provider palette drifted). */
  snapBand?: boolean;
  /** `'own'`: tell this family's texels apart by ITS OWN pure tiles (masks 0/15) instead of the two
   * terrains' canonical palettes, a lower-coloured texel enclosed by the upper terrain counting as
   * upper (REALM_KIT_BUILD.jointPx). For a provider sheet that draws the upper terrain with the lower
   * terrain's own colours — Frostveil's snow-dusted flagstone joints ARE the sheet's three snow
   * colours, so against the derived wild-snow twin every snow texel of every mask was nearer the
   * road and the whole family baked to the pure road. Replacement still uses the canonical tiles;
   * wang16 only (a derived family classifies through its source). */
  classify?: 'own';
  from?: string; replace?: Record<string, string>;
  verge?: { terrain: string; px: number } }
export interface KitVariants { transforms: Transform[]; jitter: number }
/** `highlightFraction` of the brightest texels drift diagonally, the next `rippleFraction` drift
 * horizontally the other way (both wrap, so frames × shiftPx must be a multiple of 32). */
export interface KitWater { canonical: string; frames: number; frameDurationMs: number; shiftPx: number; highlightFraction: number; rippleFraction?: number; flattenBody?: boolean;
  /** Highlight drift per frame in texels (default [shiftPx, shiftPx], the diagonal); frames × each component must be ≡ 0 mod 32. */
  drift?: [number, number] }
export interface KitClip { source: string; frames: number; frameDurationMs: number }
export interface KitProp { id: string; source: string; kind: PropKind; footprint: [number, number]; clip?: KitClip }
/** `mask: 'organic'` for cover patches that fill their tile (ART-NOTES: square patches read as tiles). */
/** `noRepeatNeighbours` (opt-in, default off): the shape never lands beside itself, edge or corner — a tile whose
 * pick equals an already-chosen neighbour's decal re-draws from its group's other decals (Thornwake's
 * water currents; the owner's "no dense repeated pattern" verdict of 2026-09-24). */
export interface KitDecal { id: string; source: string; mask?: 'organic'; noRepeatNeighbours?: boolean }
export interface KitSprite { id: string; sources: string[]; frameDurationMs: number }
/** A roaming creature's walk cycles (D-173 creature paths; `sources/creatures/README.md`): `source`
 * names one PNG per facing and frame (`%s` ∈ down,left,right,up; `%d` ∈ 0..frames−1), every frame on
 * one canvas seated bottom-centre with frame 0 touching the bottom row. Packed into one sheet asset
 * per creature, `directions × frames` cells row-major in REALM_KIT_FACINGS order. `speed` is its
 * walking pace in art px/s; `kind` says which terrains its roam groups may name. */
export interface KitCreature { id: string; source: string; directions: 4; frames: number; frameDurationMs: number; speed: number; kind: 'ground' | 'water' }
export interface Kit {
  schemaVersion: 1; realmId: RealmId; tilePixels: 32; paddingColor: string;
  /** The runtime boundary ring: kingdom terrain (upper of the Wang mask), wild terrain, the family drawing it.
   * `road` names the kingdom road terrain (P0 §2 ring variants, D-173, K-177 "road end"): the layout's
   * road must run from the field edge into the smallest kingdom so EVERY reachable claim's ring crosses
   * it — the builder refuses a road that stops in the wild ground, naming the first claim it misses.
   * Optional only so a realm without a road role (the synthetic test realm) still builds; every authored
   * realm declares it, or the cut-off the ring variants fixed could return unnoticed. */
  boundary: { kingdom: string; wild: string; family: string; road?: string };
  terrains: Record<string, KitTerrain>;
  families: KitFamily[];
  variants: Record<string, KitVariants>;
  water: KitWater;
  props: KitProp[];
  decals: KitDecal[];
  /** Standalone animated sprites for ambient paths (each frame its own source). */
  sprites: KitSprite[];
  /** Roaming creatures (absent = none). */
  creatures?: KitCreature[];
  obstacleSprites: Partial<Record<ObstacleSpriteKey, { intact: string; remnant: string }>>;
  palette: { ground: Record<string, string>; accent: string[] };
}
export type LayoutOp =
  | { op: 'fill'; terrain: string }
  | { op: 'rect'; terrain: string; x0: number; y0: number; x1: number; y1: number; over?: string[] }
  | { op: 'blob'; terrain: string; cx: number; cy: number; rx: number; ry: number; jitter: number; power?: number; over?: string[] }
  | { op: 'path'; terrain: string; points: [number, number][]; width: number; jitter: number; wobbleTiles?: number; over?: string[] }
  | { op: 'ring'; terrain: string; x0: number; y0: number; x1: number; y1: number; thickness: number; over?: string[] };
export interface LayoutWeighted { id: string; weight: number }
/** `field` is everything; `frame` the protected frame; `exterior` the field minus the frame and its meadow rings. */
export type LayoutRegion = 'exterior' | 'frame' | 'field' | { x0: number; y0: number; x1: number; y1: number };
/** A grove lays its props on a jittered hexagonal lattice (`spacing` tiles between neighbours,
 * `jitter` as a fraction of spacing) instead of uniform random tiles, and each `clusterTiles`²
 * cell of the field prefers one species (picked by hash) with probability `clusterWeight`, so
 * a wood reads as stands of oak and stands of pine rather than salt-and-pepper. `density` then
 * thins the lattice (percent of points kept). */
export interface LayoutGrove { spacing: number; jitter: number; clusterTiles: number; clusterWeight: number }
/** `terrains` is the allowed corner set of every footprint tile; `require` lists terrains the
 * anchor tile must also contain (shore props on shore tiles, not open water). `footOn` (optional)
 * lists the terrains both BOTTOM corners of the anchor tile must hold: a prop stands on that
 * edge, and `require` alone lets a shore tile's chord put a bank tree's roots in the water. */
export interface LayoutScatter { id: string; region: LayoutRegion; zone?: string; terrains: string[]; require?: string[]; footOn?: string[]; props: LayoutWeighted[]; density: number; minGap: number; max?: number; grove?: LayoutGrove }
/** `near` (optional) keeps a group within `tiles` (Chebyshev) of a tile holding one of the named
 * terrains — pebbles along the shore, not across the whole meadow. */
export interface LayoutDecals { id: string; region: LayoutRegion; zone?: string; terrains: string[]; decals: LayoutWeighted[]; density: number; near?: { terrains: string[]; tiles: number } }
/** `on` (optional) lists the terrains every footprint tile may contain — a boat on water, a
 * mill on the bank — so a moved blob cannot leave a prop stranded unnoticed. */
export interface LayoutPlace { prop: string; tx: number; ty: number; dx?: number; dy?: number; on?: string[] }
export interface LayoutPath { id: string; sprite: string; points: [number, number][]; speed: number }
/** A roam group (D-173 creature paths): `count` creatures apportioned by `weight` (largest remainder,
 * so the authored counts are exact), each given a seeded closed polyline of `vertices` tile centres
 * within `radius` (Chebyshev) of an anchor tile — every vertex and every tile a segment crosses on
 * `terrains` (all corners), outside the protected frame and its meadow rings, off every placement
 * footprint, the sprite inside the field — pausing `dwellMs` at each vertex. A `water` creature's
 * group names water terrains only, a `ground` creature's ground terrains only. */
export interface LayoutRoam { id: string; region: LayoutRegion; zone?: string; terrains: string[]; count: number; radius: number; vertices: number; dwellMs: number; creatures: LayoutWeighted[] }
/** Zones are painted like terrain ops (terrain 'in' on a blank field, 'out' carving back out) but
 * change no ground: a scatter or decal group with `zone` lands only on tiles with at least two
 * vertices inside. `'out'` clears a glade or a farm out of a zone without painting ground (D-173
 * rounds (3): zones steer where trees stand). */
export interface Layout { schemaVersion: 1; seed: number; ops: LayoutOp[]; zones?: Record<string, LayoutOp[]>; decals: LayoutDecals[]; scatter: LayoutScatter[]; place: LayoutPlace[]; paths: LayoutPath[]; roam?: LayoutRoam[] }

class KitError extends Error {}
function fail(message: string): never { throw new KitError(message); }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown, lo: number, hi: number): v is number => Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi;
const finite = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const keyed = (v: unknown): v is string => typeof v === 'string' && KEY.test(v);
const source = (v: unknown): v is string => typeof v === 'string' && RELATIVE_SOURCE.test(v) && !v.includes('..');
const weighted = (v: unknown): v is LayoutWeighted[] => Array.isArray(v) && v.length > 0
  && v.every(w => object(w) && keyed(w.id) && finite(w.weight, 0, 1e6)) && v.some(w => (w as LayoutWeighted).weight > 0);
const region = (v: unknown): v is LayoutRegion => v === 'exterior' || v === 'frame' || v === 'field'
  || (object(v) && [v.x0, v.y0, v.x1, v.y1].every(n => integer(n, FIELD_ORIGIN, FIELD_END)) && (v.x0 as number) < (v.x1 as number) && (v.y0 as number) < (v.y1 as number));

export function assertKit(value: unknown): asserts value is Kit {
  if (!object(value) || value.schemaVersion !== 1 || !isRealmId(value.realmId) || value.tilePixels !== TILE
    || typeof value.paddingColor !== 'string' || !HEX.test(value.paddingColor)
    || !object(value.terrains) || !Array.isArray(value.families) || !object(value.variants) || !object(value.water)
    || !Array.isArray(value.props) || !Array.isArray(value.decals) || !Array.isArray(value.sprites)
    || !object(value.obstacleSprites) || !object(value.palette) || !object(value.boundary)) fail('kit.json: invalid top-level shape');
  const k = value as unknown as Kit, terrains = Object.keys(k.terrains);
  if (!terrains.length || !terrains.every(keyed)) fail('kit.json: terrains must be keyed by [a-z][a-z0-9_]*');
  const has = (t: unknown) => typeof t === 'string' && t in k.terrains;
  const familyIds = new Set<string>();
  for (const f of k.families) {
    if (!object(f) || !keyed(f.id) || familyIds.has(f.id) || !has(f.lower) || !has(f.upper) || f.lower === f.upper
      || !['wang16', 'tone', 'cliff25', 'derived'].includes(f.kind)
      || (f.kind === 'tone' || f.kind === 'derived' ? f.source !== undefined : !source(f.source)) || (f.corners !== undefined && f.corners !== 'provider')
      || (f.snapBand !== undefined && typeof f.snapBand !== 'boolean')
      || (f.classify !== undefined && (f.classify !== 'own' || f.kind !== 'wang16'))
      || (f.kind === 'derived') !== (f.from !== undefined)
      || (f.from !== undefined && (!familyIds.has(f.from) || !object(f.replace) || !Object.entries(f.replace).every(([a, b]) => has(a) && has(b) && a !== b)))
      || (f.verge !== undefined && (!object(f.verge) || !has(f.verge.terrain) || !integer(f.verge.px, 1, 4)))) fail(`kit.json: invalid family ${String((f as { id?: unknown })?.id)}`);
    familyIds.add(f.id);
  }
  // A derived family keeps the source's roles: each replaced terrain maps lower→lower or upper→upper.
  for (const f of k.families) if (f.kind === 'derived') {
    const src = k.families.find(x => x.id === f.from)!;
    for (const [a, b] of Object.entries(f.replace!)) if (!((a === src.lower && b === f.lower) || (a === src.upper && b === f.upper))) fail(`kit.json: derived family ${f.id} must replace ${src.lower}→${f.lower} or ${src.upper}→${f.upper}`);
    if ((f.lower === src.lower) === (f.lower in f.replace!) || (f.upper === src.upper) === (f.upper in f.replace!)) { /* one side kept, one replaced — or both kept, which is pointless but harmless */ }
  }
  for (const [id, t] of Object.entries(k.terrains)) {
    if (!object(t) || typeof t.label !== 'string' || !['ground', 'water', 'plateau'].includes(t.kind)
      || typeof t.wild !== 'boolean' || typeof t.inFrame !== 'boolean'
      || (t.canonical === undefined) === (t.derived === undefined)) fail(`kit.json: terrain ${id} needs exactly one of canonical|derived`);
    if (t.canonical && (!object(t.canonical) || !familyIds.has(t.canonical.family as string) || !['lower', 'upper'].includes(t.canonical.side as string)
      || !k.families.some(f => f.id === t.canonical!.family && f.kind !== 'tone' && f[t.canonical!.side] === id))) fail(`kit.json: terrain ${id} canonical must name a source family side that is this terrain`);
    if (t.derived && (!object(t.derived) || !has(t.derived.from) || t.derived.from === id || !finite(t.derived.value, 0.5, 1.5)
      || !finite(t.derived.hue, -180, 180) || !finite(t.derived.saturation, 0, 2) || k.terrains[t.derived.from]!.derived !== undefined)) fail(`kit.json: terrain ${id} derived is invalid`);
    if (t.tone !== undefined) {
      if (!object(t.tone) || !finite(t.tone.value, 0.5, 1.5) || !finite(t.tone.hue, -180, 180) || !finite(t.tone.saturation, 0, 2)) fail(`kit.json: terrain ${id} tone is invalid (value 0.5–1.5, hue −180..180, saturation 0–2)`);
      if (t.kind === 'water' || t.derived !== undefined) fail(`kit.json: terrain ${id} takes no tone (a water loop keeps its locked palette; a derived terrain carries its own value/hue/saturation)`);
      const twin = Object.entries(k.terrains).find(([, o]) => object(o) && object(o.derived) && o.derived.from === id)?.[0];
      if (twin !== undefined) fail(`kit.json: terrain ${id} takes no tone while ${twin} derives from it (the twin's source would move under it; tone a terrain no derived terrain names)`);
    }
    if (t.kind === 'water' && t.inFrame) fail(`kit.json: water terrain ${id} may not be inFrame (E-6)`);
    if (t.fallback !== undefined && (!has(t.fallback) || t.fallback === id)) fail(`kit.json: terrain ${id} fallback must name another terrain`);
    if (t.layer !== undefined && !integer(t.layer, 0, 15)) fail(`kit.json: terrain ${id} layer must be 0..15`);
  }
  for (const id of terrains) { // fallback chains terminate
    const seen = new Set<string>();
    for (let t: string | undefined = id; t !== undefined; t = k.terrains[t]!.fallback) { if (seen.has(t)) fail(`kit.json: fallback cycle through ${t}`); seen.add(t); }
  }
  for (const [id, v] of Object.entries(k.variants)) {
    if (!has(id) || !object(v) || !Array.isArray(v.transforms) || !v.transforms.length || !v.transforms.every(t => TRANSFORMS.includes(t as Transform))
      || new Set(v.transforms).size !== v.transforms.length || !finite(v.jitter, 0, 0.25)) fail(`kit.json: invalid variants for ${id}`);
  }
  const b = k.boundary;
  if (!has(b.kingdom) || !has(b.wild) || b.kingdom === b.wild || !k.terrains[b.wild]!.wild || k.terrains[b.kingdom]!.wild
    || !k.families.some(f => f.id === b.family && f.kind === 'wang16' && new Set([f.lower, f.upper]).size === 2 && [f.lower, f.upper].includes(b.kingdom) && [f.lower, f.upper].includes(b.wild))
    || !k.variants[b.kingdom] || !k.variants[b.wild]) fail('kit.json: boundary must name a wang16 family between the kingdom and wild terrains, both with variants');
  if (b.road !== undefined && (!has(b.road) || b.road === b.kingdom || b.road === b.wild || k.terrains[b.road]!.kind !== 'ground' || !k.terrains[b.road]!.inFrame))
    fail('kit.json: boundary.road must name an inFrame ground terrain other than the kingdom and wild terrains (the kingdom road runs into the smallest kingdom)');
  const w = k.water;
  if (!has(w.canonical) || k.terrains[w.canonical]!.kind !== 'water' || !integer(w.frames, 2, 32) || !integer(w.frameDurationMs, 50, 10000)
    || !integer(w.shiftPx, 1, TILE) || (w.shiftPx * w.frames) % TILE !== 0 || !finite(w.highlightFraction, 0.02, 0.5)
    || (w.rippleFraction !== undefined && (!finite(w.rippleFraction, 0, 0.5) || w.highlightFraction + w.rippleFraction > 0.6))
    || (w.flattenBody !== undefined && typeof w.flattenBody !== 'boolean')
    || (w.drift !== undefined && (!Array.isArray(w.drift) || w.drift.length !== 2 || !w.drift.every(d => integer(d, -TILE, TILE) && (d * w.frames) % TILE === 0)))) fail('kit.json: water loop must wrap the tile exactly (frames × shiftPx ≡ 0 mod 32)');
  const propIds = new Set<string>();
  for (const p of k.props) {
    if (!object(p) || !keyed(p.id) || propIds.has(p.id) || !source(p.source) || !['tall', 'low', 'decal'].includes(p.kind)
      || !Array.isArray(p.footprint) || p.footprint.length !== 2 || !p.footprint.every(n => integer(n, 1, 8))
      || (p.clip !== undefined && (!object(p.clip) || !source(p.clip.source) || !(p.clip.source as string).includes('%d')
        || !integer(p.clip.frames, 2, 64) || !integer(p.clip.frameDurationMs, 50, 10000)))) fail(`kit.json: invalid prop ${String((p as { id?: unknown })?.id)}`);
    propIds.add(p.id);
  }
  const decalIds = new Set<string>();
  for (const d of k.decals) {
    if (!object(d) || !keyed(d.id) || decalIds.has(d.id) || !source(d.source) || (d.mask !== undefined && d.mask !== 'organic')
      || (d.noRepeatNeighbours !== undefined && typeof d.noRepeatNeighbours !== 'boolean')) fail(`kit.json: invalid decal ${String((d as { id?: unknown })?.id)}`);
    decalIds.add(d.id);
  }
  const spriteIds = new Set<string>();
  for (const s of k.sprites) {
    if (!object(s) || !keyed(s.id) || spriteIds.has(s.id) || propIds.has(s.id) || !Array.isArray(s.sources) || !s.sources.length || !s.sources.every(source)
      || !integer(s.frameDurationMs, 50, 10000)) fail(`kit.json: invalid sprite ${String((s as { id?: unknown })?.id)}`);
    spriteIds.add(s.id);
  }
  if (k.creatures !== undefined && !Array.isArray(k.creatures)) fail('kit.json: creatures must be an array');
  const creatureIds = new Set<string>();
  for (const c of k.creatures ?? []) {
    if (!object(c) || !keyed(c.id) || creatureIds.has(c.id) || propIds.has(c.id) || spriteIds.has(c.id) || !source(c.source)
      || !(c.source as string).includes('%s') || !(c.source as string).includes('%d') || c.directions !== 4
      || !integer(c.frames, 2, 16) || !integer(c.frameDurationMs, 50, 10000) || !integer(c.speed, 1, 4096) || !['ground', 'water'].includes(c.kind as string)) fail(`kit.json: invalid creature ${String((c as { id?: unknown })?.id)}`);
    creatureIds.add(c.id);
  }
  for (const [key, states] of Object.entries(k.obstacleSprites)) {
    if (!OBSTACLE_SPRITE_KEYS.includes(key as ObstacleSpriteKey) || !object(states) || !propIds.has(states.intact as string) || !propIds.has(states.remnant as string)
      || k.props.find(p => p.id === states.intact)!.clip || k.props.find(p => p.id === states.remnant)!.clip) fail(`kit.json: obstacleSprites.${key} must map to two still props`);
  }
  if (!object(k.palette.ground) || !Array.isArray(k.palette.accent) || !k.palette.accent.every(c => typeof c === 'string' && HEX.test(c))) fail('kit.json: palette shape');
  for (const [id, hex] of Object.entries(k.palette.ground)) if (!has(id) || typeof hex !== 'string' || !HEX.test(hex)) fail(`kit.json: palette.ground.${id}`);
  for (const id of terrains) if (!k.terrains[id]!.derived && !(id in k.palette.ground)) fail(`kit.json: palette.ground lacks ${id} (palette check per family)`);
}
export function assertLayout(value: unknown, kit: Kit): asserts value is Layout {
  if (!object(value) || value.schemaVersion !== 1 || !integer(value.seed, 0, 0xffffffff) || !Array.isArray(value.ops)
    || !Array.isArray(value.decals) || !Array.isArray(value.scatter) || !Array.isArray(value.place) || !Array.isArray(value.paths)) fail('layout.json: invalid top-level shape');
  const l = value as unknown as Layout;
  const terrain = (t: unknown) => typeof t === 'string' && t in kit.terrains;
  const over = (o: unknown) => o === undefined || (Array.isArray(o) && o.every(terrain));
  const vertex = (n: unknown) => integer(n, FIELD_ORIGIN, FIELD_END);
  const zoneNames = new Set(Object.keys(l.zones ?? {}));
  if (l.zones !== undefined && (!object(l.zones) || ![...zoneNames].every(keyed))) fail('layout.json: zones must be keyed by [a-z][a-z0-9_]*');
  const opOk = (op: unknown, terrainOk: (t: unknown) => boolean, overOk: (o: unknown) => boolean): boolean =>
    object(op) && terrainOk(op.terrain) && (
      op.op === 'fill'
      || (op.op === 'rect' && [op.x0, op.y0, op.x1, op.y1].every(vertex) && overOk(op.over))
      || (op.op === 'blob' && finite(op.cx, FIELD_ORIGIN, FIELD_END) && finite(op.cy, FIELD_ORIGIN, FIELD_END) && finite(op.rx, 0.5, FIELD_TILES) && finite(op.ry, 0.5, FIELD_TILES) && finite(op.jitter, 0, 1)
        && (op.power === undefined || finite(op.power, 1, 8)) && overOk(op.over))
      || (op.op === 'path' && Array.isArray(op.points) && op.points.length >= 2 && op.points.every(p => Array.isArray(p) && p.length === 2 && p.every(n => finite(n, FIELD_ORIGIN, FIELD_END)))
        && finite(op.width, 0, FIELD_TILES) && finite(op.jitter, 0, 1) && (op.wobbleTiles === undefined || finite(op.wobbleTiles, 1, FIELD_TILES)) && overOk(op.over))
      || (op.op === 'ring' && [op.x0, op.y0, op.x1, op.y1].every(vertex) && integer(op.thickness, 1, FIELD_TILES) && overOk(op.over)));
  for (const [name, ops] of Object.entries(l.zones ?? {})) {
    if (!Array.isArray(ops) || !ops.length) fail(`layout.json: zone ${name} needs ops`);
    for (const [i, op] of ops.entries()) if (!opOk(op, t => t === 'in' || t === 'out', o => o === undefined)) fail(`layout.json: zone ${name} ops[${i}] is invalid (terrain must be 'in' or 'out', no over)`);
  }
  for (const [i, op] of l.ops.entries()) {
    const ok = opOk(op, terrain, over);
    if (!ok) fail(`layout.json: ops[${i}] is invalid`);
  }
  const ids = new Set<string>();
  for (const s of l.scatter) {
    if (!object(s) || !keyed(s.id) || ids.has(s.id) || !region(s.region) || (s.zone !== undefined && !zoneNames.has(s.zone as string)) || !Array.isArray(s.terrains) || !s.terrains.length || !s.terrains.every(terrain)
      || (s.require !== undefined && (!Array.isArray(s.require) || !s.require.every(t => terrain(t) && (s.terrains as string[]).includes(t))))
      || (s.footOn !== undefined && (!Array.isArray(s.footOn) || !s.footOn.length || !s.footOn.every(t => terrain(t) && (s.terrains as string[]).includes(t))))
      || !weighted(s.props) || !s.props.every(p => kit.props.some(k => k.id === p.id)) || !finite(s.density, 0, 100) || !integer(s.minGap, 0, FIELD_TILES)
      || (s.max !== undefined && !integer(s.max, 0, L.placements))
      || (s.grove !== undefined && (!object(s.grove) || !finite(s.grove.spacing, 1, FIELD_TILES) || !finite(s.grove.jitter, 0, 1)
        || !integer(s.grove.clusterTiles, 1, FIELD_TILES) || !finite(s.grove.clusterWeight, 0, 1)))) fail(`layout.json: scatter ${String((s as { id?: unknown })?.id)} is invalid`);
    ids.add(s.id);
  }
  for (const d of l.decals) {
    if (!object(d) || !keyed(d.id) || ids.has(d.id) || !region(d.region) || (d.zone !== undefined && !zoneNames.has(d.zone as string)) || !Array.isArray(d.terrains) || !d.terrains.length || !d.terrains.every(terrain)
      || !weighted(d.decals) || !d.decals.every(p => kit.decals.some(k => k.id === p.id)) || !finite(d.density, 0, 1)
      || (d.near !== undefined && (!object(d.near) || !Array.isArray(d.near.terrains) || !d.near.terrains.length || !d.near.terrains.every(terrain) || !integer(d.near.tiles, 1, 8)))) fail(`layout.json: decals ${String((d as { id?: unknown })?.id)} is invalid`);
    ids.add(d.id);
  }
  for (const [i, p] of l.place.entries()) {
    if (!object(p) || !kit.props.some(k => k.id === p.prop) || !integer(p.tx, FIELD_ORIGIN, FIELD_END - 1) || !integer(p.ty, FIELD_ORIGIN, FIELD_END - 1)
      || (p.dx !== undefined && !integer(p.dx, -TILE, TILE)) || (p.dy !== undefined && !integer(p.dy, -TILE, TILE))
      || (p.on !== undefined && (!Array.isArray(p.on) || !p.on.length || !p.on.every(terrain)))) fail(`layout.json: place[${i}] is invalid`);
  }
  for (const p of l.paths) {
    if (!object(p) || !keyed(p.id) || ids.has(p.id) || !kit.sprites.some(s => s.id === p.sprite) || !Array.isArray(p.points) || p.points.length < 2 || p.points.length > L.pathPoints
      || !p.points.every(q => Array.isArray(q) && q.length === 2 && q.every(n => finite(n, FIELD_ORIGIN, FIELD_END))) || !integer(p.speed, 1, 4096)) fail(`layout.json: path ${String((p as { id?: unknown })?.id)} is invalid`);
    ids.add(p.id);
  }
  if (l.roam !== undefined && !Array.isArray(l.roam)) fail('layout.json: roam must be an array');
  let routes = l.paths.length;
  for (const g of l.roam ?? []) {
    const creatures = kit.creatures ?? [];
    if (!object(g) || !keyed(g.id) || ids.has(g.id) || !region(g.region) || (g.zone !== undefined && !zoneNames.has(g.zone as string))
      || !Array.isArray(g.terrains) || !g.terrains.length || !g.terrains.every(terrain)
      || !integer(g.count, 1, L.paths) || !integer(g.radius, 1, FIELD_TILES) || !integer(g.vertices, 4, 8) || !integer(g.dwellMs, 0, 60000)
      || !weighted(g.creatures) || !g.creatures.every(w => creatures.some(c => c.id === w.id))) fail(`layout.json: roam ${String((g as { id?: unknown })?.id)} is invalid`);
    // A duck's group names water, a deer's group ground: the creature's kind and the group's terrains agree.
    for (const w of g.creatures) {
      const c = creatures.find(k => k.id === w.id)!;
      const want = c.kind === 'water' ? 'water' : 'ground';
      if (!g.terrains.every(t => kit.terrains[t]!.kind === want)) fail(`layout.json: roam ${g.id} puts ${c.id} (${c.kind}) on ${g.terrains.join('/')}`);
    }
    ids.add(g.id); routes += g.count;
  }
  if (routes > L.paths) fail(`layout.json: ${routes} routes (paths + roam counts) exceed LAYERED_GROUND_LIMITS_R5.paths`);
}

// ---------------------------------------------------------------------------
// Rasters (straight RGBA, binary alpha everywhere the kit touches)
// ---------------------------------------------------------------------------
export interface Raster { width: number; height: number; data: Uint8Array }
export const raster = (width: number, height: number): Raster => ({ width, height, data: new Uint8Array(width * height * 4) });
export async function readPng(file: string): Promise<Raster> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) fail(`${file}: expected RGBA`);
  const out = { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  for (let i = 3; i < out.data.length; i += 4) if (out.data[i] !== 0 && out.data[i] !== 255) fail(`${file}: semi-transparent texel (E-13 binary alpha)`);
  for (let i = 0; i < out.data.length; i += 4) if (out.data[i + 3] === 0) out.data[i] = out.data[i + 1] = out.data[i + 2] = 0;
  return out;
}
/** Deterministic lossless PNG: fixed filter/compression, no palette, no metadata. */
export async function encodePng(r: Raster): Promise<Buffer> {
  return sharp(Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength), { raw: { width: r.width, height: r.height, channels: 4 } })
    .png({ palette: false, compressionLevel: 9, adaptiveFiltering: false, effort: 10 }).toBuffer();
}
export function crop(src: Raster, x: number, y: number, width: number, height: number): Raster {
  if (x < 0 || y < 0 || x + width > src.width || y + height > src.height) fail(`crop ${x},${y} ${width}×${height} escapes ${src.width}×${src.height}`);
  const out = raster(width, height);
  for (let v = 0; v < height; v++) out.data.set(src.data.subarray(((y + v) * src.width + x) * 4, ((y + v) * src.width + x + width) * 4), v * width * 4);
  return out;
}
export function blit(dst: Raster, src: Raster, x: number, y: number, mask?: (u: number, v: number) => boolean): void {
  for (let v = 0; v < src.height; v++) for (let u = 0; u < src.width; u++) {
    const dx = x + u, dy = y + v;
    if (dx < 0 || dy < 0 || dx >= dst.width || dy >= dst.height || (mask && !mask(u, v))) continue;
    const s = (v * src.width + u) * 4, d = (dy * dst.width + dx) * 4;
    if (src.data[s + 3] === 0) continue;
    dst.data[d] = src.data[s]!; dst.data[d + 1] = src.data[s + 1]!; dst.data[d + 2] = src.data[s + 2]!; dst.data[d + 3] = 255;
  }
}
export function transformTile(t: Raster, how: Transform): Raster {
  const out = raster(t.width, t.height);
  for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) {
    const sx = how === 'mirror-x' || how === 'rotate-180' ? t.width - 1 - x : x, sy = how === 'mirror-y' || how === 'rotate-180' ? t.height - 1 - y : y;
    out.data.set(t.data.subarray((sy * t.width + sx) * 4, (sy * t.width + sx) * 4 + 4), (y * t.width + x) * 4);
  }
  return out;
}
const clamp255 = (n: number) => n < 0 ? 0 : n > 255 ? 255 : Math.round(n);
/** Value jitter on opaque texels (ART-NOTES ±3 %): integer rounding keeps it reproducible. */
export function jitterValue(t: Raster, factor: number): Raster {
  const out = { width: t.width, height: t.height, data: new Uint8Array(t.data) };
  for (let i = 0; i < out.data.length; i += 4) if (out.data[i + 3] === 255) for (let c = 0; c < 3; c++) out.data[i + c] = clamp255(out.data[i + c]! * factor);
  return out;
}
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, v = max / 255, s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d !== 0) { h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, s, v];
}
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [clamp255((r + m) * 255), clamp255((g + m) * 255), clamp255((b + m) * 255)];
}
/** One texel of `toneTile`: every tone the builder applies (derived twins, graded terrains, decals) is this math. */
function toneTexel(r: number, g: number, b: number, d: KitTone): [number, number, number] {
  const [h, s, v] = rgbToHsv(r, g, b);
  return hsvToRgb(((h + d.hue) % 360 + 360) % 360, Math.min(1, s * d.saturation), Math.min(1, v * d.value));
}
/** Tonal derivation of a canonical tile (shade/dry blobs): value ×, hue +°, saturation ×. */
export function toneTile(t: Raster, d: KitTone): Raster {
  const out = { width: t.width, height: t.height, data: new Uint8Array(t.data) };
  for (let i = 0; i < out.data.length; i += 4) {
    if (out.data[i + 3] !== 255) continue;
    const [r, g, b] = toneTexel(out.data[i]!, out.data[i + 1]!, out.data[i + 2]!, d);
    out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b;
  }
  return out;
}
/** Grade by class (KitTerrain.tone): the untoned family tiles with `toneTile`'s math applied to exactly the
 * opaque texels whose class — 0 lower, 1 upper, 2 verge, as the untoned build decided them — is a toned
 * terrain. Classes come in, never out: a tone recolours texels and cannot move a boundary. */
export function gradeTiles(tiles: Raster[], classes: Uint8Array[], tones: ReadonlyArray<KitTone | undefined>): Raster[] {
  if (!tones.some(Boolean)) return tiles;
  return tiles.map((t, mask) => {
    const cls = classes[mask]!, out = { width: t.width, height: t.height, data: new Uint8Array(t.data) };
    for (let i = 0; i < TILE * TILE; i++) {
      const tone = tones[cls[i]!];
      if (tone && t.data[i * 4 + 3] === 255) out.data.set(toneTexel(t.data[i * 4]!, t.data[i * 4 + 1]!, t.data[i * 4 + 2]!, tone), i * 4);
    }
    return out;
  });
}
/** Ground-cover patches fill their 32-px tile with texture, so on the meadow they read as
 * pasted squares. The organic mask keeps a texel while its centre distance plus hash noise
 * stays under coverRadius: corners go, the edge turns ragged, the patch reads as a blob. */
export function organicMask(t: Raster, seed: number): Raster {
  const out = { width: t.width, height: t.height, data: new Uint8Array(t.data) };
  for (let v = 0; v < t.height; v++) for (let u = 0; u < t.width; u++) {
    const dx = (u + 0.5) / t.width * 2 - 1, dy = (v + 0.5) / t.height * 2 - 1;
    const d = Math.sqrt(dx * dx + dy * dy) + (hash01(seed, u, v) - 0.5) * REALM_KIT_BUILD.coverNoise;
    if (d > REALM_KIT_BUILD.coverRadius) out.data[(v * t.width + u) * 4 + 3] = 0;
  }
  return out;
}
export function meanRgb(t: Raster): [number, number, number] {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < t.data.length; i += 4) if (t.data[i + 3] === 255) { r += t.data[i]!; g += t.data[i + 1]!; b += t.data[i + 2]!; n++; }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}
/** Mean absolute per-channel difference of two same-size rasters over opaque texels. */
export function meanAbsDiff(a: Raster, b: Raster): number {
  let sum = 0, n = 0;
  for (let i = 0; i < a.data.length; i += 4) { if (a.data[i + 3] !== 255 || b.data[i + 3] !== 255) continue; for (let c = 0; c < 3; c++) sum += Math.abs(a.data[i + c]! - b.data[i + c]!); n += 3; }
  return n ? sum / n : 0;
}
export function rasterEquals(a: Raster, b: Raster): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}
/** The `n` most frequent opaque colours of a tile, packed as 0xRRGGBB. */
export function palette(t: Raster, n = REALM_KIT_BUILD.paletteColours): number[] {
  const counts = new Map<number, number>();
  for (let i = 0; i < t.data.length; i += 4) if (t.data[i + 3] === 255) { const c = (t.data[i]! << 16) | (t.data[i + 1]! << 8) | t.data[i + 2]!; counts.set(c, (counts.get(c) ?? 0) + 1); }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, n).map(e => e[0]);
}
export function paletteDistanceSq(r: number, g: number, b: number, p: number[]): number {
  let best = Infinity;
  for (const c of p) { const d = (r - (c >> 16)) ** 2 + (g - ((c >> 8) & 255)) ** 2 + (b - (c & 255)) ** 2; if (d < best) best = d; }
  return best;
}
/** Seamless check for a repeat tile: wrap-edge difference vs interior adjacent-column/row difference. */
export function seamRatio(t: Raster): number {
  const px = (x: number, y: number, c: number) => t.data[((y % t.height) * t.width + (x % t.width)) * 4 + c]!;
  let wrap = 0, wrapN = 0, inner = 0, innerN = 0;
  for (let y = 0; y < t.height; y++) for (let c = 0; c < 3; c++) { wrap += Math.abs(px(t.width - 1, y, c) - px(0, y, c)); wrapN++; }
  for (let x = 0; x < t.width; x++) for (let c = 0; c < 3; c++) { wrap += Math.abs(px(x, t.height - 1, c) - px(x, 0, c)); wrapN++; }
  for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width - 1; x++) for (let c = 0; c < 3; c++) { inner += Math.abs(px(x + 1, y, c) - px(x, y, c)); innerN++; }
  for (let y = 0; y < t.height - 1; y++) for (let x = 0; x < t.width; x++) for (let c = 0; c < 3; c++) { inner += Math.abs(px(x, y + 1, c) - px(x, y, c)); innerN++; }
  return (wrap / wrapN) / Math.max(1e-6, inner / innerN);
}
/** Integer box downsample by `k` (used for the overview); alpha forced opaque. */
export function boxDown(src: Raster, k: number): Raster {
  const out = raster(src.width / k, src.height / k);
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    let r = 0, g = 0, b = 0;
    for (let v = 0; v < k; v++) for (let u = 0; u < k; u++) { const i = ((y * k + v) * src.width + x * k + u) * 4; r += src.data[i]!; g += src.data[i + 1]!; b += src.data[i + 2]!; }
    const o = (y * out.width + x) * 4, n = k * k;
    out.data[o] = Math.floor((r + n / 2) / n); out.data[o + 1] = Math.floor((g + n / 2) / n); out.data[o + 2] = Math.floor((b + n / 2) / n); out.data[o + 3] = 255;
  }
  return out;
}
export function upscaleNearest(src: Raster, k: number): Raster {
  const out = raster(src.width * k, src.height * k);
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) out.data.set(src.data.subarray((Math.floor(y / k) * src.width + Math.floor(x / k)) * 4, (Math.floor(y / k) * src.width + Math.floor(x / k)) * 4 + 4), (y * out.width + x) * 4);
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic randomness (layout seed) — mulberry32, never Math.random
// ---------------------------------------------------------------------------
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** FNV-1a of a kit id: a per-decal mask seed that does not depend on load order. */
const fnv1a = (s: string) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); return h >>> 0; };
const hash01 = (...n: number[]) => { let h = 0x9e3779b9; for (const v of n) h = realmKitTileHash(h ^ Math.imul(v | 0, 0x85ebca6b), v | 0); return (h >>> 0) / 4294967296; };

// ---------------------------------------------------------------------------
// Provider tileset families (corner Wang, `metadata.json` tiles[] with corners + bounding_box)
// ---------------------------------------------------------------------------
export interface FamilyTiles { id: string; lower: string; upper: string; kind: FamilyKind; tiles: Raster[] /* index = mask NW·8+NE·4+SW·2+SE·1, bit = upper */;
  /** The same tiles before gradeTiles (=== `tiles` when neither side is toned): what a composite classifies. */
  untoned: Raster[] }
export function familyMask(c: { NW: string; NE: string; SW: string; SE: string }): number {
  return (c.NW === 'upper' ? 8 : 0) | (c.NE === 'upper' ? 4 : 0) | (c.SW === 'upper' ? 2 : 0) | (c.SE === 'upper' ? 1 : 0);
}
async function loadWang16(realmDir: string, f: KitFamily): Promise<Raster[]> {
  const dir = path.join(realmDir, f.source!);
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'metadata.json'), 'utf8')) as { tileset_data?: { tiles?: unknown[] } };
  const sheet = await readPng(path.join(dir, 'sheet.png'));
  const expected = (await fs.readFile(path.join(dir, 'sheet.sha256'), 'utf8')).trim().split(/\s+/)[0];
  const actual = createHash('sha256').update(await fs.readFile(path.join(dir, 'sheet.png'))).digest('hex');
  if (expected !== actual) fail(`family ${f.id}: sheet.png does not match sheet.sha256`);
  const tiles: Raster[] = new Array<Raster>(16);
  for (const t of meta.tileset_data?.tiles ?? []) {
    if (!object(t) || !object(t.corners) || !object(t.bounding_box)) fail(`family ${f.id}: malformed tile metadata`);
    const c = t.corners as { NW: string; NE: string; SW: string; SE: string }, b = t.bounding_box as { x: number; y: number; width: number; height: number };
    if (![c.NW, c.NE, c.SW, c.SE].every(s => s === 'lower' || s === 'upper')) continue; // cliff transition rows are not corner-Wang cells
    if (b.width !== TILE || b.height !== TILE) fail(`family ${f.id}: tile ${String(t.name)} is ${b.width}×${b.height}, expected ${TILE}`);
    const mask = familyMask(c);
    if (tiles[mask]) continue; // provider duplicates: first wins (board.py precedent)
    tiles[mask] = crop(sheet, b.x, b.y, TILE, TILE);
  }
  for (let m = 0; m < 16; m++) if (!tiles[m]) fail(`family ${f.id}: no tile for corner mask ${m}`);
  return tiles;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
interface TerrainArt { id: string; kind: TerrainKind; canonical: Raster; palette: number[]; variants: Raster[] }
interface CellKeyed { key: string; frames: Raster[]; frameDurationMs?: number }
export interface BuildResult { manifest: RealmKitManifest; sources: Array<{ asset: string; source: string }>; files: Map<string, Buffer>; stats: Record<string, number>; unusedProps: string[] }

/** Bilinear corner weight of an upper-terrain mask at a texel centre. */
function cornerWeight(mask: number, u: number, v: number): number {
  const nw = (mask >> 3) & 1, ne = (mask >> 2) & 1, sw = (mask >> 1) & 1, se = mask & 1, fx = (u + 0.5) / TILE, fy = (v + 0.5) / TILE;
  return (nw * (1 - fx) + ne * fx) * (1 - fy) + (sw * (1 - fx) + se * fx) * fy;
}
/** ART-NOTES "canonicalise": pure tiles are the canonical texture; inside transition
 * tiles, every texel farther than the band from the other class becomes canonical,
 * so the family's own rendition of a shared terrain never halos. Water-class texels
 * of a water side are keyed transparent (§7 shore convention). */
/** Upper-class mask of a tile by nearest palette (1 = upper terrain; a tie is the lower). With
 * `jointPx` > 0 (`classify: 'own'`) the upper class is then CLOSED by that radius — dilated, then
 * eroded, neighbours outside the tile ignored — so a lower-coloured texel enclosed by upper texels
 * (a snow-dusted flagstone joint) is upper too, while the boundary itself moves nowhere and no
 * texel the palettes called upper is ever lost. */
function classifyTile(t: Raster, lower: TerrainArt, upper: TerrainArt, jointPx = 0): Uint8Array {
  const cls = new Uint8Array(TILE * TILE);
  for (let i = 0; i < TILE * TILE; i++) {
    const r = t.data[i * 4]!, g = t.data[i * 4 + 1]!, b = t.data[i * 4 + 2]!;
    cls[i] = paletteDistanceSq(r, g, b, upper.palette) < paletteDistanceSq(r, g, b, lower.palette) ? 1 : 0;
  }
  if (jointPx <= 0) return cls;
  const near = (src: Uint8Array, u: number, v: number, k: number): boolean => {
    for (let dy = -jointPx; dy <= jointPx; dy++) for (let dx = -jointPx; dx <= jointPx; dx++) {
      const x = u + dx, y = v + dy;
      if (x >= 0 && y >= 0 && x < TILE && y < TILE && src[y * TILE + x] === k) return true;
    }
    return false;
  };
  const dilated = new Uint8Array(TILE * TILE), closed = new Uint8Array(TILE * TILE);
  for (let v = 0; v < TILE; v++) for (let u = 0; u < TILE; u++) dilated[v * TILE + u] = cls[v * TILE + u] || near(cls, u, v, 1) ? 1 : 0;
  for (let v = 0; v < TILE; v++) for (let u = 0; u < TILE; u++) closed[v * TILE + u] = cls[v * TILE + u] || (dilated[v * TILE + u] && !near(dilated, u, v, 0)) ? 1 : 0;
  return closed;
}
/** The provider draws a single-corner Wang tile (masks 1/2/4/8) as a small bump on the
 * tile's edge and a three-corner tile as a bump of the other side, so every diagonal
 * boundary rendered as square notches. The corner tiles (and the two diagonal tiles 6/9)
 * are rebuilt on a 45° CHORD between the two edge midpoints beside the corner: a run of
 * such tiles along a stepped vertex boundary lines up into one straight diagonal, and a
 * rectangle corner becomes a chamfer — the classic autotile look. The provider's own
 * transition band is kept: every texel within `bandPx` of the chord samples the family's
 * horizontal straight tile (mask 3) at the same signed distance from ITS ragged boundary,
 * so the outline, tufts and raggedness are warped onto the chord instead of redrawn. */
export function synthesizeCorners(tiles: Raster[], lower: TerrainArt, upper: TerrainArt, jointPx = 0): Raster[] {
  const out = [...tiles], bandPx = REALM_KIT_BUILD.chordBandPx;
  // The horizontal band source: mask 3 (SW+SE upper) has the upper terrain below a
  // boundary near row 16; b[u] is that boundary row per column, 16 where a column
  // never turns upper (a defect in the provider tile, not a hole in the band).
  const src = tiles[3]!, srcCls = classifyTile(src, lower, upper, jointPx), b = new Int32Array(TILE).fill(TILE / 2);
  for (let u = 0; u < TILE; u++) for (let v = 0; v < TILE; v++) if (srcCls[v * TILE + u]) { b[u] = v; break; }
  // A chord is described by its corner (cx, cy) in texel units; the line runs between the
  // two edge midpoints beside it. Signed distance is positive toward the corner.
  const chord = (cx: number, cy: number) => {
    const sx = cx === 0 ? -1 : 1, sy = cy === 0 ? -1 : 1; // corner direction
    return (x: number, y: number) => {
      // Distance from the line x*sx + y*sy = const through the midpoints, toward the corner.
      const px = x - cx, py = y - cy; // relative to the corner
      const along = -(px * sx + py * sy); // 0 at the corner, TILE/2 on the chord, 2·TILE at the far corner
      const d = (TILE / 2 - along) / Math.SQRT2; // > 0 on the corner side of the chord
      // Parameter along the chord (0..L) for band sampling: signed lateral position.
      const t = ((px * sx - py * sy) / Math.SQRT2) + TILE / (2 * Math.SQRT2);
      return { d, t };
    };
  };
  const L = TILE / Math.SQRT2; // chord length
  const compose = (chords: Array<{ cx: number; cy: number; cornerIsUpper: boolean }>): Raster => {
    const res = raster(TILE, TILE), fns = chords.map(c => ({ ...c, f: chord(c.cx, c.cy) }));
    for (let v = 0; v < TILE; v++) for (let u = 0; u < TILE; u++) {
      const x = u + 0.5, y = v + 0.5, i = v * TILE + u;
      // Signed distance to the upper side: the nearest chord decides; two chords (masks 6/9) both put upper at their corners.
      let best: { dUpper: number; t: number } | undefined;
      for (const c of fns) { const { d, t } = c.f(x, y); const dUpper = c.cornerIsUpper ? d : -d; if (!best || Math.abs(dUpper) < Math.abs(best.dUpper)) best = { dUpper, t }; }
      const { dUpper, t } = best!;
      if (Math.abs(dUpper) <= bandPx) {
        // Warp the source band: same column fraction along the chord, same signed row offset from its boundary.
        const su = Math.max(0, Math.min(TILE - 1, Math.floor(t / L * TILE))), sv = b[su]! + Math.round(dUpper);
        if (sv >= 0 && sv < TILE) { res.data.set(src.data.subarray((sv * TILE + su) * 4, (sv * TILE + su) * 4 + 4), i * 4); continue; }
      }
      const side = dUpper >= 0 ? upper : lower;
      res.data.set(side.canonical.data.subarray(i * 4, i * 4 + 4), i * 4);
    }
    return res;
  };
  const corners = [{ mask: 1, cx: TILE, cy: TILE }, { mask: 2, cx: 0, cy: TILE }, { mask: 4, cx: TILE, cy: 0 }, { mask: 8, cx: 0, cy: 0 }];
  for (const c of corners) { out[c.mask] = compose([{ cx: c.cx, cy: c.cy, cornerIsUpper: true }]); out[15 - c.mask] = compose([{ cx: c.cx, cy: c.cy, cornerIsUpper: false }]); }
  out[6] = compose([{ cx: TILE, cy: 0, cornerIsUpper: true }, { cx: 0, cy: TILE, cornerIsUpper: true }]);
  out[9] = compose([{ cx: 0, cy: 0, cornerIsUpper: true }, { cx: TILE, cy: TILE, cornerIsUpper: true }]);
  return out;
}
/** A worn fringe: lower-class texels within `px` of the boundary become the verge terrain's
 * canonical texel, all of them at 1 px and thinning by hash farther out, so a cobbled road
 * meets grass through a band of trodden earth instead of a hard line. */
export function vergeFamily(tiles: Raster[], lower: TerrainArt, upper: TerrainArt, verge: TerrainArt, px: number, seed: number, jointPx = 0, classes?: Uint8Array[]): Raster[] {
  // `classes` (from canonicaliseFamily, for gradeTiles): every texel the verge paints becomes class 2.
  return tiles.map((t, mask) => {
    if (mask === 0 || mask === 15) return t;
    const cls = classifyTile(t, lower, upper, jointPx), out = { width: TILE, height: TILE, data: new Uint8Array(t.data) };
    for (let v = 0; v < TILE; v++) for (let u = 0; u < TILE; u++) {
      const i = v * TILE + u;
      if (cls[i] || t.data[i * 4 + 3] !== 255) continue;
      let d = Infinity;
      for (let dy = -px; dy <= px; dy++) for (let dx = -px; dx <= px; dx++) {
        const x = u + dx, y = v + dy;
        if (x >= 0 && y >= 0 && x < TILE && y < TILE && cls[y * TILE + x]) d = Math.min(d, Math.max(Math.abs(dx), Math.abs(dy)));
      }
      if (d > px) continue;
      if (d === 1 || hash01(seed, u, v) < 1 - (d - 1) / px) { out.data.set(verge.canonical.data.subarray(i * 4, i * 4 + 4), i * 4); if (classes) classes[mask]![i] = 2; }
    }
    return out;
  });
}
/** Nearest colour of a canonical palette (packed 0xRRGGBB entries). */
function snapToPalette(r: number, g: number, b: number, p: number[]): [number, number, number] {
  let best = 0, bestD = Infinity;
  for (const c of p) { const dr = r - (c >> 16 & 255), dg = g - (c >> 8 & 255), db = b - (c & 255), d = dr * dr + dg * dg + db * db; if (d < bestD) { bestD = d; best = c; } }
  return [best >> 16 & 255, best >> 8 & 255, best & 255];
}
/** `classes`, when given, receives each mask's class of every texel (0 lower, 1 upper) for gradeTiles. */
export function canonicaliseFamily(tiles: Raster[], lower: TerrainArt, upper: TerrainArt, snapBand = false, jointPx = 0, classes?: Uint8Array[]): Raster[] {
  const band = REALM_KIT_BUILD.canonBandPx, out: Raster[] = [];
  for (let mask = 0; mask < 16; mask++) {
    if (mask === 0) { out.push(lower.kind === 'water' ? raster(TILE, TILE) : lower.canonical); classes?.push(new Uint8Array(TILE * TILE)); continue; }
    if (mask === 15) { out.push(upper.kind === 'water' ? raster(TILE, TILE) : upper.canonical); classes?.push(new Uint8Array(TILE * TILE).fill(1)); continue; }
    const t = tiles[mask]!, cls = classifyTile(t, lower, upper, jointPx), water = new Uint8Array(TILE * TILE);
    for (let i = 0; i < TILE * TILE; i++) {
      const r = t.data[i * 4]!, g = t.data[i * 4 + 1]!, b = t.data[i * 4 + 2]!;
      const dl = paletteDistanceSq(r, g, b, lower.palette), du = paletteDistanceSq(r, g, b, upper.palette);
      const side = cls[i] ? upper : lower;
      if (side.kind === 'water' && Math.min(dl, du) <= REALM_KIT_BUILD.waterKeyMaxDistanceSq) water[i] = 1;
    }
    const res = { width: TILE, height: TILE, data: new Uint8Array(t.data) };
    for (let v = 0; v < TILE; v++) for (let u = 0; u < TILE; u++) {
      const i = v * TILE + u, k = cls[i];
      let near = false;
      for (let dy = -band; dy <= band && !near; dy++) for (let dx = -band; dx <= band; dx++) {
        const x = u + dx, y = v + dy;
        if (x >= 0 && y >= 0 && x < TILE && y < TILE && cls[y * TILE + x] !== k) { near = true; break; }
      }
      const side = k ? upper : lower;
      if (!near) res.data.set(side.canonical.data.subarray(i * 4, i * 4 + 4), i * 4);
      else if (snapBand && res.data[i * 4 + 3] === 255) res.data.set(snapToPalette(res.data[i * 4]!, res.data[i * 4 + 1]!, res.data[i * 4 + 2]!, side.palette), i * 4);
      // The wet edge: a water texel touching land (4-neighbour) keeps the family's own
      // shoreline tone as a 1-px rim above the animated surface; everything else keys out.
      const rim = side.kind === 'water' && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const x = u + dx!, y = v + dy!; return x >= 0 && y >= 0 && x < TILE && y < TILE && cls[y * TILE + x] !== k; });
      if (side.kind === 'water' && (water[i] || !near) && !rim) res.data[i * 4] = res.data[i * 4 + 1] = res.data[i * 4 + 2] = res.data[i * 4 + 3] = 0;
    }
    out.push(res); classes?.push(cls);
  }
  return out;
}
/** Tone family: the upper terrain is a tonal twin of the lower one, so the 16 tiles are
 * composed with noise-edged corner masks — the texture stays continuous across the edge. */
export function composeToneFamily(lower: TerrainArt, upper: TerrainArt, familySeed: number, classes?: Uint8Array[]): Raster[] {
  const out: Raster[] = [];
  for (let mask = 0; mask < 16; mask++) {
    const res = raster(TILE, TILE), cls = new Uint8Array(TILE * TILE);
    for (let v = 0; v < TILE; v++) for (let u = 0; u < TILE; u++) {
      const w = cornerWeight(mask, u, v) + (hash01(familySeed, u, v) - 0.5) * 2 * REALM_KIT_BUILD.toneNoise;
      const side = mask === 15 || (mask !== 0 && w > 0.5) ? upper : lower, i = (v * TILE + u) * 4;
      res.data.set(side.canonical.data.subarray(i, i + 4), i);
      cls[v * TILE + u] = side === upper ? 1 : 0;
    }
    out.push(res); classes?.push(cls);
  }
  return out;
}
/** ART-NOTES water loop: the tile's brightest texels (highlights) scroll diagonally over
 * its median dark water; frame 0 is the untouched still. */
export function waterFrames(tile: Raster, w: KitWater): Raster[] {
  const n = TILE * TILE, lum = new Float64Array(n);
  for (let i = 0; i < n; i++) lum[i] = 0.299 * tile.data[i * 4]! + 0.587 * tile.data[i * 4 + 1]! + 0.114 * tile.data[i * 4 + 2]!;
  const sorted = [...lum].sort((a, b) => a - b), percentile = (p: number) => sorted[Math.min(n - 1, Math.max(0, Math.floor(n * p)))]!;
  const hi = percentile(1 - w.highlightFraction), mid = percentile(1 - w.highlightFraction - (w.rippleFraction ?? 0));
  // Band 2 = highlights (drift diagonally), band 1 = ripples (drift horizontally), band 0 = the
  // still water body, which keeps the tile's own depth variation instead of collapsing to a median.
  const band = new Uint8Array(n);
  for (let i = 0; i < n; i++) band[i] = lum[i]! >= hi ? 2 : (w.rippleFraction ?? 0) > 0 && lum[i]! >= mid ? 1 : 0;
  const bodyMedian = [0, 1, 2].map(c => { const v: number[] = []; for (let i = 0; i < n; i++) if (!band[i]) v.push(tile.data[i * 4 + c]!); v.sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)]! : 0; });
  // The moving texels leave holes in the body: fill each from its nearest still texel (wrapping,
  // so the loop stays seamless), falling back to the body median when none is within 4 px.
  const base = { width: TILE, height: TILE, data: new Uint8Array(tile.data) };
  for (let v = 0; v < TILE; v++) for (let u = 0; u < TILE; u++) {
    const i = v * TILE + u;
    if (!band[i]) continue;
    let src = -1;
    for (let r = 1; r <= 4 && src < 0; r++) for (let dv = -r; dv <= r && src < 0; dv++) for (let du = -r; du <= r; du++) {
      if (Math.max(Math.abs(dv), Math.abs(du)) !== r) continue;
      const j = (((v + dv) % TILE + TILE) % TILE) * TILE + ((u + du) % TILE + TILE) % TILE;
      if (!band[j]) { src = j; break; }
    }
    if (src >= 0) base.data.set(tile.data.subarray(src * 4, src * 4 + 4), i * 4);
    else { base.data[i * 4] = bodyMedian[0]!; base.data[i * 4 + 1] = bodyMedian[1]!; base.data[i * 4 + 2] = bodyMedian[2]!; }
  }
  // The provider's still carries a soft tile-wide gradient that repeats every 32 px on
  // open water; flattening the body's low frequencies (wrapping 9×9 box, mean restored)
  // leaves its fine texture and removes the repeat.
  if (w.flattenBody) {
    const flat = new Uint8Array(base.data), r = 4;
    for (let c = 0; c < 3; c++) {
      let mean = 0; for (let i = 0; i < n; i++) mean += base.data[i * 4 + c]!; mean /= n;
      for (let v = 0; v < TILE; v++) for (let u = 0; u < TILE; u++) {
        let sum = 0;
        for (let dv = -r; dv <= r; dv++) for (let du = -r; du <= r; du++) sum += base.data[((((v + dv) % TILE) + TILE) % TILE * TILE + (((u + du) % TILE) + TILE) % TILE) * 4 + c]!;
        flat[(v * TILE + u) * 4 + c] = clamp255(base.data[(v * TILE + u) * 4 + c]! - sum / ((2 * r + 1) ** 2) + mean);
      }
    }
    base.data.set(flat);
  }
  const frames: Raster[] = [];
  for (let k = 0; k < w.frames; k++) {
    const f = { width: TILE, height: TILE, data: new Uint8Array(base.data) }, s = (k * w.shiftPx) % TILE;
    const [dx, dy] = w.drift ?? [w.shiftPx, w.shiftPx], sx = ((k * dx) % TILE + TILE) % TILE, sy = ((k * dy) % TILE + TILE) % TILE;
    for (const which of [1, 2]) for (let v = 0; v < TILE; v++) for (let u = 0; u < TILE; u++) {
      const i = v * TILE + u;
      if (band[i] !== which) continue;
      const j = which === 2 ? ((v + sy) % TILE) * TILE + (u + sx) % TILE : v * TILE + (u + TILE - s) % TILE;
      f.data.set(tile.data.subarray(i * 4, i * 4 + 4), j * 4);
    }
    frames.push(f);
  }
  return frames;
}
const maskBits = (t: Raster) => { const m = new Uint8Array(TILE * TILE); for (let i = 0; i < TILE * TILE; i++) m[i] = t.data[i * 4 + 3] === 0 ? 1 : 0; return m; };
function maskedFrames(frames: Raster[], hole: Uint8Array): Raster[] {
  return frames.map(f => { const o = { width: TILE, height: TILE, data: new Uint8Array(f.data) }; for (let i = 0; i < TILE * TILE; i++) if (!hole[i]) o.data[i * 4] = o.data[i * 4 + 1] = o.data[i * 4 + 2] = o.data[i * 4 + 3] = 0; return o; });
}

/** Vertex terrain grid (99×99, index = terrain order in kit.terrains) after the layout ops. */
/** Paints ops onto a vertex grid keyed by `index`; `seed` salts the blob lobes and path wobble. */
export function paintOps(index: Map<string, number>, ops: LayoutOp[], seed: number, grid = new Uint8Array(VERTICES * VERTICES)): Uint8Array {
  const at = (vx: number, vy: number) => (vy - FIELD_ORIGIN) * VERTICES + (vx - FIELD_ORIGIN);
  const layout = { seed };
  for (const [n, op] of ops.entries()) {
    const value = index.get(op.terrain)!, random = rng((layout.seed ^ Math.imul(n + 1, 0x9e3779b1)) >>> 0);
    const allowed = 'over' in op && op.over ? new Set(op.over.map(t => index.get(t)!)) : undefined;
    const set = (vx: number, vy: number) => { const i = at(vx, vy); if (!allowed || allowed.has(grid[i]!)) grid[i] = value; };
    if (op.op === 'fill') { grid.fill(value); continue; }
    if (op.op === 'rect') { for (let vy = op.y0; vy <= op.y1; vy++) for (let vx = op.x0; vx <= op.x1; vx++) set(vx, vy); continue; }
    if (op.op === 'ring') {
      for (let vy = op.y0; vy <= op.y1; vy++) for (let vx = op.x0; vx <= op.x1; vx++) {
        if (Math.min(vx - op.x0, op.x1 - vx, vy - op.y0, op.y1 - vy) < op.thickness) set(vx, vy);
      }
      continue;
    }
    if (op.op === 'blob') {
      const lobes = 24, noise = Array.from({ length: lobes }, () => random() * 2 - 1);
      for (let vy = FIELD_ORIGIN; vy <= FIELD_END; vy++) for (let vx = FIELD_ORIGIN; vx <= FIELD_END; vx++) {
        const dx = (vx - op.cx) / op.rx, dy = (vy - op.cy) / op.ry, a = Math.atan2(dy, dx), f = ((a + Math.PI) / (2 * Math.PI)) * lobes;
        const i0 = Math.floor(f) % lobes, i1 = (i0 + 1) % lobes, t = f - Math.floor(f), n = noise[i0]! * (1 - t) + noise[i1]! * t;
        // A superellipse (|x|^p + |y|^p ≤ r^p): p = 2 is the ellipse, higher p squares the
        // shape off — straight axis-aligned runs with quick 45° corners, which the corner
        // Wang tiles draw cleanly where a shallow diagonal would staircase.
        const pw = op.power ?? 2;
        if (Math.abs(dx) ** pw + Math.abs(dy) ** pw <= (1 + op.jitter * n) ** pw) set(vx, vy);
      }
      continue;
    }
    // path: vertices within width/2 of the polyline; the half width wobbles by `jitter`,
    // hashed once every `wobbleTiles` of arc length and cosine-interpolated between
    // samples, so the banks meander gently instead of stepping tile by tile.
    const half = op.width / 2, period = op.wobbleTiles ?? 4;
    const cumulative = [0]; for (let s = 0; s + 1 < op.points.length; s++) { const [ax, ay] = op.points[s]!, [bx, by] = op.points[s + 1]!; cumulative.push(cumulative[s]! + Math.hypot(bx - ax, by - ay)); }
    for (let vy = FIELD_ORIGIN; vy <= FIELD_END; vy++) for (let vx = FIELD_ORIGIN; vx <= FIELD_END; vx++) {
      let best = Infinity, arc = 0;
      for (let s = 0; s + 1 < op.points.length; s++) {
        const [ax, ay] = op.points[s]!, [bx, by] = op.points[s + 1]!, ex = bx - ax, ey = by - ay, len = ex * ex + ey * ey;
        const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((vx - ax) * ex + (vy - ay) * ey) / len));
        const d = Math.hypot(vx - ax - t * ex, vy - ay - t * ey);
        if (d < best) { best = d; arc = cumulative[s]! + t * Math.sqrt(len); }
      }
      const k = Math.floor(arc / period), u = (1 - Math.cos(Math.PI * (arc / period - k))) / 2;
      const n0 = hash01(layout.seed, n, k) * 2 - 1, n1 = hash01(layout.seed, n, k + 1) * 2 - 1;
      const wobble = 1 + op.jitter * (n0 * (1 - u) + n1 * u);
      if (best <= half * wobble) set(vx, vy);
    }
  }
  return grid;
}
export function applyOps(kit: Kit, layout: Layout): Uint8Array {
  const ids = Object.keys(kit.terrains), index = new Map(ids.map((id, i) => [id, i]));
  const grid = paintOps(index, layout.ops, layout.seed);
  const at = (vx: number, vy: number) => (vy - FIELD_ORIGIN) * VERTICES + (vx - FIELD_ORIGIN);
  // Speck removal: a water vertex with no 4-neighbour water draws a lone diamond of
  // water (a jittered path's stray), so it takes the terrain most of its neighbours
  // hold; a non-water vertex boxed in by water on all four sides becomes water.
  const water = new Set(ids.filter(id => kit.terrains[id]!.kind === 'water').map(id => index.get(id)!));
  if (water.size) {
    const before = new Uint8Array(grid);
    for (let vy = FIELD_ORIGIN; vy <= FIELD_END; vy++) for (let vx = FIELD_ORIGIN; vx <= FIELD_END; vx++) {
      const i = at(vx, vy), here = before[i]!;
      const around = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).map(([dx, dy]) => [vx + dx, vy + dy] as const)
        .filter(([x, y]) => x >= FIELD_ORIGIN && x <= FIELD_END && y >= FIELD_ORIGIN && y <= FIELD_END).map(([x, y]) => before[at(x, y)]!);
      if (!around.length) continue;
      if (water.has(here) && !around.some(t => water.has(t))) {
        const counts = new Map<number, number>(); for (const t of around) counts.set(t, (counts.get(t) ?? 0) + 1);
        grid[i] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
      } else if (!water.has(here) && around.length === 4 && around.every(t => water.has(t))) grid[i] = around[0]!;
    }
  }
  // Edge plainness: the outermost vertex ring copies the ring inside it, so every tile on
  // the field's edge has equal vertex pairs across the edge normal — interior or a straight
  // band, never a corner. The runtime clamp (REALM_KIT.edgeExtendTiles) repeats the edge
  // tiles to the world's end, and a corner tile repeated 64 times is a saw blade (owner
  // 2026-09-21: "left ending upper branch has problem continuing consistently water").
  for (let v = FIELD_ORIGIN; v <= FIELD_END; v++) { grid[at(FIELD_ORIGIN, v)] = grid[at(FIELD_ORIGIN + 1, v)]!; grid[at(FIELD_END, v)] = grid[at(FIELD_END - 1, v)]!; }
  for (let v = FIELD_ORIGIN; v <= FIELD_END; v++) { grid[at(v, FIELD_ORIGIN)] = grid[at(v, FIELD_ORIGIN + 1)]!; grid[at(v, FIELD_END)] = grid[at(v, FIELD_END - 1)]!; }
  return grid;
}
const inFrame = (tx: number, ty: number) => tx >= FRAME_MIN && tx < FRAME_MAX && ty >= FRAME_MIN && ty < FRAME_MAX;
const inRings = (tx: number, ty: number) => tx >= RING_MIN && tx < RING_MAX && ty >= RING_MIN && ty < RING_MAX;
const inField = (tx: number, ty: number) => tx >= FIELD_ORIGIN && tx < FIELD_END && ty >= FIELD_ORIGIN && ty < FIELD_END;
const tileIndex = (tx: number, ty: number) => (ty - FIELD_ORIGIN) * FIELD_TILES + (tx - FIELD_ORIGIN);
function tileCorners(grid: Uint8Array, tx: number, ty: number): [number, number, number, number] {
  const at = (vx: number, vy: number) => grid[(vy - FIELD_ORIGIN) * VERTICES + (vx - FIELD_ORIGIN)]!;
  return [at(tx, ty), at(tx + 1, ty), at(tx, ty + 1), at(tx + 1, ty + 1)];
}
const inPlot = (tx: number, ty: number) => tx >= PLOT.min && tx < PLOT.max && ty >= PLOT.min && ty < PLOT.max;
const inRegion = (r: LayoutRegion, tx: number, ty: number) => r === 'field' ? inField(tx, ty) : r === 'frame' ? inFrame(tx, ty)
  : r === 'exterior' ? inField(tx, ty) && !inRings(tx, ty) : tx >= r.x0 && tx < r.x1 && ty >= r.y0 && ty < r.y1;
/** A prop's seat tile before any `place` nudge, the way the shared contract reads it back
 * (realmKitPlacementSeat of an un-nudged anchor). Only the scatter pre-check uses it — scatter
 * never nudges; `place` asks the contract about the anchor it actually emits, dx/dy included. */
const seatTile = (p: KitProp, tx: number, ty: number) => ({ tx: tx + Math.floor(p.footprint[0] / 2), ty: ty + p.footprint[1] - 1 });

/** Uniform-cell sheet packer (props by canvas size; the tileset). Returns cell origins. */
function packSheet(cellW: number, cellH: number, count: number, potWidth: boolean): { width: number; height: number; columns: number } {
  let best: { width: number; height: number; columns: number } | undefined;
  const widths = potWidth ? REALM_KIT_BUILD.sheetWidths.filter(w => w >= cellW) : [Math.min(count, Math.floor(L.dimension / cellW)) * cellW];
  for (const width of widths) {
    const columns = Math.floor(width / cellW), rows = Math.ceil(count / columns);
    let height = rows * cellH;
    if (potWidth) height = 1 << Math.ceil(Math.log2(Math.max(1, height)));
    if (height > L.dimension) continue;
    if (!best || width * height < best.width * best.height) best = { width, height, columns };
  }
  if (!best) fail(`sheet of ${count} ${cellW}×${cellH} cells exceeds ${L.dimension}²`);
  return best;
}

export async function buildRealmKit(realmDir: string): Promise<BuildResult> {
  const kitValue: unknown = JSON.parse(await fs.readFile(path.join(realmDir, 'kit.json'), 'utf8'));
  assertKit(kitValue);
  const kit = kitValue;
  const layoutValue: unknown = JSON.parse(await fs.readFile(path.join(realmDir, 'layout.json'), 'utf8'));
  assertLayout(layoutValue, kit);
  const layout = layoutValue;
  const terrainIds = Object.keys(kit.terrains), tIndex = new Map(terrainIds.map((id, i) => [id, i]));
  const stats: Record<string, number> = {};

  // 1. Provider families + canonical terrain textures.
  const rawFamilies = new Map<string, Raster[]>();
  for (const f of kit.families) {
    if (f.kind === 'cliff25') fail(`family ${f.id}: cliff25 (64-px plateau) is not supported by this builder yet — remove it from kit.json`);
    if (f.kind === 'wang16') rawFamilies.set(f.id, await loadWang16(realmDir, f));
  }
  // `art` is what renders: a toned terrain's (KitTerrain.tone) canonical is toned first, then its variants
  // are transformed and jittered from it. `plain` is the same terrain untoned — the view every class
  // decision reads (palettes, family pipelines, mask transfer, verges, the drift guard), so a tone never
  // moves a class; for an untoned terrain the two are one object.
  const art = new Map<string, TerrainArt>(), plain = new Map<string, TerrainArt>();
  const terrainArt = (id: string): TerrainArt => {
    const hit = art.get(id);
    if (hit) return hit;
    const t = kit.terrains[id]!;
    let canonical: Raster;
    if (t.canonical) canonical = rawFamilies.get(t.canonical.family)![t.canonical.side === 'upper' ? 15 : 0]!;
    else canonical = toneTile(terrainArt(t.derived!.from).canonical, t.derived!);
    const untoned = canonical;
    if (t.tone) canonical = toneTile(untoned, t.tone);
    const v = kit.variants[id] ?? { transforms: ['identity'], jitter: 0 };
    const variants = v.transforms.map((how, i) => jitterValue(transformTile(canonical, how), 1 + v.jitter * [0, 1, -1, 0.5, -0.5, 0.75, -0.75, 0.25][i % 8]!));
    const a = { id, kind: t.kind, canonical, palette: palette(untoned), variants };
    art.set(id, a); plain.set(id, canonical === untoned ? a : { ...a, canonical: untoned });
    return a;
  };
  for (const id of terrainIds) terrainArt(id);
  const toneOf = (id: string | undefined) => id === undefined ? undefined : kit.terrains[id]!.tone;
  // What a family's texels are told apart by (KitFamily.classify): the two terrains' canonical art, or
  // with `classify: 'own'` the same art carrying the family's OWN pure tiles' palettes plus the joint
  // closing — one answer per family, shared by its corners, canonicalisation, verge, every family
  // derived from it and the three-way composite, so a joint is the road at every one of those steps.
  const classes = new Map<string, { lower: TerrainArt; upper: TerrainArt; jointPx: number }>();
  const classesOf = (id: string) => {
    let c = classes.get(id);
    if (!c) {
      const f = kit.families.find(x => x.id === id)!, lower = plain.get(f.lower)!, upper = plain.get(f.upper)!, raw = rawFamilies.get(id);
      c = f.classify === 'own' && raw ? { lower: { ...lower, palette: palette(raw[0]!) }, upper: { ...upper, palette: palette(raw[15]!) }, jointPx: REALM_KIT_BUILD.jointPx }
        : { lower, upper, jointPx: 0 };
      classes.set(id, c);
    }
    return c;
  };
  // Derived families: the source family's raw tiles with the replaced terrain's texels
  // (nearest-palette class) swapped for the new terrain's canonical texel at the same position.
  for (const f of kit.families) {
    if (f.kind !== 'derived') continue;
    const src = kit.families.find(x => x.id === f.from)!, srcTiles = rawFamilies.get(src.id);
    if (!srcTiles) fail(`family ${f.id}: derives from ${src.id}, which has no raw tiles`);
    const { lower: srcLower, upper: srcUpper, jointPx } = classesOf(src.id);
    rawFamilies.set(f.id, srcTiles.map(t => {
      const cls = classifyTile(t, srcLower, srcUpper, jointPx), out = { width: TILE, height: TILE, data: new Uint8Array(t.data) };
      for (let i = 0; i < TILE * TILE; i++) {
        const from = cls[i] ? src.upper : src.lower, to = f.replace![from];
        if (to !== undefined) out.data.set(plain.get(to)!.canonical.data.subarray(i * 4, i * 4 + 4), i * 4);
      }
      return out;
    }));
  }
  // Palette check per terrain family: canonical mean vs declared tone (the TONED canonical: what renders);
  // family pure tiles vs the UNTONED canonical (the guard catches provider drift, not an authored tone).
  for (const [id, hex] of Object.entries(kit.palette.ground)) {
    const [r, g, b] = meanRgb(art.get(id)!.canonical), want = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    const d = Math.hypot(r - want[0]!, g - want[1]!, b - want[2]!);
    if (d > REALM_KIT_BUILD.paletteToleranceRgb) fail(`palette: canonical ${id} mean rgb(${[r, g, b].map(Math.round).join(',')}) is ${d.toFixed(1)} from declared ${hex} (> ${REALM_KIT_BUILD.paletteToleranceRgb})`);
  }
  for (const f of kit.families) {
    if (f.kind !== 'wang16') continue;
    const tiles = rawFamilies.get(f.id)!;
    for (const [side, mask] of [['lower', 0], ['upper', 15]] as const) {
      const drift = meanAbsDiff(tiles[mask]!, plain.get(f[side])!.canonical);
      if (drift > REALM_KIT_BUILD.familyDriftMax) fail(`palette: family ${f.id} ${side} tile drifts ${drift.toFixed(1)}/255 from canonical ${f[side]} (> ${REALM_KIT_BUILD.familyDriftMax})`);
    }
  }
  const families = new Map<string, FamilyTiles>();
  for (const [n, f] of kit.families.entries()) {
    // The whole pipeline runs on the untoned art (classesOf hands out `plain` views) and records each
    // texel's class; gradeTiles then tones exactly the texels of a toned class — the lip, the shore band and
    // the verge lift with their terrain, and no class mask differs from the untoned build's.
    const { lower, upper, jointPx } = classesOf(f.id), classes: Uint8Array[] = [];
    let tiles = f.kind === 'tone' ? composeToneFamily(lower, upper, (layout.seed ^ Math.imul(n + 101, 0x7f4a7c15)) >>> 0, classes)
      : canonicaliseFamily(f.corners === 'provider' ? rawFamilies.get(f.id)! : synthesizeCorners(rawFamilies.get(f.id)!, lower, upper, jointPx), lower, upper, f.snapBand === true, jointPx, classes);
    if (f.verge) tiles = vergeFamily(tiles, lower, upper, plain.get(f.verge.terrain)!, f.verge.px, (layout.seed ^ fnv1a(`verge:${f.id}`)) >>> 0, jointPx, classes);
    families.set(f.id, { id: f.id, lower: f.lower, upper: f.upper, kind: f.kind, tiles: gradeTiles(tiles, classes, [toneOf(f.lower), toneOf(f.upper), toneOf(f.verge?.terrain)]), untoned: tiles });
  }
  const pairFamily = new Map<string, FamilyTiles>();
  for (const f of families.values()) {
    const key = [tIndex.get(f.lower), tIndex.get(f.upper)].sort((a, b) => a! - b!).join(':');
    if (pairFamily.has(key)) fail(`families ${pairFamily.get(key)!.id} and ${f.id} both join ${f.lower}/${f.upper}`);
    pairFamily.set(key, f);
  }
  const water = waterFrames(art.get(kit.water.canonical)!.canonical, kit.water);

  // 2. Vertex grid → per-tile corner sets; builder rules (§8), each failure names the tile.
  const grid = applyOps(kit, layout);
  // Zones: painted like ops on a blank field ('in' = 1); a tile belongs when ≥ 2 of its vertices are in.
  const zoneTiles = new Map<string, Uint8Array>();
  for (const [name, ops] of Object.entries(layout.zones ?? {})) {
    const z = paintOps(new Map([['out', 0], ['in', 1]]), ops, (layout.seed ^ fnv1a(`zone:${name}`)) >>> 0), tiles = new Uint8Array(FIELD_TILES * FIELD_TILES);
    for (let ty = FIELD_ORIGIN; ty < FIELD_END; ty++) for (let tx = FIELD_ORIGIN; tx < FIELD_END; tx++) {
      const c = tileCorners(z, tx, ty); if (c[0] + c[1] + c[2] + c[3] >= 2) tiles[tileIndex(tx, ty)] = 1;
    }
    zoneTiles.set(name, tiles);
  }
  const inZone = (zone: string | undefined, tx: number, ty: number) => zone === undefined || zoneTiles.get(zone)![tileIndex(tx, ty)] === 1;
  const wildIndex = tIndex.get(kit.boundary.wild)!;
  const cells: CellKeyed[] = [], cellId = new Map<string, number>();
  const cell = (key: string, frames: () => Raster[], frameDurationMs?: number): number => {
    let id = cellId.get(key);
    if (id === undefined) { id = cells.length + 1; cells.push({ key, frames: frames(), ...(frameDurationMs !== undefined ? { frameDurationMs } : {}) }); cellId.set(key, id); }
    return id;
  };
  const pureVariant = (terrain: number, v: number): number => {
    const a = art.get(terrainIds[terrain]!)!;
    if (a.kind === 'water') return cell('bed', () => [raster(TILE, TILE)]);
    return cell(`pure:${a.id}:${v}`, () => [a.variants[v]!]);
  };
  const pureCell = (terrain: number, tx: number, ty: number): number => pureVariant(terrain, realmKitTileHash(tx, ty) % art.get(terrainIds[terrain]!)!.variants.length);
  const waterCell = (baseKey: string, base: Raster) => cell(`water:${baseKey}`, () => maskedFrames(water, maskBits(base)), kit.water.frameDurationMs);
  // Open water runs the one loop at four phases picked per tile by hash: the body
  // texture stays continuous across tiles (a mirrored body reads as a mosaic) while
  // no two neighbours carry the same highlight positions on the same frame.
  const openWater = (tx: number, ty: number) => {
    const n = realmKitTileHash(tx ^ 0x77, ty ^ 0x99) % 4, phase = n * Math.floor(water.length / 4);
    return cell(`water:open:${n}`, () => water.map((_, k) => water[(k + phase) % water.length]!), kit.water.frameDurationMs);
  };
  /** Family joining two terrain indices, whichever way round, or undefined. */
  const familyOf = (a: number, b: number) => pairFamily.get([a, b].sort((x, y) => x - y).join(':'));
  const maskOf = (corners: readonly number[], isUpper: (c: number) => boolean) => corners.reduce((m, c, n) => m | (isUpper(c) ? 8 >> n : 0), 0);
  const familyTile = (f: FamilyTiles, corners: readonly number[], isUpper: (c: number) => boolean) => f.tiles[maskOf(corners, isUpper)]!;
  const compositeTile = (distinct: number[], corners: readonly number[]): { key: string; tile: Raster } | undefined => {
    const layerOf = (d: number) => kit.terrains[terrainIds[d]!]!.layer ?? 0;
    const order = [...distinct].sort((a, b) => layerOf(a) - layerOf(b) || a - b);
    const [t0, t1, ...rest] = order;
    const first = familyOf(t0!, t1!);
    if (!first) return undefined;
    const upper1 = tIndex.get(first.upper)!;
    const out = { width: TILE, height: TILE, data: new Uint8Array(familyTile(first, corners, c => c === upper1).data) };
    let key = `fam:${first.id}:${maskOf(corners, c => c === upper1)}`;
    // Each higher terrain is cut from its family with the LOWEST terrain it shares a family with
    // (water first: a dirt corner on a shore keeps the wet edge), else the lowest ground terrain.
    for (const t of rest) {
      const f = order.filter(d => d !== t && layerOf(d) < layerOf(t)).map(d => familyOf(d, t)).find(Boolean);
      if (!f) return undefined;
      // A Wang bit means "f.upper at this vertex": when t is the family's lower, t's corners are the CLEAR bits.
      // The paste mask classifies the UNTONED tile (a graded texel would be judged against untoned palettes).
      const wantUpper = tIndex.get(f.upper)! === t, fm = maskOf(corners, c => (c === t) === wantUpper), tile = f.tiles[fm]!;
      const { lower, upper: upperArt, jointPx } = classesOf(f.id), cls = classifyTile(f.untoned[fm]!, lower, upperArt, jointPx);
      const paste = new Uint8Array(TILE * TILE);
      for (let i = 0; i < TILE * TILE; i++) if ((cls[i] === 1) === wantUpper) paste[i] = 1;
      // 1-px rim of the family's band so the outline comes along.
      const rim = new Uint8Array(paste);
      for (let v = 0; v < TILE; v++) for (let u = 0; u < TILE; u++) {
        if (paste[v * TILE + u]) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const x = u + dx, y = v + dy;
          if (x >= 0 && y >= 0 && x < TILE && y < TILE && paste[y * TILE + x]) { rim[v * TILE + u] = 1; break; }
        }
      }
      for (let i = 0; i < TILE * TILE; i++) if (rim[i] && tile.data[i * 4 + 3] === 255) out.data.set(tile.data.subarray(i * 4, i * 4 + 4), i * 4);
      key += `+${f.id}:${maskOf(corners, c => c === t)}`;
    }
    return { key: `mix:${key}`, tile: out };
  };
  const baseGrid = new Uint16Array(FIELD_TILES * FIELD_TILES), waterGrid = new Uint16Array(FIELD_TILES * FIELD_TILES), overlayGrid = new Uint16Array(FIELD_TILES * FIELD_TILES);
  const tileTerrains: number[][] = [], bakedCorners: number[][] = [];
  let collapsed = 0;
  /** Resolves four corner terrains to the one base tile that draws them — a pure cell, one family's
   * Wang tile, the layer-order composite where three or more meet, else (field tiles only) the
   * `fallback` collapse until a family can draw it (mutating `corners`; `where` names the tile in the
   * failure). Shared by the field bake and the ring variants so a ring tile over a yard is drawn by
   * exactly the rule that drew the yard — except the collapse: the ring passes `fallbacks: false`,
   * because a ring tile that collapsed would be the default turf↔wild cell painted over ground the
   * cell has none of (the K-177 cut-off the variants exist to remove), so it fails naming the tile
   * instead. `pure` draws a one-terrain tile (the field hashes a variant; a ring cell has none). */
  const resolveTile = (corners: number[], pure: (terrain: number) => number, where: () => string, fallbacks = true): { id: number; distinct: number[]; tile?: Raster; key?: string; collapsed: number } => {
    const distinctOf = () => [...new Set(corners)].sort((a, b) => a - b);
    let distinct = distinctOf(), count = 0;
    const names = () => distinct.map(d => terrainIds[d]!);
    // Three or four terrains on one tile: composite it in `layer` order (kit.json terrains[].layer,
    // lowest first) instead of collapsing a corner to its fallback — the collapse painted a whole
    // tile's corner as another terrain and left a square notch wherever a yard met a river or a
    // track met the road. The lowest two terrains draw through their own family; each higher
    // terrain is pasted from its family with the lowest ground terrain (its own class texels plus
    // a 1-px rim of that family's band), so dirt lies over grass and cobbles lie over dirt.
    const layered = distinct.length > 2 ? compositeTile(distinct, corners) : undefined;
    if (layered) return { id: cell(layered.key, () => [layered.tile]), distinct, tile: layered.tile, key: layered.key, collapsed: 0 };
    // Collapse (data-driven `fallback`) until one family can draw the tile.
    while (distinct.length > 2 || (distinct.length === 2 && !pairFamily.has(distinct.join(':')))) {
      const victim = fallbacks ? distinct.find(d => kit.terrains[terrainIds[d]!]!.fallback !== undefined) : undefined;
      if (victim === undefined) fail((distinct.length > 2 ? `${where()}: terrains ${names().join(', ')} meet — no family can draw it`
        : `${where()}: terrains ${names().join(' / ')} touch but no family joins them`)
        + (fallbacks ? '' : ' (a declared fallback never draws a ring tile: it would paint the fallback terrain over ground the cell has none of, the K-177 cut-off — add the family)'));
      const to = tIndex.get(kit.terrains[terrainIds[victim]!]!.fallback!)!;
      for (let c = 0; c < 4; c++) if (corners[c] === victim) corners[c] = to;
      distinct = distinctOf(); count++;
    }
    if (distinct.length === 1) return { id: pure(distinct[0]!), distinct, collapsed: count };
    const f = pairFamily.get(distinct.join(':'))!;
    const upper = tIndex.get(f.upper)!, mask = corners.reduce((m, c, n) => m | (c === upper ? 8 >> n : 0), 0);
    const base = f.tiles[mask]!, key = `fam:${f.id}:${mask}`;
    return { id: cell(key, () => [base]), distinct, tile: base, key, collapsed: count };
  };
  for (let ty = FIELD_ORIGIN; ty < FIELD_END; ty++) for (let tx = FIELD_ORIGIN; tx < FIELD_END; tx++) {
    const corners = tileCorners(grid, tx, ty), i = tileIndex(tx, ty);
    for (const d of new Set(corners)) {
      const t = kit.terrains[terrainIds[d]!]!;
      if (inFrame(tx, ty) && !t.inFrame) fail(`tile ${tx},${ty}: ${t.label} inside the protected frame (E-6 ground-level only)`);
      // The two wild rings outside the frame hold ground-level terrain only: the widest claim's
      // boundary ring runs through them (a 50×50 claim's ring is the frame's first outer tile), and
      // the ring is drawn from ground families — a shore or a cliff there would put water under
      // turf. Any GROUND terrain may cross them since the §2 ring variants (D-173, K-177 "road end"):
      // the kingdom road runs through the rings into the smallest kingdom and every ring tile over
      // it is baked below from the road's own corners, so the rings no longer need to be pure meadow.
      if (inRings(tx, ty) && t.kind !== 'ground') fail(`tile ${tx},${ty}: ${t.label} inside the two wild rings around the frame (§8: ground-level only — the widest claim's ring crosses them)`);
    }
    const r = resolveTile(corners, d => pureCell(d, tx, ty), () => `tile ${tx},${ty}`);
    collapsed += r.collapsed; tileTerrains[i] = r.distinct; bakedCorners[i] = corners; baseGrid[i] = r.id;
    if (!r.distinct.some(d => art.get(terrainIds[d]!)!.kind === 'water')) continue;
    // A tile touching water carries the surface loop beneath it: the open loop under a pure water
    // cell (its bed is transparent), the keyed loop under a shore or a composite with a wet corner.
    waterGrid[i] = r.tile ? waterCell(r.key!, r.tile) : openWater(tx, ty);
  }
  stats.collapsedTiles = collapsed;
  // Overlay decals by hash on the named terrains (ground-level tiles, E-6). With any terrain toned, a decal
  // texel whose nearest UNTONED canonical colour (every terrain's, kit order, first wins a tie) belongs to a
  // toned terrain takes that terrain's tone — a grass tuft lifts with the meadow it lies on, where untoned it
  // would read as a dark speck; petals, pebbles and litter nearer another terrain keep their colours.
  const decalColours = terrainIds.some(id => toneOf(id)) ? terrainIds.map(id => {
    const c = plain.get(id)!.canonical, set = new Set<number>();
    for (let i = 0; i < c.data.length; i += 4) if (c.data[i + 3] === 255) set.add((c.data[i]! << 16) | (c.data[i + 1]! << 8) | c.data[i + 2]!);
    return { tone: toneOf(id), colours: [...set] };
  }) : undefined;
  const gradeDecal = (r: Raster): Raster => {
    if (!decalColours) return r;
    const out = { width: r.width, height: r.height, data: new Uint8Array(r.data) };
    for (let i = 0; i < out.data.length; i += 4) {
      if (out.data[i + 3] !== 255) continue;
      let best = Infinity, tone: KitTone | undefined;
      for (const t of decalColours) { const d = paletteDistanceSq(out.data[i]!, out.data[i + 1]!, out.data[i + 2]!, t.colours); if (d < best) { best = d; tone = t.tone; } }
      if (tone) out.data.set(toneTexel(out.data[i]!, out.data[i + 1]!, out.data[i + 2]!, tone), i);
    }
    return out;
  };
  const decalArt = new Map<string, Raster>(), landedGroups = new Set<string>(), decalAt = new Map<number, string>();
  for (const d of layout.decals) {
    const allowed = new Set(d.terrains.map(t => tIndex.get(t)!)), total = d.decals.reduce((s, w) => s + w.weight, 0), salt = fnv1a(d.id) | 0;
    const nearSet = d.near ? new Set(d.near.terrains.map(t => tIndex.get(t)!)) : undefined, reach = d.near?.tiles ?? 0;
    const nearby = (tx: number, ty: number) => {
      if (!nearSet) return true;
      for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
        if (inField(tx + dx, ty + dy) && tileTerrains[tileIndex(tx + dx, ty + dy)]!.some(t => nearSet.has(t))) return true;
      }
      return false;
    };
    for (let ty = FIELD_ORIGIN; ty < FIELD_END; ty++) for (let tx = FIELD_ORIGIN; tx < FIELD_END; tx++) {
      const i = tileIndex(tx, ty);
      if (overlayGrid[i] || !inRegion(d.region, tx, ty) || !inZone(d.zone, tx, ty) || !tileTerrains[i]!.every(t => allowed.has(t)) || tileTerrains[i]!.length !== 1 || !nearby(tx, ty)) continue;
      // Salt the gate per group: with one hash per tile, every tile a low-density
      // later group would take was already claimed by an earlier, denser group.
      // The salt is the group id, so inserting or removing a group leaves the
      // others' landings alone.
      const h = realmKitTileHash(tx ^ 0x5a5a ^ Math.imul(salt + 1, 0x9e37), ty ^ 0x3c3c ^ Math.imul(salt + 1, 0x7f4a));
      if ((h % 10000) / 10000 >= d.density) continue;
      let pick = ((h >>> 16) % 10000) / 10000 * total, chosen = d.decals[d.decals.length - 1]!;
      for (const w of d.decals) { if (pick < w.weight) { chosen = w; break; } pick -= w.weight; }
      // Opt-in neighbour rule (KitDecal.noRepeatNeighbours): a flagged pick that equals an already-chosen neighbour
      // of the eight (W, NW, N, NE in scan order; the rest when an earlier group landed there) re-draws once, by a
      // salted hash of the same tile, from the group's decals no such neighbour holds. Diagonals count: an edge-only
      // rule re-drew one lagoon tile into a three-tile diagonal run of one shape. The gate above is untouched, so
      // the same tiles land; only the shape changes, and a kit that flags nothing builds exactly as before.
      if (kit.decals.find(k => k.id === chosen.id)!.noRepeatNeighbours) {
        const taken = new Set<string>();
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const n = (dx || dy) && inField(tx + dx, ty + dy) ? decalAt.get(tileIndex(tx + dx, ty + dy)) : undefined; if (n) taken.add(n); }
        const rest = d.decals.filter(w => !taken.has(w.id));
        if (taken.has(chosen.id) && rest.length) {
          let again = ((realmKitTileHash(h ^ 0x6e72, salt ^ 0x6e62) >>> 16) % 10000) / 10000 * rest.reduce((s, w) => s + w.weight, 0);
          chosen = rest[rest.length - 1]!;
          for (const w of rest) { if (again < w.weight) { chosen = w; break; } again -= w.weight; }
        }
      }
      const src = kit.decals.find(k => k.id === chosen.id)!;
      if (!decalArt.has(src.id)) {
        const r = await readPng(path.join(realmDir, src.source));
        if (r.width !== TILE || r.height !== TILE) fail(`decal ${src.id}: ${r.width}×${r.height}, expected ${TILE}²`);
        const graded = gradeDecal(r);
        decalArt.set(src.id, src.mask === 'organic' ? organicMask(graded, (layout.seed ^ fnv1a(src.id)) >>> 0) : graded);
      }
      overlayGrid[i] = cell(`decal:${src.id}`, () => [decalArt.get(src.id)!]);
      decalAt.set(i, src.id);
      landedGroups.add(d.id);
    }
  }
  // Runtime state cells: kingdom turf variants and the boundary Wang family (all 16, kingdom = upper bit).
  const kingdom = art.get(kit.boundary.kingdom)!, boundary = families.get(kit.boundary.family)!;
  const turf = kingdom.variants.map((v, n) => cell(`pure:${kingdom.id}:${n}`, () => [v]));
  const edge: number[] = [];
  for (let m = 0; m < 16; m++) {
    const flipped = boundary.upper === kit.boundary.kingdom ? m : 15 - m; // family bit = its own upper terrain
    edge.push(m === 15 ? turf[0]! : m === 0 ? cell(`pure:${art.get(kit.boundary.wild)!.id}:0`, () => [art.get(kit.boundary.wild)!.variants[0]!]) : cell(`fam:${boundary.id}:${flipped}`, () => [boundary.tiles[flipped]!]));
  }
  // §2 ring variants (D-173; K-177 "road end"). The default ring above is the one turf↔wild
  // family whatever lies under it, so over any other baked ground — the kingdom road's cobbles, a
  // dirt yard — it painted meadow where the cell has none and the road stopped dead on a straight
  // tile edge against the land. For every base cell a REACHABLE ring can cross — the one-tile
  // rings of the 13 CAPS.claimTilesByExpansion rects, centred in the legacy plot exactly as the
  // API's footprints.claimRect centres them — whose corners are not all the wild ground (or its
  // tonal twins: still the wild texture, the boundary family draws them), bake one ring cell per
  // corner-Wang mask that ring puts on it: the kingdom corners take the kingdom terrain, the other
  // corners keep the cell's own terrains (a twin as the wild terrain, the only one turf has a
  // family with), resolved by the very rule that drew the cell — one family, else the layer-order
  // composite — but NEVER the fallback collapse: a collapsed ring tile IS the default turf↔wild
  // cell (`fallback` names the wild ground) painted over a yard or road that has none, the very
  // cut-off this table removes, so the ring fails on it instead of counting it (there is no
  // "collapsed" stat for the ring: a build that succeeds has zero). Rows are keyed by the baked
  // cell (a pure terrain's hashed variants are separate cells, so separate rows) and deduped per (cell, mask) in
  // first-seen order — claims in CAPS order, ring tiles row-major, the order the shared fixture
  // derives them in — so the table is deterministic. The shared cell rule (realmKitCell) prefers a
  // row's cell over edge.cells[mask]; 0 means the default, which this bake never leaves behind: a
  // ring tile that cannot be drawn fails naming the tile, the claim and the terrains.
  const reachableClaims: RealmKitClaim[] = CAPS.claimTilesByExpansion.map(tiles => { const min = (GRID.plotTiles - tiles) / 2; return { min, max: min + tiles }; });
  const kingdomIndex = tIndex.get(kit.boundary.kingdom)!;
  const wildLike = (d: number) => d === wildIndex || kit.terrains[terrainIds[d]!]!.derived?.from === kit.boundary.wild;
  // The road reaches the land only if it reaches the SMALLEST kingdom: a road `path` that stops in the
  // wild ground (Crownlands once ended at row 44, four tiles short of the frame) leaves every claim it
  // misses on the default turf↔wild ring — no variant row, nothing else fails, the K-177 cut-off back
  // unnoticed. With `boundary.road` declared, every reachable claim's ring must cross a road corner.
  const roadIndex = kit.boundary.road === undefined ? undefined : tIndex.get(kit.boundary.road)!;
  const variantRows = new Map<number, number[]>();
  let ringTiles = 0, roadRingTiles = 0;
  for (const claim of reachableClaims) {
    const lo = claim.min - REALM_KIT.edgeRingTiles, hi = claim.max + REALM_KIT.edgeRingTiles;
    let roadCrossings = 0;
    for (let ty = lo; ty < hi; ty++) for (let tx = lo; tx < hi; tx++) {
      if (realmKitTileState(claim, tx, ty) !== 'edge') continue;
      if (!inField(tx, ty)) fail(`claim ${claim.min}..${claim.max}: ring tile ${tx},${ty} lies outside the field`);
      const i = tileIndex(tx, ty), corners = bakedCorners[i]!;
      if (roadIndex !== undefined && corners.includes(roadIndex)) roadCrossings++;
      if (corners.every(wildLike)) continue;
      const baked = baseGrid[i]!, mask = realmKitEdgeMask(claim, tx, ty);
      const row = variantRows.get(baked) ?? new Array<number>(16).fill(0);
      variantRows.set(baked, row);
      if (row[mask]) continue;
      const ring = corners.map((c, n) => mask & (8 >> n) ? kingdomIndex : wildLike(c) ? wildIndex : c);
      const where = () => `ring tile ${tx},${ty} over ${[...new Set(corners)].map(d => terrainIds[d]!).join('/')} (claim ${claim.min}..${claim.max}, mask ${mask})`;
      const r = resolveTile(ring, d => pureVariant(d, 0), where, false);
      if (r.distinct.some(d => art.get(terrainIds[d]!)!.kind !== 'ground')) fail(`${where()}: the ring is ground-level (water and overlay stay empty on it)`);
      row[mask] = r.id; ringTiles++;
    }
    if (roadIndex !== undefined && roadCrossings === 0) fail(`claim ${claim.min}..${claim.max}: its boundary ring never crosses the kingdom road (${kit.boundary.road}) — the road must run from the field edge into the smallest kingdom [${REALM_KIT_SMALLEST_KINGDOM.min},${REALM_KIT_SMALLEST_KINGDOM.max}) so every claim meets it through a ring variant (§2, K-177 "road end")`);
    roadRingTiles += roadCrossings;
  }
  const edgeVariants: RealmKitEdgeVariant[] = [...variantRows].map(([cellIndex, cellsByMask]) => ({ cell: cellIndex, cells: cellsByMask }));
  if (edgeVariants.length > L.edgeVariants) fail(`${edgeVariants.length} ring-variant rows exceed LAYERED_GROUND_LIMITS_R5.edgeVariants (${L.edgeVariants}) — the reachable rings cross too many distinct cells`);
  stats.edgeVariantRows = edgeVariants.length; stats.edgeVariantPairs = ringTiles;
  if (roadIndex !== undefined) stats.roadRingTiles = roadRingTiles;
  if (cells.length > L.cells) fail(`${cells.length} tileset cells exceed LAYERED_GROUND_LIMITS_R5.cells`);

  // 3. Pack the tileset: one POT lossless sheet, smallest area among the candidate widths;
  // an animated cell's frames stay consecutive on one row (the shared cell source steps 32 px right).
  const slots = cells.reduce((s, c) => s + c.frames.length, 0);
  const layoutSheet = (width: number) => {
    const columns = width / TILE, origins: Array<{ x: number; y: number }> = [];
    let cx = 0, cy = 0;
    for (const c of cells) {
      if (c.frames.length > columns) fail(`cell ${c.key}: ${c.frames.length} frames do not fit a ${width}-px row`);
      if (cx + c.frames.length > columns) { cx = 0; cy++; }
      origins.push({ x: cx * TILE, y: cy * TILE }); cx += c.frames.length;
    }
    return { width, height: 1 << Math.ceil(Math.log2((cy + 1) * TILE)), origins };
  };
  let tileset: ReturnType<typeof layoutSheet> | undefined;
  for (const width of REALM_KIT_BUILD.sheetWidths) {
    // A width whose row is narrower than the longest animated cell cannot hold it (a 16-frame water loop needs 512 px):
    // skip it rather than fail, so assertKit's frames ≤ 32 is what the packer accepts too.
    if (cells.some(c => c.frames.length > width / TILE)) continue;
    const candidate = layoutSheet(width);
    if (candidate.height > L.dimension) continue;
    const area = candidate.width * candidate.height, best = tileset ? tileset.width * tileset.height : Infinity;
    if (area < best || (area === best && Math.max(candidate.width, candidate.height) < Math.max(tileset!.width, tileset!.height))) tileset = candidate;
  }
  if (!tileset) fail(`${slots} tileset slots exceed a ${L.dimension}² sheet`);
  const origins = tileset.origins;
  const tilesetRaster = raster(tileset.width, tileset.height);
  const manifestCells: RealmKitCell[] = cells.map((c, n) => {
    c.frames.forEach((f, k) => blit(tilesetRaster, f, origins[n]!.x + k * TILE, origins[n]!.y));
    return { asset: 'tileset', x: origins[n]!.x, y: origins[n]!.y, ...(c.frames.length > 1 ? { frames: c.frames.length, frameDurationMs: c.frameDurationMs! } : {}) };
  });

  // 4. Props: sheets by canvas size, bottom-centre seat; obstacle twins and path sprites standalone (the
  // shared obstacleSprites/paths contract names an ASSET, not a sheet cell).
  const standalone = new Set<string>();
  for (const s of Object.values(kit.obstacleSprites)) { standalone.add(s.intact); standalone.add(s.remnant); }
  interface PropCells { prop: KitProp; frames: Raster[]; sheet: string; frame: number }
  const propArt = new Map<string, PropCells>();
  const seat = (frames: Raster[]): Raster[] => {
    let bottom = -1;
    for (const f of frames) for (let y = f.height - 1; y > bottom; y--) for (let x = 0; x < f.width; x++) if (f.data[(y * f.width + x) * 4 + 3] === 255) { bottom = y; break; }
    if (bottom < 0) fail('prop frame is fully transparent');
    const dy = frames[0]!.height - 1 - bottom;
    return frames.map(f => { const o = raster(f.width, f.height); blit(o, f, 0, dy); return o; });
  };
  for (const p of kit.props) {
    const frames: Raster[] = [];
    if (p.clip) for (let k = 0; k < p.clip.frames; k++) frames.push(await readPng(path.join(realmDir, p.clip.source.replace('%d', String(k)))));
    else frames.push(await readPng(path.join(realmDir, p.source)));
    const w = frames[0]!.width, h = frames[0]!.height;
    if (!frames.every(f => f.width === w && f.height === h)) fail(`prop ${p.id}: clip frames differ in size`);
    if (w % TILE || h % TILE || w > L.dimension || h > L.dimension) fail(`prop ${p.id}: canvas ${w}×${h} must be a multiple of ${TILE}`);
    propArt.set(p.id, { prop: p, frames: seat(frames), sheet: standalone.has(p.id) ? p.id.replace(/_/g, '-') : (w === h ? `props${w}` : `props${w}x${h}`), frame: 0 });
  }
  const sheets = new Map<string, { cellW: number; cellH: number; members: PropCells[] }>();
  const sheetFill = new Map<string, number>();
  for (const pc of [...propArt.values()].sort((a, b) => a.prop.id < b.prop.id ? -1 : 1)) {
    if (pc.frames.length > REALM_KIT_BUILD.maxSheetFrames) fail(`prop ${pc.prop.id}: ${pc.frames.length} frames exceed one sheet`);
    let n = sheetFill.get(pc.sheet) ?? 1, id = n === 1 ? pc.sheet : `${pc.sheet}-${n}`;
    while (!standalone.has(pc.prop.id) && (sheets.get(id)?.members.reduce((c, m) => c + m.frames.length, 0) ?? 0) + pc.frames.length > REALM_KIT_BUILD.maxSheetFrames) { n++; id = `${pc.sheet}-${n}`; }
    sheetFill.set(pc.sheet, n);
    const s = sheets.get(id) ?? { cellW: pc.frames[0]!.width, cellH: pc.frames[0]!.height, members: [] };
    pc.frame = s.members.reduce((c, m) => c + m.frames.length, 0); pc.sheet = id;
    s.members.push(pc); sheets.set(id, s);
  }
  const assets: LayeredAsset[] = [], files = new Map<string, Buffer>(), sources: Array<{ asset: string; source: string }> = [];
  const segments = path.resolve(realmDir).split(path.sep), artAt = segments.lastIndexOf('art');
  if (artAt < 0) fail(`${realmDir}: a realm kit lives under art/ (layered-sources.json paths are repository-relative art paths)`);
  const relativeRealmDir = segments.slice(artAt).join('/');
  const addAsset = async (id: string, r: Raster, frameWidth: number, frameHeight: number, anchor: { x: number; y: number }, frameDurationMs: number) => {
    if (!ID.test(id)) fail(`asset id ${id}`);
    const png = await encodePng(r), sha256 = createHash('sha256').update(png).digest('hex');
    assets.push({ id, path: `atlas/fantasy/layered-ground/assets/${sha256}.png`, sha256, size: png.length, width: r.width, height: r.height,
      frameWidth, frameHeight, frameCount: (r.width / frameWidth) * (r.height / frameHeight), frameDurationMs, anchor, reducedMotionFrame: 0 });
    files.set(`built/${id}.png`, png);
    sources.push({ asset: id, source: `${relativeRealmDir}/built/${id}.png` });
  };
  await addAsset('tileset', tilesetRaster, tilesetRaster.width, tilesetRaster.height, { x: 0, y: 0 }, kit.water.frameDurationMs);
  for (const [id, s] of [...sheets.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    const count = s.members.reduce((n, m) => n + m.frames.length, 0), geometry = packSheet(s.cellW, s.cellH, count, false);
    const r = raster(geometry.width, geometry.height);
    for (const m of s.members) m.frames.forEach((f, k) => { const n = m.frame + k; blit(r, f, (n % geometry.columns) * s.cellW, Math.floor(n / geometry.columns) * s.cellH); });
    const clip = s.members.find(m => m.prop.clip)?.prop.clip;
    await addAsset(id, r, s.cellW, s.cellH, { x: s.cellW / 2, y: s.cellH }, clip?.frameDurationMs ?? 1000);
  }
  for (const s of kit.sprites) {
    const frames = [];
    for (const src of s.sources) frames.push(await readPng(path.join(realmDir, src)));
    const w = frames[0]!.width, h = frames[0]!.height;
    if (!frames.every(f => f.width === w && f.height === h)) fail(`sprite ${s.id}: frames differ in size`);
    const r = raster(w * frames.length, h);
    frames.forEach((f, k) => blit(r, f, k * w, 0));
    await addAsset(s.id.replace(/_/g, '-'), r, w, h, { x: w / 2, y: h / 2 }, s.frameDurationMs);
  }
  // Creatures (D-173 creature paths): one sheet per species, directions × frames cells row-major in facing
  // order, seated bottom-centre. The art contract (sources/creatures/README.md) seats every facing by its
  // frame 0, so the builder checks the seat rather than moving owner masters; the sprite must fit the
  // meadow rings around the frame, which is what keeps a route's sprite clear of the frame (§5).
  const creatureAssets = new Map<string, LayeredAsset>();
  for (const c of kit.creatures ?? []) {
    const frames: Raster[] = [];
    for (const dir of REALM_KIT_FACINGS) for (let k = 0; k < c.frames; k++) {
      const f = await readPng(path.join(realmDir, c.source.replace('%s', dir).replace('%d', String(k))));
      if (k === 0 && !Array.from({ length: f.width }, (_, x) => f.data[((f.height - 1) * f.width + x) * 4 + 3]).includes(255)) fail(`creature ${c.id}: ${dir}_0 does not touch the bottom row — frames are seated by frame 0 (sources/creatures/README.md)`);
      frames.push(f);
    }
    const w = frames[0]!.width, h = frames[0]!.height;
    if (!frames.every(f => f.width === w && f.height === h)) fail(`creature ${c.id}: frames differ in size`);
    if (w % TILE || h % TILE || w > L.dimension || h > L.dimension) fail(`creature ${c.id}: canvas ${w}×${h} must be a multiple of ${TILE}`);
    if (Math.max(Math.ceil(w / 2 / TILE), Math.ceil(h / TILE)) > REALM_KIT.meadowRingsOutsideFrame) fail(`creature ${c.id}: a ${w}×${h} sprite does not fit the ${REALM_KIT.meadowRingsOutsideFrame}-tile rings that keep routes clear of the frame`);
    const geometry = packSheet(w, h, frames.length, false), r = raster(geometry.width, geometry.height);
    frames.forEach((f, n) => blit(r, f, (n % geometry.columns) * w, Math.floor(n / geometry.columns) * h));
    await addAsset(c.id.replace(/_/g, '-'), r, w, h, { x: w / 2, y: h }, c.frameDurationMs);
    creatureAssets.set(c.id, assets[assets.length - 1]!);
  }

  // 5. Placements: explicit `place` first (footprints reserved), then seeded scatter.
  const occupied = new Uint8Array(FIELD_TILES * FIELD_TILES);
  const placements: Array<RealmKitPlacement & { ty: number }> = [];
  const assetOf = (sheet: string) => assets.find(a => a.id === sheet)!;
  let serial = 0;
  const place = (p: KitProp, tx: number, ty: number, dx: number, dy: number, why: string): RealmKitPlacement & { ty: number } => {
    const pc = propArt.get(p.id)!, a = assetOf(pc.sheet);
    const x = tx * TILE + Math.floor(p.footprint[0] * TILE / 2) + dx, y = (ty + p.footprint[1]) * TILE + dy;
    // E-11 expansion obstacles: `prop` and `footprint` let the shared rule (realmKitObstacles.ts)
    // turn a prop the claim reaches into a clearable row of the right tier and the same species.
    const placement: RealmKitPlacement & { ty: number } = { id: `${p.id.replace(/_/g, '-')}-${++serial}`, asset: a.id, x, y, width: a.frameWidth, height: a.frameHeight,
      layer: p.kind === 'tall' ? 1 : 0, phaseFrame: 0, animated: p.clip !== undefined, interactive: false, frame: pc.frame,
      ...(p.clip ? { clip: { frames: p.clip.frames, frameDurationMs: p.clip.frameDurationMs } } : {}),
      prop: p.id.replace(/_/g, '-'), footprint: [p.footprint[0], p.footprint[1]], ty };
    // The seat is read from the anchor the manifest will carry (dx/dy included), so this check
    // and the draw-time E-6 rule agree on which tile the prop stands on.
    const b = layeredPlacementBounds(placement, a), seat = realmKitPlacementSeat(placement);
    if (b.x < REALM_KIT_FIELD.x || b.y < REALM_KIT_FIELD.y || b.x + b.width > REALM_KIT_FIELD.x + REALM_KIT_FIELD.width || b.y + b.height > REALM_KIT_FIELD.y + REALM_KIT_FIELD.height) fail(`${why}: ${p.id} at ${tx},${ty} leaves the field`);
    if (inPlot(seat.tx, seat.ty)) fail(`${why}: ${p.id} at ${tx},${ty} is seated on the legacy plot [${PLOT.min},${PLOT.max}), the server obstacles' land (seat tile ${seat.tx},${seat.ty})`);
    for (let v = 0; v < p.footprint[1]; v++) for (let u = 0; u < p.footprint[0]; u++) { if (inField(tx + u, ty + v)) occupied[tileIndex(tx + u, ty + v)] = 1; }
    return placement;
  };
  for (const [n, e] of layout.place.entries()) {
    const p = kit.props.find(k => k.id === e.prop)!;
    if (e.on) {
      const allowed = new Set(e.on.map(t => tIndex.get(t)!));
      for (let v = 0; v < p.footprint[1]; v++) for (let u = 0; u < p.footprint[0]; u++) {
        const here = inField(e.tx + u, e.ty + v) ? tileTerrains[tileIndex(e.tx + u, e.ty + v)]! : [];
        if (!here.length || !here.every(t => allowed.has(t))) fail(`place[${n}]: ${p.id} at ${e.tx},${e.ty} stands on ${here.map(t => terrainIds[t]).join('/') || 'nothing'}, not ${e.on.join('/')}`);
      }
    }
    placements.push(place(p, e.tx, e.ty, e.dx ?? 0, e.dy ?? 0, `place[${n}]`));
  }
  for (const s of layout.scatter) {
    const random = rng((layout.seed ^ (createHash('sha256').update(s.id).digest().readUInt32LE(0))) >>> 0);
    const allowed = new Set(s.terrains.map(t => tIndex.get(t)!)), required = (s.require ?? []).map(t => tIndex.get(t)!), total = s.props.reduce((n, w) => n + w.weight, 0);
    const footOn = s.footOn && new Set(s.footOn.map(t => tIndex.get(t)!));
    const candidates: Array<[number, number]> = [], candidateSet = new Set<number>();
    for (let ty = FIELD_ORIGIN; ty < FIELD_END; ty++) for (let tx = FIELD_ORIGIN; tx < FIELD_END; tx++) {
      const here = tileTerrains[tileIndex(tx, ty)]!;
      if (inRegion(s.region, tx, ty) && inZone(s.zone, tx, ty) && here.every(t => allowed.has(t)) && required.every(t => here.includes(t))) { candidates.push([tx, ty]); candidateSet.add(tileIndex(tx, ty)); }
    }
    const pickWeighted = (roll: number) => {
      let pick = roll * total, chosen = s.props[s.props.length - 1]!;
      for (const w of s.props) { if (pick < w.weight) { chosen = w; break; } pick -= w.weight; }
      return kit.props.find(k => k.id === chosen.id)!;
    };
    const mine: Array<[number, number]> = [];
    let placed = 0;
    // One attempt: the footprint is free, on allowed terrain, off the legacy plot, apart from
    // this group's other props by minGap, and its sprite stays inside the field.
    const attempt = (tx: number, ty: number, p: KitProp): boolean => {
      const seat = seatTile(p, tx, ty);
      if (inPlot(seat.tx, seat.ty)) return false;
      for (let v = 0; v < p.footprint[1]; v++) for (let u = 0; u < p.footprint[0]; u++) {
        if (!inField(tx + u, ty + v) || occupied[tileIndex(tx + u, ty + v)] || !tileTerrains[tileIndex(tx + u, ty + v)]!.every(t => allowed.has(t))) return false;
      }
      // The baked corners (after any collapse), i.e. what the drawn tile shows under the foot.
      if (footOn) { const c = bakedCorners[tileIndex(seat.tx, seat.ty)]!; if (!footOn.has(c[2]!) || !footOn.has(c[3]!)) return false; }
      if (mine.some(([mx, my]) => Math.max(Math.abs(mx - tx), Math.abs(my - ty)) < s.minGap)) return false;
      const b = layeredPlacementBounds({ id: 'x', asset: '', x: tx * TILE + Math.floor(p.footprint[0] * TILE / 2), y: (ty + p.footprint[1]) * TILE,
        width: assetOf(propArt.get(p.id)!.sheet).frameWidth, height: assetOf(propArt.get(p.id)!.sheet).frameHeight, layer: 0, phaseFrame: 0, animated: false, interactive: false }, assetOf(propArt.get(p.id)!.sheet));
      if (b.x < REALM_KIT_FIELD.x || b.y < REALM_KIT_FIELD.y || b.x + b.width > REALM_KIT_FIELD.x + REALM_KIT_FIELD.width || b.y + b.height > REALM_KIT_FIELD.y + REALM_KIT_FIELD.height) return false;
      placements.push(place(p, tx, ty, 0, 0, `scatter ${s.id}`));
      mine.push([tx, ty]); placed++;
      return true;
    };
    const cap = s.max ?? L.placements;
    if (s.grove) {
      // Hexagonal lattice over the field, rows spacing·√3/2 apart, odd rows offset half a spacing;
      // each point jitters, thins by density, and is skipped unless it lands on a candidate tile.
      const g = s.grove, rowStep = g.spacing * Math.sqrt(3) / 2, salt = fnv1a(s.id);
      for (let row = 0; FIELD_ORIGIN + row * rowStep < FIELD_END && placed < cap; row++) {
        for (let col = 0; FIELD_ORIGIN + col * g.spacing < FIELD_END && placed < cap; col++) {
          const jx = (random() * 2 - 1) * g.jitter * g.spacing, jy = (random() * 2 - 1) * g.jitter * g.spacing, keep = random() * 100, roll = random(), lean = random();
          const tx = Math.floor(FIELD_ORIGIN + col * g.spacing + (row % 2 ? g.spacing / 2 : 0) + jx), ty = Math.floor(FIELD_ORIGIN + row * rowStep + jy);
          if (keep >= s.density || !inField(tx, ty) || !candidateSet.has(tileIndex(tx, ty))) continue;
          // The cluster's own species with probability clusterWeight, else the plain weighted mix.
          const cluster = hash01(layout.seed ^ salt, Math.floor(tx / g.clusterTiles), Math.floor(ty / g.clusterTiles));
          attempt(tx, ty, pickWeighted(lean < g.clusterWeight ? cluster : roll));
        }
      }
    } else {
      const target = Math.min(cap, Math.round(candidates.length * s.density / 100));
      let attempts = 0;
      while (placed < target && attempts < candidates.length * 4) {
        attempts++;
        const [tx, ty] = candidates[Math.floor(random() * candidates.length)]!;
        attempt(tx, ty, pickWeighted(random()));
      }
    }
    stats[`scatter.${s.id}`] = placed;
  }
  if (placements.length > L.placements) fail(`${placements.length} placements exceed LAYERED_GROUND_LIMITS_R5.placements (${layout.place.length} placed; ${layout.scatter.map(s => `${s.id}=${stats[`scatter.${s.id}`]}`).join(', ')})`);
  // Manifest order: layer, then the seat row, then x — the stable tie-break under the shared draw
  // order (realmKitDrawBand, then the seat row: every ground layer is one painter's band).
  placements.sort((a, b) => a.layer - b.layer || a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1));
  const ordered: RealmKitPlacement[] = placements.map(({ ty: _ty, ...p }) => p);

  // 6. Ambient paths (render-only), points at tile centres in art px. Kit sprites (birds, smoke)
  // keep the one-row default and rise over the props on the ambient layer.
  const paths: RealmKitPath[] = layout.paths.map(p => ({ id: p.id.replace(/_/g, '-'), asset: p.sprite.replace(/_/g, '-'),
    points: p.points.map(([tx, ty]) => ({ x: Math.round(tx * TILE + TILE / 2), y: Math.round(ty * TILE + TILE / 2) })), speed: p.speed,
    layer: REALM_KIT_BUILD.ambientLayer }));
  // 6b. Roam groups (D-173 creature paths): each creature gets a seeded closed polyline of tile centres
  // around an anchor tile — vertices and every tile a segment crosses on the group's terrains, outside
  // the frame and its meadow rings, off every placement footprint, the sprite inside the field. The
  // counts are apportioned by weight (largest remainder), so an authored "sheep ×3" is three sheep.
  const creatureSerial = new Map<string, number>();
  for (const g of layout.roam ?? []) {
    const random = rng((layout.seed ^ createHash('sha256').update(`roam:${g.id}`).digest().readUInt32LE(0)) >>> 0);
    const allowed = new Set(g.terrains.map(t => tIndex.get(t)!));
    // A group's tiles: in its region and zone (a pen keeps its animals), on its terrains, outside the frame's
    // rings, off every placement footprint. Vertices and the tiles under every segment must all be such tiles.
    const walkable = (tx: number, ty: number) => inField(tx, ty) && !inRings(tx, ty) && inRegion(g.region, tx, ty) && inZone(g.zone, tx, ty)
      && !occupied[tileIndex(tx, ty)] && tileTerrains[tileIndex(tx, ty)]!.every(t => allowed.has(t));
    const candidates: Array<[number, number]> = [];
    for (let ty = FIELD_ORIGIN; ty < FIELD_END; ty++) for (let tx = FIELD_ORIGIN; tx < FIELD_END; tx++) if (walkable(tx, ty)) candidates.push([tx, ty]);
    // Exact counts from weights: floor shares, then one leftover each to the largest remainders in creature
    // order. A share that took a leftover forfeits its remainder, so the next goes to the next species.
    const total = g.creatures.reduce((n, w) => n + w.weight, 0);
    const shares = g.creatures.map(w => ({ id: w.id, n: Math.floor(g.count * w.weight / total), rest: g.count * w.weight / total - Math.floor(g.count * w.weight / total) }));
    for (let left = g.count - shares.reduce((n, x) => n + x.n, 0); left > 0; left--) {
      const top = shares.slice().sort((a, b) => b.rest - a.rest || g.creatures.findIndex(w => w.id === a.id) - g.creatures.findIndex(w => w.id === b.id))[0]!;
      top.n++; top.rest = -1;
    }
    const anchors = new Set<number>();
    for (const share of shares) {
      const c = (kit.creatures ?? []).find(k => k.id === share.id)!, a = creatureAssets.get(c.id)!;
      const centre = (tx: number, ty: number) => ({ x: tx * TILE + TILE / 2, y: (ty + 1) * TILE });
      const inside = (tx: number, ty: number) => { const p = centre(tx, ty), b = { x: p.x - a.anchor.x, y: p.y - a.anchor.y, width: a.frameWidth, height: a.frameHeight };
        return b.x >= REALM_KIT_FIELD.x && b.y >= REALM_KIT_FIELD.y && b.x + b.width <= REALM_KIT_FIELD.x + REALM_KIT_FIELD.width && b.y + b.height <= REALM_KIT_FIELD.y + REALM_KIT_FIELD.height; };
      // Every tile under the segment (sampled every roamSegmentStepPx) is walkable: a deer never fords the lake, a duck never waddles ashore.
      const clear = (p: [number, number], q: [number, number]) => {
        const a0 = centre(p[0], p[1]), a1 = centre(q[0], q[1]), dx = a1.x - a0.x, dy = a1.y - a0.y, steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / REALM_KIT_BUILD.roamSegmentStepPx));
        for (let k = 0; k <= steps; k++) { const x = a0.x + Math.floor(dx * k / steps), y = a0.y + Math.floor(dy * k / steps); if (!walkable(Math.floor(x / TILE), Math.floor((y - 1) / TILE))) return false; }
        return true;
      };
      let placed = 0, attempts = 0;
      while (placed < share.n && attempts < candidates.length * REALM_KIT_BUILD.roamAnchorTriesPerCandidate) {
        attempts++;
        const anchor = candidates[Math.floor(random() * candidates.length)]!;
        if (anchors.has(tileIndex(anchor[0], anchor[1])) || !inside(anchor[0], anchor[1])) continue;
        const vertices: Array<[number, number]> = [anchor];
        for (let v = 1; v < g.vertices; v++) {
          let found = false;
          for (let t = 0; t < REALM_KIT_BUILD.roamVertexTries && !found; t++) {
            const tx = anchor[0] + Math.floor(random() * (2 * g.radius + 1)) - g.radius, ty = anchor[1] + Math.floor(random() * (2 * g.radius + 1)) - g.radius, prev = vertices[vertices.length - 1]!;
            // Every vertex is a new tile (a loop, not a shuttle) reached across walkable tiles.
            if (vertices.some(([vx, vy]) => vx === tx && vy === ty) || !walkable(tx, ty) || !inside(tx, ty) || !clear(prev, [tx, ty])) continue;
            vertices.push([tx, ty]); found = true;
          }
          if (!found) break;
        }
        if (vertices.length < g.vertices || !clear(vertices[vertices.length - 1]!, anchor)) continue;
        vertices.push(anchor);
        const n = (creatureSerial.get(c.id) ?? 0) + 1; creatureSerial.set(c.id, n);
        paths.push({ id: `${c.id.replace(/_/g, '-')}-${n}`, asset: a.id, points: vertices.map(([tx, ty]) => centre(tx, ty)), speed: c.speed,
          directions: c.directions, frames: c.frames, frameDurationMs: c.frameDurationMs, dwellMs: g.dwellMs, loop: 'cycle', layer: REALM_KIT_BUILD.creatureLayer });
        anchors.add(tileIndex(anchor[0], anchor[1])); placed++;
      }
      if (placed < share.n) fail(`roam ${g.id}: placed ${placed} of ${share.n} ${c.id} (${candidates.length} candidate tiles; widen the region, lower the radius or count)`);
    }
    stats[`roam.${g.id}`] = g.count;
  }
  if (new Set(paths.map(p => p.id)).size !== paths.length) fail(`ambient path ids collide: ${paths.map(p => p.id).filter((id, i, all) => all.indexOf(id) !== i).join(', ')}`);

  // 7. Far repeat (wild pure cells by the same hash) and the overview still.
  const wild = art.get(kit.boundary.wild)!, farRaster = raster(REALM_KIT_BUILD.farTiles * TILE, REALM_KIT_BUILD.farTiles * TILE);
  for (let ty = 0; ty < REALM_KIT_BUILD.farTiles; ty++) for (let tx = 0; tx < REALM_KIT_BUILD.farTiles; tx++) blit(farRaster, wild.variants[realmKitTileHash(tx, ty) % wild.variants.length]!, tx * TILE, ty * TILE);
  const seam = seamRatio(farRaster);
  if (seam > REALM_KIT_BUILD.farSeamFactor) fail(`far repeat is not seamless (wrap/interior difference ratio ${seam.toFixed(2)})`);
  stats.farSeamRatio = Math.round(seam * 1000) / 1000;
  await addAsset('far', farRaster, farRaster.width, farRaster.height, { x: 0, y: 0 }, 1000);
  const layers: RealmKitLayer[] = [];
  if (waterGrid.some(v => v)) layers.push({ id: 'water', rle: encodeRealmKitRle(waterGrid) });
  layers.push({ id: 'base', rle: encodeRealmKitRle(baseGrid) });
  if (overlayGrid.some(v => v)) layers.push({ id: 'overlay', rle: encodeRealmKitRle(overlayGrid) });
  const obstacleSprites: Partial<Record<ObstacleSpriteKey, RealmKitSpriteStates>> = {};
  for (const [key, s] of Object.entries(kit.obstacleSprites)) obstacleSprites[key as ObstacleSpriteKey] = { intact: propArt.get(s.intact)!.sheet, remnant: propArt.get(s.remnant)!.sheet };
  // Status comes from the registry beside the realm directories (the one source of truth the
  // publisher reads): an `accepted` row stamps the manifest so the same rebuild is what publishes.
  const manifest: RealmKitManifest = {
    schemaVersion: 3, groundRevision: 5, realmId: kit.realmId, status: await registryStatus(realmDir, kit.realmId), tilePixels: 32,
    field: { ...REALM_KIT_FIELD }, protectedFrame: { ...REALM_KIT_PROTECTED_FRAME },
    ground: { kind: 'tiles', paddingColor: kit.paddingColor, cells: manifestCells, layers, state: { turf, edge: { cells: edge, ...(edgeVariants.length ? { variants: edgeVariants } : {}) }, clearInside: true },
      far: { asset: 'far', origin: { x: 0, y: 0 }, period: { width: farRaster.width, height: farRaster.height } },
      overview: { asset: 'overview', pxPerTile: REALM_KIT_BUILD.overviewPxPerTile } },
    assets, placements: ordered, obstacleSprites, paths,
  };
  // The overview is the wild field's TILE layers baked claim-independently, rendered from
  // the very manifest it joins, then registered as the last asset. Props stay out of it:
  // E-6 (amended) hides a prop by the claim at draw time, a bake cannot be unbaked, and
  // native draws the visible props over the still at every zoom (E-8) — a baked twin
  // would strand the claim's hidden trees in the zoom floor and ghost under animated clips.
  const pixels = new Map<string, LayeredPixels>();
  for (const a of assets) { const png = files.get(`built/${a.id}.png`)!; const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); pixels.set(a.id, { data, width: info.width, height: info.height }); }
  const wildField = renderWildField(manifest, pixels, { props: false });
  const overview = boxDown(wildField, TILE / REALM_KIT_BUILD.overviewPxPerTile);
  await addAsset('overview', overview, overview.width, overview.height, { x: 0, y: 0 }, 1000);
  pixels.set('overview', { data: overview.data, width: overview.width, height: overview.height });
  assertRealmKitManifest(manifest);
  for (const a of manifest.assets) assertRealmKitAssetPixels(manifest, a, pixels.get(a.id)!);
  // Every family, prop, decal and sprite of the kit is used at least once (§5 "every asset used at least once").
  // (families joining the kingdom terrain are runtime material — the bake never sees a kingdom.)
  for (const f of kit.families) if (![f.lower, f.upper].includes(kit.boundary.kingdom) && !cells.some(c => c.key.startsWith(`fam:${f.id}:`))) fail(`family ${f.id} is never used by the layout`);
  const unusedProps = kit.props.filter(p => !standalone.has(p.id) && !ordered.some(o => o.asset === propArt.get(p.id)!.sheet && o.frame === propArt.get(p.id)!.frame)).map(p => p.id);
  stats.unusedProps = unusedProps.length;
  // A decal library may hold more kinds than one seeded scatter lands. A group that
  // lands nothing is a layout bug (wrong terrain, empty region, zero density); a
  // low-weight decal the seeded picks happen to skip is statistics, and counts as unused.
  for (const d of layout.decals) if (!landedGroups.has(d.id)) fail(`decal group ${d.id} never lands`);
  stats.unusedDecals = kit.decals.filter(d => !cells.some(c => c.key === `decal:${d.id}`)).length;
  for (const s of kit.sprites) if (!paths.some(p => p.asset === s.id.replace(/_/g, '-'))) fail(`sprite ${s.id} has no path`);
  for (const c of kit.creatures ?? []) if (!paths.some(p => p.asset === c.id.replace(/_/g, '-'))) fail(`creature ${c.id} roams nowhere (no roam group names it)`);
  stats.cells = cells.length; stats.tilesetSlots = slots; stats.tilesetWidth = tileset.width; stats.tilesetHeight = tileset.height;
  stats.placements = ordered.length; stats.assets = assets.length; stats.paths = paths.length;
  stats.compressedBytes = assets.reduce((s, a) => s + a.size, 0); stats.rgbaBytes = assets.reduce((s, a) => s + a.width * a.height * 4, 0);
  stats.manifestBytes = Buffer.byteLength(JSON.stringify(manifest) + '\n');
  stats.bakedTiles = [waterGrid, baseGrid, overlayGrid].reduce((s, g) => s + g.reduce((n, v) => n + (v ? 1 : 0), 0), 0);
  return { manifest, sources, files, stats, unusedProps };
}
export const REALM_KIT_REGISTRY = 'accepted.json';
async function registryStatus(realmDir: string, realmId: RealmId): Promise<'preview-only' | 'accepted'> {
  let text: string;
  try { text = await fs.readFile(path.join(realmDir, '..', REALM_KIT_REGISTRY), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'preview-only'; throw error; }
  const registry = JSON.parse(text) as { manifests?: Array<{ realmId?: unknown; status?: unknown }> };
  const row = registry.manifests?.find(r => r.realmId === realmId);
  if (row && row.status !== 'accepted' && row.status !== 'preview-only') fail(`${REALM_KIT_REGISTRY}: ${realmId} has status ${String(row.status)}`);
  return row?.status === 'accepted' ? 'accepted' : 'preview-only';
}
/** Frame-0 composite of the WHOLE baked field without a claim (the wild scene), the same
 * water → base → overlay → props order and integer blend as renderRealmKitPixels.
 * `props: false` stops after the tile layers: the overview still is baked that way, because
 * the claim decides at draw time which props show (realmKitPlacementHidden). */
export function renderWildField(m: RealmKitManifest, pixels: ReadonlyMap<string, LayeredPixels>, { props = true }: { props?: boolean } = {}): Raster {
  const out = raster(FIELD_TILES * TILE, FIELD_TILES * TILE), rgb = [1, 3, 5].map(i => parseInt(m.ground.paddingColor.slice(i, i + 2), 16));
  for (let i = 0; i < out.data.length; i += 4) { out.data[i] = rgb[0]!; out.data[i + 1] = rgb[1]!; out.data[i + 2] = rgb[2]!; out.data[i + 3] = 255; }
  const tiles = pixels.get(m.ground.cells[0]!.asset)!;
  const grids = m.ground.layers.map(l => ({ id: l.id, grid: decodeRealmKitRle(l.rle, FIELD_TILES * FIELD_TILES) }));
  for (const { grid } of grids) for (let i = 0; i < FIELD_TILES * FIELD_TILES; i++) {
    const id = grid[i]!;
    if (!id) continue;
    const c = m.ground.cells[id - 1]!, tx = i % FIELD_TILES, ty = Math.floor(i / FIELD_TILES);
    blit(out, { width: TILE, height: TILE, data: cropData(tiles, c.x, c.y) }, tx * TILE, ty * TILE);
  }
  if (!props) return out;
  const assets = new Map(m.assets.map(a => [a.id, a]));
  // Props and the creatures' stills (first vertex, frame 0) in the ground band's one order: the draw band,
  // then the anchor row, props first on a tie — the order realmKitGroundBandPlan gives both clients.
  const band = [
    ...m.placements.map(p => ({ layer: p.layer, bottom: p.y, asset: assets.get(p.asset)!, frame: p.frame ?? 0, bounds: layeredPlacementBounds(p, assets.get(p.asset)!) })),
    ...realmKitPathPlan(m, m.tilePixels, m.field, 0, true).map(d => ({ layer: d.layer, bottom: d.anchor.y, asset: d.asset, frame: d.frame, bounds: d.destination })),
  ].map((d, order) => ({ d, order })).sort((a, b) => realmKitDrawBand(a.d.layer) - realmKitDrawBand(b.d.layer) || a.d.bottom - b.d.bottom || a.order - b.order).map(({ d }) => d);
  for (const { asset: a, frame: f, bounds: b } of band) {
    const px = pixels.get(a.id)!, columns = a.width / a.frameWidth;
    const sx = (f % columns) * a.frameWidth, sy = Math.floor(f / columns) * a.frameHeight;
    for (let y = 0; y < a.frameHeight; y++) for (let x = 0; x < a.frameWidth; x++) {
      const s = ((sy + y) * px.width + sx + x) * 4, dx = b.x - m.field.x + x, dy = b.y - m.field.y + y;
      if (px.data[s + 3] !== 255 || dx < 0 || dy < 0 || dx >= out.width || dy >= out.height) continue;
      const d = (dy * out.width + dx) * 4;
      out.data[d] = px.data[s]!; out.data[d + 1] = px.data[s + 1]!; out.data[d + 2] = px.data[s + 2]!;
    }
  }
  return out;
}
function cropData(p: LayeredPixels, x: number, y: number): Uint8Array {
  const out = new Uint8Array(TILE * TILE * 4);
  for (let v = 0; v < TILE; v++) out.set(p.data.subarray(((y + v) * p.width + x) * 4, ((y + v) * p.width + x + TILE) * 4), v * TILE * 4);
  return out;
}

export async function writeRealmKitBuild(realmDir: string, result: BuildResult): Promise<void> {
  for (const [relative, bytes] of result.files) { const file = path.join(realmDir, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); }
  await fs.writeFile(path.join(realmDir, 'layered-manifest.json'), JSON.stringify(result.manifest, null, 2) + '\n');
  await fs.writeFile(path.join(realmDir, 'layered-sources.json'), JSON.stringify(result.sources, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Preview (CPU renders for owner review; never published)
// ---------------------------------------------------------------------------
export async function loadBuiltRealmKit(realmDir: string): Promise<{ manifest: RealmKitManifest; pixels: Map<string, LayeredPixels> }> {
  const value: unknown = JSON.parse(await fs.readFile(path.join(realmDir, 'layered-manifest.json'), 'utf8'));
  assertRealmKitManifest(value);
  const pixels = new Map<string, LayeredPixels>();
  for (const a of value.assets) {
    const png = await fs.readFile(path.join(realmDir, 'built', `${a.id}.png`));
    if (createHash('sha256').update(png).digest('hex') !== a.sha256) fail(`built/${a.id}.png does not match the manifest digest — rebuild`);
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    pixels.set(a.id, { data, width: info.width, height: info.height });
  }
  return { manifest: value, pixels };
}
export async function previewRealmKit(realmDir: string, outDir: string, claims: number[]): Promise<string[]> {
  const { manifest, pixels } = await loadBuiltRealmKit(realmDir);
  await fs.mkdir(outDir, { recursive: true });
  const written: string[] = [];
  const write = async (name: string, r: Raster) => { const file = path.join(outDir, name); await fs.writeFile(file, await encodePng(r)); written.push(file); };
  await write('wild.png', renderWildField(manifest, pixels));
  const margin = REALM_KIT_BUILD.previewMarginTiles, origin = (FRAME_MIN - margin) * TILE, size = (FRAME_MAX - FRAME_MIN + 2 * margin) * TILE;
  for (const n of claims) {
    const claim = { min: 15 - Math.floor(n / 2), max: 15 - Math.floor(n / 2) + n };
    const data = renderRealmKitPixels(manifest, pixels, claim, size, size, origin, origin);
    const r = { width: size, height: size, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
    await write(`kingdom-${n}.png`, r);
    await write(`kingdom-${n}-2x.png`, upscaleNearest(r, 2));
  }
  // Contact sheet: every tileset cell (frame 0) numbered by row, then every prop-sheet cell.
  const tileset = pixels.get(manifest.ground.cells[0]!.asset)!;
  const contact = raster(tileset.width, tileset.height + manifest.assets.filter(a => a.id !== 'tileset' && a.id !== 'far' && a.id !== 'overview').reduce((s, a) => s + a.height + 8, 0));
  for (let i = 0; i < contact.data.length; i += 4) { contact.data[i] = 24; contact.data[i + 1] = 20; contact.data[i + 2] = 28; contact.data[i + 3] = 255; }
  blit(contact, { width: tileset.width, height: tileset.height, data: new Uint8Array(tileset.data) }, 0, 0);
  let y = tileset.height + 8;
  for (const a of manifest.assets) {
    if (a.id === 'tileset' || a.id === 'far' || a.id === 'overview') continue;
    const p = pixels.get(a.id)!;
    blit(contact, { width: p.width, height: p.height, data: new Uint8Array(p.data) }, 0, y); y += p.height + 8;
  }
  await write('contact.png', contact);
  await write('contact-2x.png', upscaleNearest(contact, 2));
  const overview = manifest.ground.overview && pixels.get(manifest.ground.overview.asset);
  if (overview) await write('overview.png', { width: overview.width, height: overview.height, data: new Uint8Array(overview.data) });
  return written;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  const [command, realmDir, ...rest] = process.argv.slice(2);
  try {
    if (command === 'build' && realmDir && rest.length === 0) {
      const result = await buildRealmKit(realmDir);
      await writeRealmKitBuild(realmDir, result);
      console.log(JSON.stringify({ ...result.stats, unusedProps: result.unusedProps }));
    } else if (command === 'preview' && realmDir && rest[0] && !rest[0].startsWith('--')) {
      const claims = [14, 26, 50];
      for (let i = 1; i < rest.length; i++) if (rest[i] === '--claim' && rest[i + 1]) claims.push(Number(rest[++i]));
      for (const file of await previewRealmKit(realmDir, rest[0], [...new Set(claims)].sort((a, b) => a - b))) console.log(file);
    } else {
      console.error('usage: tsx scripts/src/realm-kit.ts build <realmDir> | preview <realmDir> <outDir> [--claim N]');
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error instanceof KitError ? `realm-kit: ${error.message}` : error);
    process.exitCode = 1;
  }
}
