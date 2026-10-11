/**
 * Duration labels for the client. `fmtDur` ("6d 2h" / "2h 36m" / "36m 5s") is
 * the ONE shared definition in @shardkeep/shared (the API error copy uses the
 * same words); `fmtClock` is the hh:mm:ss clock for sub-day cycles. Both are
 * framework-free so React screens and Phaser world chips share them.
 */
import { fmtDur } from '@shardkeep/shared';

export { fmtDur };

/**
 * Clock-style countdown "hh:mm:ss" for sub-day cycles (daily cache, Gold Forge
 * cycle) — above a day it falls back to fmtDur so hours never stack past 23.
 */
export function fmtClock(sec: number): string {
  const total = Number.isFinite(sec) ? Math.max(0, Math.floor(sec)) : 0;
  if (total >= 86_400) return fmtDur(total);
  const hh = String(Math.floor(total / 3_600)).padStart(2, '0');
  const mm = String(Math.floor((total % 3_600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
