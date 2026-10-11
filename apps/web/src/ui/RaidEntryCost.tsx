import { pvpAttackShardCostForKeepLevel, RAID_ENERGY } from '@shardkeep/shared';
import { useApp } from '../state/store';
import { COLORS as C, fmtN } from './primitives';

export function raidEntryCostLabel(keepLevel: number | undefined): string {
  return `${RAID_ENERGY.perRaid} ENERGY + ${keepLevel ? fmtN(pvpAttackShardCostForKeepLevel(keepLevel)) : '—'} SHARDS`;
}

/** The selected base's server-confirmed Keep level determines the existing ante. */
export function RaidEntryCost(): React.JSX.Element {
  const keepLevel = useApp((state) => state.base?.player.keepLevel);
  return <div style={{ color: C.goldHi, fontSize: 15, lineHeight: 1.3 }}>
    EACH PVP TARGET · {raidEntryCostLabel(keepLevel)}
    <div style={{ color: C.textDim, fontSize: 12 }}>Charged when a target is found. Retreat keeps these spent.</div>
  </div>;
}
