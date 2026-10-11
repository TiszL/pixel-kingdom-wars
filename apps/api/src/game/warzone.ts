/**
 * Warzone / shieldless windows (owner 2026-07-20, #46). A REQUEST-TIME predicate —
 * no cron, so it is correct even with ENABLE_WORKERS off (the default). Two modes,
 * switched by game_config.shieldlessMode:
 *   'scheduled' — a PREDICTABLE weekly window derived from the WARZONE constants
 *                 (default: the whole weekend, Sat 00:00 UTC → Mon 00:00). Players
 *                 know exactly when it runs; nothing is stored per-window.
 *   'purge'     — an UNANNOUNCED admin-set window (purgeStartAt/EndAt). No player-
 *                 facing endpoint returns those times, so the start stays secret.
 * When a window is active, isShielded is SUPPRESSED (rows are kept, not deleted, so
 * loss-shields resume after) and the per-target cadence tightens to
 * WARZONE.attackCooldownHours ("attackable every 4h").
 */
import { WARZONE } from '@shardkeep/shared';
import type { GameConfigRow } from './gameConfig';

const DAY_MS = 24 * 60 * 60 * 1_000;
const WEEK_MS = 7 * DAY_MS;

export interface WarzoneStatus {
  mode: GameConfigRow['shieldlessMode'];
  active: boolean;
  /** Public scheduled-window boundary. Purges deliberately never disclose a start. */
  startsAt: Date | null;
  /** Active purge end is safe to disclose; an inactive/future purge discloses nothing. */
  endsAt: Date | null;
  /** Next predictable scheduled start. Purges have no public next window. */
  nextStartsAt: Date | null;
  /** Until the active window ends, or until the next scheduled window starts. */
  remainingMs: number | null;
}

function scheduledStartAtOrBefore(now: Date): Date {
  const daysSinceStartDay = (now.getUTCDay() - WARZONE.scheduledStartDayUtc + 7) % 7;
  const start = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceStartDay,
    WARZONE.scheduledStartHourUtc, 0, 0, 0,
  ));
  if (start.getTime() > now.getTime()) start.setTime(start.getTime() - WEEK_MS);
  return start;
}

/**
 * Is `now` inside a SCHEDULED weekend window? Deterministic from the clock: find
 * the most recent scheduled start (the configured weekday/hour, UTC, at or before
 * now) and test whether now is within WARZONE.durationHours of it. Date.UTC
 * normalizes the day-of-month arithmetic (negative/overflow days roll correctly).
 */
export function isScheduledWarzone(now: Date): boolean {
  const nowMs = now.getTime();
  const start = scheduledStartAtOrBefore(now);
  const endMs = start.getTime() + WARZONE.durationHours * 3_600_000;
  return nowMs >= start.getTime() && nowMs < endMs;
}

/** Is a warzone (shieldless window) active right now, given the config row? */
export function isWarzoneActive(cfg: GameConfigRow, now: Date): boolean {
  switch (cfg.shieldlessMode) {
    case 'off':
      return false;
    case 'purge':
      return cfg.purgeStartAt != null && cfg.purgeEndAt != null
        && now.getTime() >= cfg.purgeStartAt.getTime()
        && now.getTime() < cfg.purgeEndAt.getTime();
    case 'scheduled':
      return isScheduledWarzone(now);
  }
}

/** Player-facing warzone clock. Scheduled windows are predictable; purge starts
 * stay secret even when configured. Once a purge is active, disclosing only its
 * end lets players understand the live rule without leaking an upcoming event. */
export function warzoneStatus(cfg: GameConfigRow, now: Date): WarzoneStatus {
  const nowMs = now.getTime();
  if (cfg.shieldlessMode === 'off') {
    return {
      mode: 'off', active: false, startsAt: null, endsAt: null,
      nextStartsAt: null, remainingMs: null,
    };
  }
  if (cfg.shieldlessMode === 'purge') {
    const active = isWarzoneActive(cfg, now);
    // A configured future purge is itself private. Until its first active
    // instant the public wire shape is indistinguishable from warzones being
    // off; otherwise polling this endpoint would announce the supposedly
    // unannounced event even though its timestamps were redacted.
    if (!active) {
      return {
        mode: 'off', active: false, startsAt: null, endsAt: null,
        nextStartsAt: null, remainingMs: null,
      };
    }
    const endsAt = active ? cfg.purgeEndAt : null;
    return {
      mode: 'purge', active, startsAt: null, endsAt, nextStartsAt: null,
      remainingMs: endsAt ? Math.max(0, endsAt.getTime() - nowMs) : null,
    };
  }

  const previousStart = scheduledStartAtOrBefore(now);
  const previousEnd = new Date(previousStart.getTime() + WARZONE.durationHours * 3_600_000);
  const active = nowMs < previousEnd.getTime();
  const startsAt = active ? previousStart : new Date(previousStart.getTime() + WEEK_MS);
  const endsAt = active
    ? previousEnd
    : new Date(startsAt.getTime() + WARZONE.durationHours * 3_600_000);
  const nextStartsAt = active
    ? new Date(previousStart.getTime() + WEEK_MS)
    : startsAt;
  return {
    mode: 'scheduled', active, startsAt, endsAt, nextStartsAt,
    remainingMs: Math.max(0, (active ? endsAt : startsAt).getTime() - nowMs),
  };
}
