/**
 * Human duration label for countdowns, ETAs, cost previews and server error
 * copy — owner 2026-08-23: an upgrade chip must read "6d 2h", never
 * "8796:31" minutes, and the same words must appear everywhere a duration is
 * shown (client chips, sheets, globe, API messages).
 *
 * Always the two most significant non-zero units, seconds only under an hour:
 *   6d 2h · 6d · 2h 36m · 2h · 36m 5s · 36m · 45s · 0s
 * Pure (no clock, integer math); callers pass whole seconds. Negative / NaN → "0s".
 */
export function fmtDur(sec: number): string {
  const total = Number.isFinite(sec) ? Math.max(0, Math.floor(sec)) : 0;
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}
