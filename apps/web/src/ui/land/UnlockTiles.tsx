/**
 * WHAT 0.2 SOL BUYS, as six icon tiles.
 *
 * The copy is `LAND_UNLOCKS` verbatim (state/land.ts — its titles are pinned
 * and every line maps to a server gate); only the presentation changed. The
 * title is the tile, the sub reads at lower weight beneath it and as a
 * tooltip, so the pitch scans in one glance instead of six sentences.
 */
import { LAND_UNLOCKS } from '../../state/land';
import { hudChipStyle } from '../hudChrome';
import type { IconName } from '../icons';
import { COLORS as C, Icon } from '../primitives';

/** Icon per pinned unlock title. An unlock added without an entry here gets
 *  the star rather than nothing, so the grid never has a blank tile. */
export const UNLOCK_ICONS: Readonly<Record<string, IconName>> = {
  'YOUR PARCEL': 'map',
  'GOLD FORGE': 'keep',
  'TRADE ON THE MARKET': 'sol',
  'RAID LANDOWNERS': 'attack',
  'PVE BOUNTIES': 'quest',
  'CLANS': 'referral',
};

export function UnlockTiles({ columns }: { columns: 2 | 3 }): React.JSX.Element {
  return (
    <ul aria-label="What your land unlocks" style={{
      listStyle: 'none', margin: 0, padding: 0, display: 'grid',
      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 6,
    }}>
      {LAND_UNLOCKS.map((u) => (
        <li key={u.title} title={u.sub} style={{
          ...hudChipStyle('shard'), padding: '8px 6px', minWidth: 0,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, textAlign: 'center',
        }}>
          <Icon name={UNLOCK_ICONS[u.title] ?? 'star'} size={22} />
          <span style={{ color: C.goldHi, fontSize: 13, letterSpacing: '1px', lineHeight: 1.15 }}>{u.title}</span>
          <span style={{
            color: C.textFaint, fontSize: 11, lineHeight: 1.25, overflow: 'hidden',
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          }}>
            {u.sub}
          </span>
        </li>
      ))}
    </ul>
  );
}
