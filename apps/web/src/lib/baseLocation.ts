import { REALM_NAMES } from '@shardkeep/shared/baseVisual';
import type { BasesDto, WalletBaseDto } from './api';

/** A migrated directory cannot reveal historical addresses on flag-off clients. */
export function fantasyDirectory(directory: BasesDto | null): boolean {
  return import.meta.env.VITE_FEATURE_FANTASY_WORLD === '1'
    || directory?.worldId === 'fantasy-v1'
    || directory?.bases.some(base => base.fantasyLocation != null) === true;
}

export function baseLocationLabel(base: WalletBaseDto | undefined, fantasy: boolean): string {
  const location = base?.fantasyLocation;
  if (location) return `${REALM_NAMES[location.realmId].toUpperCase()} · TILE ${location.tileId}`;
  if (fantasy) return base?.landPaidAt || base?.deedAssetId ? 'DEED LOCATION PENDING' : 'NO DEEDED LAND';
  if (base?.earthCell == null) return 'EARTH CELL PENDING';
  return `EARTH · ${base.earthCell}${base.countryA3 ? ` · ${base.countryA3}` : ''}`;
}
