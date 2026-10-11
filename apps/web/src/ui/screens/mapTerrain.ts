/**
 * Map terrain kit — a 1:1 port of the MAPS handout's `_mapkit.js` endless
 * procedural tile world, plus the hand-authored terrain grids and act bands
 * from "PVE MAP (Campaign).html" / "WORLD MAP (PvP).html".
 * Handout sprite ids (mp_* / mk_*) were shipped renamed to map_* in assets-v3,
 * so the letter→frame table below targets those names.
 *
 * Pure data + functions (no React, no DOM) so map.tsx stays a renderer and
 * this file is unit-testable. Terrain and act chrome live here; campaign
 * encounter identity/position is server-owned shared gameplay data.
 */
import { CAMPAIGN } from '@shardkeep/shared';

/** Terrain letter → atlas/master frame base name (handout `CODE`, mp_→map_). */
export const TILE_CODE: Record<string, string> = {
  g: 'map_grass', F: 'map_forest', P: 'map_pine', H: 'map_hill',
  L: 'map_mtn_low', M: 'map_mtn_mid', K: 'map_mtn_peak',
  S: 'map_sand', A: 'map_ash', N: 'map_snow', R: 'map_ruins',
  C: 'map_camp', Y: 'map_marsh', Q: 'map_farm',
  '|': 'map_river_ns', '-': 'map_river_ew', '1': 'map_river_ne',
  '2': 'map_river_nw', '3': 'map_river_se', '4': 'map_river_sw',
  I: 'map_road_ns', '=': 'map_road_ew', '5': 'map_road_ne', '6': 'map_road_nw',
  '8': 'map_road_se', '9': 'map_road_sw',
  X: 'map_road_cross', T: 'map_road_t_e', E: 'map_road_end',
  V: 'map_bridge_ns', Z: 'map_bridge_ew',
};

/** Per-letter variant counts (handout `VAR`): frame is `base_1..base_n`. */
export const TILE_VARIANTS: Record<string, number> = { g: 4, F: 3, P: 2, H: 2 };

/** Handout `hsh`: deterministic [0,1) hash of a tile coordinate + salt. */
export function hsh(c: number, r: number, s: number): number {
  let x = (c * 374761393 + r * 668265263 + s * 2246822519) ^ 0x5bf03635;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x = x ^ (x >>> 16);
  return ((x >>> 0) % 1000) / 1000;
}

export interface Terrain {
  grid: readonly string[];
  cols: number;
  rows: number;
  /** Endless-frontier generator for tiles outside the authored grid;
   *  d = Chebyshev distance from the grid edge (≥1). */
  frontier(c: number, r: number, d: number): string;
}

// --- WORLD MAP (PvP) — authored 12×20 valley: river, road, bridge ------------
// Copied VERBATIM from "WORLD MAP (PvP).html" GRID.
const WORLD_GRID = [
  'MMKMMPPMMKMM',
  'MLPFFPggPFLM',
  'LHggFg|ggFHL',
  'gggFgg|gFgHg',
  'gFgggg|gggFg',
  'Hgg~~g|gFggL',
  'ggI~~g|gggFg',
  'gFI~~g|ggFgg',
  'ggIggg|gRggH',
  'gFIgFg|ggggg',
  '==X===V=====',
  'ggIgFg|ggFgg',
  'HgIggg|gCggg',
  'ggIgFg|ggggH',
  'gFIggg|gFggg',
  'ggIgYg|gggFg',
  'ggEgYg|ggFgg',
  'gFggYg|gggHg',
  'LHggFg|ggFHL',
  'MLPFFPPgPFLM',
] as const;

// --- PVE MAP (Campaign) — authored 12×22 coast → drowned wood → ashlands -----
// Copied VERBATIM from "PVE MAP (Campaign).html" GRID.
const CAMPAIGN_GRID = [
  'AAAAKAAAAKAA',
  'AANAAAAAAANA',
  'MAAAMAAAMAAM',
  'MMAAAAAAAAMM',
  'LMHggggHgMML',
  'gLHgFFgggLHg',
  'ggggFFggggHg',
  'gFggggggFggg',
  'ggggYYggggFg',
  'gFggYYgggggg',
  'ggggggggFggg',
  '~SggFFggggHg',
  '~~SggggggFgg',
  '~~SgggFgggPg',
  '~~~SgggggFgg',
  '~~~SggFgggPg',
  '~~~~SgggggFg',
  '~~~~SggFgggg',
  '~~~~~SgggFgg',
  '~~~~~SgggPgg',
  '~~~~~~SggFgg',
  '~~~~~~SggggP',
] as const;

/** Handout `valleyFrontier` — woods, then foothills, then impassable peaks. */
function valleyFrontier(c: number, r: number, d: number): string {
  const h = hsh(c, r, 1);
  if (d >= 9) return h < 0.55 ? 'K' : 'M';
  if (d >= 6) return h < 0.45 ? 'M' : h < 0.78 ? 'L' : 'P';
  if (d >= 3) return h < 0.34 ? 'P' : h < 0.58 ? 'F' : h < 0.74 ? 'H' : 'g';
  if (hsh(c, r, 7) < 0.06) return '~';
  return h < 0.28 ? 'F' : h < 0.42 ? 'H' : 'g';
}

/** Handout `coastFrontier` — open sea west/south, ashen peaks north/east. */
function coastFrontier(c: number, r: number, d: number): string {
  const h = hsh(c, r, 3);
  if (c < 0) return '~';
  if (r >= CAMPAIGN_GRID.length) return h < 0.72 ? '~' : 'S';
  if (r < 0) return d >= 6 ? (h < 0.5 ? 'K' : 'M') : h < 0.6 ? 'A' : 'M';
  if (d >= 8) return h < 0.5 ? 'K' : 'M';
  if (d >= 5) return h < 0.4 ? 'M' : h < 0.72 ? 'L' : 'P';
  return h < 0.32 ? 'P' : h < 0.6 ? 'F' : h < 0.75 ? 'H' : 'g';
}

const mkTerrain = (grid: readonly string[], frontier: Terrain['frontier']): Terrain => ({
  grid,
  rows: grid.length,
  cols: Math.max(...grid.map((r) => r.length)),
  frontier,
});

export const worldTerrain: Terrain = mkTerrain(WORLD_GRID, valleyFrontier);
export const campaignTerrain: Terrain = mkTerrain(CAMPAIGN_GRID, coastFrontier);

/** Chebyshev distance from the authored grid edge (0 inside; handout `outside`). */
export function outsideDist(t: Terrain, c: number, r: number): number {
  const dx = c < 0 ? -c : c >= t.cols ? c - t.cols + 1 : 0;
  const dy = r < 0 ? -r : r >= t.rows ? r - t.rows + 1 : 0;
  return Math.max(dx, dy);
}

/**
 * Terrain letter at a coordinate (authored grid inside, frontier beyond).
 * `land` forces listed `c,r` keys to grass when the generator says open water —
 * the server places PvP markers anywhere on its own grid, and a keep must
 * never stand in the sea (same guarantee the old flat map gave).
 */
export function genTile(t: Terrain, c: number, r: number, land?: ReadonlySet<string>): string {
  const ch = r >= 0 && r < t.rows && c >= 0 && c < (t.grid[r]?.length ?? 0)
    ? t.grid[r]![c]!
    : t.frontier(c, r, outsideDist(t, c, r));
  if (ch === '~' && land?.has(`${c},${r}`)) return 'g';
  return ch;
}

/** Water-edge autotile (handout `shoreAt`): 8 shoreline frames + open water. */
export function shoreAt(t: Terrain, c: number, r: number, land?: ReadonlySet<string>): string {
  const wet = (cc: number, rr: number): boolean => genTile(t, cc, rr, land) === '~';
  const n = wet(c, r - 1), s = wet(c, r + 1), e = wet(c + 1, r), w = wet(c - 1, r);
  if (n && s && e && w) return 'map_water_c';
  if (!n && !w) return 'map_water_nw';
  if (!n && !e) return 'map_water_ne';
  if (!s && !w) return 'map_water_sw';
  if (!s && !e) return 'map_water_se';
  if (!n) return 'map_water_n';
  if (!s) return 'map_water_s';
  if (!e) return 'map_water_e';
  return 'map_water_w';
}

/** Frame name for a tile (handout `spriteAt`): variants picked by the same
 *  (c*31+r*17)%n hash so the map is stable across renders and sessions. */
export function spriteAt(t: Terrain, c: number, r: number, land?: ReadonlySet<string>): string {
  const ch = genTile(t, c, r, land);
  if (ch === '~') return shoreAt(t, c, r, land);
  const base = TILE_CODE[ch] ?? 'map_grass_1'; // fallback must be a REAL frame (bare map_grass has no master)
  const n = TILE_VARIANTS[ch];
  if (!n) return base;
  const k = (((c * 31 + r * 17) % n) + n) % n;
  return `${base}_${k + 1}`;
}

function grassFrameAt(c: number, r: number): string {
  const count = TILE_VARIANTS.g!;
  const variant = (((c * 31 + r * 17) % count) + count) % count;
  return `map_grass_${variant + 1}`;
}

/**
 * Material below a terrain cell. The handout packed grass into every mountain,
 * forest, road and river PNG, which made each object expose a hard 32px green
 * square over ash or snow. The renderer now paints this material first and a
 * transparent silhouette second.
 *
 * Explicit materials remain authoritative. For an object cell, nearby authored
 * ash beats grass only when ash has the stronger local majority; this keeps the
 * campaign's northern mountains in the ashlands while the same mountain art in
 * the valley stays on grass. Sand letters formed a one-tile staircase down the
 * coast; the connected shoreline already communicates the coast, so those cells
 * use grass instead of drawing a yellow checkerboard.
 */
export function groundFrameAt(
  t: Terrain, c: number, r: number, land?: ReadonlySet<string>,
): string {
  const ch = genTile(t, c, r, land);
  if (ch === '~') return shoreAt(t, c, r, land);
  if (ch === 'A') return 'map_ash';
  if (ch === 'N') return 'map_snow';
  if (ch === 'Y') return 'map_marsh';
  if (ch === 'Q') return 'map_farm';
  if (ch === 'g' || ch === 'S') return grassFrameAt(c, r);

  let ash = 0;
  let grass = 1; // stable tie-break: ordinary objects live on grass
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      if (dx === 0 && dy === 0) continue;
      const neighbour = genTile(t, c + dx, r + dy, land);
      const weight = 4 - Math.max(Math.abs(dx), Math.abs(dy));
      if (neighbour === 'A') ash += weight;
      else if (neighbour === 'g' || neighbour === 'S') grass += weight;
    }
  }
  return ash > grass ? 'map_ash' : grassFrameAt(c, r);
}

/** The authored sand staircase is intentionally suppressed in the board paint;
 * `map_sand` remains a valid atlas asset for other presentation surfaces. */
export function suppressTerrainOverlay(frame: string): boolean {
  return frame === 'map_sand';
}

const DIHEDRAL_GROUND = new Set(['map_ash', 'map_snow']);

/**
 * Eight deterministic presentations for square ground materials whose four
 * border runs are rotation-safe.
 *
 * Ash and snow use a neutral perimeter, so quarter-turns and a horizontal flip
 * preserve every seam. Sand has matching opposite edges but a directional edge
 * sequence, so it deliberately stays untransformed. Varying only safe material
 * presentation prevents a visible 32 px object-stamp grid without changing
 * terrain selection, collision, map coordinates, saves, or gameplay rules.
 */
export function terrainTransformAt(frame: string, c: number, r: number): number {
  if (!DIHEDRAL_GROUND.has(frame)) return 0;
  return Math.floor(hsh(c, r, 29) * 8) & 7;
}

// --- Campaign presentation layout (PVE MAP html, verbatim minus numbers) -----

export interface CampaignAct { act: number; name: string; sub: string; row: number; color: string }
/** Handout act-band tints, one per theme; acts cycle the five themes in order
 *  (coast, marsh, ash, gloam, wastes), so colors cycle with them. */
const ACT_THEME_COLORS = ['#8CB36E', '#E3AE3C', '#C75A2E', '#9B72CF', '#D97B5D'];
/** Act bands drawn across the terrain; `row` is where the divider sits.
 *  Derived from the shared CAMPAIGN config (M23 a2: ten acts of ten) so a
 *  campaign restructure can never leave this list lying about stage ranges. */
export const CAMPAIGN_ACTS: readonly CampaignAct[] = CAMPAIGN.actNames.map((name, i) => ({
  act: i + 1,
  name,
  sub: `STAGES ${i * CAMPAIGN.stagesPerAct + 1}–${(i + 1) * CAMPAIGN.stagesPerAct}`,
  row: 8,
  color: ACT_THEME_COLORS[i % ACT_THEME_COLORS.length]!,
}));

// --- World presentation layout (WORLD MAP html) ------------------------------

export interface WorldZone { row: number; name: string }
/** Decorative valley bands (handout `ZONES` names only — its trophy ranges are
 *  mock numbers; the real server does not band the valley by trophies). */
export const WORLD_ZONES: readonly WorldZone[] = [
  { row: 0, name: 'THE HIGH PASSES' },
  { row: 6, name: 'GREY TARN MIDLANDS' },
  { row: 14, name: 'THE LOWLANDS' },
];
