/**
 * Hosted core tier for the thin Solana Mobile TWA (D-101).
 *
 * This is intentionally an explicit, reviewable list. The core is the smallest
 * build-bound set that can paint the shell, title, HUD and a player's base with
 * every trainable troop represented by its current-art fallback. Rich battle
 * controllers (except the mandatory Nest/Hatchling defense lifecycle),
 * high-density historical atlases and the complete sound bank stay in the full
 * tier and stream only after this set is durable.
 */

const EAGER_ATLAS_GROUPS = [
  'tile', 'bld', 'trp', 'fx', 'ui', 'ovl', 'map', 'dec', 'hero', 'blddef',
  'v2fallback', 'warefallback',
];

// K-009/D-076/D-048: playback gates only actor families named by its event log,
// but any of the 15 trainable families can be that tick-zero actor. All four
// compact tiers plus available local FX are therefore installation core. The
// generated set including every Nest dependency measured about 78.0 MB
// (74.394 MiB) on 2026-09-03, below the 96 MiB wall;
// omitting a non-Dragon family would turn cache state into visible actor motion.
const COMPACT_COMBAT_UNITS = [
  'highlander', 'bowman', 'kegrunner', 'tunneler', 'turrider', 'plunderer',
  'giant', 'troll', 'dragon', 'mage', 'bilgewraith', 'gloamfang',
  'direwyvern', 'hexbarrow', 'barrowling',
];
const COMPACT_FX_UNITS = COMPACT_COMBAT_UNITS.filter(
  (unit) => !['plunderer', 'barrowling', 'direwyvern'].includes(unit),
);
const COMPACT_ATLAS_GROUPS = [1, 2, 3, 4].flatMap((tier) => [
  ...COMPACT_COMBAT_UNITS.map((unit) =>
    `v2${unit === 'hexbarrow' ? 'bld' : 'trp'}_${unit}_t${tier}_combatcore`),
  ...COMPACT_FX_UNITS.map((unit) =>
    `v2${unit === 'hexbarrow' ? 'bld' : 'trp'}_${unit}_t${tier}_compactfx`),
  `v2trp_direwyvern_t${tier}_fx`,
]);
const NEST_ATLAS_GROUPS = [
  'warefx',
  ...[1, 2, 3, 4].flatMap((tier) => [
    `ware_dragonnest_${tier}`,
    `ware_hatchling_${tier}`,
  ]),
];

export const CORE_ASSET_PATHS = new Set([
  '/atlas/meta.json',
  ...EAGER_ATLAS_GROUPS.flatMap((group) => [
    `/atlas/${group}@1x.json`,
    `/atlas/${group}@1x.png`,
  ]),
  ...[...COMPACT_ATLAS_GROUPS, ...NEST_ATLAS_GROUPS].flatMap((group) => [
    `/atlas/${group}@1x.json`,
    `/atlas/${group}@1x.png`,
  ]),
  '/audio/bgmusic-world.mp3',
  '/audio/sfx-ai/manifest.json',
  '/audio/sfx-ai/sfx_ambience_base_day_v1.wav',
  '/audio/sfx-ai/sfx_base_build_complete_v1.mp3',
  '/audio/sfx-ai/sfx_base_place_v1.mp3',
  '/audio/sfx-ai/sfx_base_rubble_collapse_v1.mp3',
  '/audio/sfx-ai/sfx_base_upgrade_hammer_v1.mp3',
  '/audio/sfx-ai/sfx_base_wall_place_v1.mp3',
  '/audio/sfx-ai/sfx_ui_claim_chime_v1.mp3',
  '/audio/sfx-ai/sfx_ui_coin_shower_v1.mp3',
  '/audio/sfx-ai/sfx_ui_confirm_v1.mp3',
  '/audio/sfx-ai/sfx_ui_confirm_v2.mp3',
  '/audio/sfx-ai/sfx_ui_confirm_v3.mp3',
  '/audio/sfx-ai/sfx_ui_error_v1.mp3',
  '/audio/sfx-ai/sfx_ui_error_v2.mp3',
  '/audio/sfx-ai/sfx_ui_error_v3.mp3',
  '/audio/sfx-ai/sfx_ui_levelup_v1.mp3',
  '/audio/sfx-ai/sfx_ui_quest_done_v1.mp3',
  '/audio/sfx-ai/sfx_ui_streak_tick_v1.mp3',
  '/audio/sfx-ai/sfx_ui_tap_v1.mp3',
  '/audio/sfx-ai/sfx_ui_tap_v2.mp3',
  '/audio/sfx-ai/sfx_ui_tap_v3.mp3',
]);

/** Vite hashes every runtime module/embedded asset under /assets. Brand and
 * icons are small and required before authentication, so all three roots are
 * core without trying to predict generated filenames. */
const CORE_ROOTS = ['/assets/', '/brand/', '/icons/'];

export function assetPackTier(path) {
  return CORE_ROOTS.some((prefix) => path.startsWith(prefix))
    || CORE_ASSET_PATHS.has(path)
    ? 'core'
    : 'full';
}
