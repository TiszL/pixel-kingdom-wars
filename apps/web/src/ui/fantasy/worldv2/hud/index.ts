/**
 * The World v2 HUD (lane L5): React chrome for the flat globe and the realm maps. Presentational only: props in from
 * the host's server reads, callbacks out to the host (`FantasyWorldLayer` via `WorldV2`). Import it only from the
 * lazy world chunk; nothing loaded at first paint may import this module (the L7 guard test).
 */
import './hud.css';
import './layout.css';

export { WorldHeader } from './WorldHeader';
export { WorldRail, GlobeSearch, type RailSelection, type GlobeSearchProps } from './WorldRail';
export { RealmPanel, IslandPanel } from './RealmPanel';
export { ExplorePanel } from './ExplorePanel';
export { RealmMapChrome } from './RealmMapChrome';
export { KingdomCard, type CardFailure, type KingdomCardActions } from './KingdomCard';
export { HudPanel, usePortrait } from './HudPanel';
export {
  RAIL_ENTRIES, DEFAULT_REALM_FILTER, cardTags, markersCarryShield, minesIn, realmCtaRows, realmStats, splitSearch,
  type RealmCounts, type RealmFilter, type RailEntry,
} from './model';
