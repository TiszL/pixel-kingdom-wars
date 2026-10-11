/** Frozen owner-approved geography (D-128). Import through the subpath only:
 * neither artwork regeneration nor realm naming may move a deed address. */
import data from './data/fantasy-world-v1.json';
import { FANTASY_WORLD } from './constants';
import type { RealmId } from './baseVisual';

export const FANTASY_WORLD_ID = 'fantasy-v1' as const;
export const FANTASY_MEMBERSHIP_HASH = data.membershipSha256;
/** SHA-256 of {worldId, columns, rows, tiles: sorted [tileId, realmId, allocation]}.
 * Tests pin the full catalog independently of its unchanged land silhouette. */
export const FANTASY_CATALOG_HASH = '92a30e7f69829ce6d96daf83bb932e664c75fd235fbd5890d45e7163d7e895dd';
export type FantasyAllocation = 'ordinary' | 'genesis' | 'seeker';
export interface FantasyAddress {
  worldId: typeof FANTASY_WORLD_ID;
  tileId: number;
}
export interface FantasyTile extends FantasyAddress {
  realmId: RealmId;
  allocation: FantasyAllocation;
  /** Degrees; simulation never consumes geographic positions. */
  lon: number;
  lat: number;
}

const realmByCell = new Int8Array(FANTASY_WORLD.columns * FANTASY_WORLD.rows).fill(-1);
const allocationByCell = new Uint8Array(realmByCell.length);
data.regions.forEach((region, index) => {
  for (const run of region.runs) {
    const [start, end] = run;
    if (start === undefined || end === undefined || start < 0 || end >= realmByCell.length || start > end) {
      throw new Error('Malformed frozen fantasy catalog');
    }
    for (let cell = start; cell <= end; cell++) {
      if (realmByCell[cell] !== -1) throw new Error('Overlapping frozen fantasy tiles');
      realmByCell[cell] = index;
    }
  }
});
for (const [runs, code] of [[data.genesisRuns, 1], [data.seekerRuns, 2]] as const) {
  for (const run of runs) {
    const [start, end] = run;
    if (start === undefined || end === undefined) throw new Error('Malformed sanctuary membership');
    for (let cell = start; cell <= end; cell++) {
      if (data.regions[realmByCell[cell] ?? -1]?.id !== 'seeker-reach' || allocationByCell[cell]) {
        throw new Error('Sanctuary membership must partition Solana Reach');
      }
      allocationByCell[cell] = code;
    }
  }
}

export function getFantasyTile(tileId: number): FantasyTile | null {
  if (!Number.isSafeInteger(tileId) || tileId < 0 || tileId >= realmByCell.length) return null;
  const region = data.regions[realmByCell[tileId] ?? -1];
  if (!region) return null;
  const allocation = allocationByCell[tileId] === 1 ? 'genesis' : allocationByCell[tileId] === 2 ? 'seeker' : 'ordinary';
  if (region.id === 'seeker-reach' && allocation === 'ordinary') throw new Error('Unreserved Solana tile');
  return {
    worldId: FANTASY_WORLD_ID, tileId, realmId: region.id as RealmId, allocation,
    lon: ((tileId % FANTASY_WORLD.columns) + 0.5) * 360 / FANTASY_WORLD.columns - 180,
    lat: 90 - (Math.floor(tileId / FANTASY_WORLD.columns) + 0.5) * 180 / FANTASY_WORLD.rows,
  };
}

export function fantasyTileAt(lon: number, lat: number): FantasyTile | null {
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  const wrapped = ((lon + 180) % 360 + 360) % 360;
  const x = Math.floor(wrapped / 360 * FANTASY_WORLD.columns);
  const y = Math.min(FANTASY_WORLD.rows - 1, Math.floor((90 - lat) / 180 * FANTASY_WORLD.rows));
  return getFantasyTile(y * FANTASY_WORLD.columns + x);
}

export function* fantasyTiles(realmId?: RealmId): Generator<FantasyTile> {
  for (let tileId = 0; tileId < realmByCell.length; tileId++) {
    const tile = getFantasyTile(tileId);
    if (tile && (!realmId || tile.realmId === realmId)) yield tile;
  }
}

/** Stable ranking is frozen in integer quarter-degree distances. Allocation
 * persists the result; new artworks, wallet names and fetch ordering cannot
 * reshuffle it. Crownlands centre is the accepted 26°E/23°N destination. */
export function crownlandsMigrationTiles(): FantasyTile[] {
  const distance = (t: FantasyTile) => {
    const dx = (t.lon - FANTASY_WORLD.crownlandsCenter.lon) * 4;
    const dy = (t.lat - FANTASY_WORLD.crownlandsCenter.lat) * 4;
    return dx * dx + dy * dy;
  };
  return [...fantasyTiles('crownlands')].sort((a, b) => distance(a) - distance(b) || a.tileId - b.tileId);
}

/** Small typed transport discriminator; Earth recovery must never reinterpret
 * an old cell as a same-numbered fantasy tile. */
export type LandAddress =
  | { kind: 'legacy-earth'; earthCell: number }
  | ({ kind: 'fantasy' } & FantasyAddress);

export function fantasyLocationLabel(tile: FantasyTile, realmName: string): string {
  return `${realmName} · Tile ${tile.tileId}`;
}
