// World v2 ↔ host contract (D-186). FROZEN when L1a merges: FantasyWorldLayer renders
// either the CPU FantasyGlobe or the lazy WorldV2 with the SAME props and ref. Change
// this file only with the host in the same commit.
//
// Round 3 (L8) added `hud`: while WorldV2 is live the host hides its own header, rail,
// tools and panel, and WorldV2 draws the owner-reviewed HUD (L5) from the host's reads.
// The host still owns every server read and every action: each HUD button calls one of
// the host's existing functions through `hud.actions` (choose land writes landPurchase
// exactly as the host panel does; scout and raid go through the host's handlers).
//
// Type-only imports: this file must never pull a runtime module into the WorldV2 chunk
// or into first paint.
import type { ReactNode } from 'react';
import type { FantasyGlobeProps } from '../FantasyGlobe';
import type { FantasyGlobeData, FantasyOwnedTile, FantasyParcelData, FantasySearchResult, FantasyViewBounds } from '../data';
import type { FantasyExploration, FantasyGlobeHandle } from '../types';

/** The three D-182 Phase E islands (native `GlobeV2Pin.kt` ids). Visible and inert:
 *  tapping one opens its coming-soon panel, never a map. */
export const WORLD_V2_SPECIAL_ISLANDS = ['seeker-island', 'solana-island', 'divine-isle'] as const;
export type WorldV2SpecialIslandId = typeof WORLD_V2_SPECIAL_ISLANDS[number];

/** A failed parcel read, in the host's words: `land-gate` = the server's 402/403 (no Land Deed yet). */
export interface WorldV2CardFailure { kind: 'land-gate' | 'other'; message: string }

/**
 * The host's reads and actions for the World v2 HUD. Values only: the HUD decides nothing the server decides
 * ("You can attack" reads `parcel.data.detail.actions.attack.allowed`).
 */
export interface WorldV2Hud {
  /** `/globe/fantasy` (useFantasyDirectory): per-realm counts, your owned tiles, the warzone. */
  directory: FantasyGlobeData | null;
  /** The selected tile's parcel read (useFantasyParcel); null tile = nothing selected. */
  parcel: { tileId: number | null; data: FantasyParcelData | null; pending: boolean; failure: WorldV2CardFailure | null; retry(): void };
  /** The selected tile when it is one of your deeds (open base / manage deed). */
  ownTile: FantasyOwnedTile | null;
  /** D-181: your current base's tile and its own /base shield read. It can only ADD a dome (domes.mjs). */
  ownShield: { tileId: number; shielded: boolean } | null;
  /** A host action (scout, open base) is in flight. */
  busy: boolean;
  /** The owner search ("Find a keeper…", useFantasySearch). */
  search: { query: string; setQuery(query: string): void; results: readonly FantasySearchResult[] | null; pending: boolean; error: boolean; retry(): void };
  /** The EXPLORE destination the host holds (an exploration chain), or null. */
  explore: FantasyExploration | 'list' | null;
  /** Warzone: active from the directory read; the status panel is the host's. */
  warzone: { active: boolean; open: boolean; panel: ReactNode };
  /** The host's slot under the card: action errors, the shield clock, the deed picture. */
  cardExtras: ReactNode;
  actions: {
    scout(): void; raid(): void; chooseLand(): void; openBase(baseId: string): void; manageDeed(): void;
    explore(destination: FantasyExploration): void; openCampaign(): void;
    /** Header BASE: leave the world for the base screen. */
    back(): void;
    setWarzoneOpen(open: boolean): void;
  };
}

/**
 * Everything the CPU globe receives, plus three World v2 callbacks and the `hud` feed. What the renderer
 * must honour:
 * - `onTerrainStatus({ready:true})` once a frame is up, or the host veil never lifts.
 * - `onViewChange` zoom on the host scale: < 5 on the globe, >= 5 inside a realm map
 *   (the host picks realm clusters vs the parcel feed from it).
 * - `onSelect(tile)` for every deed/kingdom tap; `onRealmSelect`, `onExplore` as the CPU globe.
 * - Draw `markers` itself, including `shielded` (D-181 domes).
 * - Register its own back handler (dive -> globe) at a priority above the host's 100.
 * - Fetch only pack files and avatars; parcel reads stay in the host.
 */
export interface WorldV2Props extends FantasyGlobeProps {
  /** A D-182 island was tapped on the globe or the rail. */
  onSpecialIsland(id: WorldV2SpecialIslandId): void;
  /** The ground box a realm-map camera shows, in degrees (longitudes continuous across
   *  the seam), or null on the globe. The host plans its bounded, debounced parcel reads
   *  from it (realmFeed.ts). */
  onViewportBounds(bounds: FantasyViewBounds | null): void;
  /** This device or chunk cannot run World v2: the host swaps in the CPU globe for the
   *  rest of the visit. `reason` is logged, never shown. */
  fallbackTo2D(reason: string): void;
  /** The HUD's reads and actions (round 3). */
  hud: WorldV2Hud;
}

/** Same imperative surface as the CPU globe: focusRealm, focusTile, focusIsland (the 7
 *  exploration chains), setView (the host calls zoom 16 and 3.8), view, stats. */
export type WorldV2Handle = FantasyGlobeHandle;
