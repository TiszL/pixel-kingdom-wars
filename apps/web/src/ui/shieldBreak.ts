/**
 * Shield-break warning before a PvP raid (tester report 2026-09-16: "initiating
 * a new raid silently and instantly removes the active shield … no warning").
 *
 * The server rule this mirrors (never re-derives): liveRaids.ts breaks the
 * ATTACKER's deed shield on the first accepted deploy/hero command and
 * raids.ts on the batch /orders POST — in both places ONLY when the raid has a
 * `defenderWallet`, i.e. PvP. Campaign stages and PvE camps never touch it
 * (GDD §3.3 "attacking breaks YOUR shield"). So the confirm fires for the
 * auto-match (target null) and a chosen PvP base, and never for campaign/PvE
 * or for RESUMING a raid that already started (raidId set — the shield is
 * already gone or was never at stake).
 *
 * Pure so the two rules are testable without a DOM; RaidUI renders the panel.
 */
import type { BaseStateDto, RaidTarget } from '../state/store';

/** Seconds of protection an attack would throw away, or null when none.
 *  Prefers the server's remainingMs (same field the HUD shield pill reads) and
 *  falls back to the stored expiry for an older API cut. A warzone-suppressed
 *  row still counts: it is ineffective NOW but resumes after the purge, and the
 *  attack deletes it for good. */
export function shieldBreakRemainingSec(
  shield: BaseStateDto['shield'] | undefined,
  nowMs: number,
): number | null {
  if (!shield) return null;
  const remainingMs = typeof shield.remainingMs === 'number'
    ? shield.remainingMs
    : Date.parse(shield.expiresAt ?? shield.activeUntil) - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  return Math.ceil(remainingMs / 1000);
}

/** True only for a FRESH PvP raid: auto-match or a chosen base. */
export function raidBreaksShield(target: RaidTarget | null): boolean {
  if (!target) return true;
  if (target.raidId) return false;
  return target.kind === 'pvp';
}
