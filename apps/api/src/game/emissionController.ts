/**
 * Treasury-aware emission controller (owner 2026-07-20, #45). A plain, testable job
 * body (jobs.ts convention): read three live signals off the ledger, map them to a
 * target emission multiplier via the pure shared policy, smooth it (cut fast /
 * recover slow), and persist it to game_config. getMiningQuota then throttles at
 * every player's next collect through the existing lazy accrual — no player loop,
 * no reward cron. This is a SOFT throttle on drawdown; the pool's non-negative
 * ledger invariant remains the hard mint cap.
 *
 * Runs every ECONOMY.emissionControllerSec — via BullMQ when ENABLE_WORKERS, else
 * an always-on server tick (server.ts), so it works on a plain devnet boot.
 */
import { EMISSION_CONTROL, TOKEN, emissionTargetBps, smoothEmissionBps } from '@shardkeep/shared';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { accounts, players, withdrawals } from '../db/schema';
import { getEmissionMultBps, setEmissionMultBps } from './gameConfig';

export interface EmissionControllerResult {
  /** emission_pool balance (KEEP remaining to mint). */
  poolBalance: number;
  /** Pool remaining as a percent of the 500M genesis allocation. */
  poolPct: number;
  /** Rolling-24h withdrawal outflow (KEEP), the only permanent pool exit. */
  outflow24h: number;
  /** Players seen within EMISSION_CONTROL.activeWindowSec. */
  activePlayers: number;
  /** Raw target from the policy (before smoothing). */
  target: number;
  /** Multiplier before this tick. */
  previous: number;
  /** Multiplier persisted this tick (previous eased toward target). */
  next: number;
}

/** Recompute + persist the emission multiplier from live pool/outflow/crowd signals. */
export async function runEmissionController(db: Db, now = new Date()): Promise<EmissionControllerResult> {
  // 1. Remaining pool = emission_pool balance (the lifetime mint left).
  const [poolRow] = await db.select({ bal: sql<string>`COALESCE(SUM(${accounts.balance}), 0)` })
    .from(accounts).where(eq(accounts.kind, 'emission_pool'));
  const poolBalance = Number(BigInt(poolRow?.bal ?? '0'));
  const playPool = TOKEN.allocation.playPool;
  const poolPct = playPool > 0 ? (poolBalance * 100) / playPool : 0;

  // 2. Rolling-24h withdrawal outflow (permanent exit), non-cancelled — same query
  //    shape as the withdrawal circuit-breaker (money/withdrawals.ts).
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const [outRow] = await db.select({ sum: sql<string>`COALESCE(SUM(${withdrawals.amount}), 0)` })
    .from(withdrawals)
    .where(and(gte(withdrawals.createdAt, dayAgo), sql`${withdrawals.status} != 'cancelled'`));
  const outflow24h = Number(BigInt(outRow?.sum ?? '0'));

  // 3. Active players (crowd flood signal): seen within the active window.
  const activeSince = new Date(now.getTime() - EMISSION_CONTROL.activeWindowSec * 1000);
  const [actRow] = await db.select({ n: sql<number>`count(*)::int` })
    .from(players).where(gte(players.lastSeenAt, activeSince));
  const activePlayers = actRow?.n ?? 0;

  // 4. Map to a target multiplier, then smooth (cut fast, recover slow) + persist.
  const target = emissionTargetBps({ poolPct, outflow24h, poolBalance, activePlayers });
  const previous = await getEmissionMultBps(db);
  const next = smoothEmissionBps(previous, target);
  await setEmissionMultBps(db, next, now);

  return { poolBalance, poolPct, outflow24h, activePlayers, target, previous, next };
}
