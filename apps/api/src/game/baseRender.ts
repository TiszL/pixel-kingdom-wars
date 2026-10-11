/**
 * Server-side base renderer (owner 2026-07-26: "the NFT's image should be a
 * picture of your actual base") — composites a PNG of a player's base from the
 * SAME generated atlases the web client draws with, so the deed image and the
 * game agree pixel-for-pixel on what the base looks like.
 *
 * Faithful to the client's draw rules (BaseScene):
 *  - 1 tile = 32 px at 1× (the @1x atlases; the client renders @2x on canvas);
 *  - a sprite's atlas comes from the shared grouping rule (atlasGroupFor), not
 *    from its key prefix — batch 13 moved the six defences into `blddef`;
 *  - sprites are bottom-anchored, centred on their footprint;
 *  - painter's order = the shared structure depth, with walls/buildings sorted
 *    by bottom edge Y and equal ties favouring the building;
 *  - walls use the same eight-neighbor contextual pixel compositor as Phaser;
 *  - the full ground uses the same world-coordinate sampler as Phaser.
 *
 * Presentation-only, like the metadata it feeds: INV-1 stands (gameplay never
 * reads any of this). Atlases are generated + gitignored — when absent the
 * renderer reports unavailable and deed images simply stay at the placeholder,
 * same degrade-not-fail story as every other optional integration.
 */
import { readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { and, eq, isNull } from 'drizzle-orm';
import {
  ART_V2,
  LAYERED_GROUND_LIMITS_R5,
  STRUCTURES,
  TRAP_TYPES,
  artTierOfLevel,
  atlasGroupFor,
  wareTrapStateAliasKey,
  structureDepth,
  type StructureDepthKind,
  type BuildingType,
  type TrapType,
} from '@shardkeep/shared';
import { buildField, composeWall, wallTierOfLevel, type WallGrid } from '@shardkeep/shared/wallRender';
import {
  baseGroundArt, assertGroundSource, baseGroundPath, renderGroundPixels,
  isLayeredBaseVisualContext, isRealmKitBaseVisualContext, resolveBaseVisualContext,
  type BaseVisualContext, type GroundPixels,
} from '@shardkeep/shared/baseVisual';
import { layeredGroundDescriptor } from '@shardkeep/shared/layeredGroundCatalogue';
import {
  assertLayeredGroundManifest, assertLayeredGroundAssetPixels, renderLayeredGroundPixels,
  LAYERED_GROUND_LIMITS, type LayeredAsset, type LayeredGroundManifest, type LayeredPixels,
} from '@shardkeep/shared/layeredGround';
import {
  assertRealmKitManifest, assertRealmKitAssetPixels, renderRealmKitPixels,
  OBSTACLE_SPRITE_KEYS, realmKitSpriteSource,
  type ObstacleSpriteKey, type RealmKitClaim, type RealmKitManifest,
} from '@shardkeep/shared/realmKit';
import { realmKitObstacleSpriteAt } from '@shardkeep/shared/realmKitObstacles';
import {
  boundCosmeticAwningForCompletedLevel, matchBoundCosmeticBaseRead, type BoundCosmeticBaseRead,
} from '@shardkeep/shared/boundCosmeticVisual';
import type { Db, DbOrTx } from '../db/client';
import { PHASE_E_VEHICLES } from '@shardkeep/shared';
import { PHASE_E_VEHICLE_FAMILY_IDS } from '@shardkeep/shared/phaseEVehicles';
import { deedDrawingIdentityCurrent, type CapturedDeedDrawing } from './deedFleetCapture';
import { bases, builderJobs, buildings, obstacles, players } from '../db/schema';
import { claimRect, footprintOf } from './footprints';
import { resolveBaseVisual } from './baseVisual';
import { readBoundCosmeticBase } from './boundCosmeticPresentation';
import { realmKitDescriptor } from './realmKitCatalogue';
import { HttpError } from '../lib/errors';

const TILE = 32; // px per tile at 1× (HANDOFF §2.1)
const MARGIN_TILES = 1; // breathing room around the claim in the framed image

const groundSources = new Map<string, Promise<GroundPixels>>();
/** One decoded working set per published manifest: the r3/r4 painting readers or
 * the revision-5 realm kit (docs/REALM-KIT-PLAN.md E-10), never both for one key. */
type LayeredGroundSource =
  | { kind: 'layered'; manifest: LayeredGroundManifest; pixels: Map<string, LayeredPixels> }
  | { kind: 'realm-kit'; manifest: RealmKitManifest; pixels: Map<string, LayeredPixels> };
const layeredSources = new Map<string, LayeredGroundSource>();
const layeredLoads = new Map<string, Promise<LayeredGroundSource>>();
// Infrastructure admission, not a gameplay cap. Keep both expensive image jobs
// and decoded realm working sets bounded; public crawlers cannot enqueue work.
// The two published families share one cache, so the tighter resident budget
// of the two catalogue limits is the one that binds.
const RESIDENT_REALMS = Math.min(LAYERED_GROUND_LIMITS.residentRealms, LAYERED_GROUND_LIMITS_R5.residentRealms);
const MAX_BASE_RENDERS = RESIDENT_REALMS;
let activeBaseRenders = 0;
function rendererBusy(): HttpError {
  return new HttpError(503, 'Deed image is busy; retry shortly', 'DEED_RENDER_BUSY');
}
async function withRenderPermit<T>(render: () => Promise<T>): Promise<T> {
  if (activeBaseRenders >= MAX_BASE_RENDERS) throw rendererBusy();
  activeBaseRenders++;
  try { return await render(); }
  finally { activeBaseRenders--; }
}

/** Match the clients' immutable manifest and texture admission. Only a small
 * realm working set is retained; a corrupt candidate never substitutes scenery.
 * A revision-5 context resolves through the realm-kit catalogue and validator; an
 * unpublished kit throws from realmKitDescriptor before any file is opened. */
async function layeredSource(context: BaseVisualContext): Promise<LayeredGroundSource> {
  const realmKit = isRealmKitBaseVisualContext(context);
  const descriptor = realmKit ? realmKitDescriptor(context) : layeredGroundDescriptor(context);
  const repoRoot = process.env['REPO_ROOT'] ?? path.resolve(process.cwd(), '..', '..');
  const publicRoot = path.join(repoRoot, 'apps/web/public');
  const key = `${publicRoot}:${descriptor.sha256}`;
  const existing = layeredSources.get(key);
  if (existing) {
    layeredSources.delete(key); layeredSources.set(key, existing);
    return existing;
  }
  // Pending identity is independent of LRU eviction. An A/B/C/A burst cannot
  // evict unfinished A and start its decoding twice.
  const loading = layeredLoads.get(key);
  if (loading) return loading;
  if (layeredLoads.size >= RESIDENT_REALMS) throw rendererBusy();
  const pending = (async (): Promise<LayeredGroundSource> => {
    const bytes = await readFile(path.join(publicRoot, descriptor.manifestPath));
    if (bytes.length !== descriptor.size || createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256) {
      throw new Error('Deed layered manifest integrity check failed');
    }
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    let manifest: LayeredGroundManifest | RealmKitManifest;
    if (realmKit) { assertRealmKitManifest(value); manifest = value; }
    else { assertLayeredGroundManifest(value); manifest = value; }
    if (manifest.status !== 'accepted' || manifest.realmId !== context.realmId || manifest.groundRevision !== context.groundRevision) {
      throw new Error('Deed layered realm is not accepted');
    }
    const pixels = new Map<string, LayeredPixels>();
    // Sequential decode bounds transient compressed/decoded memory; paths are
    // hash-addressed and validated before any asset file is opened.
    for (const asset of manifest.assets) {
      const assetBytes = await readFile(path.join(publicRoot, asset.path));
      if (assetBytes.length !== asset.size || createHash('sha256').update(assetBytes).digest('hex') !== asset.sha256) {
        throw new Error('Deed layered artwork integrity check failed');
      }
      const { data, info } = await sharp(assetBytes, { limitInputPixels: asset.width * asset.height })
        .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (info.width !== asset.width || info.height !== asset.height || info.channels !== 4) {
        throw new Error('Deed layered artwork dimensions disagree');
      }
      // Check the complete texture once when admitting the immutable working
      // set, not on every small PNG crop from that already verified cache.
      if (manifest.groundRevision === 5) assertRealmKitAssetPixels(manifest, asset, { data, width: info.width, height: info.height });
      else if (manifest.groundRevision === 4) assertLayeredGroundAssetPixels(manifest, asset, { data, width: info.width, height: info.height });
      pixels.set(asset.id, { data, width: info.width, height: info.height });
    }
    return manifest.groundRevision === 5 ? { kind: 'realm-kit', manifest, pixels } : { kind: 'layered', manifest, pixels };
  })();
  layeredLoads.set(key, pending);
  try {
    const source = await pending;
    while (layeredSources.size >= RESIDENT_REALMS) layeredSources.delete(layeredSources.keys().next().value!);
    layeredSources.set(key, source);
    return source;
  } finally {
    layeredLoads.delete(key);
  }
}
/** A missing or corrupt accepted floor refuses rendering rather than publishing
 * an NFT with a different realm's terrain. Rejected loads can recover on retry. */
async function groundSource(context: BaseVisualContext): Promise<GroundPixels> {
  const repoRoot = process.env['REPO_ROOT'] ?? path.resolve(process.cwd(), '..', '..');
  const key = `${repoRoot}:${context.artVersion}:${context.groundRevision ?? 0}:${context.realmId}`;
  let pending = groundSources.get(key);
  if (!pending) {
    pending = (async () => {
      const filename = path.join(repoRoot, 'apps/web/public', baseGroundPath(context));
      const bytes = readFileSync(filename);
      if (createHash('sha256').update(bytes).digest('hex') !== baseGroundArt(context).sources[context.realmId].sha256) {
        throw new Error('Deed ground artwork integrity check failed');
      }
      const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const source = { data, width: info.width, height: info.height };
      assertGroundSource(source, context);
      return source;
    })();
    groundSources.set(key, pending);
    void pending.catch(() => { if (groundSources.get(key) === pending) groundSources.delete(key); });
  }
  return pending;
}

/** Native-scale contract shared by deed crops and Phaser full-field painting.
 * `claim` is the server claim rect in plot tiles: revision-5 ground draws the
 * kingdom turf and its boundary ring from it (REALM-KIT-PLAN §3, E-10), so a
 * realm-kit context without one refuses rather than guessing a claim; every
 * older revision ignores it (paintings never moved with the claim). */
export async function renderBaseGroundPng(
  context: BaseVisualContext, size: number, originX: number, originY = originX, claim?: RealmKitClaim,
): Promise<Buffer> {
  return withRenderPermit(() => paintBaseGroundPng(context, size, originX, originY, claim));
}
async function paintBaseGroundPng(
  context: BaseVisualContext, size: number, originX: number, originY: number, claim?: RealmKitClaim,
): Promise<Buffer> {
  if (isRealmKitBaseVisualContext(context)) {
    if (!claim) throw new Error('Realm kit ground requires the base claim');
    const source = await layeredSource(context);
    if (source.kind !== 'realm-kit') throw new Error('Realm kit context resolved a painting working set');
    const data = renderRealmKitPixels(source.manifest, source.pixels, claim, size, size, originX, originY);
    return sharp(Buffer.from(data), { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
  }
  if (isLayeredBaseVisualContext(context)) {
    const source = await layeredSource(context);
    if (source.kind !== 'layered') throw new Error('Layered context resolved a realm kit working set');
    const data = renderLayeredGroundPixels(source.manifest, source.pixels, size, size, originX, originY);
    return sharp(Buffer.from(data), { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
  }
  const source = await groundSource(context);
  const data = renderGroundPixels(source, context, size, size, originX, originY);
  return sharp(Buffer.from(data), { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}

async function groundPaddingColor(context: BaseVisualContext): Promise<sharp.Color> {
  if (isRealmKitBaseVisualContext(context)) {
    // E-10: the kit names its kingdom turf tone explicitly; no sampling guess.
    const source = await layeredSource(context);
    if (source.kind !== 'realm-kit') throw new Error('Realm kit context resolved a painting working set');
    return source.manifest.ground.paddingColor;
  }
  if (!isLayeredBaseVisualContext(context)) return baseGroundArt(context).sources[context.realmId].color;
  const working = await layeredSource(context);
  if (working.kind !== 'layered') throw new Error('Layered context resolved a realm kit working set');
  const source = working.pixels.get(working.manifest.ground.asset)!;
  const i = (Math.floor(source.height / 2) * source.width + Math.floor(source.width / 2)) * 4;
  return { r: source.data[i]!, g: source.data[i + 1]!, b: source.data[i + 2]!, alpha: source.data[i + 3]! / 255 };
}

/** Exported pure seam so server deed painter order cannot drift from Phaser. */
export function baseRenderStructureDepth(
  kind: StructureDepthKind, ty: number, footprintHeight: number,
): number {
  return structureDepth(kind, (ty + footprintHeight) * TILE);
}

interface AtlasFrame { x: number; y: number; w: number; h: number }
interface Atlas { image: Buffer; frames: Map<string, AtlasFrame> }
interface SpriteMeta {
  anchor: [number, number];
  footprint: [number, number] | null;
  /** Published ART FACT: M22 WARE buildings anchor at the centre of the art's
   *  own ground quad. It is the sprite ORIGIN in the client, never the seat —
   *  see the `top` computation below. */
  anchorAtFootprintCentre?: boolean;
  /** Uniform authored-source fit for WARE world aliases (32 px/tile at @1x). */
  sourceScale?: number;
  /** Presentation-only correction in authored 32-px game coordinates. */
  offsetGamePx?: readonly [number, number];
}
/** meta.json v2Clips entry, the slice this renderer needs (anchor geometry). */
interface V2ClipMeta { cellW: number; cellH: number; anchorPx?: [number, number] }

interface AtlasSet {
  /** Loaded atlases keyed by atlas GROUP — the answer atlasGroupFor gives, not
   *  the key's prefix. Batch 13 moved the six defences out of `bld`, so those
   *  two stopped being the same thing. */
  groups: Map<string, Atlas>;
  meta: Map<string, SpriteMeta>;
  /** Rework-v2 clip table — v2 frames are absent from `sprites`; their
   *  anchors live here, in cell PIXELS rather than fractions. */
  v2Clips: Map<string, V2ClipMeta>;
}

/**
 * The atlas groups a deed picture draws from: ground, buildings, the batch-13
 * defences, obstacles. (`skin` stays out — see spriteKeyFor.)
 *
 * `blddef` is not optional. This renderer skips any sprite it cannot find a
 * frame for — a deliberate degrade — so if the defence atlas were merely absent
 * instead of fatal, deeds would publish as pictures of a base with no towers on
 * it and nothing would report a problem. The set is therefore all-or-nothing.
 */
const RENDER_GROUPS = [
  'tile', 'bld', 'blddef', 'dec',
  // M22's spent/damaged/collapse aliases are exact pack pixels in a compact
  // @1x group. Omitting it silently erases persisted spent traps from deeds.
  'warefallback',
  // Rework-v2 cannon/mortar (Phase D): the deed composites their v2 idle
  // masters, one on-demand group per (unit, tier) — same all-or-nothing rule
  // as blddef and for the same reason: a merely-absent group would publish
  // deeds of bases with no cannons and nothing would report a problem.
  'v2bld_cannon_t1', 'v2bld_cannon_t2', 'v2bld_cannon_t3', 'v2bld_cannon_t4',
  'v2bld_mortar_t1', 'v2bld_mortar_t2', 'v2bld_mortar_t3', 'v2bld_mortar_t4',
] as const;

let atlasSet: AtlasSet | null | undefined; // undefined = not tried, null = unavailable
let warnedMissing = false;

function loadAtlas(dir: string, name: string): Atlas {
  const json = JSON.parse(readFileSync(path.join(dir, `${name}@1x.json`), 'utf8')) as {
    textures: Array<{ frames: Array<{ filename: string; frame: AtlasFrame }> }>;
  };
  const frames = new Map<string, AtlasFrame>();
  for (const f of json.textures[0]?.frames ?? []) frames.set(f.filename, f.frame);
  return { image: readFileSync(path.join(dir, `${name}@1x.png`)), frames };
}

/** Load (once) the generated atlases the web client ships. Null when absent. */
function atlases(): AtlasSet | null {
  // A loaded set is final; "unavailable" is RE-CHECKED every call (cheap stat) so
  // running `pnpm assets` after boot recovers without a restart — the memoized
  // null previously disabled deed images for the process lifetime (verify wf).
  if (atlasSet) return atlasSet;
  const repoRoot = process.env['REPO_ROOT'] ?? path.resolve(process.cwd(), '..', '..');
  const dir = path.join(repoRoot, 'apps', 'web', 'public', 'atlas');
  const missing = RENDER_GROUPS.filter((g) => !existsSync(path.join(dir, `${g}@1x.png`)));
  if (missing.length > 0) {
    if (!warnedMissing) {
      console.log(`[base-render] atlases ${missing.join(', ')} not found under ${dir} — run \`pnpm assets\`; deed images disabled until they appear`);
      warnedMissing = true;
    }
    atlasSet = null;
    return null;
  }
  const metaJson = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')) as {
    sprites: Record<string, SpriteMeta>;
    v2Clips?: Record<string, V2ClipMeta>;
  };
  atlasSet = {
    groups: new Map(RENDER_GROUPS.map((g) => [g, loadAtlas(dir, g)])),
    meta: new Map(Object.entries(metaJson.sprites)),
    v2Clips: new Map(Object.entries(metaJson.v2Clips ?? {})),
  };
  return atlasSet;
}

export function baseRenderAvailable(): boolean {
  return atlases() !== null;
}

// ---------------------------------------------------------------------------
// Phase E Market art (C3): ordinary `pe_market_t<T>` groups + the bound Artisan
// Awning `pe_cosmetics` group. Outside RENDER_GROUPS on purpose: a base with no
// Market never needs them, so their absence must not disable every deed. A base
// WITH a Market is refused (null) when they are absent — the same reasoning as
// blddef: a deed of a base with no Market on it would report no problem.
// ---------------------------------------------------------------------------

/** meta.json `peMarket`/`peCosmetics` clip slice this renderer needs. */
interface MarketClipMeta {
  cellW: number;
  cellH: number;
  anchorPx?: [number, number];
  frames: Array<{ key: string }>;
}
interface MarketArtSet {
  groups: Map<string, Atlas>;
  clips: Map<string, MarketClipMeta>;
  /** Awning outputId → generated binding hashes (equality gates application). */
  bindings: Map<string, { sha256: string; sourceManifestSha256: string; sourceIndexSha256: string }>;
}
const MARKET_RENDER_GROUPS = [
  'pe_market_t1', 'pe_market_t2', 'pe_market_t3', 'pe_market_t4', 'pe_cosmetics',
] as const;
/** The pack is authored at the web world's 64 px tile (cell 112 for a 2×2 body);
 *  this renderer's TILE is 32, so the same cell goes down at half density. */
const MARKET_DEED_SCALE = TILE / 64;
let marketArtSet: MarketArtSet | null | undefined;
let warnedMarketMissing = false;
let warnedCosmeticRefused = false;

/** P5: the ordinary Workshop/Lodge families of the accepted service pack
 *  (`meta.peServiceBuildings`, eight optional 1x groups). Validated on their
 *  own, so a missing service pack never touches the Market/Awning set. */
const SERVICE_RENDER_GROUPS = [
  'pe_workshop_t1', 'pe_workshop_t2', 'pe_workshop_t3', 'pe_workshop_t4',
  'pe_lodge_t1', 'pe_lodge_t2', 'pe_lodge_t3', 'pe_lodge_t4',
] as const;
/** Only a validated set is kept, and only for the directory it was read from:
 *  readiness is re-checked while false (Market rule) and never answered for
 *  another generated-output location. */
let serviceArtSet: { dir: string; set: MarketArtSet } | undefined;
let warnedServiceMissing = false;

function serviceArt(): MarketArtSet | null {
  const repoRoot = process.env['REPO_ROOT'] ?? path.resolve(process.cwd(), '..', '..');
  const dir = path.join(repoRoot, 'apps', 'web', 'public', 'atlas');
  if (serviceArtSet && serviceArtSet.dir === dir) return serviceArtSet.set;
  const missing = SERVICE_RENDER_GROUPS.filter((g) => !existsSync(path.join(dir, `${g}@1x.png`)));
  if (!existsSync(path.join(dir, 'meta.json'))) missing.push('meta.json' as never);
  if (missing.length > 0) {
    if (!warnedServiceMissing) {
      console.log(`[base-render] Phase E Workshop/Lodge art ${missing.join(', ')} not found under ${dir} — run \`pnpm assets\`; deed images of bases with a Workshop or Lodge are unavailable until it appears`);
      warnedServiceMissing = true;
    }
    return null;
  }
  const metaJson = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')) as {
    peServiceBuildings?: { schemaVersion?: unknown; families?: unknown; clips?: Record<string, MarketClipMeta> };
  };
  const table = metaJson.peServiceBuildings;
  const families = table?.families;
  if (table?.schemaVersion !== 1 || !table.clips || !Array.isArray(families) || families.length !== 2
    || families[0] !== 'workshop' || families[1] !== 'lodge') {
    if (!warnedServiceMissing) {
      console.log(`[base-render] Phase E Workshop/Lodge metadata (peServiceBuildings) is missing or foreign in ${dir}/meta.json — run \`pnpm assets\`; deed images of bases with a Workshop or Lodge are unavailable until it appears`);
      warnedServiceMissing = true;
    }
    return null;
  }
  const set: MarketArtSet = {
    groups: new Map(SERVICE_RENDER_GROUPS.map((g) => [g, loadAtlas(dir, g)])),
    clips: new Map(Object.entries(table.clips)),
    bindings: new Map(),
  };
  // Validated-art admission: every family's and tier's idle/damaged/destroyed
  // bodies are packed under their published group with a full-cell anchor, or
  // the whole service set is unavailable (a half-admitted catalogue would draw
  // one family while its sibling could not be drawn).
  const admitted = (['workshop', 'lodge'] as const).every((family) => [1, 2, 3, 4].every((tier) =>
    ['idle', 'damaged', 'destroyed'].every((state) => set.groups.get(`pe_${family}_t${tier}`)?.frames.has(`pe_${family}_t${tier}_${state}_f1`)
      && marketSeatOf(set, `pe_${family}_t${tier}_${state}_f1`))));
  if (!admitted) {
    if (!warnedServiceMissing) {
      console.log(`[base-render] Phase E Workshop/Lodge art under ${dir} is incomplete (a family or tier body is missing); deed images of bases with a Workshop or Lodge are unavailable until \`pnpm assets\` completes`);
      warnedServiceMissing = true;
    }
    return null;
  }
  serviceArtSet = { dir, set };
  return set;
}

/** Readiness of the ordinary Workshop/Lodge deed bodies (the same validated
 *  set the deed draws from); re-checked while false like the Market seam. */
export function baseRenderServiceArtAvailable(): boolean {
  return serviceArt() !== null;
}

// ---------------------------------------------------------------------------
// Phase E fleet berths (P6b): the starter group `pe_fleet_starter` plus the
// twenty advanced groups (`pe_berth_<family>`, `pe_veh_<family>_t1..4`). Drawn
// ONLY from a captured deed packet (deedFleetCapture.ts): the packet names the
// admitted art fingerprint it was captured against, and the painter composes
// from ONE retained working set — these decoded bytes and tables — whose own
// fingerprint must equal it. Outside RENDER_GROUPS on purpose: a base with no
// presented berth never needs them; one with a packet is refused (null) when
// they are absent or differ, never drawn from other bytes.
// ---------------------------------------------------------------------------

const STARTER_FLEET_GROUP = 'pe_fleet_starter';
const FLEET_FAMILIES = PHASE_E_VEHICLE_FAMILY_IDS;
const FLEET_TIERS = PHASE_E_VEHICLES.tiers;
const FLEET_RENDER_GROUPS: readonly string[] = [
  STARTER_FLEET_GROUP,
  ...FLEET_FAMILIES.flatMap((family) => [`pe_berth_${family}`, ...FLEET_TIERS.map((tier) => `pe_veh_${family}_t${tier}`)]),
];
interface FleetCell { atlas: string; cellW: number; cellH: number; anchorPx: [number, number]; frame: string }
interface FleetBerthGeometry { horizontalPivot: number; sourceCellBottom: number; attachment: [number, number] }
interface FleetVehicleGeometry { contactPx: [number, number]; dockOffsetPx: [number, number] }
interface FleetAtlas extends Atlas { pngSha256: string; jsonSha256: string }
interface FleetArtSet {
  dir: string;
  /** Canonical digest of exactly these retained bytes and tables. */
  fingerprint: string;
  groups: Map<string, FleetAtlas>;
  /** clip id → the still the deed draws (frame 1 of the clip). */
  cells: Map<string, FleetCell>;
  /** 'starter' | family → berth geometry; 'starter' | `${family}:${tier}` → vehicle geometry. */
  berthGeometry: Map<string, FleetBerthGeometry>;
  vehicleGeometry: Map<string, FleetVehicleGeometry>;
}
let fleetArtSet: { dir: string; set: FleetArtSet } | undefined;
let warnedFleetMissing = false;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isIntPair = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number' && Number.isInteger(n));
const isHex64 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const pairOf = (value: [number, number]): [number, number] => [value[0], value[1]];

/** A berth geometry record: full-cell bottom pivot at the game footprint. */
function fleetBerthGeometry(raw: unknown): FleetBerthGeometry | null {
  if (!isRecord(raw) || !isIntPair(raw['cell']) || !isIntPair(raw['footprint']) || !isIntPair(raw['attachment'])) return null;
  const [fw, fh] = STRUCTURES.berth.footprint;
  if (raw['footprint'][0] !== fw || raw['footprint'][1] !== fh || raw['drawScale'] !== 1) return null;
  const { horizontalPivot, sourceCellBottom } = raw;
  if (typeof horizontalPivot !== 'number' || !Number.isInteger(horizontalPivot) || horizontalPivot <= 0 || horizontalPivot > raw['cell'][0]) return null;
  if (sourceCellBottom !== raw['cell'][1]) return null;
  return { horizontalPivot, sourceCellBottom, attachment: pairOf(raw['attachment']) };
}

/** A vehicle geometry record authored against `berthRef`, dock translation stated twice. */
function fleetVehicleGeometry(raw: unknown, berthRef: string, berth: FleetBerthGeometry): FleetVehicleGeometry | null {
  if (!isRecord(raw) || !isIntPair(raw['cell']) || !isIntPair(raw['contactPx']) || !isIntPair(raw['dockOffsetPx'])) return null;
  if (raw['berthRef'] !== berthRef || raw['drawScale'] !== 1 || raw['sourceCellBottom'] !== raw['cell'][1]) return null;
  const contactPx = pairOf(raw['contactPx']), dockOffsetPx = pairOf(raw['dockOffsetPx']);
  if (berth.attachment[0] - contactPx[0] !== dockOffsetPx[0] || berth.attachment[1] - contactPx[1] !== dockOffsetPx[1]) return null;
  return { contactPx, dockOffsetPx };
}

/** One drawn cell: the clip's first packed frame, anchored exactly as authored. */
function fleetCell(raw: unknown, atlas: FleetAtlas, group: string, anchorPx: [number, number]): FleetCell | null {
  if (!isRecord(raw) || raw['atlas'] !== undefined && raw['atlas'] !== group) return null;
  const { cellW, cellH, frames } = raw;
  if (typeof cellW !== 'number' || typeof cellH !== 'number' || !isIntPair(raw['anchorPx'])) return null;
  if (raw['anchorPx'][0] !== anchorPx[0] || raw['anchorPx'][1] !== anchorPx[1]) return null;
  if (!Array.isArray(frames) || frames.length === 0 || !isRecord(frames[0]) || typeof frames[0]['key'] !== 'string') return null;
  const frame = frames[0]['key'];
  const packed = atlas.frames.get(frame);
  if (!packed || packed.w !== cellW || packed.h !== cellH) return null;
  return { atlas: group, cellW, cellH, anchorPx: pairOf(anchorPx), frame };
}

/** One read per file: the JSON bytes that are parsed into the retained frame
 *  map are the SAME bytes the fingerprint digests, and the PNG bytes the deed
 *  crops from are the same bytes it digests. A concurrent file replacement can
 *  therefore never pair one file's rectangles with another's digest. */
function loadFleetAtlas(dir: string, name: string): FleetAtlas {
  const jsonBytes = readFileSync(path.join(dir, `${name}@1x.json`));
  const json = JSON.parse(jsonBytes.toString('utf8')) as {
    textures: Array<{ frames: Array<{ filename: string; frame: AtlasFrame }> }>;
  };
  const frames = new Map<string, AtlasFrame>();
  for (const f of json.textures[0]?.frames ?? []) frames.set(f.filename, f.frame);
  const image = readFileSync(path.join(dir, `${name}@1x.png`));
  return { image, frames, pngSha256: createHash('sha256').update(image).digest('hex'), jsonSha256: createHash('sha256').update(jsonBytes).digest('hex') };
}

/** The retained fleet working set for the generated-output directory, or null
 *  (re-checked while null, Market rule). ALL-OR-NOTHING over every cell the
 *  deed can draw: a half-admitted set would paint one berth's family and omit
 *  its neighbour under the same fingerprint. */
function fleetArt(): FleetArtSet | null {
  const repoRoot = process.env['REPO_ROOT'] ?? path.resolve(process.cwd(), '..', '..');
  const dir = path.join(repoRoot, 'apps', 'web', 'public', 'atlas');
  if (fleetArtSet && fleetArtSet.dir === dir) return fleetArtSet.set;
  const refuse = (reason: string): null => {
    if (!warnedFleetMissing) {
      console.log(`[base-render] Phase E fleet art under ${dir} is unavailable (${reason}); deed images of bases with a presented berth are unavailable until \`pnpm assets\` completes`);
      warnedFleetMissing = true;
    }
    return null;
  };
  const missing = FLEET_RENDER_GROUPS.filter((g) => !existsSync(path.join(dir, `${g}@1x.png`)) || !existsSync(path.join(dir, `${g}@1x.json`)));
  if (!existsSync(path.join(dir, 'meta.json'))) missing.push('meta.json');
  if (missing.length > 0) return refuse(`${missing.join(', ')} missing`);
  const metaJson = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')) as {
    peStarterFleet?: unknown; peClips?: unknown; peAdvancedFleet?: unknown;
  };
  const groups = new Map<string, FleetAtlas>(FLEET_RENDER_GROUPS.map((g) => [g, loadFleetAtlas(dir, g)]));
  const cells = new Map<string, FleetCell>();
  const berthGeometry = new Map<string, FleetBerthGeometry>();
  const vehicleGeometry = new Map<string, FleetVehicleGeometry>();
  // Starter (P4 tables): identity + geometry on peStarterFleet, cells on peClips.
  const starter = metaJson.peStarterFleet, clips = metaJson.peClips;
  if (!isRecord(starter) || starter['schemaVersion'] !== 1 || starter['atlas'] !== STARTER_FLEET_GROUP
    || starter['sourceScale'] !== 1 || starter['keyIndexBase'] !== 1 || !isRecord(clips)) return refuse('peStarterFleet/peClips are missing or foreign');
  for (const key of ['bindingSha256', 'sourceManifestSha256', 'sourceIndexSha256', 'sourceTracksSha256']) {
    if (!isHex64(starter[key])) return refuse(`peStarterFleet.${key} is not a digest`);
  }
  const starterGeometry = isRecord(starter['geometry']) ? starter['geometry'] : null;
  const starterBerth = starterGeometry ? fleetBerthGeometry(starterGeometry['berth']) : null;
  const starterVehicle = starterGeometry && starterBerth ? fleetVehicleGeometry(starterGeometry['starter'], 'starter-berth', starterBerth) : null;
  if (!starterBerth || !starterVehicle) return refuse('peStarterFleet geometry is defective');
  const starterAtlas = groups.get(STARTER_FLEET_GROUP)!;
  const starterIntact = fleetCell(clips['pe_berth_starter_intact'], starterAtlas, STARTER_FLEET_GROUP, [starterBerth.horizontalPivot, starterBerth.sourceCellBottom]);
  const starterDocked = fleetCell(clips['pe_veh_starter_docked'], starterAtlas, STARTER_FLEET_GROUP, starterVehicle.contactPx);
  if (!starterIntact || !starterDocked) return refuse('starter berth/vehicle cells are defective');
  cells.set('pe_berth_starter_intact', starterIntact); cells.set('pe_veh_starter_docked', starterDocked);
  berthGeometry.set('starter', starterBerth); vehicleGeometry.set('starter', starterVehicle);
  // Advanced (D237 table): per-clip geometry, bindings keyed by group.
  const advanced = metaJson.peAdvancedFleet;
  if (!isRecord(advanced) || advanced['schemaVersion'] !== 1 || advanced['sourceScale'] !== 1 || advanced['keyIndexBase'] !== 1
    || !isRecord(advanced['clips']) || !isRecord(advanced['bindings']) || !Array.isArray(advanced['atlases'])) return refuse('peAdvancedFleet is missing or foreign');
  for (const key of ['sourceManifestSha256', 'sourceTracksSha256', 'sourceIndexSha256', 'provenanceSha256']) {
    if (!isHex64(advanced[key])) return refuse(`peAdvancedFleet.${key} is not a digest`);
  }
  const advancedGroups = FLEET_RENDER_GROUPS.filter((g) => g !== STARTER_FLEET_GROUP);
  const atlasesListed = new Set(advanced['atlases'].filter((g): g is string => typeof g === 'string'));
  if (atlasesListed.size !== advancedGroups.length || !advancedGroups.every((g) => atlasesListed.has(g))) return refuse('peAdvancedFleet.atlases are not the twenty groups');
  const bindingSha = new Map<string, string>();
  for (const group of advancedGroups) {
    const binding = advanced['bindings'][group];
    if (!isRecord(binding) || !isHex64(binding['sha256']) || !isRecord(binding['value'])) return refuse(`binding ${group} is missing`);
    // The exporter's binding digest is the digest of its value: a hand-edited
    // value under an old digest is refused, never admitted under that name.
    if (createHash('sha256').update(JSON.stringify(binding['value'])).digest('hex') !== binding['sha256']) return refuse(`binding ${group} does not match its value`);
    bindingSha.set(group, binding['sha256']);
  }
  const advancedClips = advanced['clips'];
  for (const family of FLEET_FAMILIES) {
    const berthGroup = `pe_berth_${family}`;
    const intactRaw = advancedClips[`${berthGroup}_intact`];
    const geometry = isRecord(intactRaw) ? fleetBerthGeometry(intactRaw['geometry']) : null;
    if (!geometry) return refuse(`${berthGroup} geometry is defective`);
    const intact = fleetCell(intactRaw, groups.get(berthGroup)!, berthGroup, [geometry.horizontalPivot, geometry.sourceCellBottom]);
    if (!intact) return refuse(`${berthGroup}_intact is defective`);
    cells.set(`${berthGroup}_intact`, intact); berthGeometry.set(family, geometry);
    for (const tier of FLEET_TIERS) {
      const vehicleGroup = `pe_veh_${family}_t${tier}`;
      let vehicle: FleetVehicleGeometry | null = null;
      for (const state of ['docked', 'exhausted'] as const) {
        const raw = advancedClips[`${vehicleGroup}_${state}`];
        const g = isRecord(raw) ? fleetVehicleGeometry(raw['geometry'], `${family.replaceAll('_', '-')}-berth`, geometry) : null;
        if (!g || (vehicle && (vehicle.contactPx[0] !== g.contactPx[0] || vehicle.contactPx[1] !== g.contactPx[1]
          || vehicle.dockOffsetPx[0] !== g.dockOffsetPx[0] || vehicle.dockOffsetPx[1] !== g.dockOffsetPx[1]))) return refuse(`${vehicleGroup}_${state} geometry is defective`);
        vehicle = g;
        const cell = fleetCell(raw, groups.get(vehicleGroup)!, vehicleGroup, g.contactPx);
        if (!cell) return refuse(`${vehicleGroup}_${state} is defective`);
        cells.set(`${vehicleGroup}_${state}`, cell);
      }
      vehicleGeometry.set(`${family}:${tier}`, vehicle!);
    }
  }
  // The admitted placement tables are part of the working set: two sidecars
  // carrying the same digest strings but different geometry/anchors must never
  // share a fingerprint (review S2).
  const tables = createHash('sha256').update(JSON.stringify({
    cells: [...cells.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, c]) => [id, c.atlas, c.cellW, c.cellH, c.anchorPx, c.frame]),
    berths: [...berthGeometry.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, g]) => [id, g.horizontalPivot, g.sourceCellBottom, g.attachment]),
    vehicles: [...vehicleGeometry.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, g]) => [id, g.contactPx, g.dockOffsetPx]),
  })).digest('hex');
  const fingerprint = createHash('sha256').update(JSON.stringify({
    version: 1,
    tables,
    starter: {
      atlas: STARTER_FLEET_GROUP, pngSha256: starterAtlas.pngSha256, jsonSha256: starterAtlas.jsonSha256,
      bindingSha256: starter['bindingSha256'], sourceManifestSha256: starter['sourceManifestSha256'],
      sourceIndexSha256: starter['sourceIndexSha256'], sourceTracksSha256: starter['sourceTracksSha256'],
    },
    advanced: {
      sourceManifestSha256: advanced['sourceManifestSha256'], sourceTracksSha256: advanced['sourceTracksSha256'],
      sourceIndexSha256: advanced['sourceIndexSha256'], provenanceSha256: advanced['provenanceSha256'],
      groups: [...advancedGroups].sort().map((group) => ({
        group, pngSha256: groups.get(group)!.pngSha256, jsonSha256: groups.get(group)!.jsonSha256, bindingSha256: bindingSha.get(group),
      })),
    },
  })).digest('hex');
  const set: FleetArtSet = { dir, fingerprint, groups, cells, berthGeometry, vehicleGeometry };
  fleetArtSet = { dir, set };
  return set;
}

/** The fingerprint of the exact retained fleet working set the painter will
 *  compose from (null while nothing is admitted). A caller captures a deed
 *  packet against this value; the painter refuses a packet naming any other. */
export function baseRenderFleetArtFingerprint(): string | null {
  return fleetArt()?.fingerprint ?? null;
}

type FleetInstallation = CapturedDeedDrawing['advancedServicePresentation']['berths'][number]['installation']
  | CapturedDeedDrawing['servicePresentation']['berths'][number]['installation'];

/** The cells a presented berth draws: its family's intact berth and, for an
 *  occupied/exhausted installation, the vehicle still at the ONE authored dock
 *  translation (origin-to-origin = −pivot + dock + contact, the web's rule),
 *  scaled to this renderer's density. Null when the admitted set lacks a cell. */
function fleetPlacement(fleet: FleetArtSet, installation: NonNullable<FleetInstallation>): {
  berth: FleetCell; vehicle: { cell: FleetCell; originDx: number; originDy: number } | null;
} | null {
  const family = installation.family;
  const berthKey = family === 'starter' ? 'pe_berth_starter_intact' : `pe_berth_${family}_intact`;
  const berth = fleet.cells.get(berthKey);
  const geometry = fleet.berthGeometry.get(family);
  if (!berth || !geometry) return null;
  if (installation.presence === 'away') return { berth, vehicle: null };
  const vehicleKey = family === 'starter'
    ? 'pe_veh_starter_docked'
    : `pe_veh_${family}_t${installation.tier}_${installation.presence === 'exhausted' ? 'exhausted' : 'docked'}`;
  const cell = fleet.cells.get(vehicleKey);
  const vehicle = fleet.vehicleGeometry.get(family === 'starter' ? 'starter' : `${family}:${installation.tier}`);
  if (!cell || !vehicle) return null;
  return {
    berth,
    vehicle: {
      cell,
      originDx: (-geometry.horizontalPivot + vehicle.dockOffsetPx[0] + vehicle.contactPx[0]) * MARKET_DEED_SCALE,
      originDy: (-geometry.sourceCellBottom + vehicle.dockOffsetPx[1] + vehicle.contactPx[1]) * MARKET_DEED_SCALE,
    },
  };
}

/** Ordinary Workshop/Lodge idle cell for a completed OR constructing row (D4:
 *  construction keeps the tier body, exactly as the Market deed does). The tier
 *  rule is the Market's (four visual tiers over twenty levels). */
function serviceKeyFor(type: 'workshop' | 'lodge', level: number): string {
  return `pe_${type}_t${marketDeedTier(level, type)}_idle_f1`;
}

function marketArt(): MarketArtSet | null {
  if (marketArtSet) return marketArtSet;
  const repoRoot = process.env['REPO_ROOT'] ?? path.resolve(process.cwd(), '..', '..');
  const dir = path.join(repoRoot, 'apps', 'web', 'public', 'atlas');
  // Stat only while unavailable (atlases() precedent): root's per-request
  // readiness hook must not parse meta.json on every call on an art-less host.
  const missing = MARKET_RENDER_GROUPS.filter((g) => !existsSync(path.join(dir, `${g}@1x.png`)));
  if (!existsSync(path.join(dir, 'meta.json'))) missing.push('meta.json' as never);
  if (missing.length > 0) {
    if (!warnedMarketMissing) {
      console.log(`[base-render] Phase E Market art ${missing.join(', ')} not found under ${dir} — run \`pnpm assets\`; deed images of bases with a Market are unavailable until it appears`);
      warnedMarketMissing = true;
    }
    marketArtSet = null;
    return null;
  }
  const metaJson = existsSync(path.join(dir, 'meta.json'))
    ? JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')) as {
      peMarket?: { clips?: Record<string, MarketClipMeta> };
      peCosmetics?: {
        clips?: Record<string, MarketClipMeta>;
        bindings?: Record<string, { sha256: string; value: { sourceManifestSha256: string; sourceIndexSha256: string } }>;
      };
    }
    : undefined;
  if (!metaJson?.peMarket?.clips || !metaJson.peCosmetics?.clips || !metaJson.peCosmetics.bindings) {
    if (!warnedMarketMissing) {
      console.log(`[base-render] Phase E Market metadata (peMarket/peCosmetics) is missing from ${dir}/meta.json — run \`pnpm assets\`; deed images of bases with a Market are unavailable until it appears`);
      warnedMarketMissing = true;
    }
    marketArtSet = null;
    return null;
  }
  const set: MarketArtSet = {
    groups: new Map(MARKET_RENDER_GROUPS.map((g) => [g, loadAtlas(dir, g)])),
    clips: new Map([...Object.entries(metaJson.peMarket.clips), ...Object.entries(metaJson.peCosmetics.clips)]),
    bindings: new Map(Object.entries(metaJson.peCosmetics.bindings).map(([outputId, b]) => [outputId, {
      sha256: b.sha256, sourceManifestSha256: b.value.sourceManifestSha256, sourceIndexSha256: b.value.sourceIndexSha256,
    }])),
  };
  // Validated-art admission: every tier's ordinary and Awning bodies (the
  // cells a base, a raid and a deed can show) are packed under their published
  // group with a full-cell anchor, and each Awning has its generated binding.
  // Anything less is unavailable as a whole — a half-admitted catalogue would
  // let one tier apply while its sibling could not be drawn.
  const admitted = [1, 2, 3, 4].every((tier) => {
    const bodies = ['idle', 'damaged', 'destroyed'];
    const ordinary = bodies.every((state) => set.groups.get(`pe_market_t${tier}`)?.frames.has(`pe_market_t${tier}_${state}_f1`)
      && marketSeatOf(set, `pe_market_t${tier}_${state}_f1`));
    const awning = bodies.every((state) => set.groups.get('pe_cosmetics')?.frames.has(`pe_cos_market_t${tier}_${state}_f1`)
      && marketSeatOf(set, `pe_cos_market_t${tier}_${state}_f1`));
    const binding = set.bindings.get(`artisan_market_awning_t${tier}`);
    return ordinary && awning && !!binding && /^[0-9a-f]{64}$/.test(binding.sha256)
      && /^[0-9a-f]{64}$/.test(binding.sourceManifestSha256) && /^[0-9a-f]{64}$/.test(binding.sourceIndexSha256);
  });
  if (!admitted) {
    if (!warnedMarketMissing) {
      console.log(`[base-render] Phase E Market art under ${dir} is incomplete (a tier body or Awning binding is missing); deed images of bases with a Market are unavailable until \`pnpm assets\` regenerates it`);
      warnedMarketMissing = true;
    }
    marketArtSet = null;
    return null;
  }
  marketArtSet = set;
  return marketArtSet;
}

/**
 * Application readiness for the four Awnings and the ordinary Market bodies:
 * true only when this process can draw every tier's ordinary and Awning cells
 * and holds each Awning's generated binding (the same validated set the deed
 * renders from). Re-checked while false, so `pnpm assets` recovers without a
 * restart. Root's public Workshop admission reuses this instead of a second
 * filesystem validator.
 */
export function baseRenderMarketArtAvailable(): boolean {
  return marketArt() !== null;
}

/** The generated binding hashes this process admits for one Market Awning, or
 *  null when the validated set is unavailable or the id is not one of the four
 *  Awnings this renderer draws — the exact values a supplied appearance must
 *  carry for the deed to draw it. Aurora (the wake) has no delivered consumer
 *  here and is never reported as admitted by this seam. */
export function baseRenderAwningBinding(
  outputId: string,
): { sha256: string; sourceManifestSha256: string; sourceIndexSha256: string } | null {
  if (!/^artisan_market_awning_t[1-4]$/.test(outputId)) return null;
  const binding = marketArt()?.bindings.get(outputId);
  return binding ? { ...binding } : null;
}

/** Market visual tier from the completed level via the ONE shared boundary
 *  rule (apps/web marketArt.ts#marketArtTierOfLevel mirrors this exactly). */
function marketDeedTier(level: number, family: 'market' | 'workshop' | 'lodge' = 'market'): number {
  // Mirrors apps/web marketArtTierOfLevel: the family cap is honoured up to the Market's.
  const clamped = Math.min(STRUCTURES[family].maxLevel, STRUCTURES.market.maxLevel, Math.max(1, Math.floor(level)));
  return Number(/_t([1-4])$/.exec(boundCosmeticAwningForCompletedLevel(clamped))![1]);
}

/**
 * Per-Market Awning choice from the projection actually supplied (frozen fifth
 * argument) or read for the current base. Legacy absence and a verified empty
 * visual draw ordinary art. An unavailable, mismatched, unknown-binding or
 * wrong-hash projection is REFUSED whole (null): the deed must never publish an
 * image asserted to be the applied appearance, nor a falsely plain one.
 */
function selectDeedAwnings(
  art: MarketArtSet,
  read: BoundCosmeticBaseRead | undefined,
  markets: ReadonlyArray<{ id: string; type: string; level: number; underConstruction: boolean }>,
): Map<string, string> | null {
  const awnings = new Map<string, string>();
  if (read === undefined) return awnings;
  let matched: BoundCosmeticBaseRead | undefined;
  try {
    matched = matchBoundCosmeticBaseRead(read, markets);
  } catch {
    return null;
  }
  if (!matched || matched.state !== 'available') return null;
  for (const entry of matched.visual.marketAwnings) {
    const { appearance } = entry;
    const binding = art.bindings.get(appearance.outputId);
    if (!binding
      || binding.sha256 !== appearance.bindingSha256
      || binding.sourceManifestSha256 !== appearance.sourceManifestSha256
      || binding.sourceIndexSha256 !== appearance.sourceIndexSha256) return null;
    awnings.set(entry.buildingId, appearance.outputId);
  }
  return awnings;
}

/** The current base's projection through root's reader; a wallet-scoped
 *  legacy caller resolves its single active base first. `undefined` = legacy
 *  absence (no base to ask), which draws ordinary art. */
async function currentBoundCosmetics(
  db: DbOrTx, wallet: string, baseId: string | undefined,
): Promise<BoundCosmeticBaseRead | undefined> {
  let target = baseId;
  if (!target) {
    const owned = await db.select({ id: bases.id }).from(bases)
      .where(and(eq(bases.ownerWallet, wallet), eq(bases.status, 'active'))).limit(2);
    if (owned.length === 0) return undefined; // no base to ask: legacy absence
    if (owned.length > 1) return { state: 'unavailable', visual: null }; // ambiguous: refuse, never guess
    target = owned[0]!.id;
  }
  return readBoundCosmeticBase(db, target, wallet);
}

/** Server mirror of apps/web marketArt.ts#marketSeat: the full-cell anchor
 *  fraction of a Market/Awning frame key, null for every other key. */
function marketSeatOf(art: MarketArtSet | null, key: string): { anchor: [number, number] } | null {
  const m = /^(pe_(?:cos_market|market|workshop|lodge)_t[1-4]_[a-z]+)_f\d+$/.exec(key);
  const clip = m && art ? art.clips.get(m[1]!) : undefined;
  if (!clip?.anchorPx) return null;
  return { anchor: [clip.anchorPx[0] / clip.cellW, clip.anchorPx[1] / clip.cellH] };
}

/** Mirror of BaseScene.spriteKeyFor, minus skins (the skin atlas is not loaded
 *  here — a skinned keep renders as its stone tier; noted, not hidden). */
function spriteKeyFor(
  type: string,
  level: number,
  trapSpentAt?: Date | null,
): string {
  if ((TRAP_TYPES as readonly string[]).includes(type)) {
    return trapSpentAt
      ? wareTrapStateAliasKey(type as TrapType, level, 'spent')
      : `bld_${type}_l${Math.min(20, level)}`;
  }
  // Hero altars ship ONE un-leveled master each (hero levels live on the hero).
  if (type === 'heroaltar' || type === 'siegestool') return `bld_${type}`;
  // Rework-v2 cannon/mortar (Phase D): the v2 idle master at the level's art
  // tier — the SAME shared tier map the web client keys by, so the deed and
  // the base can never show different towers. No loaded-gate mirror needed
  // here: the v2bld groups are in RENDER_GROUPS' all-or-nothing set.
  if ((ART_V2.units as readonly string[]).includes(type) && (type === 'cannon' || type === 'mortar')) {
    return `v2_bld_${type}_t${artTierOfLevel(level)}_idle_d0_f1`;
  }
  return `bld_${type}_l${Math.min(20, level)}`;
}

/** Mirror of apps/web marketArt.ts#marketRestFrameKey: the selected family's
 *  resting cell — the applied Awning's, else the ordinary tier's. */
function marketKeyFor(level: number, awningOutputId: string | undefined): string {
  const tier = marketDeedTier(level);
  return awningOutputId ? `pe_cos_market_t${tier}_idle_f1` : `pe_market_t${tier}_idle_f1`;
}

/** The reference App's obstacle keys that differ from asset names (BaseScene). */
const OBS_FIX: Record<string, string> = { pine1: 'pine_1', pine2: 'pine_2' };

/** Any v2 building frame key → the unit's published world fit, or null for
 *  every other key (whose fit already rides meta.sprites `sourceScale`). */
function v2SourceScaleOf(key: string): number | null {
  const unit = /^v2_bld_([a-z]+)_t\d+_[a-z]+(?:_d\d+)?_f\d+$/.exec(key)?.[1];
  if (!unit) return null;
  const fit: Record<string, number> = ART_V2.buildingSourceScale;
  return fit[unit] ?? null;
}

/**
 * Server mirror of apps/web `game/v2/clips.ts#v2BldSeat` — the anchor FRACTIONS
 * for a v2 building key, null for every other key. The ART_V2 comment in shared
 * constants is the contract: the deed and the base must show the same tower in
 * the same place.
 *
 * The ×2 half of the web scale has NO counterpart here: the web world is @2x
 * (64 world px per tile) while this renderer's TILE is 32 — 1× game px, which
 * is exactly what the v2 pack is authored at ("2x2 footprint = 64px of
 * ground"). The unit's published world FIT does apply on both sides, and
 * `v2SourceScaleOf` below is where this renderer reads it.
 */
function v2SeatOf(at: AtlasSet, key: string): { anchor: [number, number] } | null {
  const m = /^(v2_bld_[a-z]+_t\d+_[a-z]+)(?:_d\d+)?_f\d+$/.exec(key);
  if (!m) return null;
  const clip = at.v2Clips.get(m[1]!);
  if (!clip?.anchorPx) return null;
  return { anchor: [clip.anchorPx[0] / clip.cellW, clip.anchorPx[1] / clip.cellH] };
}

/**
 * Render one player's base to a PNG buffer. Null when the atlases are absent
 * or the player has no base. The frame covers the CLAIM plus a margin — the
 * deed depicts the land the deed conveys, not the whole 30×30 plot.
 */
export async function renderBasePng(
  db: DbOrTx, wallet: string, baseId?: string, frozenVisualContext?: BaseVisualContext,
  frozenBoundCosmetics?: BoundCosmeticBaseRead, capturedDeed?: CapturedDeedDrawing | null,
): Promise<Buffer | null> {
  return withRenderPermit(() => paintBasePng(db, wallet, baseId, frozenVisualContext, frozenBoundCosmetics, capturedDeed));
}
/**
 * `frozenBoundCosmetics` (C3): the exact Awning projection to draw — a raid's
 * frozen capture, or whatever the caller hashed. When supplied it is used as-is
 * and today's preference is never re-read. Absent = the current base's read.
 * A base WITH a completed Market whose projection is unavailable/refused, or
 * whose Market art is not generated, returns null (image unavailable) rather
 * than a picture that asserts an appearance nobody verified.
 */
/**
 * `capturedDeed` (P6b): the sixth argument's three states are deliberate —
 *  - object: an immutable captured drawing (deedFleetCapture.ts). The packet is
 *    the ONLY input for expansions, geometry, obstacles, context, Market
 *    appearance and both fleet siblings; nothing is re-read. Before drawing the
 *    painter requires a top-level database (a transactional handle is a caller
 *    error and throws), the packet's identity to equal the wallet/base it is
 *    asked to paint, that identity to still be persisted (never an owner or
 *    base switch), and the admitted fleet fingerprint to equal this process's
 *    retained working set; any refusal is null, never a substituted picture.
 *  - null: the caller observed no berth. After the ordinary rows are read, ANY
 *    berth row returns null before drawing — the fleet set is never consulted —
 *    so a berth placed after that observation cannot be painted uncaptured.
 *  - undefined: untouched compatibility for every existing direct caller.
 */
async function paintBasePng(
  db: DbOrTx, wallet: string, baseId?: string, frozenVisualContext?: BaseVisualContext,
  frozenBoundCosmetics?: BoundCosmeticBaseRead, capturedDeed?: CapturedDeedDrawing | null,
): Promise<Buffer | null> {
  // The packet gate runs FIRST (review S1): a caller error must be loud even
  // while the ordinary atlases are absent, and a refused packet never falls
  // through to any other read.
  let fleet: FleetArtSet | null = null;
  let packet: CapturedDeedDrawing | null = null;
  if (capturedDeed) {
    if ('rollback' in db) throw new Error('Deed packet painting requires a top-level database');
    if (!baseId || capturedDeed.identity.wallet !== wallet || capturedDeed.identity.baseId !== baseId) return null;
    if (!(await deedDrawingIdentityCurrent(db as Db, capturedDeed))) return null;
    fleet = fleetArt();
    if (!fleet || fleet.fingerprint !== capturedDeed.admittedArtFingerprint) return null;
    packet = capturedDeed;
  }
  const at = atlases();
  if (!at) return null;
  let expansions: number;
  if (packet) {
    expansions = packet.expansions;
  } else {
    const [p] = baseId
      ? await db.select({ expansions: bases.expansions }).from(bases)
        .where(and(eq(bases.id, baseId), eq(bases.ownerWallet, wallet)))
      : await db.select({ expansions: players.expansions })
        .from(players).where(eq(players.wallet, wallet));
    if (!p) return null;
    expansions = p.expansions;
  }
  const visualContext = packet
    ? resolveBaseVisualContext(packet.visualContext)
    : frozenVisualContext ? resolveBaseVisualContext(frozenVisualContext) : await resolveBaseVisual(db, baseId);
  const buildingScope = baseId ? eq(buildings.baseId, baseId) : eq(buildings.playerWallet, wallet);
  const obstacleScope = baseId ? eq(obstacles.baseId, baseId) : eq(obstacles.playerWallet, wallet);
  const rows: Array<{ id: string; type: string; level: number; tx: number; ty: number; trapSpentAt: Date | null }> = packet
    ? packet.buildings.map((b) => ({ id: b.id, type: b.type, level: b.level, tx: b.tx, ty: b.ty, trapSpentAt: b.trapSpentAt === null ? null : new Date(b.trapSpentAt) }))
    : await db.select({
      id: buildings.id,
      type: buildings.type,
      level: buildings.level,
      tx: buildings.tx,
      ty: buildings.ty,
      trapSpentAt: buildings.trapSpentAt,
    })
      .from(buildings).where(buildingScope);
  // The no-berth sentinel: an uncaptured berth is refused, never painted.
  if (capturedDeed === null && rows.some((b) => b.type === 'berth')) return null;
  const obs: Array<{ spriteKey: string; tx: number; ty: number }> = packet
    ? packet.obstacles.map((o) => ({ spriteKey: o.spriteKey, tx: o.tx, ty: o.ty }))
    : await db.select({ spriteKey: obstacles.spriteKey, tx: obstacles.tx, ty: obstacles.ty })
      .from(obstacles).where(and(obstacleScope, isNull(obstacles.clearedAt)));
  // E-11: on revision-5 ground the standing rows draw the kit's own prop family,
  // exactly as BaseScene.styleObstacle re-keys them — `obstacleSprites` names the
  // sheet whose still seats bottom-centre on the `dec_` footprint; a key the
  // manifest leaves unmapped keeps the frozen `dec_` master (O-7). The SAME
  // admitted working set the ground paints from, so the deed and the base can
  // never show different trees on one plot.
  const kit = isRealmKitBaseVisualContext(visualContext) ? await layeredSource(visualContext) : undefined;
  if (kit && kit.kind !== 'realm-kit') throw new Error('Realm kit context resolved a painting working set');

  // Phase E Market (C3): decide each Market's family before anything is keyed.
  // A base without a Market touches none of this (same query set, same hash
  // inputs as before); one with a Market needs its art and its projection.
  const marketRows = rows.filter((b) => b.type === 'market');
  const awningByMarket = new Map<string, string>();
  let market: MarketArtSet | null = null;
  if (marketRows.length > 0) {
    market = marketArt();
    if (!market) return null;
    const pendingBuild = packet
      ? new Set(packet.buildings.filter((b) => b.underConstruction).map((b) => b.id))
      : new Set((await db.select({ buildingId: builderJobs.buildingId }).from(builderJobs)
        .where(and(
          eq(builderJobs.playerWallet, wallet),
          baseId ? eq(builderJobs.baseId, baseId) : undefined,
          eq(builderJobs.kind, 'build'), isNull(builderJobs.completedAt),
        ))).map((job) => job.buildingId));
    const markets = marketRows.map((b) => ({
      id: b.id, type: b.type, level: b.level, underConstruction: pendingBuild.has(b.id),
    }));
    // The packet's projection is deeply frozen; the selector only reads it.
    const read: BoundCosmeticBaseRead | undefined = packet
      ? packet.boundCosmetics as BoundCosmeticBaseRead
      : frozenBoundCosmetics ?? await currentBoundCosmetics(db, wallet, baseId);
    const selected = selectDeedAwnings(market, read, markets);
    if (!selected) {
      if (!warnedCosmeticRefused) {
        console.log('[base-render] Market Awning projection unavailable or refused; deed images of that base stay at their last published picture');
        warnedCosmeticRefused = true;
      }
      return null;
    }
    selected.forEach((outputId, id) => awningByMarket.set(id, outputId));
    // Every Market body must resolve to a packed frame, or the deed would show
    // a base with no Market on it and report nothing.
    for (const b of marketRows) {
      const key = marketKeyFor(b.level, awningByMarket.get(b.id));
      if (!market.groups.get(atlasGroupFor(key))?.frames.has(key) || !marketSeatOf(market, key)) return null;
    }
  }

  // Phase E Workshop/Lodge (P5): a base with either family needs the validated
  // service set; every body must resolve to a packed cell or the deed would show
  // a base with no Workshop/Lodge on it and report nothing (Market rule).
  const serviceRows = rows.filter((b): b is typeof b & { type: 'workshop' | 'lodge' } => b.type === 'workshop' || b.type === 'lodge');
  let service: MarketArtSet | null = null;
  if (serviceRows.length > 0) {
    service = serviceArt();
    if (!service) return null;
    for (const b of serviceRows) {
      const key = serviceKeyFor(b.type, b.level);
      if (!service.groups.get(atlasGroupFor(key))?.frames.has(key) || !marketSeatOf(service, key)) return null;
    }
  }

  // Phase E fleet berths (P6b, packet branch only): the packet's siblings name
  // each berth's installation (the capture refused conflicting pairs). A berth
  // with none, under construction or below level 1 draws nothing — the deed's
  // existing omission is the web's hidden-footprint policy, never vacancy art.
  const fleetByBerth = new Map<string, NonNullable<ReturnType<typeof fleetPlacement>>>();
  if (packet && fleet) {
    for (const b of packet.buildings) {
      if (b.type !== 'berth' || b.underConstruction || b.level < 1) continue;
      const installation: FleetInstallation = packet.advancedServicePresentation.berths.find((entry) => entry.buildingId === b.id)?.installation
        ?? packet.servicePresentation.berths.find((entry) => entry.buildingId === b.id)?.installation ?? null;
      if (!installation) continue;
      const placement = fleetPlacement(fleet, installation);
      // An admitted set carries every cell; a gap here is a defect, not a blank berth.
      if (!placement) return null;
      fleetByBerth.set(b.id, placement);
    }
  }

  const claim = claimRect(expansions);
  const side = claim.max - claim.min + 2 * MARGIN_TILES;
  const size = side * TILE;
  const ox = (claim.min - MARGIN_TILES) * TILE; // world-px origin of the frame
  const oy = ox;

  // The render-only compositor is shared with Phaser, including diagonal fill,
  // mixed-tier height shoulders and global material phase. Gameplay stays 1×1.
  const wallGrid: WallGrid = new Map(rows.filter((b) => b.type === 'wall')
    .map((b) => [`${b.tx},${b.ty}`, { tier: wallTierOfLevel(b.level) }]));
  const wallField = buildField(wallGrid);

  type Placed = {
    key: string; tx: number; ty: number; fw: number; fh: number;
    kind: StructureDepthKind;
    /** E-11 kit sprite of an obstacle row (the seated prop's still, else the tier
     * twin): drawn instead of `key`, never beside it. */
    kit?: { asset: LayeredAsset; frame: number; pixels: LayeredPixels };
    /** P6b fleet cell: its own anchor and, for a vehicle, the origin-to-origin
     * offset from the berth's seat (already at this renderer's density). */
    fleet?: { anchor: [number, number]; originDx: number; originDy: number };
  };
  const placed: Placed[] = [];
  for (const b of rows) {
    const presented = b.type === 'berth' ? fleetByBerth.get(b.id) : undefined;
    if (presented) {
      const { fw, fh } = footprintOf(b.type as BuildingType);
      const berthCell = presented.berth;
      placed.push({ key: berthCell.frame, tx: b.tx, ty: b.ty, fw, fh, kind: 'building',
        fleet: { anchor: [berthCell.anchorPx[0] / berthCell.cellW, berthCell.anchorPx[1] / berthCell.cellH], originDx: 0, originDy: 0 } });
      if (presented.vehicle) {
        const { cell, originDx, originDy } = presented.vehicle;
        // Pushed right after its berth: equal depth keys keep insertion order.
        placed.push({ key: cell.frame, tx: b.tx, ty: b.ty, fw, fh, kind: 'building',
          fleet: { anchor: [cell.anchorPx[0] / cell.cellW, cell.anchorPx[1] / cell.cellH], originDx, originDy } });
      }
      continue;
    }
    const key = b.type === 'wall' ? ''
      : b.type === 'market' && market ? marketKeyFor(b.level, awningByMarket.get(b.id))
        : (b.type === 'workshop' || b.type === 'lodge') && service ? serviceKeyFor(b.type, b.level)
          : spriteKeyFor(b.type, b.level, b.trapSpentAt);
    // v2 and Phase E Market keys are absent from meta.sprites, and a pack's
    // visual footprint ([2,2] for both v2 units) is NOT the game footprint
    // (cannon stays 1×1 — locked owner decision) — the sim-derived table
    // answers for them.
    const fp: readonly [number, number] = key.startsWith('v2_') || key.startsWith('pe_')
      ? (({ fw, fh }) => [fw, fh] as const)(footprintOf(b.type as BuildingType))
      : at.meta.get(key)?.footprint ?? [1, 1];
    placed.push({
      key, tx: b.tx, ty: b.ty, fw: fp[0], fh: fp[1],
      kind: b.type === 'wall' ? 'wall' : 'building',
    });
  }
  for (const o of obs) {
    const key = `dec_${OBS_FIX[o.spriteKey] ?? o.spriteKey}`;
    // The tile footprint always comes from the `dec_` meta, whichever art draws
    // (BaseScene.styleObstacle): occupancy never changes with the kit.
    const fp = at.meta.get(key)?.footprint ?? [1, 1];
    // Obstacles inside the frame only — the treeline outside the claim is
    // scenery, not the deeded land.
    if (o.tx * TILE < ox || o.tx * TILE >= ox + size || o.ty * TILE < oy || o.ty * TILE >= oy + size) continue;
    // A row outside the server's eight keys keeps the scene's historical
    // fallback path rather than failing the whole picture. The deed shows the
    // intact still: a running clear job is transient and its row vanishes with it.
    // E-11 expansion obstacles: a row seated on a kit prop draws that prop's own
    // still (realmKitObstacleSpriteAt), so the deed shows the tree the player sees.
    const twin = kit && OBSTACLE_SPRITE_KEYS.includes(o.spriteKey as ObstacleSpriteKey)
      ? realmKitObstacleSpriteAt(kit.manifest, o.tx, o.ty, o.spriteKey, 'intact') : undefined;
    const sheet = twin && kit ? kit.pixels.get(twin.asset.id) : undefined;
    if (twin && !sheet) throw new Error('Deed realm kit sprite sheet is not decoded');
    placed.push({ key, tx: o.tx, ty: o.ty, fw: fp[0], fh: fp[1], kind: 'building',
      ...(twin && sheet ? { kit: { asset: twin.asset, frame: twin.frame, pixels: sheet } } : {}) });
  }
  // Painter's order mirrors both Phaser scenes: strictly southern walls may
  // overflow a building; northern/equal-edge walls stay behind it.
  placed.sort((a, b) =>
    baseRenderStructureDepth(a.kind, a.ty, a.fh)
      - baseRenderStructureDepth(b.kind, b.ty, b.fh));

  // Frame-crop cache: one extract per distinct frame per render. WHICH atlas a
  // key lives in comes from the shared grouping rule — never from its prefix,
  // which stopped being the answer when batch 13 moved `bld_archertower_l3` and
  // friends into `blddef`. Guessing wrong does not throw here: the sprite is
  // simply omitted, i.e. deed images of a base with no towers on it.
  const cut = new Map<string, { buf: Buffer; width: number; height: number }>();
  const cropOf = async (
    key: string,
  ): Promise<{ buf: Buffer; width: number; height: number } | null> => {
    const group = atlasGroupFor(key);
    const atlas = at.groups.get(group) ?? market?.groups.get(group) ?? service?.groups.get(group) ?? fleet?.groups.get(group);
    const fr = atlas?.frames.get(key);
    if (!atlas || !fr) return null; // missing art degrades to an omitted sprite, never a throw
    // Rework-v2 masters ship @1x ONLY, and they are authored at 32 GAME px per
    // tile ("2x2 footprint = 64px of ground") — which is exactly this renderer's
    // TILE. So they go down at NATIVE size, like every other @1x crop. (An
    // earlier halving here read the pack as 64px/tile: it drew the deed's cannon
    // at half the size the live base shows, the one thing the shared ART_V2
    // contract exists to prevent.) The web client scales v2 art ×2 instead,
    // because ITS world is @2x — see game/v2/clips.ts#V2_DRAW_SCALE.
    let crop = cut.get(key); // a key resolves to exactly one group, so it is the whole cache key
    if (!crop) {
      let buf = await sharp(atlas.image)
        .extract({ left: fr.x, top: fr.y, width: fr.w, height: fr.h })
        .png().toBuffer();
      // v2 keys are absent from meta.sprites, so their fit comes from the
      // shared v2 contract instead — the SAME number game/v2/clips.ts
      // #v2BldDrawScale multiplies into the web seat. Without this line the
      // deed would keep drawing the unfitted Cannon/Mortar the base stopped
      // showing, which is exactly the disagreement ART_V2 exists to prevent.
      // Phase E Market/Awning cells are authored at the web's 64 px tile: half
      // density here, the same cell the base draws at scale 1 (marketArt.ts).
      const sourceScale = at.meta.get(key)?.sourceScale ?? v2SourceScaleOf(key)
        ?? (key.startsWith('pe_') ? MARKET_DEED_SCALE : 1);
      const width = Math.max(1, Math.round(fr.w * sourceScale));
      const height = Math.max(1, Math.round(fr.h * sourceScale));
      if (width !== fr.w || height !== fr.h) {
        // Pixel masters must stay crisp: this is presentation fitting, never
        // filtered asset authoring. Nearest-neighbour also makes deed output
        // agree with Phaser's pixelArt world renderer at the same @1x scale.
        buf = await sharp(buf)
          .resize({ width, height, kernel: sharp.kernel.nearest })
          .png().toBuffer();
      }
      crop = { buf, width, height };
      cut.set(key, crop);
    }
    return crop;
  };
  // E-11 kit sprites: the sheet's still (the twin's frame 0, or the seated prop's
  // own cell) cut from the admitted RGBA working set at NATIVE size — the kit is
  // authored at this renderer's TILE (32 px/tile, RealmKitManifest.tilePixels), so
  // no fit applies; the web scales the same cell ×2 into its @2x world
  // (realmKitGround.ts#obstacleSprite).
  const kitCut = new Map<string, { buf: Buffer; width: number; height: number }>();
  const kitCropOf = async (
    asset: LayeredAsset, frame: number, pixels: LayeredPixels,
  ): Promise<{ buf: Buffer; width: number; height: number }> => {
    let crop = kitCut.get(`${asset.id}:${frame}`);
    if (!crop) {
      const src = realmKitSpriteSource(asset, frame);
      const buf = await sharp(Buffer.from(pixels.data.buffer, pixels.data.byteOffset, pixels.data.byteLength),
        { raw: { width: pixels.width, height: pixels.height, channels: 4 } })
        .extract({ left: src.x, top: src.y, width: src.width, height: src.height })
        .png().toBuffer();
      crop = { buf, width: src.width, height: src.height };
      kitCut.set(`${asset.id}:${frame}`, crop);
    }
    return crop;
  };

  // Compose on a PADDED canvas, then crop: sharp rejects overlays that extend
  // past the canvas, and tall sprites (keep L20 art is 232px) overflow the top
  // of the frame by design (bottom-anchored). The pads absorb every overflow;
  // the final extract crops back to the frame. Two sharp passes because
  // .composite() is applied LAST in a sharp pipeline — an extract chained onto
  // the same instance would run before the overlays landed.
  const PAD_TOP = 8 * TILE;  // > tallest sprite
  const PAD = 2 * TILE;      // sides/bottom: wide-art slop
  const layers: sharp.OverlayOptions[] = [];
  // The crop begins at real plot coordinates, so expansion and image framing
  // cannot stretch or shift the same terrain shown under the defender in-game.
  layers.push({ input: await paintBaseGroundPng(visualContext, size, ox, oy, claim), left: PAD, top: PAD_TOP });
  for (const s of placed) {
    const frame = s.kind === 'wall' ? composeWall(wallGrid, s.tx, s.ty, wallField) : null;
    const sp = frame ? {
      buf: await sharp(Buffer.from(frame.data), { raw: { width: frame.width, height: frame.height, channels: 4 } }).png().toBuffer(),
      width: frame.width, height: frame.height,
    } : s.kit ? await kitCropOf(s.kit.asset, s.kit.frame, s.kit.pixels) : await cropOf(s.key);
    if (!sp) continue;
    const { buf, width, height } = sp;
    // EXACTLY BaseScene.positionBuilding (game/v2/clips.ts#buildingSeatY): the
    // sprite's drawn BOTTOM EDGE sits on the south edge of its footprint, so the
    // top is that edge minus the drawn height and the ANCHOR cancels out of the
    // vertical seat entirely. Horizontally the anchor still decides: it is
    // [0.5,1] for almost everything but [0,0] for spiketraps, and hardcoding
    // [0.5,1] here drew traps half a tile away from where the game shows them
    // (verify wf). The old vertical rule seated a WARE/v2 anchor on the
    // footprint's MIDDLE row, which floated every pixel-anchored building above
    // its plot in both the deed and the base — owner 2026-08-30.
    // PAINT ORDER above is unchanged (still bottom-edge Y = the scene's depth
    // rule), or a tall tower would paint over the wall in front of it.
    // A kit twin carries the sheet's own anchor (bottom-centre by §7) and no
    // authored correction — the web's kitSeat is {origin, scale, offsetGamePx [0,0]}.
    const seat = v2SeatOf(at, s.key) ?? marketSeatOf(market, s.key) ?? marketSeatOf(service, s.key);
    const meta = at.meta.get(s.key);
    const [ax] = s.fleet ? s.fleet.anchor : s.kit ? [s.kit.asset.anchor.x / s.kit.asset.frameWidth] : seat?.anchor ?? meta?.anchor ?? [0.5, 1];
    // A fleet vehicle is the one sprite whose drawn BOTTOM is not the south
    // edge: it hangs from its contact point at the authored dock translation
    // from the berth's seat (BerthBuildingFx.layout), so its own anchor row
    // seats it; every other sprite keeps the bottom-edge rule.
    const ay = s.fleet ? s.fleet.anchor[1] : 1;
    const [offsetX, offsetY] = s.fleet ? [s.fleet.originDx, s.fleet.originDy] : s.kit ? [0, 0] : meta?.offsetGamePx ?? [0, 0];
    const left = Math.round((s.tx + s.fw / 2) * TILE + offsetX - ax * width) - ox + PAD;
    const top = Math.round((s.ty + s.fh) * TILE + offsetY - ay * height) - oy + PAD_TOP;
    if (left < 0 || top < 0 || left + width > size + 2 * PAD || top + height > size + PAD_TOP + PAD) continue;
    layers.push({ input: buf, left, top });
  }

  const composed = await sharp({
    create: { width: size + 2 * PAD, height: size + PAD_TOP + PAD, channels: 4,
      background: await groundPaddingColor(visualContext) },
  }).composite(layers).png().toBuffer();
  return sharp(composed).extract({ left: PAD, top: PAD_TOP, width: size, height: size }).png().toBuffer();
}
