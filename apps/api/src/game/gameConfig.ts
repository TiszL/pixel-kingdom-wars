/**
 * Runtime levers (owner 2026-07-20) — the singleton game_config row. Baselines are
 * compile-time constants in @shardkeep/shared; THIS holds the runtime OVERRIDE that
 * a job or admin mutates:
 *   #45 emissionMultBps — the treasury-aware emission multiplier the 10-min
 *       controller drives, read by getMiningQuota on every collect.
 *   #46 shieldlessMode (+ purge window) — the warzone mode switch (game/warzone.ts
 *       turns it into an isWarzoneActive(now) predicate).
 * Reads fall back to the compile-time defaults if the row is unseeded, so nothing
 * breaks before ensureGameConfig runs at boot.
 */
import { EMISSION_CONTROL, MINING } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { gameConfig } from '../db/schema';

/** The one and only row's primary key. */
export const GAME_CONFIG_ID = true;

export type ShieldlessMode = 'off' | 'scheduled' | 'purge';

export interface GameConfigRow {
  emissionMultBps: number;
  emissionUpdatedAt: Date | null;
  shieldlessMode: ShieldlessMode;
  purgeStartAt: Date | null;
  purgeEndAt: Date | null;
  globalChatEnabled: boolean;
}

const DEFAULTS: GameConfigRow = {
  emissionMultBps: MINING.EPOCH_RATE_BPS,
  emissionUpdatedAt: null,
  shieldlessMode: 'off',
  purgeStartAt: null,
  purgeEndAt: null,
  globalChatEnabled: true,
};

function clampBps(bps: number): number {
  return Math.max(EMISSION_CONTROL.minBps, Math.min(EMISSION_CONTROL.maxBps, Math.round(bps)));
}

/** Idempotently ensure the singleton row exists (called once at boot). */
export async function ensureGameConfig(db: DbOrTx): Promise<void> {
  await db.insert(gameConfig).values({ id: GAME_CONFIG_ID }).onConflictDoNothing();
}

/** Read the singleton config; returns compile-time defaults if unseeded. */
export async function getGameConfig(db: DbOrTx): Promise<GameConfigRow> {
  const [row] = await db.select().from(gameConfig).where(eq(gameConfig.id, GAME_CONFIG_ID));
  if (!row) return { ...DEFAULTS };
  return {
    emissionMultBps: clampBps(row.emissionMultBps),
    emissionUpdatedAt: row.emissionUpdatedAt,
    shieldlessMode: row.shieldlessMode,
    purgeStartAt: row.purgeStartAt,
    purgeEndAt: row.purgeEndAt,
    globalChatEnabled: row.globalChatEnabled,
  };
}

/** The live emission multiplier (bps), clamped to the controller bounds. One small
 *  read; getMiningQuota's callers pass the result so a throttle takes effect at each
 *  player's next collect via the existing lazy accrual (no player iteration). */
export async function getEmissionMultBps(db: DbOrTx): Promise<number> {
  const [row] = await db.select({ bps: gameConfig.emissionMultBps })
    .from(gameConfig).where(eq(gameConfig.id, GAME_CONFIG_ID));
  return clampBps(row?.bps ?? MINING.EPOCH_RATE_BPS);
}

/** Persist a recomputed emission multiplier (the controller job). */
export async function setEmissionMultBps(db: DbOrTx, bps: number, now = new Date()): Promise<void> {
  await ensureGameConfig(db);
  await db.update(gameConfig)
    .set({ emissionMultBps: clampBps(bps), emissionUpdatedAt: now, updatedAt: now })
    .where(eq(gameConfig.id, GAME_CONFIG_ID));
}

/** Set the shieldless/warzone mode (#46 admin lever). For 'purge' pass the window;
 *  'off'/'scheduled' clear it. No player-facing endpoint ever returns purge times. */
export async function setShieldlessMode(
  db: DbOrTx,
  mode: ShieldlessMode,
  window?: { purgeStartAt: Date; purgeEndAt: Date },
  now = new Date(),
): Promise<void> {
  await ensureGameConfig(db);
  await db.update(gameConfig)
    .set({
      shieldlessMode: mode,
      purgeStartAt: mode === 'purge' ? (window?.purgeStartAt ?? null) : null,
      purgeEndAt: mode === 'purge' ? (window?.purgeEndAt ?? null) : null,
      updatedAt: now,
    })
    .where(eq(gameConfig.id, GAME_CONFIG_ID));
}
