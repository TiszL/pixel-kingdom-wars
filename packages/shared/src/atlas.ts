/**
 * Which atlas a sprite key belongs to.
 *
 * WHY THIS IS SHARED. The rule used to be one line in two places — a
 * `key.split('_')[0]` in scripts/src/rasterize.ts that decides which atlas a
 * sprite is PACKED into, and a near-copy in apps/web BootScene that decides
 * which atlas a sprite is LOADED FROM. They agreed only by coincidence. Once
 * grouping stopped being "the prefix" (batch 13, below) two copies would have
 * drifted the first time either was touched, and the failure is silent: the
 * client asks a texture that exists for a frame that was packed elsewhere, and
 * Phaser renders nothing at all rather than erroring.
 *
 * The API's Land Deed renderer is the third consumer, which is why this lives
 * in @shardkeep/shared rather than in either app.
 *
 * ── Why grouping is no longer just the prefix ──
 * Batch 13 (dragon/giant/6-defence rework, 1560 masters) broke the one-atlas-
 * per-prefix assumption on measurement, not opinion: packed with the pipeline's
 * own options, the merged `bld` set needs 2 textures and `trp` needs 3, against
 * a hard single-4096²-texture assertion. Two groups are split out:
 *
 *   trpdg_l<N>  the per-level dragon + giant art (54 sprites/level → 1482×1456
 *               at @2x, one texture). Deliberately NOT in the boot set: all 20
 *               levels together are ~150MB of VRAM, while a battle only ever
 *               shows the levels actually deployed. Loaded on demand.
 *   blddef      the seven batch-13 defences, all 20 levels, all states. Base
 *               key + idle frames (`_work_f1` for the six older towers,
 *               `_f1..f4` for the electric tower) + fire frames (`_fire_f1/f2`,
 *               electric `_fire_f1..f4`) MUST land in the same group: a Phaser
 *               animation sequence cannot span two textures.
 *
 * Everything else keeps the historical prefix rule.
 */

import { DEVICE_ART, WARE_WORLD_PRESENTATION } from './constants';

/** The atlas groups packed eagerly and loaded at boot. `skin` was retired with
 *  the keep-skin removal (M23 a8) — see RETIRED_SKIN_RE below. */
export const ATLAS_PREFIXES = [
  'tile', 'bld', 'trp', 'fx', 'ui', 'ovl', 'map', 'dec', 'hero',
  /** Batch-13 defences — eager: these are live base-view buildings. */
  'blddef',
  /** Exact current-v2 startup art, packed only at @1x. */
  'v2fallback',
  /** M22 exact-current damaged/collapse/trap states, authored @1x and drawn @2x. */
  'warefallback',
  /** Accepted five-tier walls, packed at source density and drawn at world scale. */
  'wall5',
] as const;
export type AtlasPrefix = (typeof ATLAS_PREFIXES)[number];

/** The batch-13 defences: six redrawn towers plus the electric tower, which
 *  batch-13 v2 turned into a fully-animated defence (4-frame idle crackle +
 *  4-frame discharge). Their `bld_` keys leave the `bld` atlas, which is what
 *  brings `bld` back under the single-texture cap. The pack's electric keys
 *  SHADOW the 20 legacy 'NEW assets' masters of the same names, so routing by
 *  key name (the only thing this module ever sees) is unambiguous. */
export const B13_DEFENCES = [
  'archertower', 'magetower', 'lasertower', 'dragonnest', 'cannon', 'mortar',
  'electrictower',
] as const;

/** Troops with real per-level art (batch 13), keyed `trp_<troop>_l<N>_…`. */
export const LEVELED_TROOPS = ['dragon', 'giant'] as const;

const DEFENCE_RE = new RegExp(`^bld_(${B13_DEFENCES.join('|')})_l(\\d+)(?:_|$)`);
const LEVELED_TROOP_RE = new RegExp(`^trp_(${LEVELED_TROOPS.join('|')})_l(\\d+)_`);

/**
 * Legacy Mortar frames retired by D-039.
 *
 * These masters remain in their owner-authored source roots for provenance,
 * but no runtime artifact or React resolver may expose them. The protected
 * rework-v2 body, eager fallback loop, FX and portraits use the `v2_` /
 * `ui_portrait_mortar_t<n>` namespaces and are deliberately unaffected.
 */
const RETIRED_LEGACY_MORTAR_RE =
  /^bld_mortar_l(?:[1-9]|1\d|20)(?:$|_(?:work|fire)_f\d+)$/;
const RETIRED_LEGACY_WYRMLING_RE = /^trp_wyrmling(?:_|$)/;
const RETIRED_LEGACY_WYRM_BREATH_RE = /^fx_breath_wyrm(?:ling)?(?:_|$)/;
/** The whole `skin_` namespace (keep skins + never-shipped shop-copy skins)
 *  was retired with the keep-skin removal (owner 2026-08-15, M23 a8). Masters
 *  stay in their owner-authored roots for provenance; no runtime artifact may
 *  expose them, and `skin` left ATLAS_PREFIXES so nothing loads at boot. */
const RETIRED_SKIN_RE = /^skin_/;
/** Accepted wall5 art replaces both the historical alias and rich-wall routes. */
const RETIRED_WALL_RE = /^(?:bld_wall(?:_|$)|ware_bld_wall(?:_|$))/;

export function isRetiredRuntimeSpriteKey(spriteKey: string): boolean {
  return RETIRED_LEGACY_MORTAR_RE.test(spriteKey)
    || RETIRED_LEGACY_WYRMLING_RE.test(spriteKey)
    || RETIRED_LEGACY_WYRM_BREATH_RE.test(spriteKey)
    || RETIRED_SKIN_RE.test(spriteKey)
    || RETIRED_WALL_RE.test(spriteKey);
}

/**
 * Rework-v2 grid pack (batch 14/15, `Giant dragon cannon  mortar rework v2/`):
 * every sliced frame is namespaced `v2_<svg-stem>_…`, so the `v2_` prefix alone
 * decides the branch — no v2 key can collide with a historical prefix (the
 * pipeline asserts zero collisions). Grouping mirrors the trpdg/blddef lesson
 * at tier granularity: one atlas per (unit, tier) so a battle loads only the
 * tiers actually present, and everything directionless-or-shared (projectile
 * travel sets, muzzle/impact/stream FX, scorch decals, tier portraits) lands
 * together in `v2fx`. None of those FULL animation groups are eager — Phase D
 * loads them on demand. `v2fallback` is the deliberate exception: it contains
 * duplicated winning startup frames at @1x — one stand frame per
 * gameplay-active or spawned troop+tier, plus the complete two-frame Mortar
 * idle loop needed before (or after eviction of) its optional rich atlas.
 *
 * The all-troop pack makes four measured exceptions. Every gameplay-active
 * troop keeps its movement clips in a compact sibling locomotion atlas. A
 * rejected complete controller can therefore keep authored current-pack legs
 * moving without admitting its attack/death sheets or exceeding the optional
 * texture budget. Each Direwyvern tier is
 * 19,222,528 raw cell pixels before padding, already larger than the 4096²
 * single-texture cap. Its 64 firestorm frames therefore live in a sibling
 * `<unit-tier>_firestorm` atlas. Maul gets a gameplay-critical `_maul` shard;
 * spawn/hit/death share an optional `_lifecycle` shard. Compact locomotion,
 * maul, firestorm, and a tiny Dire-only FX shard fit alongside protected
 * Cannon+Mortar art under the unchanged 96 MiB decoded-art ceiling. The
 * original hover sheet remains an optional animation enhancement in the
 * now-small base group; compact directional stand aliases cover the required
 * core. Every authored state remains reachable when the enhancement fits, and
 * every clip remains wholly inside one texture.
 */
const V2_UNIT_RE = /^v2_(trp|bld)_([a-z]+)_t(\d+)_/;
const V2_DIREWYVERN_FIRESTORM_RE = /^v2_trp_direwyvern_t(\d+)_firestorm_/;
const V2_DIREWYVERN_FX_RE = /^v2_direwyvern_fx_(?:firestorm|burnfield|impact_slam)_t(\d+)_f\d+$/;
const V2_COMPACT_FX_RE = /^v2_compact_fx_([a-z]+)_t(\d+)_[a-z_]+(?:_d[0-7])?_f\d+$/;
const V2_COMPACT_BODY_RE = /^v2_compact_body_([a-z]+)_t(\d+)_[a-z]+(?:_d[0-7])?_f\d+$/;
const V2_LOCOMOTION_STAND_RE = /^v2_locomotion_stand_([a-z]+)_t(\d+)_d[0-7]$/;
const V2_GLOAMFANG_REND_RE = /^v2_trp_gloamfang_t(\d+)_rend_/;
const V2_GLOAMFANG_REND_FX_RE = /^v2_fx_rend_t(\d+)_f\d+$/;

/** M22's owner-authored building pack is a third, independent grid namespace.
 * It must never be merged into either legacy SVG roots or the protected `v2_`
 * namespace: doing so makes basename precedence decide which silhouette wins. */
const WARE_UNIT_RE = /^ware_(?:bld|trp|unt)_([a-z]+)_(?:t|l)(\d+)_/;

/** Stable database/runtime identity -> immutable pack identity. */
export const WARE_BUILDING_ART = {
  keep: { packUnit: 'keep', progression: 'level' },
  goldforge: { packUnit: 'goldforge', progression: 'level' },
  vault: { packUnit: 'vault', progression: 'tier' },
  barracks: { packUnit: 'barracks', progression: 'tier' },
  forge: { packUnit: 'alchemylab', progression: 'tier' },
  camp: { packUnit: 'camp', progression: 'tier' },
  archertower: { packUnit: 'archer', progression: 'tier' },
  electrictower: { packUnit: 'electrictower', progression: 'tier' },
  magetower: { packUnit: 'magetower', progression: 'tier' },
  lasertower: { packUnit: 'lasertower', progression: 'tier' },
  mine: { packUnit: 'mine', progression: 'tier' },
  clanhall: { packUnit: 'clanhall', progression: 'tier' },
  dragonnest: { packUnit: 'dragonnest', progression: 'tier' },
  airdefence: { packUnit: 'airdefence', progression: 'tier' },
} as const;
export type WareBuildingUnit = keyof typeof WARE_BUILDING_ART;

export const WARE_TRAP_ART = {
  spiketrap: 'armed', powdermine: 'armed', pitfall: 'armed', airmine: 'drift',
} as const;
export type WareTrapUnit = keyof typeof WARE_TRAP_ART;
export type WareWorldPresentationUnit = keyof typeof WARE_WORLD_PRESENTATION;
export type WareWorldPresentation =
  (typeof WARE_WORLD_PRESENTATION)[WareWorldPresentationUnit];
export const WARE_FALLBACK_ATLAS = 'warefallback' as const;

/**
 * Immutable pack identity -> runtime presentation contract. Authoring names
 * differ for Archer Tower and Alchemy Lab, while saved/API identities must not
 * change. Hatchling/portraits deliberately return null: they are not world
 * buildings and must never inherit building-fit scaling.
 */
export function wareWorldPresentationForPackUnit(
  packUnit: string | undefined,
): WareWorldPresentation | null {
  if (!packUnit) return null;
  if (packUnit === 'wall') return WARE_WORLD_PRESENTATION.wall;
  if (Object.prototype.hasOwnProperty.call(WARE_TRAP_ART, packUnit)) {
    return WARE_WORLD_PRESENTATION[packUnit as WareTrapUnit];
  }
  const runtimeUnit = (Object.keys(WARE_BUILDING_ART) as WareBuildingUnit[])
    .find((unit) => WARE_BUILDING_ART[unit].packUnit === packUnit);
  return runtimeUnit ? WARE_WORLD_PRESENTATION[runtimeUnit] : null;
}

export const WARE_PORTRAIT_ART = {
  airdefence: 'airdefence', airmine: 'airmine', forge: 'alchemylab',
  archertower: 'archer', barracks: 'barracks', camp: 'camp', clanhall: 'clanhall',
  dragonnest: 'dragonnest', electrictower: 'electrictower', goldforge: 'goldforge',
  wyrmling: 'hatchling', keep: 'keep', lasertower: 'lasertower',
  magetower: 'magetower', mine: 'mine', pitfall: 'pitfall',
  powdermine: 'powdermine', spiketrap: 'spiketrap', vault: 'vault',
} as const;
export type WarePortraitUnit = keyof typeof WARE_PORTRAIT_ART;

export const WARE_WALL_PIECES = [
  'post', 'end_n', 'end_e', 'corner_sw', 'end_s', 'ns', 'corner_nw', 'tee_e',
  'end_w', 'corner_se', 'straight', 'tee_n', 'corner_ne', 'tee_w', 'tee_s', 'cross',
] as const;

function wareTier(level: number): number {
  return Math.max(1, Math.min(4, Math.ceil(level / 5)));
}

export function wareBuildingAliasKey(unit: WareBuildingUnit, level: number): string {
  return `bld_${unit}_l${Math.max(1, Math.min(20, level))}`;
}

export function wareBuildingIdleFrameKey(unit: WareBuildingUnit, level: number): string {
  const art = WARE_BUILDING_ART[unit];
  const n = art.progression === 'level' ? Math.max(1, Math.min(20, level)) : wareTier(level);
  const direction = unit === 'archertower' || unit === 'lasertower' || unit === 'airdefence'
    ? '_d0'
    : '';
  return `ware_bld_${art.packUnit}_${art.progression === 'level' ? 'l' : 't'}${n}_idle${direction}_f1`;
}

/** Historical four-tier wall alias used only by full-source preflight.
 * Active renderers use wallFrameKey from wallArt/wallRender. */
export function wareWallAliasKey(piece: typeof WARE_WALL_PIECES[number], level: number): string {
  return `bld_wall_${piece}_t${wareTier(level)}`;
}

export function wareWallFrameKey(piece: typeof WARE_WALL_PIECES[number], level: number): string {
  return `ware_bld_wall_${piece}_t${wareTier(level)}_f1`;
}

export function wareTrapAliasKey(unit: WareTrapUnit, level: number): string {
  return `bld_${unit}_l${Math.max(1, Math.min(20, level))}`;
}

export function wareTrapFrameKey(unit: WareTrapUnit, level: number): string {
  return `ware_trp_${unit}_t${wareTier(level)}_${WARE_TRAP_ART[unit]}_f1`;
}

export function wareBuildingStateAliasKey(
  unit: WareBuildingUnit,
  level: number,
  state: 'damaged' | 'collapse',
): string {
  return `bld_${unit}_l${Math.max(1, Math.min(20, level))}_${state}`;
}

export function wareBuildingStateFrameKey(
  unit: WareBuildingUnit,
  level: number,
  state: 'damaged' | 'collapse',
): string {
  const art = WARE_BUILDING_ART[unit];
  const n = art.progression === 'level' ? Math.max(1, Math.min(20, level)) : wareTier(level);
  const direction = unit === 'airdefence' && state === 'damaged' ? '_d0' : '';
  const frame = state === 'damaged' ? 2 : unit === 'airdefence' ? 4 : 5;
  return `ware_bld_${art.packUnit}_${art.progression === 'level' ? 'l' : 't'}${n}_${state}${direction}_f${frame}`;
}

/** Historical level-indexed state alias retained only for immutable-pack
 * validation. No runtime lookup or atlas publication exposes this namespace. */
export function wareWallStateAliasKey(
  piece: typeof WARE_WALL_PIECES[number],
  level: number,
  state: 'damaged' | 'collapse',
): string {
  return `bld_wall_${piece}_t${Math.max(1, Math.min(20, level))}_${state}`;
}

export function wareWallStateFrameKey(
  piece: typeof WARE_WALL_PIECES[number],
  level: number,
  state: 'damaged' | 'collapse',
): string {
  const row = WARE_WALL_PIECES.indexOf(piece);
  return `ware_bld_wall_t${wareTier(level)}_${state}_d${row}_f${state === 'damaged' ? 2 : 4}`;
}

export function wareTrapStateAliasKey(
  unit: WareTrapUnit,
  level: number,
  state: 'hidden' | 'spent',
): string {
  return `bld_${unit}_${state}_l${Math.max(1, Math.min(20, level))}`;
}

export function wareTrapStateFrameKey(
  unit: WareTrapUnit,
  level: number,
  state: 'hidden' | 'spent',
): string {
  const packState = state === 'spent' ? 'sprung' : unit === 'airmine' ? 'drift' : 'hidden';
  return `ware_trp_${unit}_t${wareTier(level)}_${packState}_f1`;
}

export function warePortraitAliasKey(unit: WarePortraitUnit, tier: number): string {
  return `ui_portrait_${unit}_t${Math.max(1, Math.min(4, tier))}`;
}

export function warePortraitFrameKey(unit: WarePortraitUnit, tier: number): string {
  return `ware_ui_portrait_${WARE_PORTRAIT_ART[unit]}_t${Math.max(1, Math.min(4, tier))}_f1`;
}

/** Eager exact hatchling pose used until/after the optional rich lifecycle group. */
export function wareHatchlingFallbackKey(tier: number): string {
  return `ware_fallback_hatchling_t${Math.max(1, Math.min(4, tier))}`;
}

export function wareHatchlingFallbackSourceFrameKey(tier: number): string {
  return `ware_unt_hatchling_t${Math.max(1, Math.min(4, tier))}_hover_d0_f1`;
}

/** Full historical inventory for source/overlay preflight. Runtime registration
 * passes false so retired wall aliases are neither constructed nor registered. */
export function wareCurrentArtAliases(includeHistoricalWalls = true): ReadonlyArray<{ aliasKey: string; sourceFrameKey: string }> {
  const aliases: { aliasKey: string; sourceFrameKey: string }[] = [];
  for (const unit of Object.keys(WARE_BUILDING_ART) as WareBuildingUnit[]) {
    for (let level = 1; level <= 20; level++) {
      aliases.push({
        aliasKey: wareBuildingAliasKey(unit, level),
        sourceFrameKey: wareBuildingIdleFrameKey(unit, level),
      });
      for (const state of ['damaged', 'collapse'] as const) aliases.push({
        aliasKey: wareBuildingStateAliasKey(unit, level, state),
        sourceFrameKey: wareBuildingStateFrameKey(unit, level, state),
      });
    }
  }
  if (includeHistoricalWalls) for (const piece of WARE_WALL_PIECES) {
    for (let n = 1; n <= 20; n++) {
      // Historical K-053 contract only: the first four intact suffixes meant
      // visual tiers; later spellings meant levels. Preserve exact source
      // validation without exposing these aliases in the active runtime set.
      aliases.push({
        aliasKey: `bld_wall_${piece}_t${n}`,
        sourceFrameKey: wareWallFrameKey(piece, n <= 4 ? n * 5 : n),
      });
      for (const state of ['damaged', 'collapse'] as const) aliases.push({
        aliasKey: wareWallStateAliasKey(piece, n, state),
        sourceFrameKey: wareWallStateFrameKey(piece, n, state),
      });
    }
  }
  for (const unit of Object.keys(WARE_TRAP_ART) as WareTrapUnit[]) {
    for (let level = 1; level <= 20; level++) {
      aliases.push({
        aliasKey: wareTrapAliasKey(unit, level), sourceFrameKey: wareTrapFrameKey(unit, level),
      });
      for (const state of ['hidden', 'spent'] as const) aliases.push({
        aliasKey: wareTrapStateAliasKey(unit, level, state),
        sourceFrameKey: wareTrapStateFrameKey(unit, level, state),
      });
    }
  }
  // The existing renderer has one pre-levelled Spike Trap key.
  aliases.push({ aliasKey: 'bld_spiketrap_armed', sourceFrameKey: wareTrapFrameKey('spiketrap', 1) });
  for (const unit of Object.keys(WARE_PORTRAIT_ART) as WarePortraitUnit[]) {
    for (let tier = 1; tier <= 4; tier++) aliases.push({
      aliasKey: warePortraitAliasKey(unit, tier), sourceFrameKey: warePortraitFrameKey(unit, tier),
    });
  }
  aliases.push(
    { aliasKey: 'ui_icon_keeptoken', sourceFrameKey: 'ware_ui_icon_keeptoken_f1' },
    { aliasKey: 'fx_arrow', sourceFrameKey: 'ware_fx_arrow_d0_f1' },
  );
  for (let tier = 1; tier <= 4; tier++) aliases.push({
    aliasKey: wareHatchlingFallbackKey(tier),
    sourceFrameKey: wareHatchlingFallbackSourceFrameKey(tier),
  });
  return aliases;
}

const WARE_CURRENT_ALIAS_KEYS = new Set(wareCurrentArtAliases(false).map(({ aliasKey }) => aliasKey));

export function isSupersededByWareAlias(spriteKey: string): boolean {
  return WARE_CURRENT_ALIAS_KEYS.has(spriteKey);
}

/** Historical source families wholly replaced by M22 WARE art. This predicate
 * is deliberately broader than the exact alias set: it removes obsolete
 * animation siblings before packing, while the pipeline later reintroduces
 * only the approved exact keys with pixels copied from the immutable pack. */
export function isSupersededWareSourceSpriteKey(spriteKey: string): boolean {
  if (spriteKey === 'bld_keep_ruined') return false;
  return /^bld_(?:keep|goldforge|vault|barracks|forge|camp|archertower|electrictower|magetower|lasertower|mine|clanhall|dragonnest|airdefence)_l\d+(?:_|$)/.test(spriteKey)
    || /^bld_(?:spiketrap|powdermine|pitfall|airmine)(?:_|$)/.test(spriteKey)
    || /^bld_wall(?:_|$)/.test(spriteKey);
}

export function v2GloamfangCombatAtlasGroup(tier: number): string {
  return `v2trp_gloamfang_t${tier}_combat`;
}

/**
 * Current-art state copied into the eager fallback atlas for every trainable
 * or spawned v2 troop. Barrowling is spawn-only but still renders in replays.
 */
export const V2_FALLBACK_STAND_STATES = {
  highlander: 'idle', bowman: 'idle', kegrunner: 'idle', tunneler: 'idle',
  turrider: 'idle', plunderer: 'idle', giant: 'idle', troll: 'idle',
  dragon: 'hover', mage: 'idle', bilgewraith: 'idle',
  gloamfang: 'prowl', direwyvern: 'hover', hexbarrow: 'idle', barrowling: 'scurry',
} as const;
export type V2FallbackUnit = keyof typeof V2_FALLBACK_STAND_STATES;
export const V2_FALLBACK_ATLAS = 'v2fallback' as const;

/**
 * Exact-current fixed-building art that must exist before optional tier atlases
 * load: neither tower may ever render its superseded batch-13 `bld_<t>_l<N>`
 * silhouette, because visibly flashing it makes the same building change
 * identity. Both idle frames are copied so home ambience stays animated even
 * when the rich atlas is evicted. Mortar always had this; Cannon joined on
 * 2026-08-16 (owner: "old cannon loaded in assets in campaign bases map") —
 * its eager alias used to be the LEGACY sprite, so any battle whose on-demand
 * `v2bld_cannon_t<n>` load was rejected by the decoded-texture budget (typical
 * for campaign stages whose tier differs from the home base's resident pair)
 * showed the old cannon for the whole fight. With the truthful still in the
 * eager set, a rejected rich load degrades to CURRENT art.
 */
export const V2_BUILDING_FALLBACKS = {
  cannon: { state: 'idle', frames: 2 },
  mortar: { state: 'idle', frames: 2 },
} as const;
export type V2BuildingFallbackUnit = keyof typeof V2_BUILDING_FALLBACKS;

/** Stable eager alias for one frame of an approved fixed-building idle loop. */
export function v2BuildingFallbackFrameKey(
  unit: V2BuildingFallbackUnit,
  tier: number,
  frame: number,
): string {
  const state = V2_BUILDING_FALLBACKS[unit].state;
  return `v2_fallback_bld_${unit}_t${tier}_${state}_d0_f${frame}`;
}

/** Optional lifecycle bodies; maul is isolated because it is gameplay-critical. */
export const V2_DIREWYVERN_LIFECYCLE_STATES = [
  'spawn', 'hit', 'death',
] as const;

/** FX duplicated for a Dire-only controller; originals stay in shared v2fx. */
export const V2_DIREWYVERN_FX_STATES = [
  'firestorm', 'burnfield', 'impact_slam',
] as const;
export type V2DirewyvernFxState = typeof V2_DIREWYVERN_FX_STATES[number];

/**
 * The minimum current-pack projectile/effect families a locomotion fallback
 * needs in battle. They are duplicated into tiny per-unit/tier groups so a
 * rejected rich controller never falls through to an old projectile sheet.
 * Direwyvern keeps its separately measured local aliases below.
 */
export const V2_COMPACT_TROOP_FX_STATES = {
  highlander: ['sweep'],
  bowman: ['arrow', 'shadow', 'impact_burn'],
  kegrunner: ['keg_blast'],
  tunneler: ['pick_hit', 'soil'],
  turrider: ['lance_hit', 'dust'],
  plunderer: [],
  giant: ['impact_slam', 'dust', 'boulder', 'shadow', 'impact_rubble'],
  troll: ['sweep', 'impact_slam', 'dust'],
  dragon: ['breath', 'stream_root', 'stream_mid', 'stream_tip', 'impact_burn'],
  mage: ['castflash', 'bolt', 'bolt_hit'],
  bilgewraith: ['slash', 'soil'],
  gloamfang: ['howl', 'dust', 'rend'],
  hexbarrow: ['hexshot', 'shadow', 'impact_crater'],
  barrowling: [],
} as const;
export type V2CompactTroopFxUnit = keyof typeof V2_COMPACT_TROOP_FX_STATES;
export type V2CompactTroopFxState =
  typeof V2_COMPACT_TROOP_FX_STATES[V2CompactTroopFxUnit][number];

function isV2CompactTroopFxUnit(unit: string): unit is V2CompactTroopFxUnit {
  return Object.prototype.hasOwnProperty.call(V2_COMPACT_TROOP_FX_STATES, unit);
}

function v2FxSourceBaseKey(fx: string, tier: number): string {
  return fx === 'shadow' || fx === 'dust' ? `v2_fx_${fx}` : `v2_fx_${fx}_t${tier}`;
}

function v2CompactTroopFxAtlasGroup(unit: V2CompactTroopFxUnit, tier: number): string {
  const kind = unit === 'hexbarrow' ? 'bld' : 'trp';
  return `v2${kind}_${unit}_t${tier}_compactfx`;
}

/** Behavior-complete body atlas used as the mandatory mobile combat core. */
export function v2CompactCombatAtlasGroup(unit: V2FallbackUnit, tier: number): string {
  const kind = unit === 'hexbarrow' ? 'bld' : 'trp';
  return `v2${kind}_${unit}_t${tier}_combatcore`;
}

/** Dire's unusually large 304×208 cells use a quarter-linear core; all other
 * roots use half-linear. Both are integer nearest-neighbour scales at runtime. */
export function v2CompactCombatDownsample(unit: V2FallbackUnit): 2 | 4 {
  return unit === 'direwyvern' ? 4 : 2;
}

export function v2CompactCombatBaseKey(
  unit: V2FallbackUnit,
  tier: number,
  state: string,
): string {
  return `v2_compact_body_${unit}_t${tier}_${state}`;
}

export function v2CompactCombatFrameKey(
  unit: V2FallbackUnit,
  tier: number,
  state: string,
  row: number,
  frame: number,
  rows = 8,
): string {
  const base = v2CompactCombatBaseKey(unit, tier, state);
  return rows > 1 ? `${base}_d${row}_f${frame}` : `${base}_f${frame}`;
}

/** Compact FX dependencies for one fallback controller; unsupported units need none. */
export function v2TroopFallbackFxAtlasGroups(unit: string, tier: number): string[] {
  if (unit === 'direwyvern') return [v2DirewyvernFxAtlasGroup(tier)];
  return isV2CompactTroopFxUnit(unit) && V2_COMPACT_TROOP_FX_STATES[unit].length > 0
    ? [v2CompactTroopFxAtlasGroup(unit, tier)]
    : [];
}

/**
 * Map an original metadata base (for example `v2_fx_boulder_t2`) to the alias
 * base in that unit's compact texture. Returning null makes unsupported or
 * cross-tier requests fail closed instead of selecting another unit's art.
 */
export function v2TroopFallbackFxBaseKey(
  unit: string,
  tier: number,
  metaBase: string,
): string | null {
  if (unit === 'direwyvern') {
    const fx = V2_DIREWYVERN_FX_STATES.find(
      (state) => v2FxSourceBaseKey(state, tier) === metaBase,
    );
    return fx ? v2DirewyvernFxBaseKey(fx, tier) : null;
  }
  if (!isV2CompactTroopFxUnit(unit)) return null;
  const fx = (V2_COMPACT_TROOP_FX_STATES[unit] as readonly string[]).find(
    (state) => v2FxSourceBaseKey(state, tier) === metaBase,
  );
  return fx ? `v2_compact_fx_${unit}_t${tier}_${fx}` : null;
}

export function v2DirewyvernMaulAtlasGroup(tier: number): string {
  return `v2trp_direwyvern_t${tier}_maul`;
}

export function v2DirewyvernLifecycleAtlasGroup(tier: number): string {
  return `v2trp_direwyvern_t${tier}_lifecycle`;
}

export function v2DirewyvernFxAtlasGroup(tier: number): string {
  return `v2trp_direwyvern_t${tier}_fx`;
}

export function v2DirewyvernFxBaseKey(fx: V2DirewyvernFxState, tier: number): string {
  return `v2_direwyvern_fx_${fx}_t${tier}`;
}

export function v2DirewyvernFxFrameKey(
  fx: V2DirewyvernFxState,
  tier: number,
  frame: number,
): string {
  return `${v2DirewyvernFxBaseKey(fx, tier)}_f${frame}`;
}

/**
 * Current-pack movement clips that remain animated when a complete troop controller is
 * over the on-demand residency budget. This is deliberately the same rendered
 * root set as the eager stand aliases above, including spawn-only Barrowlings.
 * Tur Rider includes both
 * base `walk` and battle `charge` so neither scene silently changes its verb.
 */
export const V2_FALLBACK_LOCOMOTION_STATES = {
  highlander: ['walk'],
  bowman: ['walk'],
  kegrunner: ['run'],
  tunneler: ['walk'],
  turrider: ['walk', 'charge'],
  plunderer: ['walk'],
  giant: ['walk'],
  troll: ['walk'],
  dragon: ['fly'],
  mage: ['walk'],
  bilgewraith: ['walk'],
  gloamfang: ['prowl'],
  direwyvern: ['glide'],
  hexbarrow: ['roll'],
  barrowling: ['scurry'],
} as const satisfies Record<V2FallbackUnit, readonly string[]>;

/** Every currently truthful body verb required during combat. This deliberately
 * excludes delivered-but-dormant mechanics (whirl, rear, loot/walkfull,
 * channel, spit) and defender-only Wyrmling. The packer copies these frames
 * into the mandatory reduced-resolution combat core; rich sheets remain optional. */
export const V2_COMPACT_COMBAT_STATES = {
  highlander: ['walk', 'idle', 'attack', 'spawn', 'hit', 'death'],
  bowman: ['walk', 'idle', 'draw', 'loose', 'spawn', 'hit', 'death'],
  kegrunner: ['run', 'idle', 'prime', 'spawn', 'hit', 'detonate'],
  tunneler: ['walk', 'idle', 'attack', 'hit', 'death', 'burrow', 'tunnel', 'surface'],
  turrider: ['walk', 'charge', 'idle', 'attack', 'spawn', 'hit', 'death'],
  plunderer: ['walk', 'idle', 'attack', 'spawn', 'hit', 'death'],
  giant: ['walk', 'idle', 'attack', 'throw', 'spawn', 'hit', 'death'],
  troll: ['walk', 'idle', 'attack', 'pound', 'spawn', 'hit', 'death'],
  dragon: ['fly', 'hover', 'breath', 'spawn', 'hit', 'death'],
  mage: ['walk', 'idle', 'cast', 'spawn', 'hit', 'death'],
  bilgewraith: ['walk', 'idle', 'attack', 'hit', 'death', 'burrow', 'tunnel', 'surface'],
  gloamfang: ['prowl', 'rend', 'howl', 'leap', 'lunge', 'spawn', 'hit', 'death'],
  direwyvern: ['glide', 'hover', 'firestorm', 'maul', 'spawn', 'hit', 'death'],
  hexbarrow: ['roll', 'idle', 'fire', 'disgorge', 'damaged', 'collapse'],
  barrowling: ['scurry', 'claw', 'spawn', 'hit', 'death'],
} as const satisfies Record<V2FallbackUnit, readonly string[]>;

/** Per-tier on-demand atlas containing only an active troop's locomotion. */
export function v2LocomotionAtlasGroup(unit: V2FallbackUnit, tier: number): string {
  const kind = unit === 'hexbarrow' ? 'bld' : 'trp';
  return `v2${kind}_${unit}_t${tier}_locomotion`;
}

/** Gameplay-critical Dire set, sized to fit after protected Cannon+Mortar art. */
export function v2DirewyvernCoreAtlasGroups(tier: number): string[] {
  const base = `v2trp_direwyvern_t${tier}`;
  return [
    v2LocomotionAtlasGroup('direwyvern', tier),
    v2DirewyvernMaulAtlasGroup(tier),
    `${base}_firestorm`,
    v2DirewyvernFxAtlasGroup(tier),
  ];
}

/** Optional animated-hover + lifecycle enhancement groups. */
export function v2DirewyvernEnhancementAtlasGroups(tier: number): string[] {
  return [
    `v2trp_direwyvern_t${tier}`,
    v2DirewyvernLifecycleAtlasGroup(tier),
  ];
}

/** Every authored Dire body/FX group, for reverse-reachability audits. */
export function v2DirewyvernControllerAtlasGroups(tier: number): string[] {
  return [
    ...v2DirewyvernCoreAtlasGroups(tier),
    ...v2DirewyvernEnhancementAtlasGroups(tier),
  ];
}

/** Directional first stand frame copied into the compact locomotion group. */
export function v2LocomotionStandFrameKey(
  unit: V2FallbackUnit,
  tier: number,
  row: number,
): string {
  return `v2_locomotion_stand_${unit}_t${tier}_d${row}`;
}

export function isV2FallbackUnit(unit: string): unit is V2FallbackUnit {
  return Object.prototype.hasOwnProperty.call(V2_FALLBACK_STAND_STATES, unit);
}

/** Stable alias for the single winning stand frame copied at asset-build time. */
export function v2FallbackFrameKey(unit: V2FallbackUnit, tier: number): string {
  return `v2_fallback_${unit}_t${tier}`;
}

/** Eager atlases are historical @2x, except the deliberately small v2 fallback. */
export function eagerAtlasScale(group: string): 1 | 2 {
  return group === V2_FALLBACK_ATLAS || group === WARE_FALLBACK_ATLAS || group === 'wall5' || group === 'builder' || group === 'pe_cosmetics' || group === 'pe_fleet_starter' || /^pe_harvester_(?:frostveil|elderwood|sunscar|crownlands|seeker_reach|stormcairn|thornwake|cinderfall)_t[1-4]$/.test(group) || /^pe_(?:market|workshop|lodge)_t[1-4]$/.test(group) || /^pe_(?:veh_(?:survey_balloon|cargo_cutter|courier_airship|expedition_barge)_t[1-4]|berth_(?:survey_balloon|cargo_cutter|courier_airship|expedition_barge))$/.test(group) ? 1 : 2;
}

/** D-101 residency: a constrained device (Solana-Mobile marker, low memory or
 *  few cores, `?art=1x`) draws the historical atlases from their @1x files. */
export type DeviceArtProfile = 'constrained' | 'full';

/**
 * The atlas FILE a device profile fetches for a group. This changes texel
 * density only: `eagerAtlasScale` stays the group's frame-coordinate space
 * (the client world is @2x — 64 world px per tile), and the web stitch draws a
 * @1x file into those same @2x frame rects, so anchors, `sourceScale`,
 * `offsetGamePx` and the baked KEEP-clock pivots are never re-resolved. The
 * two current-art fallbacks are packed @1x only and are unaffected.
 */
export function deviceAtlasScale(group: string, profile: DeviceArtProfile): 1 | 2 {
  const scale = eagerAtlasScale(group);
  return profile === 'constrained' && scale === 2 ? DEVICE_ART.constrainedEagerScale : scale;
}

/** The on-demand atlas group holding one level of dragon + giant art. */
export function trpdgGroup(level: number): string {
  return `trpdg_l${level}`;
}

/** Parse a `trpdg_l<N>` group name back to its level. null if not one. */
export function trpdgLevel(group: string): number | null {
  const m = /^trpdg_l(\d+)$/.exec(group);
  return m ? Number(m[1]) : null;
}

/**
 * The atlas group a sprite key is packed into and loaded from.
 *
 * Returns a plain string, not AtlasPrefix, because `trpdg_l<N>` groups are
 * per-level and open-ended. Unknown prefixes fall back to 'ui' — the historical
 * behaviour, kept deliberately: BootScene has always done this and several UI
 * keys rely on it.
 */
export function atlasGroupFor(spriteKey: string): string {
  const harvester = /^(pe_harvester_(?:frostveil|elderwood|sunscar|crownlands|seeker_reach|stormcairn|thornwake|cinderfall)_t[1-4])_(?:(?:idle|damaged|ready|destroyed)_f1|(?:working|construction|collapse)_f[1-9])$/.exec(spriteKey);
  if (harvester) return harvester[1]!;
  const advanced = /^(pe_veh_(?:survey_balloon|cargo_cutter|courier_airship|expedition_barge)_t[1-4])_(?:idle|docked|travel|exhausted)_f[1-9]\d*$/.exec(spriteKey)
    ?? /^(pe_berth_(?:survey_balloon|cargo_cutter|courier_airship|expedition_barge))_(?:intact|damaged|destroyed|ambient)_f[1-9]\d*$/.exec(spriteKey);
  if (advanced) return advanced[1]!;
  if (/^(?:pe_veh_starter_(?:idle|docked|travel)|pe_berth_starter_(?:intact|damaged|destroyed|ambient)|pe_fx_(?:departure|return)(?:_still)?)_f[1-9]\d*$/.test(spriteKey)) return 'pe_fleet_starter';
  if (spriteKey.startsWith('pe_cos_')) return 'pe_cosmetics';
  const service = /^(pe_(?:workshop|lodge)_t[1-4])_(?:idle|working|damaged|ready|destroyed|construction|collapse|ready_fx)_f[1-9]\d*$/.exec(spriteKey);
  if (service) return service[1]!;
  const market = /^(pe_market_t[1-4])_/.exec(spriteKey);
  if (market) return market[1]!;
  if (spriteKey.startsWith('builder_')) return 'builder';
  if (spriteKey.startsWith('wall5_')) return 'wall5';
  if (RETIRED_WALL_RE.test(spriteKey)) return 'retired';
  if (spriteKey.startsWith('ware_')) {
    if (spriteKey.startsWith('ware_fallback_')) return WARE_FALLBACK_ATLAS;
    if (spriteKey.startsWith('ware_ui_')) return 'wareui';
    if (spriteKey.startsWith('ware_fx_')) return 'warefx';
    const match = WARE_UNIT_RE.exec(spriteKey);
    return match ? `ware_${match[1]}_${match[2]}` : 'warefx';
  }
  if (/^bld_[a-z]+_l\d+_(?:damaged|collapse)$/.test(spriteKey)
    || /^bld_[a-z]+_(?:hidden|spent)_l\d+$/.test(spriteKey)) {
    return WARE_FALLBACK_ATLAS;
  }
  if (spriteKey.startsWith('v2_')) {
    if (spriteKey.startsWith('v2_fallback_')) return V2_FALLBACK_ATLAS;
    const direFx = V2_DIREWYVERN_FX_RE.exec(spriteKey);
    if (direFx) return v2DirewyvernFxAtlasGroup(Number(direFx[1]));
    const compactFx = V2_COMPACT_FX_RE.exec(spriteKey);
    if (compactFx && isV2CompactTroopFxUnit(compactFx[1]!)) {
      return v2CompactTroopFxAtlasGroup(compactFx[1], Number(compactFx[2]));
    }
    const compactBody = V2_COMPACT_BODY_RE.exec(spriteKey);
    if (compactBody && isV2FallbackUnit(compactBody[1]!)) {
      return v2CompactCombatAtlasGroup(compactBody[1], Number(compactBody[2]));
    }
    const locomotionStand = V2_LOCOMOTION_STAND_RE.exec(spriteKey);
    if (locomotionStand && isV2FallbackUnit(locomotionStand[1]!)) {
      return v2LocomotionAtlasGroup(locomotionStand[1], Number(locomotionStand[2]));
    }
    const gloamRend = V2_GLOAMFANG_REND_RE.exec(spriteKey);
    if (gloamRend) return v2GloamfangCombatAtlasGroup(Number(gloamRend[1]));
    const gloamRendFx = V2_GLOAMFANG_REND_FX_RE.exec(spriteKey);
    if (gloamRendFx) return v2GloamfangCombatAtlasGroup(Number(gloamRendFx[1]));
    const firestorm = V2_DIREWYVERN_FIRESTORM_RE.exec(spriteKey);
    if (firestorm) return `v2trp_direwyvern_t${firestorm[1]}_firestorm`;
    const m = V2_UNIT_RE.exec(spriteKey);
    if (m && isV2FallbackUnit(m[2]!)) {
      const stateStart = `v2_${m[1]}_${m[2]}_t${m[3]}_`;
      const state = spriteKey.slice(stateStart.length).split('_', 1)[0]!;
      if (m[2] === 'direwyvern' && state === 'maul') {
        return v2DirewyvernMaulAtlasGroup(Number(m[3]));
      }
      if (m[2] === 'direwyvern'
        && (V2_DIREWYVERN_LIFECYCLE_STATES as readonly string[]).includes(state)) {
        return v2DirewyvernLifecycleAtlasGroup(Number(m[3]));
      }
      if ((V2_FALLBACK_LOCOMOTION_STATES[m[2]] as readonly string[]).includes(state)) {
        return v2LocomotionAtlasGroup(m[2], Number(m[3]));
      }
    }
    return m ? `v2${m[1]}_${m[2]}_t${m[3]}` : 'v2fx';
  }
  const lv = LEVELED_TROOP_RE.exec(spriteKey);
  if (lv) return trpdgGroup(Number(lv[2]));
  if (DEFENCE_RE.test(spriteKey)) return 'blddef';
  const prefix = spriteKey.split('_', 1)[0] as AtlasPrefix;
  return (ATLAS_PREFIXES as readonly string[]).includes(prefix) ? prefix : 'ui';
}
