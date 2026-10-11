/** Selected-base raid interlock. A reconnect always begins with a full snapshot. */
export interface ActiveBaseRaid {
  raidId: string;
  state: 'reserved' | 'live' | 'releasing';
}
export interface BaseRaidSnapshot {
  baseId: string;
  activeRaid: ActiveBaseRaid | null;
}
export interface RaidEventError {
  status: number;
  code?: string;
  message: string;
}
