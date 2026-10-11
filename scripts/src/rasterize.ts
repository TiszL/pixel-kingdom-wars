/**
 * Asset pipeline (ARCHITECTURE §3 pipeline rows, §7 asset quirks; build-order task #4).
 *
 * versioned art roots (including art/source/inventory/) → @resvg/resvg-js @1×
 * (crispEdges)
 * → sharp kernel:'nearest' integer upscale for @2×
 * → free-tex-packer-core per-prefix atlases (Phaser3 JSON hash, padding 2,
 *   extrude 1, no rotation, no trim, no power-of-two)
 * → apps/web/public/atlas/{prefix}@{1,2}x.png+json + meta.json sidecar
 *   (anchor / footprint / paletteSwap / anim families).
 *
 * Brand exceptions (read-asset-audit.md "Brand dimension convention"):
 * manifest w/h for 5 brand_ files is the target export size at an integer
 * multiple of the SVG viewBox (app_icon 16×, banner 4×, banner_x 4×,
 * title_bg_* 2×). Those render at manifest size via integer zoom. ALL 7
 * brand_ files are emitted as standalone PNGs in apps/web/public/brand/
 * (none are atlas-packed): the atlas list is fixed to the 9 game prefixes,
 * and the two 1:1 brand files (emblem, wordmark) are loading/title-screen
 * art, not in-scene sprites — they ship at @1/2× standalone instead.
 * The complete wave-2 identity and key-art kit comes from owner-authored
 * `art/source/brand-wave2/`. That later pack wins over both the similarly named stale
 * `brand rework v2/` folder and every earlier app-brand master.
 *
 * GRID ROOTS (rework v2, batches 14–20): the original
 * `art/source/troops-rework-core` pack and its all-troop superset
 * `art/source/troops-rework-expanded` ship one SVG per
 * (unit, tier, state), rows = 8 facings (or headings for travel sets), cols =
 * frames — instead of one SVG per frame. Each sheet is rendered ONCE at 1× and
 * sliced into `v2_<stem>_d<row>_f<col+1>` cells (single-row: no `_d` token),
 * packed @1x ONLY (a @2x dragon tier would blow the 4096² cap; the art is
 * authored at final pixel size), and described by per-clip entries in
 * meta.json (`v2Clips` + one top-level `breathStream`) carrying the winning
 * manifest entry verbatim — fps, emitter tables, PIXEL anchors and all. The
 * original root wins all 191 basename collisions, so the four already-wired
 * units and their shared FX cannot change under this integration. The merged
 * contract is 679 clips / 23,758 cells (23,690 grid + 68 portraits).
 *
 * M22 WARE GRID ROOT: `art/source/buildings-rework/manifest.json` is an object of exactly
 * 827 declarations / 5,558 candidates. Eight byte-identical mock dependencies
 * are inventory-only; 29 exact omissions are registered explicitly, yielding
 * 848 emitted clips / 5,586 rich frames. Rich keys are `ware_`-namespaced.
 * 2,123 eager aliases cover current idle, damaged/collapse, 16-mask walls,
 * trap hidden/spent, hatchling fallback, portraits/token and arrow art. Every
 * same-key legacy master is retired before the alias is packed, so optional
 * denial/eviction cannot flash an old silhouette.
 *
 * FIVE-TIER WALLS: art/source/walls-five-tier/ contributes 90 accepted PNG sources / 560
 * cells at 1× in eager wall5. Historical WARE validation remains 848 clips /
 * 5,586 frames / 2,123 aliases, then runtime retirement removes exactly 72
 * wall sheets / 448 frames / 960 aliases. Active WARE becomes 776 clips /
 * 5,138 frames / 1,163 aliases; immutable old art remains provenance only.
 *
 * PHASE E COSMETICS: 30 exact PNG sources / 30 clips / 132 frames at native
 * 1x in on-demand pe_cosmetics. Four ready clips alias idle plus shared FX.
 * No protected world/deed/native application or gameplay activation is added.
 *
 * PHASE E ORDINARY MARKET: 29 exact PNG sources / 32 clips / 148 frames
 * at native 1x in four self-contained on-demand pe_market_t1..t4 groups.
 * Ready aliases idle plus tier-local shared FX; no protected consumer is added.
 *
 * PHASE E HARVESTERS: 256 exact PNG sources / 224 clips / 992 cells at native
 * 1x across32 optional realm/tier groups; ready is already composed.
 *
 * BUILDER WORKMAN: art/source/builder-workman/ contributes one accepted native PNG,
 * three civilian clips / 120 cells (16 padding cells excluded). The dedicated
 * builder group ships only @1x and loads on demand; troop art is unchanged.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { buildFantasyArt } from './fantasy-art';
import { buildRetiredDeedImages } from './retired-deed-images';
import {
  ART_V2, ATLAS_PREFIXES, V2_BUILDING_FALLBACKS, V2_COMPACT_COMBAT_STATES,
  V2_COMPACT_TROOP_FX_STATES,
  V2_DIREWYVERN_FX_STATES,
  V2_FALLBACK_ATLAS, V2_FALLBACK_STAND_STATES, WARE_FALLBACK_ATLAS, type AtlasPrefix,
  type V2BuildingFallbackUnit, type V2CompactTroopFxUnit,
  type V2DirewyvernFxState, type V2FallbackUnit,
  atlasGroupFor, eagerAtlasScale, isRetiredRuntimeSpriteKey, isSupersededByWareAlias,
  isSupersededWareSourceSpriteKey,
  wareCurrentArtAliases, wareWorldPresentationForPackUnit, v2BuildingFallbackFrameKey,
  v2CompactCombatDownsample, v2CompactCombatFrameKey,
  v2DirewyvernFxFrameKey, v2FallbackFrameKey,
  v2LocomotionStandFrameKey, v2TroopFallbackFxBaseKey,
} from '@shardkeep/shared';
import {
  packAsync,
  type PackerExporterType,
  type TexturePackerOptions,
} from 'free-tex-packer-core';

import {
  resolveArtCandidate,
  type ArtCandidate,
  type ArtCandidateLogicalFile,
} from './art-candidate.js';
import {
  GAME_V4_OVERLAY_ENV,
  formatGameV4OverlayCoverage,
  gameV4OverlayCoverage,
  type GameV4Overlay,
  type GameV4OverlayCollection,
  type GameV4OverlayCoverage,
} from './game-v4-overlay.js';
import {
  formatGameV4ReleasePromotion,
  resolveReleaseReadyGameV4Overlay,
} from './game-v4-release-overlay.js';
import { loadWallFivePack, type WallFiveFrame } from './wall-five-pack.js';
export { WALL_FIVE_DIR } from './wall-five-pack.js';
import { loadBuilderWorkmanPack, type BuilderWorkmanPack } from './builder-workman-pack.js';
import { emitPhaseECurrency, loadPhaseECurrency } from './phase-e-currency.js';
import { assertPhaseECosmeticsKeys, emitPhaseECosmeticsManifest, loadPhaseECosmeticsPack, type PhaseECosmeticsPack, type PhaseECosmeticsMetadata } from './phase-e-cosmetics-pack.js';
import { assertPhaseEMarketKeys, emitPhaseEMarketManifest, loadPhaseEMarketPack, type PhaseEMarketPack, type PhaseEMarketMetadata } from './phase-e-market-pack.js';
import { assertPhaseEStarterFleetKeys, emitPhaseEStarterFleetManifest, loadPhaseEStarterFleetPack, type PhaseEStarterFleetPack, type PhaseEStarterFleetMetadata } from './phase-e-starter-fleet-pack.js';
import { assertPhaseEHarvestersKeys, emitPhaseEHarvestersManifest, loadPhaseEHarvestersPack, type PhaseEHarvestersPack, type PhaseEHarvestersMetadata } from './phase-e-harvesters-pack.js';
import { assertPhaseEServiceBuildingsKeys, emitPhaseEServiceBuildingsManifest, loadPhaseEServiceBuildingsPack, type PhaseEServiceBuildingsPack, type PhaseEServiceBuildingsMetadata } from './phase-e-service-buildings-pack.js';
import { assertPhaseEAdvancedFleetKeys, emitPhaseEAdvancedFleetManifest, loadPhaseEAdvancedFleetPack, restoreAdvancedFleetPixels, type PhaseEAdvancedFleetPack, type PhaseEAdvancedFleetMetadata } from './phase-e-advanced-fleet-pack.js';
export { PHASE_E_STARTER_FLEET_DIR } from './phase-e-starter-fleet-pack.js';
export { BUILDER_WORKMAN_DIR } from './builder-workman-pack.js';

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ASSETS_DIR = path.join(ROOT, 'art/source/assets-v2');
/** Second (disposable) source root: L1–20 + new-roster masters, never merged into
 *  assets-v2 (that folder is the frozen art source of truth — CLAUDE.md). */
export const NEW_ASSETS_DIR = path.join(ROOT, 'art/source/expanded-assets');
/** Batch 11-13 handout masters (overnight integration 2026-07-26): keep/forge
 *  reworks, 16-state walls, heroes, map tileset, brand rework. HIGHEST-priority
 *  root — see the shadow rule in loadManifest. */
export const ASSETS_V3_DIR = path.join(ROOT, 'art/source/assets-v3');
/** Batch 13 v2 (delivery overwrite 2026-08-03): the dragon, the giant and the
 *  six defences redrawn at the Keep's detail density, PLUS the new electric
 *  tower (7th defence, 4-frame idle + 4-frame discharge), per-level wyrmling
 *  fly/attack art and the level-agnostic fx projectile/impact/breath/burn
 *  pack — 1939 masters. Highest precedence — its `bld_<defence>_l<N>`,
 *  `bld_electrictower_l<N>` and `fx_breath_dragon_f1..3` keys replace older
 *  art. The six older defences' idle second frames are renamed to the house
 *  `_work_f1` convention by `normalize-to-house-convention.mjs` inside that
 *  folder (same treatment the batch-12 forge rework got; the script MUST be
 *  re-run after every re-delivery of the folder — see its header). */
export const PACK_B13_DIR = path.join(ROOT, 'art/source/defense-rework');
/** Inventory handout integration (batch 21, 2026-08-11): 24 item icons plus
 * backpack/H2/He3 HUD icons. The handout's colliding `ui_icon_keep.svg` is
 * deliberately absent; the live KEEP logo remains owned by the brand source. */
export const INVENTORY_ASSETS_DIR = path.join(ROOT, 'art/source/inventory');
/** Rework v2 (batch 14 + mortar batch 15, delivered 2026-08-08): giant, dragon,
 *  cannon and mortar re-authored as 3D-shaded GRID atlases + the fx/portrait/
 *  decal set that serves them. NOTE the DOUBLE space in the folder name — it is
 *  part of the owner's delivery and must never be "fixed". Format `grid`: this
 *  root is loaded by loadV2Manifest, not loadManifest. */
export const PACK_V2_DIR = path.join(ROOT, 'art/source/troops-rework-core');
/** All-troop rework delivery (batches 14–20, delivered 2026-08-10). This is a
 *  strict 679-entry superset of PACK_V2_DIR. The old root deliberately wins
 *  all collisions; this root contributes only its 488 new basenames. */
export const PACK_V2_ALL_DIR = path.join(ROOT, 'art/source/troops-rework-expanded');
/** M22 owner-authored building/defence pack. It is a manifest OBJECT of grid
 * sheets and is intentionally not part of either legacy basename merge. */
export const WARE_DIR = path.join(ROOT, 'art/source/buildings-rework');
export const WARE_ASSETS_DIR = path.join(WARE_DIR, 'assets');
/** Latest owner-authored wave-2 kit (owner correction 2026-08-15). Note the
 * exact folder name: `art/source/brand-wave2`, not the older `brand rework v2`. */
export const BRAND_REWORK_DIR = path.join(ROOT, 'art/source/brand-wave2');
/** Scene/key-art overrides retained from M26. Identity marks below intentionally
 * come from `art/source/brand-wave2`; title/loading art remains the current delivery. */
export const BRAND_OVERRIDES = {
  brand_title_bg_portrait: 'title_bg_portrait.png',
  brand_title_bg_landscape: 'title_bg_landscape.png',
  brand_banner: 'banner.png',
  brand_banner_x: 'banner_x.png',
} as const;
/** D-102 owner override: all live identity surfaces derive from the approved
 * main logo; compact emblem masters remain read-only provenance only. */
export const WAVE2_BRAND_FILES = {
  brand_logo_main: 'brand_logo_main.png',
  brand_app_icon: 'brand_logo_main.png',
  brand_profile_pic: 'brand_logo_main.png',
} as const;
/** A two-frame pulse from the previous tower identity. Keeping the source master
 * is provenance; emitting it would allow a cache race to flash deprecated art. */
export const RETIRED_BRAND_KEYS = new Set(['brand_emblem_pulse_f1', 'brand_emblem']);
export const PWA_ICON_SIZES = [16, 32, 48, 64, 96, 120, 152, 167, 180, 192, 512, 1024] as const;
export const FORGE_SCENE_URL = '/brand/ui_forgescene.png' as const;
/** game-v4 masters. Read ONLY as replacement bytes for an existing manifest
 * entry (see game-v4-overlay.ts); it is never a source root of its own. */
export const GAME_V4_DIR = path.join(ROOT, 'art', 'game-v4');
/** M26 scene/key-art masters. Identity assets deliberately do not read here. */
export const GAME_V4_BRAND_DIR = path.join(GAME_V4_DIR, 'brand');
/** Loading-screen key art (owner request 2026-09-24). The masters are
 * replaceable renders, so only their aspect class and byte ceiling are pinned,
 * never their dimensions. Bytes are copied unchanged, like BRAND_OVERRIDES. */
export const LOADING_BRAND_DIR = path.join(ROOT, 'art', 'loading-v1');
export const LOADING_BRAND_FILES = {
  brand_loading_bg_landscape: 'loading_bg_landscape.png',
  brand_loading_bg_portrait: 'loading_bg_portrait.png',
} as const;
export const LOADING_BRAND_MAX_BYTES = 600 * 1024;
export const ATLAS_DIR = path.join(ROOT, 'apps', 'web', 'public', 'atlas');
export const BRAND_DIR = path.join(ROOT, 'apps', 'web', 'public', 'brand');
export const ICON_DIR = path.join(ROOT, 'apps', 'web', 'public', 'icons');

// @3x is dropped: nothing in the app loads it (BootScene loads @2x), and bld@3x is
// the only scale that brushes the 4096px single-texture cap — packing it after the
// 688-sprite merge would overflow. @1x/@2x fit every prefix with wide margin.
export const SCALES = [1, 2] as const;
/** Per-source manifest counts — asserted independently so a drift in any folder
 *  fails loud with WHICH source changed. The one-SVG-per-sprite roots contribute
 *  337 + 731 + 1063 + 1939 + 27 = 4097 entries (204 shadowed → 3893 unique
 *  source sprites; 80 superseded Mortar frames are then retired from runtime).
 *  The two v2 grid manifests add 191 + 679 declarations and the independent
 *  M22 ware grid adds 827, for MANIFEST_COUNT=5794; v2's separate old-first
 *  merge yields 679 winning clips while ware never enters that merge. */
interface AssetSource {
  dir: string;
  count: number;
  /** How this source expresses `anchor`. Every root through batch 12 wrote
   *  NORMALIZED fractions ([0.5,1]); batch 13's rig emits PIXEL coordinates
   *  ([56,82] on a 112×88 canvas). The client feeds meta anchors straight into
   *  Phaser's `setOrigin`, which is normalized — `setOrigin(16,72)` puts a
   *  tower tens of tiles off screen. Nothing downstream could catch that, so
   *  the units are declared HERE and converted once, on load. */
  anchorUnits?: 'fraction' | 'px';
  /** 'grid' = the rework-v2 pack layout: manifest is `{atlases: [...]}` with
   *  one entry per grid-atlas SVG (rows x cols of cells), loaded and sliced by
   *  the v2 path below. Absent = the historical one-SVG-per-sprite layout. */
  format?: 'grid' | 'ware-grid';
}

/** Grid sources have their own explicit precedence contract. Array order is
 *  highest priority first; loadV2Manifest keeps the first basename it sees.
 *  Do not derive this list with SOURCES.find — every winning entry must retain
 *  the source directory from which renderV2Sheet reads its SVG. */
export const V2_GRID_SOURCES: ReadonlyArray<AssetSource & { format: 'grid' }> = [
  // Protected M14 art: 191 sheets → 4,762 cells (4,746 grid + 16 portraits).
  { dir: PACK_V2_DIR, count: 191, format: 'grid' },
  // Full M19 pack: 679 sheets; 191 overlap, so it contributes 488 basenames.
  { dir: PACK_V2_ALL_DIR, count: 679, format: 'grid' },
];

export const SOURCES: ReadonlyArray<AssetSource> = [
  { dir: ASSETS_DIR, count: 337 },
  { dir: NEW_ASSETS_DIR, count: 731 },
  { dir: ASSETS_V3_DIR, count: 1063 },
  { dir: PACK_B13_DIR, count: 1939, anchorUnits: 'px' },
  { dir: INVENTORY_ASSETS_DIR, count: 27 },
  ...V2_GRID_SOURCES,
  { dir: WARE_DIR, count: 827, format: 'ware-grid' },
];
export const MANIFEST_COUNT = SOURCES.reduce((n, s) => n + s.count, 0);
/** Exact number of sprite keys a LATER source shadows in earlier ones. Asserted
 *  exactly: a new accidental basename collision must fail the build, not
 *  silently swap somebody's art.
 *
 *  61  batch-11/12 reworks — 29 assets-v2 + 32 NEW-assets masters.
 *  +143 batch 13 v2 (counted AFTER the normalize script renames the 120 lone
 *       `_f2`s — the `_work_f1` names collide with nothing, so raw and
 *       post-rename counts are both 143):
 *       120  the six reworked defences × 20 levels — 9 keys won by assets-v2
 *            (cannon/archertower/mortar L1–3), 111 by 'art/source/expanded-assets';
 *        20  `bld_electrictower_l<N>` bare — 'art/source/expanded-assets' shipped all 20
 *            electric masters, the pack's replace them;
 *         3  `fx_breath_dragon_f1..3` — the pack replaces the art and extends
 *            the family to f4.
 *       Zero collide with assets-v3, and the pack has no internal duplicates.
 *  = 204, all WITHOUT editing those frozen/legacy folders. */
export const EXPECTED_SHADOWED = 204;

/**
 * The eagerly-loaded atlas groups — brand_ is intentionally absent (see header).
 *
 * Now defined in @shardkeep/shared alongside the grouping RULE, because the
 * packer and the client must not be able to disagree about either. Re-exported
 * here so existing importers of this module are unaffected.
 */
export { ATLAS_PREFIXES, type AtlasPrefix };

/** The 16-color hard palette (asset brief §3 / contact-sheet-v2.html). */
export const PALETTE_16: ReadonlySet<string> = new Set([
  '#1A171E', // Night Ink
  '#3D3833', // Mortar Shadow
  '#6B6354', // Stone Dark
  '#9C937F', // Tower Stone
  '#C4BBA4', // Stone Light
  '#EFE8D6', // Bone White
  '#2E4636', // Deep Pine
  '#567A4B', // Highland Green
  '#8CB36E', // Meadow
  '#54677A', // Slate Blue
  '#BBD0D6', // Sky Pale
  '#9C6F1E', // Gold Deep
  '#E3AE3C', // Vault Gold
  '#F4D77B', // Shard Glow
  '#C75A2E', // Ember
  '#8F2C2C', // Blood Red
]);

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface ManifestEntry {
  file: string;
  w: number;
  h: number;
  frames: number;
  anchor: [number, number];
  footprint: [number, number] | null;
  batch: number;
  tags: string[];
  palette_swap: Record<string, string> | null;
  /** Absolute source root this entry's `file` resolves against (assets-v2 or the
   *  NEW assets folder). Set by loadManifest; never present in the on-disk JSON. */
  srcDir: string;
  /** NEW-manifest schema fields (ignored by buildMeta; present for typecheck). */
  level?: number | null;
  tier?: number | null;
}

export async function loadManifest(): Promise<ManifestEntry[]> {
  const all: ManifestEntry[] = [];
  for (const source of SOURCES) {
    // Grid roots have a different manifest schema AND a different identity
    // model (one entry = many sliced frames); loadV2Manifest owns them. Keeping
    // them out of this loop is what keeps EXPECTED_SHADOWED and the legacy
    // shadow rule untouched — v2 keys are all `v2_`-prefixed and asserted
    // collision-free in runPipeline instead.
    if (source.format) continue;
    const raw = await fs.readFile(path.join(source.dir, 'manifest.json'), 'utf8');
    const entries = JSON.parse(raw) as ManifestEntry[];
    if (!Array.isArray(entries) || entries.length !== source.count) {
      throw new Error(
        `${source.dir}/manifest.json: expected ${source.count} entries, got ${Array.isArray(entries) ? entries.length : typeof entries}`,
      );
    }
    for (const e of entries) {
      // Normalize anchors to fractions at the boundary, so exactly one place in
      // the system knows a source used pixels. Doing it in the manifest instead
      // would be clobbered by the next art regen (the file is rig-generated).
      const anchor: [number, number] = source.anchorUnits === 'px'
        ? [e.anchor[0] / e.w, e.anchor[1] / e.h]
        : e.anchor;
      all.push({ ...e, anchor, srcDir: source.dir });
    }
  }
  // The guard that did not exist when batch 13 arrived with pixel anchors. An
  // out-of-range anchor is invisible downstream — meta.json copies it verbatim
  // and Phaser silently draws the sprite far off screen — so it has to fail
  // here, loudly, for every future pack.
  for (const e of all) {
    const [ax, ay] = e.anchor;
    if (!(ax >= 0 && ax <= 1 && ay >= 0 && ay <= 1)) {
      throw new Error(
        `${e.file}: anchor [${ax}, ${ay}] is not normalized to 0..1 — declare `
        + `anchorUnits on its SOURCES entry if the pack emits pixel anchors`,
      );
    }
  }
  // SHADOW RULE (overnight 2026-07-26): later SOURCES override earlier ones on
  // sprite-key collision — assets-v3 replaces the superseded keep/forge/skin
  // masters while assets-v2 stays byte-frozen (CLAUDE.md) and 'art/source/expanded-assets' keeps
  // its history. Keyed by spriteKey (basename), the same identity the atlas
  // packer uses. The count is asserted EXACTLY: art replacement must be a
  // deliberate act recorded here, never a filename accident.
  const byKey = new Map<string, ManifestEntry>();
  let shadowed = 0;
  for (const e of all) {
    if (byKey.has(spriteKey(e))) shadowed++;
    byKey.set(spriteKey(e), e); // later sources win
  }
  if (shadowed !== EXPECTED_SHADOWED) {
    throw new Error(`shadow rule: expected exactly ${EXPECTED_SHADOWED} shadowed sprite keys, found ${shadowed} — update EXPECTED_SHADOWED only for a deliberate art replacement`);
  }
  // D-039 RETIREMENT GATE. Validation above still reads every owner master and
  // asserts the unchanged 204-key merge contract; only the final runtime view
  // drops the 20 levels × {base, work, fire1, fire2} legacy Mortar family.
  // Keeping this after shadow validation preserves provenance while making the
  // superseded silhouette impossible to pack or serialize into meta.json.
  return [...byKey.values()].filter((entry) => {
    const key = spriteKey(entry);
    return !isRetiredRuntimeSpriteKey(key)
      && !isSupersededWareSourceSpriteKey(key)
      && !isSupersededByWareAlias(key);
  });
}

/** Sprite key from the file BASENAME — strips the NEW manifest's `buildings/|
 *  characters/|fx/` dir prefixes (a no-op for the dir-less v2 files), so prefix
 *  grouping (key.split('_')[0]) works across both roots. Verified 0 collisions. */
export function spriteKey(entry: ManifestEntry): string {
  return path.basename(entry.file).replace(/\.svg$/, '');
}

// ---------------------------------------------------------------------------
// Rework-v2 grid packs (protected root + all-troop superset)
// ---------------------------------------------------------------------------

/** One grid-atlas SVG from the v2 pack manifest (`manifest.json → atlases[]`).
 *  Typed to what the sidecar contract consumes; documentation-only fields the
 *  pack also carries (emitterNote, anchorNote, rowMeaning, arc, fx, assemble,
 *  note, tileable, seamRule, rotate, kind, unit, state, tier) ride along via
 *  the index signature but are NOT copied into meta.json — the client contract
 *  is the enumerated set below (plan Phase C sidecar spec). */
export interface V2GridEntryData {
  file: string;
  batch: number;
  /** Grid geometry. Absent ONLY on static ui_portrait entries (68 after merge), which
   *  carry `w`/`h` instead — v2Grid() normalizes those to a 1×1 grid. */
  atlas?: {
    cellW: number;
    cellH: number;
    cols: number;
    rows: number;
    /** Facing order for 8-row clips ([s,sw,w,nw,n,ne,e,se]). DELIBERATELY
     *  absent on travel sets (rows are screen-space headings, row 0 = +x,
     *  +45° CCW per row) and on single-row clips. */
    rowOrder?: string[];
  };
  /** Anchor in CELL PIXELS — unlike every fraction root, these stay pixels all
   *  the way into the sidecar (`anchorPx`), alongside the pixel emitter tables. */
  anchor?: [number, number];
  frames?: number;
  fps?: number;
  loop?: boolean;
  /** Effect-spawn spec, e.g. "muzzle@2 + cannonball@2 + smoke@3"; null when a
   *  clip explicitly spawns nothing (aim), absent when not applicable. */
  fxAt?: string | null;
  footprint?: [number, number];
  /** muzzle/axis/maw tables indexed [row][frame] — muzzle/maw are [x,y] cell
   *  px, axis is degrees. Passed through VERBATIM; typed opaque because the
   *  pipeline must never interpret them (HANDOFF-V2: never derive the angle
   *  from recoil deltas). */
  emitters?: Record<string, unknown>;
  /** Heading rows are pre-baked into the atlas (projectile travel sets). */
  travel?: boolean;
  minRange?: number;
  /** Barrowling sheets store variants in contiguous column blocks. `frames`
   *  remains frames per variant; these fields tell the client which block. */
  variants?: number;
  variantStride?: number;
  w?: number;
  h?: number;
  [extra: string]: unknown;
}

export interface V2GridEntry extends V2GridEntryData {
  /** Absolute winning source root, attached by loadV2Manifest and never
   *  serialized into meta.json. */
  srcDir: string;
}

/** Candidate bytes are intentionally not an entry property: manifest JSON is
 * extensible, so a public field could impersonate a validated candidate. */
const ART_CANDIDATE_RENDER_SOURCES = new WeakMap<V2GridEntry, Buffer>();

/** Same discipline for the generalised game-v4 overlay: bytes hang off the
 * entry object identity, never off a manifest field a JSON file could forge.
 * Grid sheets (v2 + ware) and single-sprite legacy entries render through two
 * different functions, so they need two maps. */
const GAME_V4_OVERLAY_SHEET_SOURCES = new WeakMap<V2GridEntry, Buffer>();
const GAME_V4_OVERLAY_BASE_SOURCES = new WeakMap<ManifestEntry, Buffer>();

/** True when a grid sheet's pixels come from an approved override rather than
 * the legacy SVG, so the closed-palette tripwires are skipped for it. */
function hasOverriddenSheetSource(entry: V2GridEntry): boolean {
  return ART_CANDIDATE_RENDER_SOURCES.has(entry) || GAME_V4_OVERLAY_SHEET_SOURCES.has(entry);
}

export interface V2Manifest {
  entries: V2GridEntry[];
  /** The 3-part dragon breath contract (root/mid/tip, minRange 80, tile 16) —
   *  pack-global, so it rides at meta.json top level, not per clip. */
  breathStream: unknown;
}

export interface WareGridEntry extends V2GridEntry {
  unit?: string;
  state?: string;
  tier?: number;
  level?: number;
  kind?: string;
  piece?: string;
  mask?: number;
  /** Exact per-runtime-frame face centres. Absent means clockless; null hides a
   * frame intentionally. The art pipeline, never runtime inference, owns it. */
  keepClock?: {
    pivotsPx: Array<readonly [number, number] | null>;
    handScale?: number;
  };
}

export interface WareManifest {
  entries: WareGridEntry[];
  declaredEntries: number;
  declaredCandidates: number;
  ignoredUiRefs: string[];
  exceptions: string[];
}

/** Exact mock-only copies. They remain inventory-validated but can never win a
 * runtime key or waste a namespaced frame. */
export const WARE_IGNORED_UI_REFS = [
  'bld_goldforge_l20', 'bld_goldforge_l20_work_f1',
  'ui_icon_keep', 'ui_icon_shard', 'ui_icon_swiftboots', 'ui_icon_timer',
  'ui_icon_powdercharge', 'ui_icon_shield',
] as const;

/** The delivery intentionally omitted these 29 files from manifest.atlases. */
export const WARE_MANIFEST_EXCEPTIONS = [
  'ui_forgescene.svg',
  ...['archer', 'clanhall', 'dragonnest', 'goldforge', 'hatchling', 'keep', 'mine']
    .flatMap((unit) => [1, 2, 3, 4].map((tier) => `ui_portrait_${unit}_t${tier}.svg`)),
] as const;

const WARE_HATCHLING_STATES = ['fly', 'hover', 'attack', 'spawn', 'hit', 'death'] as const;

type WareEmitterPoint = [number, number];
type WareEmitterTable = WareEmitterPoint[][];

function validateWareEmitterTable(
  key: string,
  table: unknown,
  entry: WareGridEntry,
): asserts table is WareEmitterTable {
  const grid = v2Grid(entry);
  if (!Array.isArray(table) || table.length !== grid.rows) {
    throw new Error(`${key}: emitter rows must match ${grid.rows} authored direction rows`);
  }
  for (const [row, points] of table.entries()) {
    if (!Array.isArray(points) || points.length !== (entry.frames ?? grid.cols)) {
      throw new Error(`${key}: emitter row ${row} must match ${entry.frames ?? grid.cols} authored frames`);
    }
    for (const [frame, point] of points.entries()) {
      if (!Array.isArray(point) || point.length !== 2
        || point.some((coordinate) => !Number.isInteger(coordinate) || coordinate < 0)
        || point[0]! > grid.cellW || point[1]! > grid.cellH) {
        throw new Error(`${key}: invalid emitter point at row ${row}, frame ${frame}`);
      }
    }
  }
}

/** Load M22 without participating in the legacy or v2 precedence chains. */
export async function loadWareManifest(): Promise<WareManifest> {
  const raw = JSON.parse(await fs.readFile(path.join(WARE_DIR, 'manifest.json'), 'utf8')) as {
    atlases?: Record<string, V2GridEntryData>;
  };
  if (!raw.atlases || Array.isArray(raw.atlases) || typeof raw.atlases !== 'object') {
    throw new Error(`${WARE_DIR}/manifest.json: atlases must be an object`);
  }
  const declared = Object.entries(raw.atlases);
  if (declared.length !== 827) {
    throw new Error(`${WARE_DIR}/manifest.json: expected 827 entries, got ${declared.length}`);
  }
  const emitterPath = path.join(WARE_DIR, '_src', '_hatchling_emitters.json');
  const hatchlingEmitters = JSON.parse(await fs.readFile(emitterPath, 'utf8')) as Record<string, unknown>;
  const expectedEmitterKeys = WARE_HATCHLING_STATES
    .flatMap((state) => [1, 2, 3, 4].map((tier) => `hatchling_t${tier}_${state}`))
    .sort();
  if (JSON.stringify(Object.keys(hatchlingEmitters).sort()) !== JSON.stringify(expectedEmitterKeys)) {
    throw new Error(`${emitterPath}: expected exact 24 tier/state emitter tables`);
  }
  const usedEmitterKeys = new Set<string>();
  const manifestFiles = new Set<string>();
  const normalized: WareGridEntry[] = [];
  let declaredCandidates = 0;
  for (const [id, rawEntry] of declared) {
    const file = path.basename(rawEntry.file);
    if (id !== file.replace(/\.svg$/, '')) {
      throw new Error(`${WARE_DIR}/manifest.json: id ${id} does not match file ${file}`);
    }
    if (manifestFiles.has(file)) throw new Error(`${WARE_DIR}/manifest.json: duplicate file ${file}`);
    manifestFiles.add(file);
    const sourcePath = path.join(WARE_ASSETS_DIR, file);
    const svg = await fs.readFile(sourcePath, 'utf8');
    let entry = { ...rawEntry, file, srcDir: WARE_ASSETS_DIR } as WareGridEntry;
    if (!entry.atlas && !(typeof entry.w === 'number' && typeof entry.h === 'number')) {
      const vb = parseViewBox(svg, file);
      entry = { ...entry, w: vb.w, h: vb.h };
    }
    if (entry.unit === 'hatchling') {
      const emitterKey = `hatchling_t${entry.tier}_${entry.state}`;
      const maw = hatchlingEmitters[emitterKey];
      validateWareEmitterTable(emitterKey, maw, entry);
      entry = { ...entry, emitters: { maw } };
      usedEmitterKeys.add(emitterKey);
    }
    const grid = v2Grid(entry);
    if (entry.frames !== undefined && entry.frames > grid.cols) {
      throw new Error(`${file}: frames ${entry.frames} exceeds ${grid.cols} columns`);
    }
    declaredCandidates += grid.cols * grid.rows;
    normalized.push(entry);
  }
  if (declaredCandidates !== 5_558) {
    throw new Error(`ware manifest: expected 5,558 declared candidates, found ${declaredCandidates}`);
  }
  if (JSON.stringify([...usedEmitterKeys].sort()) !== JSON.stringify(expectedEmitterKeys)) {
    throw new Error('ware manifest: hatchling entries do not consume the exact 24 emitter tables');
  }

  const diskFiles = (await fs.readdir(WARE_ASSETS_DIR)).filter((name) => name.endsWith('.svg')).sort();
  const exceptions = diskFiles.filter((name) => !manifestFiles.has(name));
  if (JSON.stringify(exceptions) !== JSON.stringify([...WARE_MANIFEST_EXCEPTIONS].sort())) {
    throw new Error(`ware inventory exceptions differ: [${exceptions.join(', ')}]`);
  }
  if (diskFiles.length !== 856) throw new Error(`ware inventory: expected 856 SVGs, found ${diskFiles.length}`);

  const ignored = new Set<string>(WARE_IGNORED_UI_REFS);
  const entries = normalized.filter((entry) => !ignored.has(path.basename(entry.file, '.svg')));
  for (const file of WARE_MANIFEST_EXCEPTIONS) {
    const svg = await fs.readFile(path.join(WARE_ASSETS_DIR, file), 'utf8');
    const vb = parseViewBox(svg, file);
    if (file === 'ui_forgescene.svg') {
      entries.push({
        file, srcDir: WARE_ASSETS_DIR, unit: 'forgescene', state: 'work', frames: 8,
        atlas: { cellW: 176, cellH: 108, cols: 8, rows: 1, rowOrder: ['-'] },
        batch: 22,
      });
      if (vb.w !== 1_408 || vb.h !== 108) throw new Error('ui_forgescene.svg must be 1408x108');
      continue;
    }
    const portrait = /^ui_portrait_([a-z]+)_t([1-4])\.svg$/.exec(file);
    if (!portrait || vb.w !== 56 || vb.h !== 56) {
      throw new Error(`${file}: invalid explicit portrait exception`);
    }
    entries.push({
      file, srcDir: WARE_ASSETS_DIR, unit: portrait[1]!, tier: Number(portrait[2]),
      kind: 'portrait', frames: 1, w: vb.w, h: vb.h, batch: 22,
    });
  }
  return {
    entries,
    declaredEntries: declared.length,
    declaredCandidates,
    ignoredUiRefs: [...WARE_IGNORED_UI_REFS],
    exceptions: [...WARE_MANIFEST_EXCEPTIONS],
  };
}

export function wareClipKey(entry: WareGridEntry): string {
  return `ware_${path.basename(entry.file).replace(/\.svg$/, '')}`;
}

export function wareFrameKey(entry: WareGridEntry, row: number, col: number): string {
  return v2FrameKey(wareClipKey(entry), v2Grid(entry).rows, row, col);
}

function assertNoRetiredRuntimeArt(keys: Iterable<string>, label: string): void {
  const found = [...keys].filter(isRetiredRuntimeSpriteKey).sort();
  if (found.length > 0) {
    throw new Error(`${label}: retired runtime routes remain: ${found.join(', ')}`);
  }
}

export interface WareCurrentArtSelection {
  aliasKey: string;
  sourceFrameKey: string;
  sourceEntry: WareGridEntry;
  anchor: [number, number];
  footprint: [number, number] | null;
  anchorAtFootprintCentre: boolean;
  /** Uniform authored-source fit. Present only on world building/trap/wall aliases. */
  sourceScale?: number;
  /** Presentation-only offset in the canonical 32-px-per-tile coordinate space. */
  offsetGamePx?: readonly [number, number];
}

export function selectWareCurrentArtAliases(manifest: WareManifest): WareCurrentArtSelection[] {
  const frameToEntry = new Map<string, WareGridEntry>();
  for (const entry of manifest.entries) {
    const grid = v2Grid(entry);
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const key = wareFrameKey(entry, row, col);
        if (frameToEntry.has(key)) throw new Error(`duplicate ware frame ${key}`);
        frameToEntry.set(key, entry);
      }
    }
  }
  const selections = wareCurrentArtAliases().map(({ aliasKey, sourceFrameKey }) => {
    const sourceEntry = frameToEntry.get(sourceFrameKey);
    if (!sourceEntry) throw new Error(`ware current-art source frame missing: ${sourceFrameKey}`);
    const grid = v2Grid(sourceEntry);
    const anchor: [number, number] = sourceEntry.anchor
      ? sourceEntry.atlas && sourceEntry.unit !== 'wall'
        ? [sourceEntry.anchor[0] / grid.cellW, sourceEntry.anchor[1] / grid.cellH]
        : sourceEntry.anchor
      : [0.5, 0.5];
    const presentation = aliasKey.startsWith('bld_')
      ? wareWorldPresentationForPackUnit(sourceEntry.unit)
      : null;
    if (aliasKey.startsWith('bld_') && !presentation) {
      throw new Error(`ware world alias has no presentation contract: ${aliasKey}`);
    }
    return {
      aliasKey,
      sourceFrameKey,
      sourceEntry,
      anchor,
      footprint: sourceEntry.unit === 'mine' ? [1, 1] : sourceEntry.footprint ?? null,
      anchorAtFootprintCentre: sourceEntry.unit !== 'wall'
        && sourceFrameKey.startsWith('ware_bld_'),
      ...(presentation ? {
        sourceScale: presentation.sourceScale,
        offsetGamePx: presentation.offsetGamePx,
      } : {}),
    } satisfies WareCurrentArtSelection;
  });
  if (selections.length !== 2_123 || new Set(selections.map(({ aliasKey }) => aliasKey)).size !== 2_123) {
    throw new Error('ware current-art alias inventory must contain exactly 2,123 unique keys');
  }
  return selections;
}

/** Retire exactly the approved old wall contract only after full-source validation. */
export function retireWareWalls(manifest: WareManifest, aliases: WareCurrentArtSelection[]): {
  manifest: WareManifest; aliases: WareCurrentArtSelection[];
} {
  const oldWalls = manifest.entries.filter((entry) => entry.unit === 'wall');
  const oldAliases = aliases.filter((alias) => alias.sourceEntry.unit === 'wall');
  const cells = oldWalls.reduce((count, entry) => { const g = v2Grid(entry); return count + g.rows * g.cols; }, 0);
  if (oldWalls.length !== 72 || cells !== 448 || oldAliases.length !== 960) {
    throw new Error('wall5 retirement requires the complete 72-source / 448-cell / 960-alias historical contract');
  }
  return { manifest: { ...manifest, entries: manifest.entries.filter((entry) => entry.unit !== 'wall') },
    aliases: aliases.filter((alias) => alias.sourceEntry.unit !== 'wall') };
}

/** Load + validate the grid root's manifest. The entry count is asserted
 *  exactly, per root, same as the four legacy roots: a drift means the owner
 *  re-delivered the pack and every count/tripwire below must be re-verified. */
export async function loadV2Manifest(): Promise<V2Manifest> {
  const byBasename = new Map<string, V2GridEntry>();
  let breathStream: unknown;
  let overlap = 0;

  for (const source of V2_GRID_SOURCES) {
    const raw = JSON.parse(await fs.readFile(path.join(source.dir, 'manifest.json'), 'utf8')) as {
      atlases?: V2GridEntryData[];
      breathStream?: unknown;
    };
    const sourceEntries = raw.atlases;
    if (!Array.isArray(sourceEntries) || sourceEntries.length !== source.count) {
      throw new Error(
        `${source.dir}/manifest.json: expected ${source.count} atlases entries, got ${Array.isArray(sourceEntries) ? sourceEntries.length : typeof sourceEntries}`,
      );
    }
    if (raw.breathStream == null) {
      throw new Error(`${source.dir}/manifest.json: missing breathStream block (the client's dragon-stream contract)`);
    }
    if (breathStream === undefined) breathStream = raw.breathStream;
    else if (JSON.stringify(raw.breathStream) !== JSON.stringify(breathStream)) {
      throw new Error(`${source.dir}/manifest.json: breathStream differs from the protected grid root`);
    }

    const sourceBasenames = new Set<string>();
    for (const rawEntry of sourceEntries) {
      if (!rawEntry.atlas && !(typeof rawEntry.w === 'number' && typeof rawEntry.h === 'number')) {
        throw new Error(`${rawEntry.file}: neither an atlas grid block nor w/h — cannot slice`);
      }
      const basename = path.basename(rawEntry.file);
      if (sourceBasenames.has(basename)) {
        throw new Error(`${source.dir}/manifest.json: duplicate grid basename ${basename}`);
      }
      sourceBasenames.add(basename);
      if (byBasename.has(basename)) {
        overlap++;
        continue; // V2_GRID_SOURCES is highest-priority first: old art wins.
      }
      byBasename.set(basename, { ...rawEntry, srcDir: source.dir });
    }
  }

  if (overlap !== 191) {
    throw new Error(`grid shadow rule: expected exactly 191 protected basename collisions, found ${overlap}`);
  }
  if (byBasename.size !== 679) {
    throw new Error(`grid merge: expected exactly 679 winning clips, found ${byBasename.size}`);
  }
  const entries = [...byBasename.values()];
  const portraits = entries.filter((entry) => !entry.atlas).length;
  const gridCells = entries.reduce(
    (total, entry) => total + (entry.atlas ? entry.atlas.cols * entry.atlas.rows : 0),
    0,
  );
  if (gridCells !== 23_690 || portraits !== 68) {
    throw new Error(
      `grid merge: expected 23,690 grid cells + 68 portraits, found ${gridCells} + ${portraits}`,
    );
  }
  return { entries, breathStream };
}

/** Grid geometry of a v2 entry; static portraits normalize to a 1×1 grid so
 *  every entry goes through the one slicing path ("skip nothing"). */
export function v2Grid(entry: V2GridEntry): { cellW: number; cellH: number; cols: number; rows: number } {
  if (entry.atlas) {
    const { cellW, cellH, cols, rows } = entry.atlas;
    return { cellW, cellH, cols, rows };
  }
  return { cellW: entry.w!, cellH: entry.h!, cols: 1, rows: 1 };
}

/** Clip base name = `v2_` + the SVG stem; also the meta.v2Clips key. */
export function v2ClipKey(entry: V2GridEntry): string {
  return `v2_${path.basename(entry.file).replace(/\.svg$/, '')}`;
}

/** Sliced-frame key: `<clip>_d<row>_f<col+1>`, the `_d` token only when the
 *  atlas has multiple rows (facing/heading grids). Frames are 1-based to match
 *  the house `_f<N>` convention; rows are 0-based indexes into rowOrder. */
export function v2FrameKey(clipKey: string, rows: number, row: number, col: number): string {
  return rows > 1 ? `${clipKey}_d${row}_f${col + 1}` : `${clipKey}_f${col + 1}`;
}

export interface V2FallbackSelection {
  unit: V2FallbackUnit;
  tier: number;
  aliasKey: string;
  sourceFrameKey: string;
}

export interface V2LocomotionStandSelection extends V2FallbackSelection {
  row: number;
}

export interface V2BuildingFallbackSelection {
  unit: V2BuildingFallbackUnit;
  tier: number;
  frame: number;
  aliasKey: string;
  sourceFrameKey: string;
}

export interface V2DirewyvernFxSelection {
  fx: V2DirewyvernFxState;
  tier: number;
  aliasKey: string;
  sourceFrameKey: string;
}

export interface V2TroopFallbackFxSelection {
  unit: V2CompactTroopFxUnit;
  tier: number;
  /** Original `meta.v2Clips` key; alias frames deliberately reuse its geometry. */
  metaBase: string;
  aliasBase: string;
  aliasKey: string;
  sourceFrameKey: string;
}

export interface V2CompactCombatSelection {
  unit: V2FallbackUnit;
  tier: number;
  state: string;
  aliasKey: string;
  sourceFrameKey: string;
  cellW: number;
  cellH: number;
  downsample: 2 | 4;
}

/** Select one south-facing first frame from each gameplay-active current troop clip. */
export function selectV2FallbackFrames(manifest: V2Manifest): V2FallbackSelection[] {
  const selected: V2FallbackSelection[] = [];
  for (const [unit, state] of Object.entries(V2_FALLBACK_STAND_STATES) as [V2FallbackUnit, string][]) {
    for (let tier = 1; tier <= ART_V2.tiers; tier++) {
      const matches = manifest.entries.filter((entry) =>
        entry.unit === unit && entry.tier === tier && entry.state === state,
      );
      if (matches.length !== 1) {
        throw new Error(`v2 fallback ${unit} t${tier}: expected one winning ${state} clip, found ${matches.length}`);
      }
      const entry = matches[0]!;
      const grid = v2Grid(entry);
      let row = 0;
      if (grid.rows > 1) {
        row = entry.atlas?.rowOrder?.indexOf('s') ?? -1;
        if (row < 0) throw new Error(`v2 fallback ${unit} t${tier}: ${state} clip has no south row`);
      }
      selected.push({
        unit, tier,
        aliasKey: v2FallbackFrameKey(unit, tier),
        sourceFrameKey: v2FrameKey(v2ClipKey(entry), grid.rows, row, 0),
      });
    }
  }
  const aliases = new Set(selected.map((item) => item.aliasKey));
  const expected = Object.keys(V2_FALLBACK_STAND_STATES).length * 4;
  if (selected.length !== expected || aliases.size !== selected.length) {
    throw new Error(`v2 fallback: expected ${expected} unique aliases, found ${selected.length}/${aliases.size}`);
  }
  return selected;
}

/** Copy the protected Mortar's complete two-frame south-facing idle into the
 * eager current-art atlas. These are the only truthful pixels available while
 * its optional full aim/fire/reload tier loads or is evicted. */
export function selectV2BuildingFallbackFrames(
  manifest: V2Manifest,
): V2BuildingFallbackSelection[] {
  const selected: V2BuildingFallbackSelection[] = [];
  for (const [unit, config] of Object.entries(V2_BUILDING_FALLBACKS) as
    [V2BuildingFallbackUnit, (typeof V2_BUILDING_FALLBACKS)[V2BuildingFallbackUnit]][]) {
    for (let tier = 1; tier <= ART_V2.tiers; tier++) {
      const matches = manifest.entries.filter((entry) =>
        entry.unit === unit && entry.tier === tier && entry.state === config.state,
      );
      if (matches.length !== 1) {
        throw new Error(
          `v2 building fallback ${unit} t${tier}: expected one winning ${config.state} clip, found ${matches.length}`,
        );
      }
      const entry = matches[0]!;
      const grid = v2Grid(entry);
      const row = entry.atlas?.rowOrder?.indexOf('s') ?? -1;
      if (grid.rows !== 8 || row < 0 || grid.cols !== config.frames) {
        throw new Error(
          `v2 building fallback ${unit} t${tier}: expected 8 headings and ${config.frames} frames, found ${grid.rows}×${grid.cols}`,
        );
      }
      for (let frame = 1; frame <= config.frames; frame++) {
        selected.push({
          unit,
          tier,
          frame,
          aliasKey: v2BuildingFallbackFrameKey(unit, tier, frame),
          sourceFrameKey: v2FrameKey(v2ClipKey(entry), grid.rows, row, frame - 1),
        });
      }
    }
  }
  const expected = Object.values(V2_BUILDING_FALLBACKS)
    .reduce((sum, config) => sum + config.frames * ART_V2.tiers, 0);
  const aliases = new Set(selected.map((item) => item.aliasKey));
  if (selected.length !== expected || aliases.size !== selected.length) {
    throw new Error(
      `v2 building fallback: expected ${expected} unique aliases, found ${selected.length}/${aliases.size}`,
    );
  }
  return selected;
}

/** One current stand pose per authored heading, packed beside movement. */
export function selectV2LocomotionStandFrames(
  manifest: V2Manifest,
): V2LocomotionStandSelection[] {
  const selected: V2LocomotionStandSelection[] = [];
  for (const [unit, state] of Object.entries(V2_FALLBACK_STAND_STATES) as [V2FallbackUnit, string][]) {
    for (let tier = 1; tier <= 4; tier++) {
      const matches = manifest.entries.filter((entry) =>
        entry.unit === unit && entry.tier === tier && entry.state === state,
      );
      if (matches.length !== 1) {
        throw new Error(`v2 locomotion stand ${unit} t${tier}: expected one winning ${state} clip, found ${matches.length}`);
      }
      const entry = matches[0]!;
      const grid = v2Grid(entry);
      if (grid.rows !== 8) {
        throw new Error(`v2 locomotion stand ${unit} t${tier}: expected 8 authored headings, found ${grid.rows}`);
      }
      for (let row = 0; row < grid.rows; row++) {
        selected.push({
          unit, tier, row,
          aliasKey: v2LocomotionStandFrameKey(unit, tier, row),
          sourceFrameKey: v2FrameKey(v2ClipKey(entry), grid.rows, row, 0),
        });
      }
    }
  }
  const expected = Object.keys(V2_FALLBACK_STAND_STATES).length * 4 * 8;
  const aliases = new Set(selected.map((item) => item.aliasKey));
  if (selected.length !== expected || aliases.size !== selected.length) {
    throw new Error(`v2 locomotion stand: expected ${expected} unique aliases, found ${selected.length}/${aliases.size}`);
  }
  return selected;
}

/** Select every frame of every truthful attacker body verb for the mandatory
 * reduced-resolution mobile combat core. Selection stays pure; resizing happens
 * once, after the winning source sheets have been rendered. */
export function selectV2CompactCombatFrames(
  manifest: V2Manifest,
): V2CompactCombatSelection[] {
  const selected: V2CompactCombatSelection[] = [];
  for (const [unit, states] of Object.entries(V2_COMPACT_COMBAT_STATES) as
    [V2FallbackUnit, readonly string[]][]) {
    for (let tier = 1; tier <= 4; tier++) {
      for (const state of states) {
        const matches = manifest.entries.filter((entry) =>
          entry.unit === unit && entry.tier === tier && entry.state === state,
        );
        if (matches.length !== 1) {
          throw new Error(`v2 combat core ${unit} t${tier}: expected one winning ${state} clip, found ${matches.length}`);
        }
        const entry = matches[0]!;
        const grid = v2Grid(entry);
        const downsample = v2CompactCombatDownsample(unit);
        if (grid.cellW % downsample !== 0 || grid.cellH % downsample !== 0) {
          throw new Error(`v2 combat core ${unit} t${tier} ${state}: cell must downsample exactly by ${downsample}`);
        }
        for (let row = 0; row < grid.rows; row++) {
          for (let col = 0; col < grid.cols; col++) {
            selected.push({
              unit, tier, state,
              aliasKey: v2CompactCombatFrameKey(unit, tier, state, row, col + 1, grid.rows),
              sourceFrameKey: v2FrameKey(v2ClipKey(entry), grid.rows, row, col),
              cellW: grid.cellW, cellH: grid.cellH, downsample,
            });
          }
        }
      }
    }
  }
  const aliases = new Set(selected.map((item) => item.aliasKey));
  if (aliases.size !== selected.length) {
    throw new Error(`v2 combat core: duplicate aliases (${selected.length}/${aliases.size})`);
  }
  return selected;
}

/** Duplicate Dire's three small required FX families into its bounded tier shard. */
export function selectV2DirewyvernFxFrames(
  manifest: V2Manifest,
): V2DirewyvernFxSelection[] {
  const selected: V2DirewyvernFxSelection[] = [];
  for (let tier = 1; tier <= 4; tier++) {
    for (const fx of V2_DIREWYVERN_FX_STATES) {
      const matches = manifest.entries.filter((entry) =>
        entry.kind === 'fx' && entry.fx === fx && entry.tier === tier,
      );
      if (matches.length !== 1) {
        throw new Error(`v2 dire fx ${fx} t${tier}: expected one winning clip, found ${matches.length}`);
      }
      const entry = matches[0]!;
      const grid = v2Grid(entry);
      if (grid.rows !== 1) {
        throw new Error(`v2 dire fx ${fx} t${tier}: expected one row, found ${grid.rows}`);
      }
      for (let frame = 1; frame <= grid.cols; frame++) {
        selected.push({
          fx, tier,
          aliasKey: v2DirewyvernFxFrameKey(fx, tier, frame),
          sourceFrameKey: v2FrameKey(v2ClipKey(entry), grid.rows, 0, frame - 1),
        });
      }
    }
  }
  const expected = 4 * (8 + 4 + 4);
  const aliases = new Set(selected.map((item) => item.aliasKey));
  if (selected.length !== expected || aliases.size !== selected.length) {
    throw new Error(`v2 dire fx: expected ${expected} unique aliases, found ${selected.length}/${aliases.size}`);
  }
  return selected;
}

/** Duplicate only the projectile/effect families needed by compact fallbacks. */
export function selectV2TroopFallbackFxFrames(
  manifest: V2Manifest,
): V2TroopFallbackFxSelection[] {
  const selected: V2TroopFallbackFxSelection[] = [];
  for (const [unit, states] of Object.entries(V2_COMPACT_TROOP_FX_STATES) as
    [V2CompactTroopFxUnit, readonly string[]][]) {
    for (let tier = 1; tier <= 4; tier++) {
      for (const fx of states) {
        const matches = manifest.entries.filter((entry) =>
          entry.kind === 'fx' && entry.fx === fx
          && (fx === 'shadow' || fx === 'dust'
            ? entry.tier === undefined
            : entry.tier === tier),
        );
        if (matches.length !== 1) {
          throw new Error(`v2 compact fx ${unit} ${fx} t${tier}: expected one winning clip, found ${matches.length}`);
        }
        const entry = matches[0]!;
        const metaBase = v2ClipKey(entry);
        const aliasBase = v2TroopFallbackFxBaseKey(unit, tier, metaBase);
        if (!aliasBase) {
          throw new Error(`v2 compact fx ${unit} ${fx} t${tier}: no alias base for ${metaBase}`);
        }
        const grid = v2Grid(entry);
        for (let row = 0; row < grid.rows; row++) {
          for (let col = 0; col < grid.cols; col++) {
            selected.push({
              unit, tier, metaBase, aliasBase,
              aliasKey: v2FrameKey(aliasBase, grid.rows, row, col),
              sourceFrameKey: v2FrameKey(metaBase, grid.rows, row, col),
            });
          }
        }
      }
    }
  }
  const aliases = new Set(selected.map((item) => item.aliasKey));
  if (aliases.size !== selected.length) {
    throw new Error(`v2 compact fx: duplicate aliases (${selected.length}/${aliases.size})`);
  }
  return selected;
}

/**
 * The v2 color law: the PAL table in the pack's own render core
 * (`_src/_pix2.js`), 103 opaque hexes in the protected root and 166 in the
 * all-troop superset. This is a DIFFERENT palette from
 * PALETTE_16 — v2 shades per-pixel over dithered ramps (iron, bronze, dragon
 * scale, giant hide, …) — so the v2 root gets its own assertion and the four
 * legacy roots keep theirs untouched. PAL's three translucent shadow keys
 * (#100D15 at alpha 0x55/0x33/0x22)
 * are excluded here; they surface post-render as the V2_SHADOW_PIXELS
 * quadruples below.
 */
export const V2_PALETTE: ReadonlySet<string> = new Set([
  '#100D15', '#1E1A26', '#2B2533', // outline o/o2/oS
  '#3D3833', '#6B6354', '#9C937F', '#C4BBA4', '#EFE8D6', // stone sh/sd/st/sl/bw
  '#9C6F1E', '#E3AE3C', '#F4D77B', '#FFF3C4', // trim trD/tr/trL/trW
  '#2E3A45', '#54677A', '#BBD0D6', // roof rfD/rf/rfL
  '#3A2A1A', '#6B4A2E', '#9A7248', '#C3A070', // wood wdD/wd/wdL/wdX
  '#14181D', '#23282F', '#3C444E', '#5A6470', '#8B98A4', '#CBD6DE', // iron irX..irW
  '#2A1608', '#4A2A10', '#7A4A1C', '#A8702C', '#D29A46', '#F2CE8E', // bronze bzX..bzW
  '#5C1408', '#8F2C2C', '#C75A2E', '#E8873A', '#FFFFFF', // fire flX/flD/fl/flM/flY (flL/flW shared above)
  '#5C1B1E', // cloth clD (cl/clL shared with fire)
  '#2E4636', '#567A4B', '#8CB36E', '#4A3A2A', // ground pin/grn/mdw/dirt
  '#3A2359', '#6B48A8', '#A480E0', '#D6C2F5', // void vd/vm/vl/vw
  '#0E4A52', '#1E8F94', '#6FE0D9', '#C4FFF6', // cyan cyD/cyM/cyL/cyW
  '#4A2A12', '#B8622A', '#F2A24E', '#FFD98A', // amber amD/am/amL/amW
  '#08130F', '#0E211D', '#16302A', '#274A40', '#3E7A67', '#6FB89B', '#A8E0C4', '#D8F5E6', // dragon scale dgY..dg5
  '#1A0E12', '#2A171C', '#43242C', '#6B3742', '#96545A', '#C07A72', '#E0A05C', '#FFD9A0', // membrane mbY..mbW
  '#3E3524', '#6E6047', '#A08F6C', '#D6C9A4', '#F5EDD4', // horn hnY..hnW
  '#B9915B', '#E8C88A', '#FFEFC4', // belly belD/bel/belL
  '#170C05', '#241408', '#3A2418', '#5C3A28', '#8C6244', '#BC9268', '#E0BC94', '#F5DEC2', // giant hide gnY..gn5
  '#2E2114', '#4A3524', '#6E5236', '#96754E', // leather lthD..lthW
  '#43473A', '#6E7660', '#9FA88C', // keratin ktD/kt/ktL
  '#1C1B22', '#2E2C36', '#46434F', '#635F6E', '#847F8F', '#A8A2B2', '#CFC9D6', // rock rkY..rkW
  '#2A2730', '#464252', '#6E6880', '#9A93A8', // smoke smD/sm/smL/smW
  // Batches 16–20 extend the SAME authored PAL table for the all-troop pack.
  '#08174A', '#123A8C', '#1E6FD4', '#3FA8F0', // direwyvern blue fire
  '#0A0810', '#120E1C', '#1D162C', '#2E2447', '#5B4389', '#9377C9', '#C0B0E0', '#DED6EF', // mage cloth
  '#3E2E6B', '#C9A6F5', '#EFE4FF', // arcane energy (shared middle tones above)
  '#07130F', '#16332F', '#25423F', '#3E6D68', '#6FA39D', '#A2CFC9', '#D6EFEB', // bilgewraith brine
  '#221D1A', '#3A322B', '#584C40', '#7C6C59', // rag / sailcloth
  '#140D08', '#241709', '#3D2712', '#5C3C1E', '#845B32', // excavated earth
  '#0C0D0A', '#171812', '#28291F', '#C6CDB6', '#E4E9DA', // troll ramp extensions
  '#0B0F14', '#151C24', '#243039', '#3A4A58', '#8199A8', '#E4F0F2', // tur-rider steel extensions
  '#141209', '#2E2A20', '#4A4436', // tur pelt extensions (stone tones shared above)
  '#150607', '#240B0C', '#3C1315', '#5E1E1F', '#C05248', '#E08C76', '#F5C7B0', // plunderer crimson
  '#080D0A', '#121B14', '#1E2C22', '#7FA968', '#AACD8E', '#D6E9BE', // bowman greens
  '#06050A', '#413A4C', '#5E5470', '#847897', '#B0A5C0', // dark-faction value ramp
]);

/**
 * The v2 analog of SHADOW_PIXELS: `_pix2.js` declares translucent shadows as
 * #100D15 at alpha 0x55/0x33/0x22 (shw/shw2/shw3), and resvg's premultiply
 * round-trip lands them on these exact whole-pixel quadruples. Measured over
 * all 191 protected sheets rendered through the identical resvg call: exactly these two
 * values (0x55 → 380,082 px, 0x33 → 796,245 px) and NO third — shw3 (0x22)
 * never reaches emitted art today, and if a re-delivery starts using it this
 * assert fails loudly so the quadruple is added deliberately, never by range.
 */
const V2_SHADOW_PIXELS: ReadonlySet<string> = new Set(['15,12,21,85', '15,15,20,51']);

/**
 * Per-sheet tripwire for the v2 root — STRICTER than the legacy roots' pair of
 * checks: every pixel must be fully transparent, or fully opaque AND on the
 * PAL palette, or one of the two declared shadow quadruples. Runs on the whole
 * rendered sheet, so every sliced cell is covered by construction.
 */
export function assertV2Pixels(data: Buffer, label: string): void {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]!;
    if (a === 0) continue;
    const hex =
      '#' +
      [data[i]!, data[i + 1]!, data[i + 2]!]
        .map((c) => c.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase();
    if (a === 255) {
      if (!V2_PALETTE.has(hex)) {
        throw new Error(`${label}: off-PAL opaque pixel ${hex} at byte ${i}`);
      }
    } else if (!V2_SHADOW_PIXELS.has(`${data[i]},${data[i + 1]},${data[i + 2]},${a}`)) {
      throw new Error(`${label}: anti-aliased pixel (${hex}, alpha=${a}) at byte ${i + 3}`);
    }
  }
}

/** Ware/brand reuse the v2 core but key art also carries the legacy 16-color
 * identity ramp. Both are closed authored palettes; translucency stays on the
 * same two exact v2 shadow quadruples. */
export function assertWarePixels(data: Buffer, label: string): void {
  const palette = new Set([...V2_PALETTE, ...PALETTE_16]);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]!;
    if (a === 0) continue;
    const hex = '#' + [data[i]!, data[i + 1]!, data[i + 2]!]
      .map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase();
    if (a === 255) {
      if (!palette.has(hex)) throw new Error(`${label}: off-ware-palette opaque pixel ${hex} at byte ${i}`);
    } else if (!V2_SHADOW_PIXELS.has(`${data[i]},${data[i + 1]},${data[i + 2]},${a}`)) {
      throw new Error(`${label}: anti-aliased pixel (${hex}, alpha=${a}) at byte ${i + 3}`);
    }
  }
}

/** K-052: game-v4 projectile travel sheets are GENERATED in the semantic
 * heading order e,ne,n,nw,w,sw,s,se, while the runtime's headingRow() reads
 * rows clockwise in screen-y-down coordinates: e,se,s,sw,w,nw,n,ne. Every
 * overlay-delivered WARE travel sheet is therefore reassembled at THIS
 * boundary — runtime row r takes generated row GAME_V4_TRAVEL_ROW_SOURCE[r].
 * headingRow() and the legacy sheets (already authored in the physical runtime
 * order) stay untouched; rows 0 (east) and 4 (west) map to themselves, which
 * is why those two headings looked correct before the fix. */
export const GAME_V4_TRAVEL_ROW_SOURCE = [0, 7, 6, 5, 4, 3, 2, 1] as const;

/** The active WARE travel sets K-052 enumerates. The ware manifest's rowOrder
 * metadata cannot identify travel sheets (it labels most of these with the
 * actor FACING order), so the affected runtime clip keys are pinned here. */
export const GAME_V4_WARE_TRAVEL_CLIP_KEYS: ReadonlySet<string> = new Set([
  'ware_fx_arrow', 'ware_fx_harpoon_t1', 'ware_fx_harpoon_t2', 'ware_fx_harpoon_t3',
  'ware_fx_harpoon_t4', 'ware_fx_hatchfire', 'ware_fx_keepbolt', 'ware_fx_magebolt',
]);

/** Reassemble an 8-row travel sheet from generated (semantic) row order into
 * the runtime heading order. Deterministic pixel transform — no resampling. */
export async function assembleRuntimeTravelRows(
  png: Buffer, width: number, cellH: number,
): Promise<Buffer> {
  const rows = await Promise.all([...GAME_V4_TRAVEL_ROW_SOURCE].map((sourceRow) =>
    sharp(png)
      .extract({ left: 0, top: sourceRow * cellH, width, height: cellH })
      .png().toBuffer()));
  return sharp({
    create: {
      width, height: cellH * GAME_V4_TRAVEL_ROW_SOURCE.length,
      channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(rows.map((input, runtimeRow) => ({ input, left: 0, top: runtimeRow * cellH })))
    .png().toBuffer();
}

/** Render a v2 grid sheet at 1× — the ONLY scale v2 ships (a @2x dragon tier
 *  alone would need ~28Mpx against the 4096² = 16.7Mpx single-texture cap, and
 *  the art is authored at final pixel size, so @2x buys nothing). */
export async function renderV2Sheet(entry: V2GridEntry): Promise<Buffer> {
  const overlayPng = GAME_V4_OVERLAY_SHEET_SOURCES.get(entry);
  const overridePng = ART_CANDIDATE_RENDER_SOURCES.get(entry) ?? overlayPng;
  if (overridePng) {
    const grid = v2Grid(entry);
    const w = grid.cellW * grid.cols;
    const h = grid.cellH * grid.rows;
    const png = Buffer.from(overridePng);
    await assertPngSize(png, w, h, `${entry.file} candidate @1x`);
    // Candidate bytes already passed the hash-pinned game-v4 proof contract
    // before attachment. Reapplying the legacy Ware/v2 palettes here would
    // reject the approved colors after the exact snapshot was accepted.
    if (overridePng === overlayPng && GAME_V4_WARE_TRAVEL_CLIP_KEYS.has(wareClipKey(entry))) {
      if (grid.rows !== GAME_V4_TRAVEL_ROW_SOURCE.length) {
        throw new Error(
          `${entry.file}: travel sheet must have ${GAME_V4_TRAVEL_ROW_SOURCE.length} heading rows, got ${grid.rows}`,
        );
      }
      return assembleRuntimeTravelRows(png, w, grid.cellH);
    }
    return png;
  }
  const svg = await fs.readFile(path.join(entry.srcDir, entry.file), 'utf8');
  const vb = parseViewBox(svg, entry.file);
  const grid = v2Grid(entry);
  const w = grid.cellW * grid.cols;
  const h = grid.cellH * grid.rows;
  if (vb.w !== w || vb.h !== h) {
    throw new Error(
      `${entry.file}: viewBox ${vb.w}x${vb.h} != grid ${grid.cols}x${grid.rows} cells of ${grid.cellW}x${grid.cellH} (${w}x${h})`,
    );
  }
  const png = renderSvg(svg, w);
  await assertPngSize(png, w, h, `${entry.file} @1x`);
  return png;
}

// ---------------------------------------------------------------------------
// meta.json OVERRIDES (read-asset-audit.md quirk list — documented table)
// ---------------------------------------------------------------------------

/**
 * Manifest quirks normalized in the sidecar. Keys are sprite keys, values are
 * field overrides applied on top of the manifest entry.
 *
 * - bld_spiketrap_sprung: manifest says anchor [0.5,1] while its 4 sibling
 *   states (hidden / armed / trigger_f1 / trigger_f2) are [0,0]. Rendering
 *   as-is shifts the sprite half a tile on state change (audit "BUG
 *   CANDIDATE"), so we normalize to [0,0].
 *
 * - fx_fire_mortar_f1/f2: stays centered [0.5,0.5] ON PURPOSE (no entry
 *   below). The 64×32 mortar plume straddles the barrel, unlike
 *   fx_fire_cannon/fx_fire_tower which are ground-attached at [0.5,1].
 *   Recorded here so the audit flag is visibly resolved, not forgotten.
 */
export const OVERRIDES: Readonly<Record<string, { anchor?: [number, number] }>> = {
  bld_spiketrap_sprung: { anchor: [0, 0] },
};

// ---------------------------------------------------------------------------
// SVG rendering (resvg @1× crispEdges → sharp nearest-neighbor upscale)
// ---------------------------------------------------------------------------

function parseViewBox(svg: string, file: string): { w: number; h: number } {
  const m = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
  if (!m) throw new Error(`${file}: missing/unsupported viewBox`);
  return { w: Number(m[1]), h: Number(m[2]) };
}

/**
 * Render at an exact pixel width. fitTo 'zoom' multiplies the SVG's
 * width/height ATTRIBUTES (brand files carry export-size attrs), so 'width'
 * is the only mode that is unambiguous for both 1:1 sprites and the
 * integer-zoom brand exports.
 */
function renderSvg(svg: string, targetW: number): Buffer {
  const resvg = new Resvg(svg, {
    shapeRendering: 1, // crispEdges
    fitTo: { mode: 'width', value: targetW },
  });
  const png = resvg.render().asPng();
  return Buffer.from(png);
}

/** Render an atlas sprite at 1× (viewBox size must equal manifest w/h). */
export async function renderBase(entry: ManifestEntry): Promise<Buffer> {
  const overlayPng = GAME_V4_OVERLAY_BASE_SOURCES.get(entry);
  if (overlayPng) {
    // Single-sprite entries are a 1×1 grid: the manifest w/h IS the cell size.
    // The caller still runs assertBinaryAlpha over the result.
    const png = Buffer.from(overlayPng);
    await assertPngSize(png, entry.w, entry.h, `${entry.file} overlay @1x`);
    return png;
  }
  const svg = await fs.readFile(path.join(entry.srcDir, entry.file), 'utf8');
  const vb = parseViewBox(svg, entry.file);
  if (vb.w !== entry.w || vb.h !== entry.h) {
    throw new Error(
      `${entry.file}: viewBox ${vb.w}x${vb.h} != manifest ${entry.w}x${entry.h} (only brand_ files may differ)`,
    );
  }
  const png = renderSvg(svg, entry.w);
  await assertPngSize(png, entry.w, entry.h, `${entry.file} @1x`);
  return png;
}

/** Render a manifest-owned brand SVG at its declared integer zoom. */
export async function renderBrand(entry: ManifestEntry): Promise<Buffer> {
  const svg = await fs.readFile(path.join(entry.srcDir, entry.file), 'utf8');
  const vb = parseViewBox(svg, entry.file);
  if (entry.w % vb.w !== 0 || entry.h % vb.h !== 0 || entry.w / vb.w !== entry.h / vb.h) {
    throw new Error(
      `${entry.file}: manifest ${entry.w}x${entry.h} is not an integer zoom of viewBox ${vb.w}x${vb.h}`,
    );
  }
  const png = renderSvg(svg, entry.w);
  await assertPngSize(png, entry.w, entry.h, `${entry.file} @zoom`);
  return png;
}

/** Exact nearest-neighbor integer upscale (mathematically lossless). */
export async function scaleNearest(png: Buffer, w: number, h: number, scale: number): Promise<Buffer> {
  if (scale === 1) return png;
  return sharp(png)
    .resize(w * scale, h * scale, { kernel: 'nearest' })
    .png()
    .toBuffer();
}

async function assertPngSize(png: Buffer, w: number, h: number, label: string): Promise<void> {
  const meta = await sharp(png).metadata();
  if (meta.width !== w || meta.height !== h) {
    throw new Error(`${label}: rendered ${meta.width}x${meta.height}, expected ${w}x${h}`);
  }
}

/**
 * Batch 13's deliberate translucency: soft ground shadows and glow overlays,
 * so art sits on grass / dirt / stone instead of on a hard dark plate
 * (README §8).
 *
 * THESE ARE POST-RENDER VALUES and deliberately differ from the source hex. The
 * masters declare `#14111A33` / `#14111A55`; resvg premultiplies alpha, and the
 * round trip lands on #140F19 @51 and #15121B @85. Matching the source hex
 * instead fails on the first mortar — which is how these were found.
 *
 * Measured over all 1939 v2 masters (rendered through the identical resvg
 * call): exactly these two quadruples, 205,917 pixels, no third value. The
 * electric arcs, zap bolts, breath cones and orbs are fully opaque. Each value
 * with its source art:
 *   '20,15,25,51' (#14111A33) — dragon/giant flight shadows, mortar pit,
 *       dragon nest, and new in v2: fx_burn_1x1/2x2 ground overlays and
 *       fx_shell_hit debris.
 *   '21,18,27,85' (#14111A55) — dragon/giant families only.
 * Stored as "r,g,b,a" so the match is on the whole pixel, and the allowlist is
 * exact-match — never a range.
 */
const SHADOW_PIXELS: ReadonlySet<string> = new Set(['20,15,25,51', '21,18,27,85']);

/**
 * Global anti-aliasing tripwire: every pixel must be fully transparent, fully
 * opaque, or one of the two declared shadow values above.
 *
 * WHY THE EXEMPTION IS SAFE. It matches the whole pixel, not just the alpha.
 * Anti-aliasing blends a sprite's colour toward what is behind it, producing
 * arbitrary alphas AND blended RGB — it cannot land on exactly one of two
 * known quadruples. So the check still catches a rasterizer that started
 * smearing, which is the only thing it was ever protecting against. Widening it
 * to "any alpha" would have thrown that away to ship one art pack.
 *
 * (The 3-sprite golden test additionally checks exact palette membership; this
 * alpha check is shade-agnostic so it runs on every sprite.)
 */
async function assertBinaryAlpha(png: Buffer, label: string): Promise<void> {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]!;
    if (a === 0 || a === 255) continue;
    if (!SHADOW_PIXELS.has(`${data[i]},${data[i + 1]},${data[i + 2]},${a}`)) {
      const hex = [data[i]!, data[i + 1]!, data[i + 2]!]
        .map((c) => c.toString(16).padStart(2, '0')).join('');
      throw new Error(
        `${label}: anti-aliased pixel (#${hex}, alpha=${a}) at byte ${i + 3}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// meta.json sidecar
// ---------------------------------------------------------------------------

export interface MetaSprite {
  anchor: [number, number];
  footprint: [number, number] | null;
  /** M22 building anchors seat at footprint centre; walls remain bottom-seated. */
  anchorAtFootprintCentre?: boolean;
  /** M22 authored-source multiplier; web/deed resolve it against atlas scale. */
  sourceScale?: number;
  /** Presentation-only offset in 32-px game coordinates. */
  offsetGamePx?: readonly [number, number];
  /** hex→hex recolor map, verbatim from manifest palette_swap (runtime canvas substitution). */
  paletteSwap: Record<string, string> | null;
  /** Family base name when the sprite is an animation frame (trailing _fN), else null. */
  animFamily: string | null;
}

export interface MetaFamily {
  frames: string[];
  /** True for 3-frame walk families: playback is f1,f2,f3,f2 (contact-sheet contract). */
  pingpong: boolean;
  sequence: string[];
}

/**
 * One rework-v2 clip (= one grid-atlas SVG), keyed `v2_<svg-stem>` in
 * meta.v2Clips. Field-for-field the plan's sidecar contract, VERBATIM from the
 * pack manifest — the client builds its whole v2 clip registry from this, so
 * nothing here may be renamed or converted (anchor stays PIXELS as `anchorPx`;
 * emitter tables stay [row][frame] cell-px/degrees). Optional fields are
 * present exactly when the pack manifest carries them: rowOrder is absent on
 * travel sets (heading rows) and single-row clips; fps/loop are absent on the
 * frameless-timing scorch decals and fx_shadow; fxAt null means "explicitly
 * spawns nothing" (aim) while absent means not applicable.
 */
export interface V2Clip {
  frames: number;
  fps?: number;
  loop?: boolean;
  fxAt?: string | null;
  rows: number;
  rowOrder?: string[];
  cellW: number;
  cellH: number;
  /** Cell-pixel anchor. Absent only on the 68 merged static portraits. */
  anchorPx?: [number, number];
  emitters?: Record<string, unknown>;
  travel?: boolean;
  footprint?: [number, number];
  minRange?: number;
  /** Authored Barrowling column layout: variant v starts at
   *  v * variantStride and contains `frames` playback frames. */
  variants?: number;
  variantStride?: number;
}

export interface WareClip extends V2Clip {
  /** Normalized anchor only for static wall cells; grid entries use anchorPx. */
  anchor?: [number, number];
  unit?: string;
  state?: string;
  tier?: number;
  level?: number;
  kind?: string;
  piece?: string;
  mask?: number;
}

export interface AtlasMeta {
  version: 1;
  /** Legacy roots ship at every scale here; `v2*` groups are @1x ONLY (see the
   *  header) — their `@2x` files deliberately do not exist. */
  scales: number[];
  atlases: string[];
  brandStandalones: string[];
  sprites: Record<string, MetaSprite>;
  families: Record<string, MetaFamily>;
  /** Rework-v2 clip registry, one entry per winning grid-atlas SVG (679). v2 frames do
   *  NOT appear in `sprites`/`families`: their anchors are pixels and their
   *  playback is per-clip-fps, both of which the legacy shapes cannot carry
   *  without unit confusion. */
  v2Clips: Record<string, V2Clip>;
  /** M22 building/defence clips, one per emitted manifest/exception entry. */
  wareClips: Record<string, WareClip>;
  /** Native civilian clips; separate from troop art and loaded only for jobs. */
  builderClips: Record<string, V2Clip>;
  /** Validated cosmetic source/clip identity; does not imply application readiness. */
  peCosmetics?: PhaseECosmeticsMetadata;
  /** Exact ordinary Market source clips, independent from cosmetic availability. */
  peMarket?: PhaseEMarketMetadata;
  /** Source-only ordinary Workshop/Lodge state and grid-cell bindings. */
  peServiceBuildings?: PhaseEServiceBuildingsMetadata;
  peAdvancedFleet?: PhaseEAdvancedFleetMetadata;
  peHarvesters?: PhaseEHarvestersMetadata;
  /** Starter-only authored clips/tracks; source packing does not admit a renderer. */
  peClips?: PhaseEStarterFleetMetadata['clips'];
  peTracks?: PhaseEStarterFleetMetadata['tracks'];
  peStarterFleet?: Omit<PhaseEStarterFleetMetadata, 'clips' | 'tracks'> & { bindingSha256: string };
  /** Eager stable keys copied byte-for-byte from the named current frame. */
  currentArtAliases: Record<string, string>;
  wareIgnoredUiRefs: string[];
  wareManifestExceptions: string[];
  /** Native 56x56 generated PNGs for React; authoring SVGs never ship. */
  warePortraitUrls: Record<string, string>;
  /** The pack-global 3-part dragon-stream contract, verbatim (incl. minRange 80). */
  breathStream: unknown;
  /** Exact decoded RGBA residency for every on-demand atlas group at the scale
   *  the runtime fetches: rework-v2 at @1x, legacy dragon/giant at @2x. Eager
   *  groups and unused scale duplicates are deliberately absent. */
  atlasBytes: Record<string, number>;
  /** Viewer-local KEEP clock placement, compiled only from explicit authored
   * per-frame pivots. An empty table is intentional until art publishes them. */
  keepClock: KeepClockMetadata;
  /** Present only for a local proof build. Paths are deliberately logical so
   * an external studio directory can never leak into the runtime artifact. */
  artCandidate?: { files: ArtCandidateLogicalFile[] };
  /** Present only when the generalised game-v4 overlay ran. Logical paths and
   * counts only, so no local studio directory can reach a runtime artifact. */
  gameV4Overlay?: GameV4OverlayCoverage;
}

export interface KeepClockFaceMetadata {
  pivotPx: readonly [number, number];
  canvasPx: readonly [number, number];
  handScale: number;
}

export type KeepClockFrameMetadata = KeepClockFaceMetadata | null;

export interface KeepClockMetadata {
  frames: Record<string, KeepClockFrameMetadata>;
  levels: Record<number, KeepClockFaceMetadata & { sourceFrame: string }>;
}

/** The v2 sidecar fields copied VERBATIM when (and only when) the pack
 *  manifest carries them. `frames/rows/cellW/cellH` are handled separately
 *  (portraits normalize to a 1×1 grid), `anchor` becomes `anchorPx`. */
const V2_CLIP_PASSTHROUGH = [
  'fps', 'loop', 'fxAt', 'emitters', 'travel', 'footprint', 'minRange',
  'variants', 'variantStride',
] as const;

export function buildV2Clip(entry: V2GridEntry): V2Clip {
  const grid = v2Grid(entry);
  const clip: V2Clip = {
    frames: entry.frames ?? grid.cols,
    rows: grid.rows,
    cellW: grid.cellW,
    cellH: grid.cellH,
  };
  if (entry.atlas?.rowOrder) clip.rowOrder = entry.atlas.rowOrder;
  if (entry.anchor) clip.anchorPx = entry.anchor;
  for (const field of V2_CLIP_PASSTHROUGH) {
    if (field in entry) (clip as unknown as Record<string, unknown>)[field] = entry[field];
  }
  return clip;
}

export function buildWareClip(entry: WareGridEntry): WareClip {
  const base = buildV2Clip(entry) as WareClip;
  if (entry.unit === 'wall' && entry.anchor) {
    delete base.anchorPx;
    base.anchor = entry.anchor;
  }
  for (const field of ['unit', 'state', 'tier', 'level', 'kind', 'piece', 'mask'] as const) {
    if (field in entry) (base as unknown as Record<string, unknown>)[field] = entry[field];
  }
  return base;
}

/** Compile authored @1x face centres to runtime frame keys. Stable eager
 * aliases are packed at @2x, so their canvas, pivot, and hand cell scale are
 * multiplied together; Phaser then draws that body at half the rich scale and
 * both paths produce the same world transform. */
export function buildKeepClockMetadata(
  manifest: WareManifest,
  aliases: readonly WareCurrentArtSelection[],
): KeepClockMetadata {
  const frames: Record<string, KeepClockFrameMetadata> = {};
  for (const entry of manifest.entries) {
    const authored = entry.keepClock;
    if (authored === undefined) continue;
    if (entry.unit !== 'keep') {
      throw new Error(`${entry.file}: keepClock metadata is valid only for KEEP sheets`);
    }
    const grid = v2Grid(entry);
    const frameCount = entry.frames ?? grid.cols;
    const pivots = (authored as { pivotsPx?: unknown }).pivotsPx;
    const handScale = (authored as { handScale?: unknown }).handScale ?? 1;
    if (!Array.isArray(pivots) || pivots.length !== grid.rows * frameCount) {
      throw new Error(
        `${entry.file}: keepClock.pivotsPx must contain exactly ${grid.rows * frameCount} frame bindings`,
      );
    }
    if (!Number.isSafeInteger(handScale) || (handScale as number) <= 0) {
      throw new Error(`${entry.file}: keepClock.handScale must be a positive integer`);
    }
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < frameCount; col++) {
        const key = wareFrameKey(entry, row, col);
        if (Object.prototype.hasOwnProperty.call(frames, key)) {
          throw new Error(`${entry.file}: duplicate KEEP clock frame ${key}`);
        }
        const pivot = pivots[row * frameCount + col];
        if (pivot === null) {
          frames[key] = null;
          continue;
        }
        if (!Array.isArray(pivot) || pivot.length !== 2
          || pivot.some((coordinate) => !Number.isFinite(coordinate))
          || pivot[0]! < 0 || pivot[0]! >= grid.cellW
          || pivot[1]! < 0 || pivot[1]! >= grid.cellH) {
          throw new Error(`${entry.file}: invalid KEEP clock pivot at row ${row}, frame ${col + 1}`);
        }
        frames[key] = {
          pivotPx: [pivot[0]!, pivot[1]!],
          canvasPx: [grid.cellW, grid.cellH],
          handScale: handScale as number,
        };
      }
    }
  }

  const levels: Record<number, KeepClockFaceMetadata & { sourceFrame: string }> = {};
  for (const selection of aliases) {
    const match = /^bld_keep_l(\d+)$/.exec(selection.aliasKey);
    if (!match) continue;
    const level = Number(match[1]);
    const source = frames[selection.sourceFrameKey];
    if (!source) continue;
    if (levels[level]) throw new Error(`duplicate KEEP clock eager alias for level ${level}`);
    const scale = eagerAtlasScale(atlasGroupFor(selection.aliasKey));
    levels[level] = {
      sourceFrame: selection.aliasKey,
      pivotPx: [source.pivotPx[0] * scale, source.pivotPx[1] * scale],
      canvasPx: [source.canvasPx[0] * scale, source.canvasPx[1] * scale],
      handScale: source.handScale * scale,
    };
  }

  return {
    frames: Object.fromEntries(Object.entries(frames).sort(([a], [b]) => a.localeCompare(b))),
    levels: Object.fromEntries(
      Object.entries(levels).sort(([a], [b]) => Number(a) - Number(b)),
    ) as Record<number, KeepClockFaceMetadata & { sourceFrame: string }>,
  };
}

export function buildMeta(
  entries: ManifestEntry[],
  brandStandalones: string[],
  v2: { manifest: V2Manifest; frameKeys: string[] },
  atlasBytes: Record<string, number>,
  ware?: {
    manifest: WareManifest;
    frameKeys: string[];
    aliases: WareCurrentArtSelection[];
  },
  artCandidateFiles: readonly ArtCandidateLogicalFile[] = [],
  gameV4Overlay?: GameV4OverlayCoverage,
  walls: readonly WallFiveFrame[] = [],
  builder?: BuilderWorkmanPack,
  cosmetics?: PhaseECosmeticsPack,
  market?: PhaseEMarketPack,
  starter?: PhaseEStarterFleetPack,
  serviceBuildings?: PhaseEServiceBuildingsPack,
  advancedFleet?: PhaseEAdvancedFleetPack,
  harvesters?: PhaseEHarvestersPack,
): AtlasMeta {
  // Derived from the sprites themselves, not from ATLAS_PREFIXES: the eager
  // list no longer describes everything that gets packed. This is how the
  // client discovers `trpdg_l1..l20` and every emitted `v2*` group without
  // hardcoding level or tier counts.
  const atlases = [
    ...new Set([
      ...entries.map((e) => atlasGroupFor(spriteKey(e))),
      ...v2.frameKeys.map((k) => atlasGroupFor(k)),
      ...walls.map((frame) => atlasGroupFor(frame.key)),
      ...(builder?.frames ?? []).map((frame) => atlasGroupFor(frame.key)),
      ...(cosmetics?.frames ?? []).map((frame) => atlasGroupFor(frame.key)),
      ...(market?.frames ?? []).map((frame) => atlasGroupFor(frame.key)),
      ...(starter?.frames ?? []).map((frame) => atlasGroupFor(frame.key)),
      ...(serviceBuildings?.frames ?? []).map((frame) => atlasGroupFor(frame.key)),
      ...(advancedFleet?.frames ?? []).map((frame) => atlasGroupFor(frame.key)),
      ...(harvesters?.frames ?? []).map((frame) => atlasGroupFor(frame.key)),
      ...(ware?.frameKeys ?? []).map((k) => atlasGroupFor(k)),
      ...(ware?.aliases ?? []).map((selection) => atlasGroupFor(selection.aliasKey)),
    ]),
  ].sort();
  const starterIdentity = starter ? Object.fromEntries(Object.entries(starter.metadata).filter(([key]) => key !== 'clips' && key !== 'tracks')) as Omit<PhaseEStarterFleetMetadata, 'clips' | 'tracks'> : undefined;
  const sprites: Record<string, MetaSprite> = {};
  const familyFrames = new Map<string, { n: number; key: string }[]>();

  for (const entry of entries) {
    const key = spriteKey(entry);
    const frameMatch = key.match(/^(.*)_f(\d+)$/);
    const family = frameMatch ? frameMatch[1]! : null;
    if (family) {
      const list = familyFrames.get(family) ?? [];
      list.push({ n: Number(frameMatch![2]), key });
      familyFrames.set(family, list);
    }
    const override = OVERRIDES[key];
    sprites[key] = {
      anchor: override?.anchor ?? entry.anchor,
      footprint: entry.footprint,
      paletteSwap: entry.palette_swap,
      animFamily: family,
    };
  }
  for (const selection of ware?.aliases ?? []) {
    sprites[selection.aliasKey] = {
      anchor: selection.anchor,
      footprint: selection.footprint,
      paletteSwap: null,
      animFamily: null,
      ...(selection.anchorAtFootprintCentre ? { anchorAtFootprintCentre: true } : {}),
      ...(selection.sourceScale !== undefined ? { sourceScale: selection.sourceScale } : {}),
      ...(selection.offsetGamePx ? { offsetGamePx: selection.offsetGamePx } : {}),
    };
  }

  for (const frame of walls) {
    if (sprites[frame.key]) throw new Error(`wall5 metadata collision: ${frame.key}`);
    sprites[frame.key] = { anchor: [0.5, 1], footprint: [1, 1], sourceScale: 1, paletteSwap: null, animFamily: frame.family };
    const list = familyFrames.get(frame.family) ?? [];
    list.push({ n: frame.frame, key: frame.key });
    familyFrames.set(frame.family, list);
  }

  const families: Record<string, MetaFamily> = {};
  for (const [base, list] of [...familyFrames.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort((a, b) => a.n - b.n);
    list.forEach((f, i) => {
      if (f.n !== i + 1) throw new Error(`family ${base}: frame numbering gap at f${f.n}`);
    });
    const frames = list.map((f) => f.key);
    const pingpong = frames.length === 3 && /_walk_[nse]$/.test(base);
    families[base] = {
      frames,
      pingpong,
      sequence: pingpong ? [frames[0]!, frames[1]!, frames[2]!, frames[1]!] : frames,
    };
  }

  // v2 clip registry: sorted for a stable, diffable meta.json.
  const v2Clips: Record<string, V2Clip> = {};
  for (const entry of [...v2.manifest.entries].sort((a, b) => a.file.localeCompare(b.file))) {
    const key = v2ClipKey(entry);
    if (v2Clips[key]) throw new Error(`v2 clip key collision: ${key}`);
    v2Clips[key] = buildV2Clip(entry);
  }

  const wareClips: Record<string, WareClip> = {};
  for (const entry of [...(ware?.manifest.entries ?? [])].sort((a, b) => a.file.localeCompare(b.file))) {
    const key = wareClipKey(entry);
    if (wareClips[key]) throw new Error(`ware clip key collision: ${key}`);
    wareClips[key] = buildWareClip(entry);
  }
  const currentArtAliases = Object.fromEntries(
    [...(ware?.aliases ?? [])]
      .sort((a, b) => a.aliasKey.localeCompare(b.aliasKey))
      .map(({ aliasKey, sourceFrameKey }) => [aliasKey, sourceFrameKey]),
  );
  const warePortraitUrls = Object.fromEntries(
    Object.keys(currentArtAliases)
      .filter((key) => key.startsWith('ui_portrait_'))
      .sort()
      .map((key) => [key, `/brand/ware/${key}.png`]),
  );
  const keepClock = buildKeepClockMetadata(
    ware?.manifest ?? {
      entries: [], declaredEntries: 0, declaredCandidates: 0, ignoredUiRefs: [], exceptions: [],
    },
    ware?.aliases ?? [],
  );

  return {
    version: 1,
    scales: [...SCALES],
    atlases,
    brandStandalones: brandStandalones.sort(),
    sprites,
    families,
    v2Clips,
    wareClips,
    builderClips: builder?.clips ?? {},
    ...(cosmetics ? { peCosmetics: cosmetics.metadata } : {}),
    ...(market ? { peMarket: market.metadata } : {}),
    ...(serviceBuildings ? { peServiceBuildings: serviceBuildings.metadata } : {}),
    ...(advancedFleet ? { peAdvancedFleet: advancedFleet.metadata } : {}),
    ...(harvesters ? { peHarvesters: harvesters.metadata } : {}),
    ...(starter ? { peClips: starter.metadata.clips, peTracks: starter.metadata.tracks,
      peStarterFleet: { ...starterIdentity!, bindingSha256: starter.bindingSha256 } } : {}),
    currentArtAliases,
    wareIgnoredUiRefs: [...(ware?.manifest.ignoredUiRefs ?? [])].sort(),
    wareManifestExceptions: [...(ware?.manifest.exceptions ?? [])].sort(),
    warePortraitUrls,
    breathStream: v2.manifest.breathStream,
    atlasBytes: Object.fromEntries(
      Object.entries(atlasBytes).sort(([a], [b]) => a.localeCompare(b)),
    ),
    keepClock,
    ...(artCandidateFiles.length > 0 ? {
      artCandidate: { files: [...artCandidateFiles].sort() },
    } : {}),
    ...(gameV4Overlay ? { gameV4Overlay } : {}),
  };
}

// ---------------------------------------------------------------------------
// Atlas packing
// ---------------------------------------------------------------------------

export interface PackedTextureSize {
  /** Packed texture dimensions from Phaser JSON, not the compressed PNG. */
  width: number;
  height: number;
  /** Exact decoded RGBA residency: width * height * four channels. */
  decodedBytes: number;
}

interface PackedAtlas extends PackedTextureSize {
  png: Buffer;
  json: Buffer;
  frameNames: string[];
}

export interface PackedAtlasSize extends PackedTextureSize {
  group: string;
  scale: number;
}

/** Validate and decode free-tex-packer's single-texture size contract. */
export function packedTextureSize(
  atlasJson: unknown,
  textureName: string,
): PackedTextureSize {
  const textures = (atlasJson as { textures?: unknown } | null)?.textures;
  const texture = Array.isArray(textures) && textures.length === 1
    ? textures[0] as { size?: { w?: unknown; h?: unknown } }
    : undefined;
  const width = texture?.size?.w;
  const height = texture?.size?.h;
  if (
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || (width as number) <= 0 || (height as number) <= 0
  ) {
    throw new Error(
      `${textureName}: packed atlas JSON must contain exactly one texture with a positive integer size`,
    );
  }
  const decodedBytes = (width as number) * (height as number) * 4;
  if (!Number.isSafeInteger(decodedBytes)) {
    throw new Error(`${textureName}: decoded RGBA byte size is not a safe integer`);
  }
  return { width: width as number, height: height as number, decodedBytes };
}

/** The one runtime scale whose decoded bytes matter for an on-demand group. */
export function onDemandAtlasScale(group: string): 1 | 2 | null {
  if (group === V2_FALLBACK_ATLAS || group === WARE_FALLBACK_ATLAS) return null;
  if (group.startsWith('v2') || group.startsWith('ware') || group === 'builder' || group === 'pe_cosmetics' || group === 'pe_fleet_starter' || /^pe_harvester_(?:frostveil|elderwood|sunscar|crownlands|seeker_reach|stormcairn|thornwake|cinderfall)_t[1-4]$/.test(group) || /^pe_(?:market|workshop|lodge)_t[1-4]$/.test(group) || /^pe_(?:veh_(?:survey_balloon|cargo_cutter|courier_airship|expedition_barge)_t[1-4]|berth_(?:survey_balloon|cargo_cutter|courier_airship|expedition_barge))$/.test(group)) return 1;
  if (/^trpdg_l\d+$/.test(group)) return 2;
  return null;
}

/**
 * Build the stable sidecar table from what was actually packed. Selecting the
 * runtime scale here prevents @1x+@2x duplicates from being added together or
 * a hand-maintained per-unit estimate drifting from the emitted texture.
 */
export function buildAtlasBytes(packed: readonly PackedAtlasSize[]): Record<string, number> {
  const byGroup = new Map<string, PackedAtlasSize[]>();
  for (const item of packed) {
    const list = byGroup.get(item.group) ?? [];
    list.push(item);
    byGroup.set(item.group, list);
  }

  const atlasBytes: Record<string, number> = {};
  for (const group of [...byGroup.keys()].sort()) {
    const runtimeScale = onDemandAtlasScale(group);
    if (runtimeScale === null) continue;
    const matches = byGroup.get(group)!.filter((item) => item.scale === runtimeScale);
    if (matches.length !== 1) {
      throw new Error(
        `${group}: expected exactly one packed @${runtimeScale}x texture for runtime residency, found ${matches.length}`,
      );
    }
    const item = matches[0]!;
    const exact = item.width * item.height * 4;
    if (!Number.isSafeInteger(exact) || exact <= 0 || item.decodedBytes !== exact) {
      throw new Error(`${group}@${runtimeScale}x: invalid decoded RGBA byte metadata`);
    }
    atlasBytes[group] = exact;
  }
  return atlasBytes;
}

export async function packAtlas(
  /** An atlas GROUP name, not just a prefix: `blddef` and `trpdg_l<N>` are
   *  groups too, so this can no longer be the fixed AtlasPrefix union. */
  prefix: string,
  scale: number,
  images: { name: string; contents: Buffer }[],
): Promise<PackedAtlas> {
  const textureName = `${prefix}@${scale}x`;
  const files = await packAsync(
    images.map((img) => ({ path: `${img.name}.png`, contents: img.contents })),
    {
      textureName,
      width: 4096,
      height: 4096,
      fixedSize: false,
      powerOfTwo: false,
      padding: 2,
      extrude: 1,
      allowRotation: false,
      allowTrim: false,
      detectIdentical: false,
      // Default MaxRectsBin/BestShortSideFit degenerates into ~4000px-tall
      // strips (bld@3x hit 402x4092, brushing the 4096 single-texture cap).
      // MaxRectsPacker 'Smart' grows the bin compactly (trp@1x: 360x368 vs
      // 54x3154 with the default).
      packer: 'MaxRectsPacker' as NonNullable<TexturePackerOptions['packer']>,
      packerMethod: 'Smart' as NonNullable<TexturePackerOptions['packerMethod']>,
      removeFileExtension: true,
      prependFolderName: false,
      // PackerExporterType.PHASER3 — the enum only exists in the package's
      // .d.ts (no runtime export), so cast the literal string instead.
      exporter: 'Phaser3' as PackerExporterType,
      appInfo: { url: 'shardkeep/scripts/rasterize', version: '1' },
    },
  );

  const pngFile = files.find((f) => f.name === `${textureName}.png`);
  const jsonFile = files.find((f) => f.name === `${textureName}.json`);
  if (!pngFile || !jsonFile || files.length !== 2) {
    throw new Error(
      `${textureName}: expected exactly ${textureName}.png+.json (single texture), got [${files.map((f) => f.name).join(', ')}] — sprites may not fit 4096px`,
    );
  }

  const atlasJson = JSON.parse(jsonFile.buffer.toString('utf8')) as {
    textures: {
      size?: { w?: unknown; h?: unknown };
      frames: { filename: string; frame: { w: number; h: number } }[];
    }[];
  };
  const size = packedTextureSize(atlasJson, textureName);
  const frames = atlasJson.textures[0]?.frames ?? [];
  const frameNames = frames.map((f) => f.filename);

  // Fail loud: every input sprite must appear exactly once, untrimmed.
  const expected = new Set(images.map((i) => i.name));
  if (frameNames.length !== expected.size || frameNames.some((n) => !expected.has(n))) {
    throw new Error(`${textureName}: atlas frames do not match input sprite set`);
  }
  const png = prefix === 'pe_fleet_starter'
    ? await restoreStarterFleetPixels(pngFile.buffer, jsonFile.buffer, images)
    : /^pe_(?:veh_(?:survey_balloon|cargo_cutter|courier_airship|expedition_barge)_t[1-4]|berth_(?:survey_balloon|cargo_cutter|courier_airship|expedition_barge))$/.test(prefix)
      ? await restoreAdvancedFleetPixels(prefix, pngFile.buffer, jsonFile.buffer, images)
      : pngFile.buffer;
  return { png, json: jsonFile.buffer, frameNames, ...size };
}

/** The house packer clears hidden RGB under alpha zero. For this exact source
 * group retain complete authored RGBA, after proving its layout and all visible
 * pixels. Other groups, gutters/extrusion and original masters are untouched. */
export async function restoreStarterFleetPixels(png: Buffer, json: Buffer,
  images: { name: string; contents: Buffer }[]): Promise<Buffer> {
  const fail = (reason: string): never => { throw new Error(`starter fleet packed RGBA: ${reason}`); };
  const source = await loadPhaseEStarterFleetPack(); // Recheck current source hashes before restoring bytes.
  const expected = new Map(Object.values(source.metadata.clips).flatMap(clip => clip.frames.map(frame =>
    [frame.key, { width: clip.cellW, height: clip.cellH, sha256: frame.sha256 }] as const)));
  const input = new Map(images.map(image => [image.name, image.contents]));
  if (images.length !== expected.size || input.size !== expected.size || images.some(image => !expected.has(image.name))) fail('input set changed');
  type Rect = { x: number; y: number; w: number; h: number };
  const atlas = JSON.parse(json.toString('utf8')) as { textures: Array<{ size: { w: number; h: number };
    frames: Array<{ filename: string; rotated: boolean; trimmed: boolean; frame: Rect;
      sourceSize: { w: number; h: number }; spriteSourceSize: Rect }> }> };
  if (atlas.textures.length !== 1) fail('one texture required');
  const texture = atlas.textures[0]!;
  const { data: pixels, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (texture.size.w !== info.width || texture.size.h !== info.height || texture.frames.length !== expected.size) fail('texture geometry changed');
  const seen = new Set<string>(), rectangles: Rect[] = [];
  const restored: Array<{ rect: Rect; rgba: Buffer }> = [];
  for (const frame of texture.frames) {
    const canonical = expected.get(frame.filename), rect = frame.frame;
    if (!canonical || seen.has(frame.filename)) fail('duplicate or unknown frame');
    seen.add(frame.filename);
    if (frame.rotated !== false || frame.trimmed !== false
      || ![rect.x, rect.y, rect.w, rect.h].every(Number.isInteger) || rect.x < 0 || rect.y < 0
      || rect.w !== canonical!.width || rect.h !== canonical!.height
      || rect.x + rect.w > info.width || rect.y + rect.h > info.height
      || frame.sourceSize.w !== rect.w || frame.sourceSize.h !== rect.h
      || frame.spriteSourceSize.x !== 0 || frame.spriteSourceSize.y !== 0
      || frame.spriteSourceSize.w !== rect.w || frame.spriteSourceSize.h !== rect.h) fail('untrimmed in-bounds source rectangle required');
    if (rectangles.some(other => rect.x < other.x + other.w && rect.x + rect.w > other.x
      && rect.y < other.y + other.h && rect.y + rect.h > other.y)) fail('overlapping rectangles');
    rectangles.push(rect);
    const original = await sharp(input.get(frame.filename)!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (original.info.width !== rect.w || original.info.height !== rect.h
      || createHash('sha256').update(original.data).digest('hex') !== canonical!.sha256) fail('source cell changed');
    for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
      const from = (y * rect.w + x) * 4, to = ((rect.y + y) * info.width + rect.x + x) * 4;
      if (pixels[to + 3] !== original.data[from + 3]
        || (original.data[from + 3] !== 0 && !pixels.subarray(to, to + 3).equals(original.data.subarray(from, from + 3)))) fail('visible pixel or alpha changed');
    }
    restored.push({ rect, rgba: original.data });
  }
  // Mutate only after every source and rectangle has passed. No resampling or blending.
  for (const { rect, rgba } of restored) for (let y = 0; y < rect.h; y++)
    rgba.copy(pixels, ((rect.y + y) * info.width + rect.x) * 4, y * rect.w * 4, (y + 1) * rect.w * 4);
  return sharp(pixels, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

const ART_CANDIDATE_TARGETS = [
  {
    logicalFile: 'keep/bld_keep_l20_idle.png',
    collection: 'ware',
    manifestFile: 'bld_keep_l20_idle.svg',
  },
  {
    logicalFile: 'giant/trp_giant_t4_walk.png',
    collection: 'v2',
    manifestFile: 'assets/trp_giant_t4_walk.svg',
  },
  {
    logicalFile: 'giant/trp_giant_t4_throw.png',
    collection: 'v2',
    manifestFile: 'assets/trp_giant_t4_throw.svg',
  },
] as const satisfies ReadonlyArray<{
  logicalFile: ArtCandidateLogicalFile;
  collection: 'ware' | 'v2';
  manifestFile: string;
}>;

/** Attach all three validated render overrides together. Non-enumerable path
 * fields keep absolute local directories out of JSON.stringify and sidecars. */
export function attachArtCandidateRenderSources(
  candidate: ArtCandidate,
  v2Manifest: V2Manifest,
  wareManifest: WareManifest,
): void {
  const resolved = ART_CANDIDATE_TARGETS.map((target) => {
    const entries = target.collection === 'ware' ? wareManifest.entries : v2Manifest.entries;
    const matches = entries.filter((entry) => entry.file === target.manifestFile);
    if (matches.length !== 1) {
      throw new Error(
        `candidate target ${target.manifestFile}: expected one ${target.collection} manifest entry, found ${matches.length}`,
      );
    }
    const renderSourceBytes = candidate.readRenderSource(target.logicalFile);
    return { entry: matches[0]!, renderSourceBytes };
  });

  const allEntries = [...v2Manifest.entries, ...wareManifest.entries];
  if (allEntries.some((entry) => ART_CANDIDATE_RENDER_SOURCES.has(entry))) {
    throw new Error('candidate render source was already attached');
  }
  for (const { entry, renderSourceBytes } of resolved) {
    ART_CANDIDATE_RENDER_SOURCES.set(entry, Buffer.from(renderSourceBytes));
  }
}

/**
 * Bind every named game-v4 overlay PNG to the legacy manifest entry that owns
 * its runtime key, replacing PNG BYTES ONLY.
 *
 * Called BEFORE the pipeline removes apps/web/public/atlas, so a mismatched
 * sheet fails while the previously generated tree is still intact.
 *
 * The manifest keeps owning cellW/cellH/cols/rows/anchor/fps/loop/rowOrder;
 * this function's single assertion is that the replacement pixels fill exactly
 * cellW*cols x cellH*rows. There is no resize, crop or stretch anywhere.
 */
export function attachGameV4OverlayRenderSources(
  overlay: GameV4Overlay,
  legacyEntries: ManifestEntry[],
  v2Manifest: V2Manifest,
  wareManifest: WareManifest,
): GameV4OverlayCoverage {
  // Brand standalones reach apps/web/public/brand through three separate
  // bypasses (WAVE2_BRAND_FILES, BRAND_OVERRIDES, renderBrand), so an override
  // bound here would silently do nothing. Refuse instead of pretending.
  const overridableLegacy = legacyEntries.filter((entry) => !entry.file.startsWith('brand_'));
  const indexes: Record<GameV4OverlayCollection, Map<string, ManifestEntry | V2GridEntry>> = {
    legacy: indexByRuntimeKey(overridableLegacy, spriteKey, 'legacy'),
    v2: indexByRuntimeKey(v2Manifest.entries, v2ClipKey, 'v2'),
    ware: indexByRuntimeKey(wareManifest.entries, wareClipKey, 'ware'),
  };
  const activeLedgerKeys = overlay.activeLedgerKeys === null
    ? null
    : new Set(overlay.activeLedgerKeys);
  const activeLedgerEntries = activeLedgerKeys === null
    ? Object.values(indexes).reduce((count, index) => count + index.size, 0)
    : Object.values(indexes).reduce(
      (count, index) => count + [...index.keys()].filter((key) => activeLedgerKeys.has(key)).length,
      0,
    );

  const overridden: Record<GameV4OverlayCollection, number> = { legacy: 0, v2: 0, ware: 0 };
  let activeLedgerOverridden = 0;
  /** Delivered masters whose runtime key has no legacy manifest entry to override yet. */
  const unbindable: string[] = [];
  for (const source of overlay.sources) {
    if (source.collection === 'legacy' && source.runtimeKey.startsWith('brand_')) {
      throw new Error(
        `${GAME_V4_OVERLAY_ENV}: ${source.file} targets brand standalone ${source.runtimeKey}, which this seam cannot override`,
      );
    }
    const entry = indexes[source.collection].get(source.runtimeKey);
    if (!entry) {
      // A game-v4 target can legitimately be a NEW runtime key that the legacy manifest
      // never had — local_map_keep_t1..t5 are the forked non-globe Keep pins, authored
      // fresh alongside the frozen map_keep_t*. This seam replaces the BYTES of an existing
      // manifest entry, so a brand-new key has nothing to override and needs real manifest
      // wiring instead. Record it and carry on; failing the whole build over art that simply
      // arrived early would make delivering a new key impossible.
      if (!source.ledgerKey) {
        // Not a ledger key at all — a stale or mistyped filename. Silently no-opping that
        // would report success while shipping the old silhouette, so it stays fatal.
        throw new Error(
          `${GAME_V4_OVERLAY_ENV}: ${source.file} names unknown ${source.collection} runtime key ${source.runtimeKey}`,
        );
      }
      unbindable.push(`${source.file} -> ${source.collection}:${source.runtimeKey}`);
      continue;
    }
    const expected = source.collection === 'legacy'
      ? { width: (entry as ManifestEntry).w, height: (entry as ManifestEntry).h }
      : gridPixelSize(entry as V2GridEntry);
    if (source.width !== expected.width || source.height !== expected.height) {
      throw new Error(
        `${GAME_V4_OVERLAY_ENV}: ${source.file} is ${source.width}x${source.height}, `
          + `but ${source.runtimeKey} requires ${expected.width}x${expected.height}`,
      );
    }
    if (source.collection === 'legacy') {
      GAME_V4_OVERLAY_BASE_SOURCES.set(entry as ManifestEntry, Buffer.from(source.png));
    } else {
      const sheet = entry as V2GridEntry;
      if (ART_CANDIDATE_RENDER_SOURCES.has(sheet)) {
        throw new Error(
          `${GAME_V4_OVERLAY_ENV}: ${source.runtimeKey} is already pinned by the three-file art candidate`,
        );
      }
      GAME_V4_OVERLAY_SHEET_SOURCES.set(sheet, Buffer.from(source.png));
    }
    overridden[source.collection]++;
    if (activeLedgerKeys === null || activeLedgerKeys.has(source.runtimeKey)) {
      activeLedgerOverridden++;
    }
  }

  if (unbindable.length) {
    console.warn(
      `${GAME_V4_OVERLAY_ENV}: ${unbindable.length} delivered master(s) have no legacy manifest `
        + `entry to override and were skipped (they need real manifest wiring, not this seam):`,
    );
    for (const u of unbindable) console.warn(`  - ${u}`);
  }
  return gameV4OverlayCoverage({
    selectionMode: overlay.selectionMode,
    scannedFiles: overlay.scannedFiles,
    selectedFiles: overlay.sources.length,
    unmatchedFiles: overlay.unmatchedFiles,
    outsideLedgerFiles: overlay.outsideLedgerFiles,
    manifestEntries: {
      legacy: overridableLegacy.length,
      v2: v2Manifest.entries.length,
      ware: wareManifest.entries.length,
    },
    overridden,
    activeLedgerEntries,
    activeLedgerOverridden,
    unresolvedHolds: overlay.unresolvedHolds,
    identicalAlternates: overlay.identicalAlternates,
    conflictingAlternates: overlay.conflictingAlternates,
    unbindableEntries: unbindable,
  });
}

/** Pixel size a grid entry's sheet must have: cellW*cols x cellH*rows. */
function gridPixelSize(entry: V2GridEntry): { width: number; height: number } {
  const grid = v2Grid(entry);
  return { width: grid.cellW * grid.cols, height: grid.cellH * grid.rows };
}

function indexByRuntimeKey<T>(
  entries: T[],
  runtimeKeyOf: (entry: T) => string,
  label: GameV4OverlayCollection,
): Map<string, T> {
  const index = new Map<string, T>();
  for (const entry of entries) {
    const key = runtimeKeyOf(entry);
    if (index.has(key)) {
      throw new Error(`${GAME_V4_OVERLAY_ENV}: ${label} manifest has two entries for ${key}`);
    }
    index.set(key, entry);
  }
  return index;
}

export async function runPipeline(): Promise<{
  atlasSprites: number;
  brandStandalones: number;
  atlasFiles: number;
}> {
  const t0 = Date.now();
  const artCandidate = await resolveArtCandidate({
    SHARDKEEP_ART_CANDIDATE_ROOT: process.env.SHARDKEEP_ART_CANDIDATE_ROOT,
    NODE_ENV: process.env.NODE_ENV,
    CI: process.env.CI,
  }, { ware: assertWarePixels, v2: assertV2Pixels });
  const entries = await loadManifest();
  assertNoRetiredRuntimeArt(entries.map(spriteKey), 'filtered legacy manifest');
  const v2Manifest = await loadV2Manifest();
  const wareManifest = await loadWareManifest();
  if (artCandidate) attachArtCandidateRenderSources(artCandidate, v2Manifest, wareManifest);
  // Resolved and bound BEFORE the generated atlas tree is removed: a wrongly
  // sized or wrongly named overlay sheet must fail with the previous output
  // still on disk, never halfway through a wipe.
  const gameV4Overlay = await resolveReleaseReadyGameV4Overlay({
    root: GAME_V4_DIR,
    environment: {
      SHARDKEEP_GAME_V4_OVERLAY: process.env.SHARDKEEP_GAME_V4_OVERLAY,
      SHARDKEEP_GAME_V4_OVERLAY_ALLOW_RELEASE: process.env.SHARDKEEP_GAME_V4_OVERLAY_ALLOW_RELEASE,
      NODE_ENV: process.env.NODE_ENV,
      CI: process.env.CI,
    },
  });
  const gameV4Coverage = gameV4Overlay
    ? attachGameV4OverlayRenderSources(gameV4Overlay, entries, v2Manifest, wareManifest)
    : undefined;
  if (gameV4Coverage) console.log(formatGameV4OverlayCoverage(gameV4Coverage));
  if (gameV4Overlay) {
    const releasePromotion = formatGameV4ReleasePromotion(gameV4Overlay);
    if (releasePromotion) console.log(releasePromotion);
  }

  // Keep the complete historical WARE/overlay validation above. Retirement is
  // an output decision, never an omission that could conceal source drift.
  const historicalAliases = selectWareCurrentArtAliases(wareManifest);
  const wallFrames = await loadWallFivePack();
  const builder = await loadBuilderWorkmanPack();
  const currencyIcons = await loadPhaseECurrency();
  const cosmetics = await loadPhaseECosmeticsPack();
  const market = await loadPhaseEMarketPack();
  const starter = await loadPhaseEStarterFleetPack();
  const serviceBuildings = await loadPhaseEServiceBuildingsPack();
  const harvesters = await loadPhaseEHarvestersPack();
  const advancedFleet = await loadPhaseEAdvancedFleetPack();
  const runtimeWare = retireWareWalls(wareManifest, historicalAliases);
  const activeWareManifest = runtimeWare.manifest;
  const wareAliasSelections = runtimeWare.aliases;
  const knownKeys = new Set([
    ...entries.map(spriteKey),
    ...v2Manifest.entries.flatMap((entry) => { const g = v2Grid(entry); return Array.from({ length: g.rows * g.cols }, (_, i) => v2FrameKey(v2ClipKey(entry), g.rows, Math.floor(i / g.cols), i % g.cols)); }),
    ...wareManifest.entries.flatMap((entry) => { const g = v2Grid(entry); return Array.from({ length: g.rows * g.cols }, (_, i) => wareFrameKey(entry, Math.floor(i / g.cols), i % g.cols)); }),
    ...historicalAliases.map((alias) => alias.aliasKey),
  ]);
  for (const frame of [...wallFrames, ...builder.frames]) {
    if (knownKeys.has(frame.key)) throw new Error(`PNG pack preflight key collision: ${frame.key}`);
    knownKeys.add(frame.key);
  }

  assertPhaseECosmeticsKeys(cosmetics, knownKeys);
  for (const frame of cosmetics.frames) knownKeys.add(frame.key);
  assertPhaseEMarketKeys(market, knownKeys);
  for (const frame of market.frames) knownKeys.add(frame.key);
  assertPhaseEStarterFleetKeys(starter, knownKeys);
  for (const frame of starter.frames) knownKeys.add(frame.key);
  assertPhaseEHarvestersKeys(harvesters, knownKeys);
  for (const frame of harvesters.frames) knownKeys.add(frame.key);
  assertPhaseEServiceBuildingsKeys(serviceBuildings, knownKeys);
  for (const frame of serviceBuildings.frames) knownKeys.add(frame.key);
  assertPhaseEAdvancedFleetKeys(advancedFleet, knownKeys);

  await fs.rm(ATLAS_DIR, { recursive: true, force: true });
  await fs.rm(BRAND_DIR, { recursive: true, force: true });
  await fs.rm(ICON_DIR, { recursive: true, force: true });
  await fs.mkdir(ATLAS_DIR, { recursive: true });
  await fs.mkdir(BRAND_DIR, { recursive: true });
  await fs.mkdir(ICON_DIR, { recursive: true });
  // Four native currency UI rasters; standalone, no atlas sprite-count change.
  await emitPhaseECurrency(currencyIcons, path.join(ROOT, 'apps/web/public/items/pe'));

  const brandEntries = entries.filter((e) => e.file.startsWith('brand_'));
  const runtimeBrandEntries = brandEntries.filter((entry) => !RETIRED_BRAND_KEYS.has(spriteKey(entry)));
  const atlasEntries = entries.filter((e) => !e.file.startsWith('brand_'));

  // --- brand standalones ---------------------------------------------------
  // Identity marks are the exact pre-M26 `art/source/brand-wave2` exports. M26's
  // portrait/landscape title art and banners remain current scene key art.
  for (const entry of runtimeBrandEntries) {
    const key = spriteKey(entry);
    const wave2File = WAVE2_BRAND_FILES[key as keyof typeof WAVE2_BRAND_FILES];
    if (wave2File) {
      const source = path.join(BRAND_REWORK_DIR, wave2File);
      if (key === 'brand_logo_main') {
        const png = await fs.readFile(source);
        await assertPngSize(png, 844, 588, wave2File);
        await fs.writeFile(path.join(BRAND_DIR, `${key}.png`), png);
      } else if (key === 'brand_app_icon' || key === 'brand_profile_pic') {
        const size = key === 'brand_app_icon' ? 1024 : 512;
        const inner = Math.floor(size * 0.8);
        const logo = await sharp(source).resize(inner, inner, {
          fit: 'inside', kernel: 'nearest', withoutEnlargement: true,
        }).png().toBuffer();
        const png = await sharp({
          create: { width: size, height: size, channels: 4, background: '#14111a' },
        }).composite([{ input: logo, gravity: 'centre' }]).png().toBuffer();
        await assertPngSize(png, size, size, wave2File);
        await fs.writeFile(path.join(BRAND_DIR, `${key}.png`), png);
      } else {
        const svg = await fs.readFile(source, 'utf8');
        const vb = parseViewBox(svg, wave2File);
        if (vb.w * entry.h !== vb.h * entry.w) {
          throw new Error(`${wave2File}: ${vb.w}x${vb.h} cannot fit ${entry.w}x${entry.h} without distortion`);
        }
        const native = renderSvg(svg, vb.w);
        const base = entry.w === vb.w
          ? native
          : await sharp(native).resize(entry.w, entry.h, { kernel: 'nearest' }).png().toBuffer();
        await assertPngSize(base, entry.w, entry.h, wave2File);
        await assertBinaryAlpha(base, wave2File);
        for (const scale of SCALES) {
          const png = await scaleNearest(base, entry.w, entry.h, scale);
          const suffix = scale === 1 ? '' : `@${scale}x`;
          await fs.writeFile(path.join(BRAND_DIR, `${key}${suffix}.png`), png);
        }
      }
      continue;
    }
    const override = BRAND_OVERRIDES[key as keyof typeof BRAND_OVERRIDES];
    if (override) {
      const png = await fs.readFile(path.join(GAME_V4_BRAND_DIR, override));
      await assertPngSize(png, entry.w, entry.h, `${GAME_V4_BRAND_DIR}/${override}`);
      await fs.writeFile(path.join(BRAND_DIR, `${key}.png`), png);
      continue;
    }
    const svg = await fs.readFile(path.join(entry.srcDir, entry.file), 'utf8');
    const vb = parseViewBox(svg, entry.file);
    if (vb.w === entry.w && vb.h === entry.h) {
      const base = await renderBase(entry);
      await assertBinaryAlpha(base, key);
      for (const scale of SCALES) {
        const png = await scaleNearest(base, entry.w, entry.h, scale);
        const suffix = scale === 1 ? '' : `@${scale}x`;
        await fs.writeFile(path.join(BRAND_DIR, `${key}${suffix}.png`), png);
      }
    } else {
      const png = await renderBrand(entry);
      await assertBinaryAlpha(png, key);
      await fs.writeFile(path.join(BRAND_DIR, `${key}.png`), png);
    }
  }

  // Loading wallpapers are whole-screen key art fetched on first paint, so the
  // master bytes ship unchanged; a wrong orientation or bloated file fails here.
  for (const [key, file] of Object.entries(LOADING_BRAND_FILES)) {
    const source = path.join(LOADING_BRAND_DIR, file);
    const png = await fs.readFile(source);
    if (!png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      throw new Error(`${source}: not a PNG`);
    }
    if (png.length > LOADING_BRAND_MAX_BYTES) {
      throw new Error(`${source}: ${png.length} bytes exceeds ${LOADING_BRAND_MAX_BYTES}`);
    }
    const { width = 0, height = 0 } = await sharp(png).metadata();
    const landscape = key.endsWith('_landscape');
    if (landscape ? width <= height : height <= width) {
      throw new Error(`${source}: ${width}x${height} is not ${landscape ? 'landscape' : 'portrait'}`);
    }
    await fs.writeFile(path.join(BRAND_DIR, `${key}.png`), png);
  }

  // Square platform surfaces are derived from the approved main logo. The
  // opaque square is required by launchers/maskable PWA icons; 80% containment
  // preserves the complete logo and the maskable safe area without distortion.
  {
    const logoSource = path.join(BRAND_REWORK_DIR, 'brand_logo_main.png');
    for (const size of PWA_ICON_SIZES) {
      const inner = Math.floor(size * 0.8);
      const logo = await sharp(logoSource).resize(inner, inner, {
        fit: 'inside', kernel: 'nearest', withoutEnlargement: true,
      }).png().toBuffer();
      const png = await sharp({
        create: { width: size, height: size, channels: 4, background: '#14111a' },
      }).composite([{ input: logo, gravity: 'centre' }]).png().toBuffer();
      await assertPngSize(png, size, size, `logo-derived icon-${size}.png`);
      await fs.writeFile(path.join(ICON_DIR, `icon-${size}.png`), png);
    }
  }

  // The exact eight-frame strip is consumed by CSS `steps(8)`. Runtime never
  // fetches the immutable SVG or drives it with a JS timer.
  {
    const file = path.join(WARE_ASSETS_DIR, 'ui_forgescene.svg');
    const svg = await fs.readFile(file, 'utf8');
    const png = renderSvg(svg, 1_408);
    await assertPngSize(png, 1_408, 108, 'ui_forgescene.svg');
    const pixels = await sharp(png).ensureAlpha().raw().toBuffer();
    assertWarePixels(pixels, 'ui_forgescene.svg');
    await fs.writeFile(path.join(BRAND_DIR, 'ui_forgescene.png'), png);
  }

  // --- render all atlas sprites at 1× and NN-upscale -----------------------
  const rendered = await mapLimit(atlasEntries, 8, async (entry) => {
    const key = spriteKey(entry);
    const base = await renderBase(entry);
    await assertBinaryAlpha(base, key);
    const byScale = new Map<number, Buffer>();
    for (const scale of SCALES) {
      byScale.set(scale, await scaleNearest(base, entry.w, entry.h, scale));
    }
    return { entry, key, byScale };
  });

  // --- render + slice the v2 grid sheets (@1x ONLY — see header) -----------
  // One resvg render per sheet, one raw decode, then every cell is cropped
  // from that raw buffer. Limit 4: sheets run to ~1.2Mpx each.
  const v2Rendered = await mapLimit(v2Manifest.entries, 4, async (entry) => {
    const clipKey = v2ClipKey(entry);
    const sheet = await renderV2Sheet(entry);
    const grid = v2Grid(entry);
    const raw = await sharp(sheet).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    // Hash-pinned candidates were validated before attachment; legacy sheets
    // retain their original palette tripwire.
    if (!hasOverriddenSheetSource(entry)) assertV2Pixels(raw.data, clipKey);
    const rawInput = {
      raw: { width: raw.info.width, height: raw.info.height, channels: 4 as const },
    };
    const frames: { key: string; buf: Buffer }[] = [];
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const buf = await sharp(raw.data, rawInput)
          .extract({ left: col * grid.cellW, top: row * grid.cellH, width: grid.cellW, height: grid.cellH })
          .png()
          .toBuffer();
        frames.push({ key: v2FrameKey(clipKey, grid.rows, row, col), buf });
      }
    }
    return { entry, frames };
  });

  // --- render + slice M22 ware sheets (@1x; world consumers draw at 2x) -----
  const wareRendered = await mapLimit(activeWareManifest.entries, 4, async (entry) => {
    const clipKey = wareClipKey(entry);
    const sheet = await renderV2Sheet(entry);
    const grid = v2Grid(entry);
    const raw = await sharp(sheet).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (!hasOverriddenSheetSource(entry)) assertWarePixels(raw.data, clipKey);
    const rawInput = {
      raw: { width: raw.info.width, height: raw.info.height, channels: 4 as const },
    };
    const frames: { key: string; buf: Buffer }[] = [];
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        frames.push({
          key: wareFrameKey(entry, row, col),
          buf: await sharp(raw.data, rawInput).extract({
            left: col * grid.cellW, top: row * grid.cellH,
            width: grid.cellW, height: grid.cellH,
          }).png().toBuffer(),
        });
      }
    }
    return { entry, frames };
  });

  // TRIPWIRE: the v2 namespace. Every sliced key must carry the `v2_` prefix
  // and collide with NOTHING — not another v2 cell or any retained runtime
  // sprite key (brand included). Grid-root overlap was already resolved by
  // basename; the winning namespace shadows no legacy sprite.
  const legacyKeys = new Set(entries.map((e) => spriteKey(e)));
  const v2Keys = new Set<string>();
  for (const r of v2Rendered) {
    for (const f of r.frames) {
      if (!f.key.startsWith('v2_')) throw new Error(`v2 frame key '${f.key}' lost its v2_ prefix`);
      if (legacyKeys.has(f.key)) throw new Error(`v2 frame key '${f.key}' collides with a legacy sprite key`);
      if (v2Keys.has(f.key)) throw new Error(`duplicate v2 frame key '${f.key}'`);
      v2Keys.add(f.key);
    }
  }

  const wareKeys = new Set<string>();
  for (const renderedSheet of wareRendered) {
    for (const frame of renderedSheet.frames) {
      if (!frame.key.startsWith('ware_')) throw new Error(`ware frame '${frame.key}' lost its namespace`);
      if (legacyKeys.has(frame.key) || v2Keys.has(frame.key) || wareKeys.has(frame.key)) {
        throw new Error(`ware frame key collision: ${frame.key}`);
      }
      wareKeys.add(frame.key);
    }
  }

  const wareBuffers = new Map(wareRendered.flatMap((renderedSheet) =>
    renderedSheet.frames.map((frame) => [frame.key, frame.buf] as const),
  ));
  const wareAliasRendered = await mapLimit(wareAliasSelections, 8, async (selection) => {
    if (legacyKeys.has(selection.aliasKey) || v2Keys.has(selection.aliasKey)
      || wareKeys.has(selection.aliasKey)) {
      throw new Error(`ware current-art alias collides after legacy retirement: ${selection.aliasKey}`);
    }
    const base = wareBuffers.get(selection.sourceFrameKey);
    if (!base) throw new Error(`ware alias source missing: ${selection.sourceFrameKey}`);
    const grid = v2Grid(selection.sourceEntry);
    const byScale = new Map<number, Buffer>();
    for (const scale of SCALES) {
      byScale.set(scale, await scaleNearest(base, grid.cellW, grid.cellH, scale));
    }
    return { ...selection, key: selection.aliasKey, byScale };
  });
  const portraitDir = path.join(BRAND_DIR, 'ware');
  await fs.mkdir(portraitDir, { recursive: true });
  const portraitAliases = wareAliasRendered.filter(({ aliasKey }) =>
    aliasKey.startsWith('ui_portrait_'));
  if (portraitAliases.length !== 76) {
    throw new Error(`ware portraits: expected 76 canonical aliases, found ${portraitAliases.length}`);
  }
  for (const portrait of portraitAliases) {
    const png = portrait.byScale.get(1)!;
    await assertPngSize(png, 56, 56, portrait.aliasKey);
    await fs.writeFile(path.join(portraitDir, `${portrait.aliasKey}.png`), png);
  }

  // Copy exact winning current-art pixels under stable aliases. The eager set
  // keeps one south stand per tier; compact locomotion gets one pose per real
  // heading without duplicating every frame of the full idle/hover clip.
  const v2Buffers = new Map(v2Rendered.flatMap((rendered) =>
    rendered.frames.map((frame) => [frame.key, frame.buf] as const),
  ));
  const fallbackRendered = selectV2FallbackFrames(v2Manifest).map((selection) => {
    if (legacyKeys.has(selection.aliasKey) || v2Keys.has(selection.aliasKey)) {
      throw new Error(`v2 fallback alias collides with an existing frame: ${selection.aliasKey}`);
    }
    const buf = v2Buffers.get(selection.sourceFrameKey);
    if (!buf) throw new Error(`v2 fallback source frame missing: ${selection.sourceFrameKey}`);
    return { key: selection.aliasKey, buf };
  });
  const fallbackKeys = new Set(fallbackRendered.map((frame) => frame.key));
  const buildingFallbackRendered = selectV2BuildingFallbackFrames(v2Manifest)
    .map((selection) => {
      if (legacyKeys.has(selection.aliasKey) || v2Keys.has(selection.aliasKey)
        || fallbackKeys.has(selection.aliasKey)) {
        throw new Error(`v2 building fallback alias collides with an existing frame: ${selection.aliasKey}`);
      }
      const buf = v2Buffers.get(selection.sourceFrameKey);
      if (!buf) {
        throw new Error(`v2 building fallback source frame missing: ${selection.sourceFrameKey}`);
      }
      return { key: selection.aliasKey, buf };
    });
  const buildingFallbackKeys = new Set(buildingFallbackRendered.map((frame) => frame.key));
  const locomotionStandRendered = selectV2LocomotionStandFrames(v2Manifest).map((selection) => {
    if (legacyKeys.has(selection.aliasKey) || v2Keys.has(selection.aliasKey)
      || fallbackKeys.has(selection.aliasKey) || buildingFallbackKeys.has(selection.aliasKey)) {
      throw new Error(`v2 locomotion stand alias collides with an existing frame: ${selection.aliasKey}`);
    }
    const buf = v2Buffers.get(selection.sourceFrameKey);
    if (!buf) throw new Error(`v2 locomotion stand source frame missing: ${selection.sourceFrameKey}`);
    return { key: selection.aliasKey, buf };
  });
  const locomotionStandKeys = new Set(locomotionStandRendered.map((frame) => frame.key));
  const compactCombatRendered = await mapLimit(
    selectV2CompactCombatFrames(v2Manifest),
    8,
    async (selection) => {
      if (legacyKeys.has(selection.aliasKey) || v2Keys.has(selection.aliasKey)
        || fallbackKeys.has(selection.aliasKey) || buildingFallbackKeys.has(selection.aliasKey)
        || locomotionStandKeys.has(selection.aliasKey)) {
        throw new Error(`v2 combat core alias collides with an existing frame: ${selection.aliasKey}`);
      }
      const buf = v2Buffers.get(selection.sourceFrameKey);
      if (!buf) throw new Error(`v2 combat core source frame missing: ${selection.sourceFrameKey}`);
      return {
        key: selection.aliasKey,
        buf: await sharp(buf).resize({
          width: selection.cellW / selection.downsample,
          height: selection.cellH / selection.downsample,
          kernel: 'nearest',
        }).png().toBuffer(),
      };
    },
  );
  const compactCombatKeys = new Set(compactCombatRendered.map((frame) => frame.key));
  const direFxRendered = selectV2DirewyvernFxFrames(v2Manifest).map((selection) => {
    if (legacyKeys.has(selection.aliasKey) || v2Keys.has(selection.aliasKey)
      || fallbackKeys.has(selection.aliasKey) || buildingFallbackKeys.has(selection.aliasKey)
      || locomotionStandKeys.has(selection.aliasKey)
      || compactCombatKeys.has(selection.aliasKey)) {
      throw new Error(`v2 dire fx alias collides with an existing frame: ${selection.aliasKey}`);
    }
    const buf = v2Buffers.get(selection.sourceFrameKey);
    if (!buf) throw new Error(`v2 dire fx source frame missing: ${selection.sourceFrameKey}`);
    return { key: selection.aliasKey, buf };
  });
  const direFxKeys = new Set(direFxRendered.map((frame) => frame.key));
  const troopFallbackFxRendered = selectV2TroopFallbackFxFrames(v2Manifest).map((selection) => {
    if (legacyKeys.has(selection.aliasKey) || v2Keys.has(selection.aliasKey)
      || fallbackKeys.has(selection.aliasKey) || buildingFallbackKeys.has(selection.aliasKey)
      || locomotionStandKeys.has(selection.aliasKey)
      || compactCombatKeys.has(selection.aliasKey) || direFxKeys.has(selection.aliasKey)) {
      throw new Error(`v2 compact fx alias collides with an existing frame: ${selection.aliasKey}`);
    }
    const buf = v2Buffers.get(selection.sourceFrameKey);
    if (!buf) throw new Error(`v2 compact fx source frame missing: ${selection.sourceFrameKey}`);
    return { key: selection.aliasKey, buf };
  });

  // --- group and pack -------------------------------------------------------
  // Grouping comes from @shardkeep/shared so the packer and the client cannot
  // disagree about where a sprite lives (see that module's header). Group names
  // are open-ended strings now, not the fixed prefix union: batch 13 adds
  // `blddef` plus one `trpdg_l<N>` per level; the merged grid roots add their
  // per-unit/tier groups, shared `v2fx`, and Dire's bounded sibling shards.
  const groups = new Map<string, { key: string; byScale: Map<number, Buffer> }[]>();
  const addToGroup = (key: string, byScale: Map<number, Buffer>): void => {
    const group = atlasGroupFor(key);
    const list = groups.get(group) ?? [];
    list.push({ key, byScale });
    groups.set(group, list);
  };
  for (const r of rendered) addToGroup(r.key, r.byScale);
  for (const r of v2Rendered) {
    for (const f of r.frames) addToGroup(f.key, new Map([[1, f.buf]]));
  }
  for (const r of wareRendered) {
    for (const f of r.frames) addToGroup(f.key, new Map([[1, f.buf]]));
  }
  for (const alias of wareAliasRendered) addToGroup(alias.key, alias.byScale);
  for (const frame of [...wallFrames, ...builder.frames, ...cosmetics.frames, ...market.frames, ...starter.frames, ...serviceBuildings.frames, ...advancedFleet.frames, ...harvesters.frames]) addToGroup(frame.key, new Map([[1, frame.png]]));
  for (const frame of fallbackRendered) addToGroup(frame.key, new Map([[1, frame.buf]]));
  for (const frame of buildingFallbackRendered) addToGroup(frame.key, new Map([[1, frame.buf]]));
  for (const frame of locomotionStandRendered) addToGroup(frame.key, new Map([[1, frame.buf]]));
  for (const frame of compactCombatRendered) addToGroup(frame.key, new Map([[1, frame.buf]]));
  for (const frame of direFxRendered) addToGroup(frame.key, new Map([[1, frame.buf]]));
  for (const frame of troopFallbackFxRendered) addToGroup(frame.key, new Map([[1, frame.buf]]));
  assertNoRetiredRuntimeArt(
    [...groups.values()].flatMap((group) => group.map(({ key }) => key)),
    'packed atlas inputs',
  );

  // Every eagerly-loaded group must exist and be non-empty — the old
  // `atlas group is empty` guard, kept, because BootScene loads these by name
  // and a missing one is a boot failure rather than a missing sprite.
  for (const prefix of ATLAS_PREFIXES) {
    const group = groups.get(prefix);
    if (!group || group.length === 0) throw new Error(`atlas group '${prefix}' is empty`);
  }

  let atlasFiles = 0;
  const packedAtlasSizes: PackedAtlasSize[] = [];
  const groupNames = [...groups.keys()].sort();
  for (const name of groupNames) {
    const group = groups.get(name)!;
    // v2 groups exist at @1x only (their byScale maps carry no @2x by design);
    // every legacy group still ships at every scale.
    const scales = name.startsWith('v2') || name.startsWith('ware') || name === 'wall5' || name === 'builder' || name === 'pe_cosmetics' || name === 'pe_fleet_starter' || /^pe_harvester_(?:frostveil|elderwood|sunscar|crownlands|seeker_reach|stormcairn|thornwake|cinderfall)_t[1-4]$/.test(name) || /^pe_(?:market|workshop|lodge)_t[1-4]$/.test(name) || /^pe_(?:veh_(?:survey_balloon|cargo_cutter|courier_airship|expedition_barge)_t[1-4]|berth_(?:survey_balloon|cargo_cutter|courier_airship|expedition_barge))$/.test(name)
      ? ([1] as const)
      : SCALES;
    for (const scale of scales) {
      const images = group.map((r) => ({ name: r.key, contents: r.byScale.get(scale)! }));
      const packed = await packAtlas(name, scale, images);
      packedAtlasSizes.push({
        group: name,
        scale,
        width: packed.width,
        height: packed.height,
        decodedBytes: packed.decodedBytes,
      });
      await fs.writeFile(path.join(ATLAS_DIR, `${name}@${scale}x.png`), packed.png);
      await fs.writeFile(path.join(ATLAS_DIR, `${name}@${scale}x.json`), packed.json);
      atlasFiles += 2;
      console.log(`packed ${name}@${scale}x: ${packed.frameNames.length} frames`);
    }
  }

  // --- meta.json sidecar ----------------------------------------------------
  const runtimeBrandKeys = runtimeBrandEntries.map(spriteKey);
  // Metadata is itself a runtime asset. Filtering only the emitted PNGs would
  // leave a deprecated key discoverable through meta.sprites/meta.families.
  const runtimeEntries = entries.filter((entry) => !RETIRED_BRAND_KEYS.has(spriteKey(entry)));
  const meta = buildMeta(runtimeEntries, runtimeBrandKeys, {
    manifest: v2Manifest,
    frameKeys: [
      ...v2Keys,
      ...fallbackRendered.map((frame) => frame.key),
      ...buildingFallbackRendered.map((frame) => frame.key),
      ...locomotionStandRendered.map((frame) => frame.key),
      ...compactCombatRendered.map((frame) => frame.key),
      ...direFxRendered.map((frame) => frame.key),
      ...troopFallbackFxRendered.map((frame) => frame.key),
    ],
  }, buildAtlasBytes(packedAtlasSizes), {
    manifest: activeWareManifest,
    frameKeys: [...wareKeys],
    aliases: wareAliasSelections,
  }, artCandidate?.logicalFiles, gameV4Coverage, wallFrames, builder, cosmetics, market, starter, serviceBuildings, advancedFleet, harvesters);
  assertNoRetiredRuntimeArt([
    ...Object.keys(meta.sprites),
    ...Object.keys(meta.families),
    ...Object.keys(meta.currentArtAliases),
    ...Object.values(meta.currentArtAliases),
  ], 'meta.json');
  await fs.writeFile(path.join(ATLAS_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
  await emitPhaseECosmeticsManifest(cosmetics, ATLAS_DIR);
  await emitPhaseEMarketManifest(market, ATLAS_DIR);
  await emitPhaseEStarterFleetManifest(starter, ATLAS_DIR);
  await emitPhaseEServiceBuildingsManifest(serviceBuildings, ATLAS_DIR);
  await emitPhaseEAdvancedFleetManifest(advancedFleet, ATLAS_DIR);
  await emitPhaseEHarvestersManifest(harvesters, ATLAS_DIR);
  await buildFantasyArt();
  await buildRetiredDeedImages();
  if (gameV4Coverage) {
    console.log(formatGameV4OverlayCoverage(gameV4Coverage));
    for (const sample of gameV4Coverage.unmatchedSample) {
      console.log(`  game-v4 overlay matched nothing: ${sample}`);
    }
  }

  const summary = {
    atlasSprites: atlasEntries.length,
    brandStandalones: runtimeBrandKeys.length,
    atlasFiles,
  };
  console.log(
    `rasterize done in ${((Date.now() - t0) / 1000).toFixed(1)}s: ` +
      `${summary.atlasSprites} legacy sprites (x${SCALES.length} scales) + ${v2Keys.size} v2 frames ` +
      `from ${v2Manifest.entries.length} v2 sheets + ${wareKeys.size} ware frames from ` +
      `${wareManifest.declaredEntries} declarations (@1x) across ${groupNames.length} groups ` +
      `(${atlasFiles} atlas files), ${summary.brandStandalones} brand standalones, meta.json with ` +
      `${Object.keys(meta.sprites).length} sprite entries / ${Object.keys(meta.families).length} anim families / ` +
      `${Object.keys(meta.v2Clips).length} v2 clips / ${Object.keys(meta.wareClips).length} ware clips / ` +
      `${Object.keys(meta.builderClips).length} builder clips (${builder.frames.length} cells from one native PNG) / ` +
      `${Object.keys(cosmetics.metadata.clips).length} cosmetic clips (${cosmetics.frames.length} cells), ` +
      `${Object.keys(market.metadata.clips).length} ordinary Market clips (${market.frames.length} cells), ` +
      `${Object.keys(starter.metadata.clips).length} starter fleet clips (${starter.frames.length} cells), ` +
      `${Object.keys(harvesters.metadata.clips).length} Harvester clips (${harvesters.frames.length} cells), ` +
      `${Object.keys(serviceBuildings.metadata.clips).length} service building clips (${serviceBuildings.frames.length} cells), ` +
      `${Object.keys(advancedFleet.metadata.clips).length} advanced fleet clips (${advancedFleet.frames.length} cells)`,
  );
  return summary;
}

// Run when invoked as a script (pnpm --filter @shardkeep/scripts rasterize).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPipeline().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
