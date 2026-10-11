/**
 * Icon assets imported directly as vite asset URLs and rendered with
 * image-rendering:pixelated at integer scales by the <Icon> primitive.
 *
 * WHY THESE POINT AT art/game-v4/. The React overlay does NOT read the Phaser
 * atlas — it imports icon files directly — so an atlas rebuild alone leaves the
 * whole HUD on pre-rework art no matter how much of the atlas is replaced. That
 * is exactly how the owner saw a "new" build with an old UI. Every icon with a
 * game-v4 master therefore imports it here, so the React chrome and the game
 * canvas move together. The three exceptions below name their own reason.
 *
 * The masters are read-only (ARCHITECTURE asset rule); paths are four levels up
 * from apps/web/src/ui to the repo root.
 */
import {
  ART_V2, artTierOfLevel, isRetiredRuntimeSpriteKey, isSupersededByWareAlias,
  LEVELED_TROOPS, WARE_PORTRAIT_ART,
} from '@shardkeep/shared';
import { versionedPublicAsset } from '../lib/version';

import builder from '../../../../art/source/builder-workman/south.png';
import attack from '../../../../art/game-v4/ui/legacy-ui_icon_attack.png';
import backpack from '../../../../art/game-v4/ui/legacy-ui_icon_backpack.png';
import close from '../../../../art/game-v4/ui/legacy-ui_icon_close.png';
import energy from '../../../../art/game-v4/ui/legacy-ui_icon_energy.png';
import info from '../../../../art/game-v4/ui/legacy-ui_icon_info.png';
// KEEP currency icon = the NEW batch-13 token logo (art/source/assets-v3/brand_token_logo.svg),
// the same artwork published as the on-chain token metadata image. It supersedes
// the old art/source/assets-v2/ui_icon_keep.svg; both are 24×24 pixel-grid so it stays crisp
// at the 14–24px sizes the HUD/shop/market use. (owner 2026-07-29)
import keep from '../../../../art/source/assets-v3/brand_token_logo.svg';
import layout from '../../../../art/game-v4/ui/legacy-ui_icon_layout.png';
import locate from '../../../../art/game-v4/ui/legacy-ui_icon_locate.png';
import map from '../../../../art/game-v4/ui/legacy-ui_icon_map.png';
import plus from '../../../../art/game-v4/ui/legacy-ui_icon_plus.png';
import powdercharge from '../../../../art/game-v4/ui/legacy-ui_icon_powdercharge.png';
import quest from '../../../../art/game-v4/ui/legacy-ui_icon_quest.png';
import referral from '../../../../art/game-v4/ui/legacy-ui_icon_referral.png';
import replay from '../../../../art/game-v4/ui/legacy-ui_icon_replay.png';
import scout from '../../../../art/game-v4/ui/legacy-ui_icon_scout.png';
import settings from '../../../../art/game-v4/ui/legacy-ui_icon_settings.png';
import shard from '../../../../art/game-v4/ui/legacy-ui_icon_shard.png';
import shield from '../../../../art/game-v4/ui/legacy-ui_icon_shield.png';
import skr from '../../../../art/game-v4/ui/legacy-ui_icon_skr.png';
import sol from '../../../../art/game-v4/ui/legacy-ui_icon_sol.png';
import star from '../../../../art/game-v4/ui/legacy-ui_icon_star.png';
import streak from '../../../../art/game-v4/ui/legacy-ui_icon_streak.png';
import swiftboots from '../../../../art/game-v4/ui/legacy-ui_icon_swiftboots.png';
import timer from '../../../../art/game-v4/ui/legacy-ui_icon_timer.png';
import trophy from '../../../../art/game-v4/ui/legacy-ui_icon_trophy.png';
import warhorn from '../../../../art/game-v4/ui/legacy-ui_icon_warhorn.png';

import emoteGg from '../../../../art/game-v4/ui/legacy-ui_emote_gg.png';
import emoteLaugh from '../../../../art/game-v4/ui/legacy-ui_emote_laugh.png';
import emoteNicewalls from '../../../../art/game-v4/ui/legacy-ui_emote_nicewalls.png';
import emoteOuch from '../../../../art/game-v4/ui/legacy-ui_emote_ouch.png';
import emoteRevenge from '../../../../art/game-v4/ui/legacy-ui_emote_revenge.png';
import emoteSalute from '../../../../art/game-v4/ui/legacy-ui_emote_salute.png';

import barFrame from '../../../../art/game-v4/ui/legacy-ui_bar_frame.png';
import bannerEvent from '../../../../art/game-v4/ui/legacy-ui_banner_event.png';
import portraitFrame from '../../../../art/game-v4/ui/legacy-ui_portrait_frame.png';
import skillRally from '../../../../art/game-v4/ui/legacy-ui_skill_rally.png';
import regionBanner from '../../../../art/source/assets-v2/map_region_banner.svg';
import ruinedKeep from '../../../../art/source/assets-v2/bld_keep_ruined.svg';
// Owner-approved five-tier wall portraits are the same canonical pack pieces
// used by Phaser while contextual neighbors are prepared.
import wallStraightT1 from '../../../../art/source/walls-five-tier/family/t1/pieces/straight.png';
import wallStraightT2 from '../../../../art/source/walls-five-tier/family/t2/pieces/straight.png';
import wallStraightT3 from '../../../../art/source/walls-five-tier/family/t3/pieces/straight.png';
import wallStraightT4 from '../../../../art/source/walls-five-tier/family/t4/pieces/straight.png';
import wallStraightT5 from '../../../../art/source/walls-five-tier/family/t5/pieces/straight.png';
import heroTheoPortrait from '../../../../art/game-v4/portraits/theo/base.png';
import heroTheoPortraitT4 from '../../../../art/game-v4/portraits/theo/t4.png';
import heroVexPortrait from '../../../../art/game-v4/portraits/vex/base.png';
import heroVexPortraitT4 from '../../../../art/game-v4/portraits/vex/t4.png';

/**
 * INLINE PIXEL GLYPHS for the four player-menu rows that have no game-v4
 * master (owner 2026-09-17: "some things do not have icons"). Drawn on the
 * same 16-unit grid as the legacy masters and painted from the HUD's own
 * palette, so they sit beside the PNG icons without a second visual language.
 * A data URI keeps the `<Icon>` contract (an <img src>) and costs the
 * first-paint budget a few hundred bytes each — cheaper than four asset
 * fetches, and there is no atlas frame to borrow. Add a real master to
 * art/game-v4/ui and swap the entry when one is drawn.
 */
function pixelGlyph(body: string): string {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">${body}</svg>`,
  )}`;
}
/** Striped awning over a parchment counter. */
const shop = pixelGlyph(
  '<path fill="#1A171E" d="M1 2h14v1H1zM1 6h14v1H1zM2 7h1v7H2zM13 7h1v7H13zM4 9h8v1H4zM4 13h8v1H4zM4 10h1v3H4zM11 10h1v3H11z"/>'
  + '<path fill="#E3AE3C" d="M1 3h2v3H1zM5 3h2v3H5zM9 3h2v3H9zM13 3h2v3h-2z"/>'
  + '<path fill="#9C6F1E" d="M3 3h2v3H3zM7 3h2v3H7zM11 3h2v3h-2z"/>'
  + '<path fill="#EFE8D6" d="M5 10h6v3H5z"/><path fill="#C4BBA4" d="M5 12h6v1H5z"/>',
);
/** Balance scales: a beam on a post, two hanging pans. */
const market = pixelGlyph(
  '<path fill="#1A171E" d="M7 1h2v1H7zM2 3h12v1H2zM7 4h2v9H7zM5 13h6v1H5zM2 4h1v4H2zM13 4h1v4h-1z"/>'
  + '<path fill="#E3AE3C" d="M3 3h10v1H3zM7 2h2v11H7zM5 13h6v1H5z"/>'
  + '<path fill="#BBD0D6" d="M0 8h5v2H0zM11 8h5v2h-5z"/><path fill="#54677A" d="M0 9h5v1H0zM11 9h5v1h-5z"/>',
);
/** Sealed envelope. */
const mail = pixelGlyph(
  '<path fill="#1A171E" d="M1 3h14v10H1z"/><path fill="#EFE8D6" d="M2 4h12v8H2z"/>'
  + '<path fill="#9C937F" d="M2 4h1v1H2zM3 5h1v1H3zM4 6h1v1H4zM5 7h1v1H5zM6 8h1v1H6zM7 9h2v1H7zM9 8h1v1H9zM10 7h1v1h-1zM11 6h1v1h-1zM12 5h1v1h-1zM13 4h1v1h-1z"/>'
  + '<path fill="#9C6F1E" d="M7 8h2v1H7z"/>',
);
/** Three-point crown, the owner's mark. */
const admin = pixelGlyph(
  '<path fill="#1A171E" d="M1 4h2v1H1zM7 3h2v1H7zM13 4h2v1h-2zM1 5h1v9H1zM14 5h1v9h-1zM2 14h12v1H2z"/>'
  + '<path fill="#E3AE3C" d="M2 5h1v9H2zM7 4h2v10H7zM13 5h1v9h-1zM3 9h4v5H3zM9 9h4v5H9z"/>'
  + '<path fill="#F4D77B" d="M2 5h1v1H2zM7 4h2v1H7zM13 5h1v1h-1z"/>'
  + '<path fill="#9C6F1E" d="M2 13h12v1H2z"/><path fill="#8F2C2C" d="M4 11h2v1H4zM10 11h2v1h-2z"/>',
);

/** ui_icon_* keyed by the App's currency/icon short names. */
/** Native 24px chip; never downsample the inventory master for the HUD. */
export const GEM_ICONS = {
  24: versionedPublicAsset('/items/pe/gem-24.png'),
  32: versionedPublicAsset('/items/pe/gem-32.png'),
  48: versionedPublicAsset('/items/pe/gem-48.png'),
} as const;
export const ICONS = {
  gem: GEM_ICONS[24],
  admin, attack, backpack, builder, close, energy, info, keep, layout, locate, mail, map, market, plus,
  powdercharge, quest, referral, replay, scout, settings, shard, shop,
  shield, skr, sol, star, streak, swiftboots, timer, trophy, warhorn,
} as const;

export type IconName = keyof typeof ICONS;

/** ui_emote_* keyed by the App's emote short names (verbatim emote set). */
export const EMOTES: Array<{ id: string; url: string }> = [
  { id: 'gg', url: emoteGg },
  { id: 'nicewalls', url: emoteNicewalls },
  { id: 'ouch', url: emoteOuch },
  { id: 'revenge', url: emoteRevenge },
  { id: 'salute', url: emoteSalute },
  { id: 'laugh', url: emoteLaugh },
];

export const UI = { barFrame, bannerEvent, portraitFrame, skillRally, regionBanner } as const;

/** React-side assets that have not moved into the generated WARE portrait
 * surface. Replaced building masters are deliberately absent from every glob:
 * a stale `bld_*` URL must not exist in the browser graph for a tray, Codex or
 * lazy screen to select by mistake. Phaser receives those same identities only
 * through the generated exact-current aliases in the eager WARE atlas. */
const spriteModules = {
  // game-v4 troop portraits FIRST so they shadow every legacy pack. Building
  // portraits already reach React as generated /brand/ware/*.png, but the 68
  // v2 TROOP portraits are resolved from these globs, so without this entry the
  // roster keeps showing pre-rework busts while the units themselves are new.
  // Names carry the collection prefix on disk (`v2-v2_ui_portrait_giant_t4`);
  // the loop below strips it back to the runtime name React looks up.
  ...import.meta.glob<string>('../../../../art/game-v4/portraits/v2-v2_ui_portrait_*.png', { query: '?url', import: 'default', eager: true }),
  // Protected rework-v2 pack FIRST (Phase D; note the DOUBLE space in the
  // folder name — it is part of the delivered path), then the expanded owner
  // pack. `spriteByName` is first-win, matching the rasterizer's explicit
  // old-pack precedence: the 16 giant/dragon/cannon/mortar portraits remain
  // byte-for-byte the already-reviewed art while the expanded root contributes
  // the other 52. ONLY tier portraits are globbed; animation grid sheets reach
  // Phaser through generated atlases and would be both unusable in <img> and a
  // first-paint regression here.
  ...import.meta.glob<string>('../../../../art/source/troops-rework-core/assets/ui_portrait_*.svg', { query: '?url', import: 'default', eager: true }),
  ...import.meta.glob<string>('../../../../art/source/troops-rework-expanded/assets/ui_portrait_*.svg', { query: '?url', import: 'default', eager: true }),
  // Only troop portraits from the earlier roster pack have React consumers.
  // Its building bodies are canvas assets and must never enter this graph.
  ...import.meta.glob<string>('../../../../art/source/defense-rework/assets/trp_*_portrait.svg', { query: '?url', import: 'default', eager: true }),
  // assets-v3 next: the batch 11-12 handout masters (keep/forge reworks, heroes,
  // walls, maps, brand) SHADOW the older roots — the same later-source-wins rule
  // rasterize.ts applies to the atlases, so the React UI and the game canvas
  // always show the SAME art (overnight 2026-07-27; the miss surfaced as blank
  // hero cards + stale keep art on React screens, owner 2026-07-28).
  ...import.meta.glob<string>([
    '../../../../art/source/assets-v3/*.svg',
    '!../../../../art/source/assets-v3/bld_*.svg',
    // Wave-2 identity is generated from art/source/brand-wave2/. The immutable prior
    // masters stay as provenance but must not become Vite output candidates.
    '!../../../../art/source/assets-v3/brand_*.svg',
    // Release B promotes the exact approved PNG portraits below. Excluding
    // the four superseded SVGs prevents Vite from shipping both identities.
    '!../../../../art/source/assets-v3/hero_theo_portrait*.svg',
    '!../../../../art/source/assets-v3/hero_vex_portrait*.svg',
    // The skin_ namespace is retired (M23 a8 keep-skin removal). Like the
    // wyrmling rule below, a post-import predicate is too late — the eager
    // glob would still emit every retired skin SVG into the production bundle.
    '!../../../../art/source/assets-v3/skin_*.svg',
  ], { query: '?url', import: 'default', eager: true }),
  ...import.meta.glob<string>([
    '../../../../art/source/assets-v2/*.svg',
    '!../../../../art/source/assets-v2/bld_*.svg',
    '!../../../../art/source/assets-v2/brand_*.svg',
    '!../../../../art/source/assets-v2/skin_*.svg',
  ], { query: '?url', import: 'default', eager: true }),
  ...import.meta.glob<string>([
    '../../../../art/source/expanded-assets/characters/*.svg',
    // Runtime Wyrmling identity now uses the authored WARE Hatchling family.
    // A post-import predicate is too late: an eager glob would still make Vite
    // emit every retired SVG into the production bundle.
    '!../../../../art/source/expanded-assets/characters/trp_wyrmling*.svg',
  ], { query: '?url', import: 'default', eager: true }),
};

/** bare-name (no extension, no dir) → asset url. First occurrence wins, so the
 *  spread order above IS the precedence order (batch 13 > v3 > v2 > NEW assets). */
const spriteByName: Record<string, string> = {};
for (const [path, url] of Object.entries(spriteModules)) {
  // Accept .png as well as .svg: the game-v4 portraits above are PNG masters.
  const file = path.slice(path.lastIndexOf('/') + 1);
  const base = file.replace(/\.(svg|png)$/, '')
    // `v2-v2_ui_portrait_giant_t4` -> `ui_portrait_giant_t4`. The game-v4 tree
    // stores masters under `<collection>-<runtimeKey>`; React looks them up by
    // the bare runtime name, so the prefix has to come off or the entry is dead
    // weight that silently never matches.
    .replace(/^v2-v2_/, '');
  // Defense in depth for future broad globs/manual entries: D-039 leaves the
  // source masters intact, but their names are permanently retired at runtime.
  if (isRetiredRuntimeSpriteKey(base) || isSupersededByWareAlias(base)) continue;
  if (!(base in spriteByName)) spriteByName[base] = url;
}

const warePortraitUnits = new Set<string>(Object.keys(WARE_PORTRAIT_ART));
const WARE_PORTRAIT_KEY = /^ui_portrait_([a-z]+)_t([1-4])$/;

function currentWarePortraitUrl(name: string): string | null {
  const match = WARE_PORTRAIT_KEY.exec(name);
  return match && warePortraitUnits.has(match[1]!)
    ? versionedPublicAsset(`/brand/ware/${name}.png`)
    : null;
}

/** Current authored one-off React previews without a dedicated pack portrait. */
const CURRENT_REACT_SPRITES: Readonly<Record<string, string>> = {
  // The KEEP token is a currency mark, not the app identity; it remains the
  // current on-chain logo while all prior app-brand masters are excluded.
  brand_token_logo: keep,
  bld_keep_ruined: ruinedKeep,
  ui_builder_workman: builder,
  wall5_t1_straight_intact_f1: wallStraightT1,
  wall5_t2_straight_intact_f1: wallStraightT2,
  wall5_t3_straight_intact_f1: wallStraightT3,
  wall5_t4_straight_intact_f1: wallStraightT4,
  wall5_t5_straight_intact_f1: wallStraightT5,
  hero_theo_portrait: heroTheoPortrait,
  hero_theo_portrait_t4: heroTheoPortraitT4,
  hero_vex_portrait: heroVexPortrait,
  hero_vex_portrait_t4: heroVexPortraitT4,
};

/** Resolve any master sprite by its bare name (no extension), e.g.
 * 'trp_highlander_portrait' or 'map_marker_keep_l3'. Returns '' if missing. */
export function sprite(name: string): string {
  const currentPortrait = currentWarePortraitUrl(name);
  if (currentPortrait) return currentPortrait;
  const currentPreview = CURRENT_REACT_SPRITES[name];
  if (currentPreview) return currentPreview;
  if (isSupersededByWareAlias(name)) return '';
  if (isRetiredRuntimeSpriteKey(name)) return '';
  return spriteByName[name] ?? '';
}

/** Troops with per-level portrait art (batch 13) — the shared grouping module,
 *  so React portraits and the atlas pipeline cannot disagree about who is
 *  levelled. */
const LEVELED = new Set<string>(LEVELED_TROOPS);

/** Levels of portrait art batch 13 shipped (trp_<troop>_l1..l20_portrait
 *  masters on disk). An ART-PACK fact, not a game number (HERO_WALK_FRAMES
 *  precedent) — same bound and same rationale as anim.ts LEVELED_ART_LEVELS:
 *  a troop somehow levelled past the art shows the top tier, never a blank. */
const PORTRAIT_ART_LEVELS = 20;

/**
 * The portrait sprite key for a troop.
 *
 * THE LEVEL RULE, decided once, here: pass `level` ONLY when a REAL
 * server-sent level is in scope (GET /army `levels`, a raid's frozen
 * armySnapshot.levels) — that yields `trp_<troop>_l<N>_portrait` for the
 * troops that have per-level art. Screens with no level in scope (generic
 * lists, static copy) pass nothing. For ART_V2 troops that selects the current
 * owner-pack tier-1 portrait as a GENERIC visual baseline — it does not assert
 * that the player owns troop level 1. Troops outside ART_V2 keep their existing
 * level-aware/legacy rules. This distinction prevents stale portraits without
 * inventing a server-authoritative game number.
 */
export function troopPortrait(troop: string, level?: number): string {
  if (troop === 'wyrmling') {
    return `ui_portrait_wyrmling_t${artTierOfLevel(level ?? 1)}`;
  }
  if (level === undefined || !Number.isFinite(level)) {
    if ((ART_V2.troops as readonly string[]).includes(troop)) {
      return `ui_portrait_${troop}_t1`;
    }
    return `trp_${troop}_portrait`;
  }
  // Rework-v2: every authored troop root routes a REAL server level through
  // the shared 4-tier map. This check comes before LEVELED because the expanded
  // pack replaces the formerly unlevelled troop portraits too.
  if ((ART_V2.troops as readonly string[]).includes(troop)) {
    return `ui_portrait_${troop}_t${artTierOfLevel(level)}`;
  }
  if (!LEVELED.has(troop)) return `trp_${troop}_portrait`;
  const l = Math.min(PORTRAIT_ART_LEVELS, Math.max(1, Math.trunc(level)));
  return `trp_${troop}_l${l}_portrait`;
}

// The cannon/mortar tier portraits have exactly two React consumers — the
// build tray (sheets.tsx spriteFor) and the codex (copy.ts) — and neither has
// a building LEVEL in scope, so both name `ui_portrait_<type>_t1` directly;
// no leveled helper exists until a screen actually carries a defence level.
