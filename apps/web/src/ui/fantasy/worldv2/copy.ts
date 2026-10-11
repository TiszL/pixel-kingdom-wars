/**
 * World v2 player copy (D-186): every word the web world's HUD shows, kept in one module so
 * `hud/copy.test.ts` can keep pre-decision copy away from players.
 *
 * Sources: native 0.6.0 (`globe-native` 7b5075b: GlobeHud.kt, ParcelCard.kt,
 * RealmMapHud.kt, PhaseEIslands.kt, WorldHudState.kt), the concept at 8acdf059 (main.js,
 * realm/ui.js, landmarks.js) and the owner's 2026-09-26 player-copy calls (island kicker,
 * "You can attack", one naming rule).
 *
 * Presentation only. A figure shown to players comes from `@shardkeep/shared` constants or a
 * server read, never from a literal here (CLAUDE.md constants rule; the island notes read
 * PHASE_E_POLICY, which Codex owns and this module only reads).
 */
import { PHASE_E_CHARTER_TOURNAMENT, PHASE_E_DIVINE_TRIALS, PHASE_E_POLICY, STRUCTURES } from '@shardkeep/shared';
import { fmtN } from '../../primitives';

export const WORLD_COPY = {
  header: { title: 'WORLD MAP', subtitle: 'Shattered Realms', back: 'BASE', backLabel: 'Back to base', campaign: 'CAMPAIGN' },
  hint: 'Drag to spin · pinch to zoom · tap a realm',
  diveFailed: 'This realm map could not load — tap Enter map to retry',
  globeSearch: { label: 'Find a keeper', placeholder: 'Find a keeper…', none: 'No keeper by that name', unavailable: 'Search unavailable', retry: 'Retry', close: 'Close search' },
  realmSearch: { label: 'Search kingdoms', placeholder: 'Search kingdoms', none: 'No kingdom by that name', close: 'Close search' },
  rail: { label: 'Realms and islands', mapOpen: 'realm map open', yourBases: 'your bases' },
  realmPanel: {
    enterMap: 'Enter map', myBase: 'My base', chooseLand: 'Choose land here', noOpenLand: 'No open land',
    noMap: 'No map yet', preparing: (percent: number) => `Preparing ${percent}%`, preparingLabel: 'Preparing the realm map',
    reservedTitle: 'Reserved allocation',
    reservedBody: 'Genesis and Seeker owner allocations remain reserved. Awards and claims are not open.',
  },
  stats: { deeds: 'Deeds', kingdoms: 'Kingdoms', open: 'Open deeds', mine: 'Your bases', genesis: 'Genesis', seeker: 'Seeker' },
  island: { kicker: 'ISLAND · COMING SOON', soon: 'Coming soon', mapLabel: 'Island map: coming soon' },
  panel: { expand: 'Expand details', collapse: 'Collapse details' },
  realmMap: {
    exit: 'Globe', exitLabel: 'Back to globe', filters: 'Filters',
    all: 'All', mine: 'Mine', unshielded: 'Unshielded', unshieldedShort: 'No shield',
    minLevel: 'Minimum keep level', maxLevel: 'Maximum keep level',
    goTo: (realm: string) => `Go to ${realm}`,
    warzone: 'WARZONE', warzoneShow: 'Warzone status', warzoneHide: 'Hide warzone status',
  },
  card: {
    close: 'Close', openBase: 'Open base', manageDeed: 'Manage deed', chooseLand: 'Choose land', chooseThisLand: 'Choose this land',
    scout: 'Scout', raid: 'Raid', retry: 'Retry', lookCloser: 'Look closer', viewDeed: 'View deed',
    openDeed: 'Open deed', yourDeed: 'Your deed', deedAt: (x: number, y: number) => `Deed ${x}, ${y}`,
    wild: 'No kingdom yet · wild land', held: 'Another checkout currently holds this parcel.',
    reserved: (allocation: string) => `${allocation.toUpperCase()} reserve · not available for ordinary purchase.`,
    assigned: 'This land is already assigned. Its base is not currently available for inspection.',
    loading: 'Loading details…', checking: 'Checking this parcel…',
    keepLevel: 'Keep level', realm: 'Realm', parcel: 'Parcel', trophies: 'Trophies', clan: 'Clan', actions: 'Base actions',
  },
  tags: { attack: 'You can attack', suppressed: 'Shield suppressed', yours: 'Your base', shielded: 'Shielded' },
  /** The exploration chains (the host's EXPLORE panel words): gameplay destinations, never owned. */
  explore: {
    kicker: 'FUTURE RESOURCE EXPEDITIONS', title: 'The outer archipelagos',
    lore: (chains: number) => `${fmtN(chains)} island chains lie beyond the realm coastlines. These gameplay destinations cannot be owned.`,
    chain: (islands: number) => `${fmtN(islands)} islands · exploration locked`,
    island: (chain: string, n: number) => `${chain} · Island ${n}`, all: 'All archipelagos', overview: 'Chain overview',
    locked: 'Exploration locked — coming later', noDeeds: 'No land deeds are issued for these islands.',
  },
  names: { own: 'Your kingdom', rival: 'Keeper' },
} as const;

/** Why the World tab is open (L6 maps its store `worldIntent` onto this). */
export type WorldHudIntent = 'choose-land' | 'rivals' | 'my-deeds';
export const INTENT_HINTS: Record<WorldHudIntent, string> = {
  'choose-land': 'Choose a realm for your land',
  rivals: 'Choose a realm to find a rival',
  'my-deeds': 'Your realms are marked · tap one for your bases',
};
/** The globe's hint pill: a notice (a failed dive) first, then the intent's instruction, else the gesture hint
 *  (native `WorldHudFlow.hint`). */
export function worldHint(intent: WorldHudIntent | null | undefined, notice?: string | null): string {
  return notice ?? (intent ? INTENT_HINTS[intent] : WORLD_COPY.hint);
}

/** One naming rule (owner, Seeker code 31b): a blank own name reads "Your kingdom", a blank rival name "Keeper". */
export function kingdomName(name: string | null | undefined, yours: boolean): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed : yours ? WORLD_COPY.names.own : WORLD_COPY.names.rival;
}

/** The keep-level range the realm map filters on: 1 to the Keep's catalogue maximum. */
export const LEVEL_RANGE = { min: 1, max: STRUCTURES.keep.maxLevel } as const;
export const levelLabel = (lo: number, hi: number, short = false): string => `${short ? 'Lv' : 'Level'} ${lo}–${hi}`;

/**
 * The eight realms' panel copy. numeral/nav/name/epithet/landscape are `runtime/world.mjs` REGIONS verbatim and lore
 * is its first sentence (the concept's `landmarks.js` REALM_INFO); `copy.test.ts` pins both. Not imported from there:
 * world.mjs drags the island coastlines into whatever chunk imports it. accent = the selection light (landmarks.js).
 */
export interface RealmInfo {
  id: string; name: string; numeral: string; nav: string; epithet: string; lore: string; landscape: string; accent: string;
}
export const REALM_INFO: readonly RealmInfo[] = [
  { id: 'frostveil', name: 'Frostveil', numeral: 'I', nav: 'FROZEN NORTH', epithet: 'The sleeping north', lore: 'Beneath the blue ice, the bells of a buried kingdom still ring.', landscape: 'Ice shelves · frozen ridges · buried ruins', accent: '#8fe3ff' },
  { id: 'elderwood', name: 'Elderwood', numeral: 'II', nav: 'ANCIENT FOREST', epithet: 'Where the old roots remember', lore: 'Strongholds vanish beneath a canopy of silver-root trees.', landscape: 'Deep forest · ancient groves · green strongholds', accent: '#86ec6c' },
  { id: 'sunscar', name: 'Sunscar', numeral: 'III', nav: 'AMBER DESERT', epithet: 'Under the broken sun', lore: 'A sea of amber dunes surrounds the shattered observatories.', landscape: 'Amber dunes · sandstone ridges · lost observatories', accent: '#ffbf4d' },
  { id: 'crownlands', name: 'Crownlands', numeral: 'IV', nav: 'TEMPERATE HEART', epithet: 'The roads between kingdoms', lore: 'Fields and ruined causeways bind the scattered crowns.', landscape: 'Rolling fields · river valleys · fallen watchtowers', accent: '#ffd65c' },
  { id: 'seeker-reach', name: 'Solana Reach', numeral: 'V', nav: 'BEACON FRONTIER', epithet: 'Where the beacons awaken', lore: 'Violet terraces rise above sheltered mint-blue bays.', landscape: 'Violet terraces · crystal rivers · ancient beacons', accent: '#c99dff' },
  { id: 'stormcairn', name: 'Stormcairn', numeral: 'VI', nav: 'STORM HIGHLANDS', epithet: 'The thunder beyond the horizon', lore: 'Storm-worn cairns mark the passes between green coastal terraces and a snowy northern range.', landscape: 'Storm-weathered highlands · green coastal terraces · snowy northern range', accent: '#9dbcff' },
  { id: 'thornwake', name: 'Thornwake', numeral: 'VII', nav: 'WESTERN JUNGLE', epithet: 'The jungle beyond the western sea', lore: 'Waterfalls disappear into layers of fern and towering jungle.', landscape: 'Layered jungle · fern clearings · waterfalls · overgrown ruins', accent: '#c6e65a' },
  { id: 'cinderfall', name: 'Cinderfall', numeral: 'VIII', nav: 'OBSIDIAN ASHLANDS', epithet: 'Where the last embers sleep', lore: 'Ochre ash drifts through weathered ruins beneath ridges of black obsidian.', landscape: 'Ochre ashlands · obsidian ridges · weathered ruins · hardy vegetation', accent: '#ff8a4c' },
];
/** The realm whose deeds are the Genesis and Seeker owner allocations (the panel's reserved variant). */
export const RESERVED_REALM_ID = 'seeker-reach';
export const realmInfo = (id: string | null | undefined): RealmInfo | undefined => REALM_INFO.find(r => r.id === id);

/**
 * The three D-182 islands, visible and inert (coming soon). Title, accent and lore are `landmarks.js` ISLAND_INFO
 * verbatim; the rail and panel order is native `PhaseEIslands.ALL`. Notes read the shared policy's island figures
 * and the Divine trial/tournament site constants, matching native without
 * restating a game number here.
 */
export interface IslandInfo { id: string; title: string; accent: string; lore: string; note: () => string }
const DAY_SEC = 24 * 60 * 60;
export const PHASE_E_ISLANDS: readonly IslandInfo[] = [
  { id: 'seeker-island', title: 'Seeker Island', accent: '#ffb066',
    lore: 'The copper beacon of the S-shaped isle calls Seeker holders to the open sea east of Solana Reach.',
    note: () => {
      const S = PHASE_E_POLICY.seekerIsland;
      return `${fmtN(S.totalSpots)} spots — ${fmtN(S.kingSpots)} King + ${fmtN(S.regularSpots)} regular · `
        + `${fmtN(S.operatingTermSec / DAY_SEC)}-day ${PHASE_E_POLICY.currencies.markets.auctions} auction terms`;
    } },
  { id: 'solana-island', title: 'Solana Island', accent: '#5ff2c8',
    lore: 'Three crystal terraces rise off the western shore of Solana Reach: observatory, mint forest and the pale harbour.',
    note: () => `${fmtN(PHASE_E_POLICY.solanaIsland.workshopLicences)} workshop licences for crafting` },
  { id: 'divine-isle', title: 'Divine Isle', accent: '#ffd97a',
    lore: 'Split by a turquoise rift, the sacred isle lies alone in the Central Sea.',
    note: () => `${fmtN(PHASE_E_DIVINE_TRIALS.divineSites)} solo trials (west) · ${fmtN(PHASE_E_CHARTER_TOURNAMENT.divineSites)} clan citadels (east)` },
];
export const islandInfo = (id: string | null | undefined): IslandInfo | undefined => PHASE_E_ISLANDS.find(i => i.id === id);
