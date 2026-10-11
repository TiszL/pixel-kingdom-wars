import type { FantasyTile } from '@shardkeep/shared/fantasyWorld';
export type { FantasyTile };

export interface FantasyView { lon: number; lat: number; zoom: number }
export interface FantasyWorldMarker {
  tileId: number;
  name: string;
  avatarUrl?: string | null;
  keepLevel?: number;
  owned?: boolean;
  selected?: boolean;
  /** D-181 effective shield from the parcel feed; absent when the read did not carry it. */
  shielded?: boolean;
  /** Presentation-only summary of the server's occupied realm count. */
  cluster?: { count: number; realmId: string };
}
export interface FantasyExploration { chainId: string; islandId: string | null }
export interface FantasyRealm {
  id: string; name: string; epithet: string; color: string;
  lon: number; lat: number; lore: string; landscape: string; nav: string;
}
export interface FantasyChain {
  id: string; name: string; lon: number; lat: number; lore: string;
  landscape?: string;
  islands: ReadonlyArray<{lon: number; lat: number; rx: number; ry: number}>;
}
export interface FantasyRenderStats {
  frames: number; frameMs: number; ready: boolean;
  regions: number; islands: number; pending: number; view: FantasyView;
}
export interface FantasyGlobeHandle {
  focusRealm(realmId: string): void;
  focusTile(tileId: number): void;
  focusIsland(chainId: string, islandId?: string): void;
  setView(view: FantasyView): void;
  view(): FantasyView;
  stats(): FantasyRenderStats | null;
}
