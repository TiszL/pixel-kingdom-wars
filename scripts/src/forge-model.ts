/**
 * Gold Forge model — OWNER RULES (2026-07-24), the mandated modeling gate
 * before the dual-currency implementation:
 *  - DAILY emission spanning the 500M play allocation over 5 years
 *    (FORGE.dailyEmissionKeep).
 *  - Contributors burn shards into the day's pool; payout is pro-rata.
 *  - SOFT CAP: when the day's total contribution < softCapShards, only
 *    total/softCap of the emission distributes (early low-population days
 *    can't mine the full allocation).
 *  - PER-PLAYER CAP: nobody takes more than maxDailyShareBps (30%) of the
 *    day's distributed pool — the excess SHARDS ARE REFUNDED and the
 *    uncaptured emission stays in the pool (no redistribution: redistributing
 *    would reward sybil-splitting).
 *
 * KEY PROPERTY (encoded in tests): the payout rate is
 *   rate = distributed / total = dailyEmission / max(total, softCap)
 * so with softCap > dailyEmission the rate is ALWAYS sub-parity — the
 * deposit(1 KEEP→1 shard)→forge→withdraw loop can never print. The owner's
 * soft cap IS the printer guard.
 */
import { FORGE, TOKEN, getMiningQuota } from '@shardkeep/shared';

export interface EconProfileLike { keepLevel: number; mineLevels: number[]; streakDays: number }

/** One day's settlement, pure math (mirrors the server engine exactly). */
export function settleForgeDay(
  contributions: number[], // shards per player
  emission: number = FORGE.dailyEmissionKeep,
  softCap: number = FORGE.softCapShards,
  maxShareBps: number = FORGE.maxDailyShareBps,
): { payouts: number[]; refunds: number[]; distributed: number; rate: number } {
  const total = contributions.reduce((a, b) => a + b, 0);
  if (total <= 0) return { payouts: [], refunds: [], distributed: 0, rate: 0 };
  const distributable = (emission * Math.min(total, softCap)) / softCap;
  const rate = distributable / total; // = emission / max(total, softCap)
  const capPayout = (distributable * maxShareBps) / 10_000;
  const capShards = (total * maxShareBps) / 10_000;
  const payouts = contributions.map((s) => Math.min(s * rate, capPayout));
  const refunds = contributions.map((s) => (s > capShards ? s - capShards : 0));
  return { payouts, refunds, distributed: payouts.reduce((a, b) => a + b, 0), rate };
}

export interface ForgeParams {
  players: number;
  days: number;
  profile: EconProfileLike;
  /** Fraction of mined shards a player contributes daily (rest builds). */
  forgeFraction: number;
  /** Fraction of forged KEEP withdrawn (permanent pool exit). */
  withdrawFraction: number;
  /** One whale's daily KEEP deposit (→ shards 1:1, recycled to pool, all contributed). */
  whaleDepositKeepPerDay: number;
  /** Override the soft cap (default: live constant). */
  softCapShards?: number;
  initialPool?: number;
}

export interface ForgeDay {
  day: number; pool: number; distributed: number; rate: number;
  totalShards: number; whalePayout: number; whaleRefund: number;
}

export interface ForgeResult {
  days: ForgeDay[]; poolEnd: number; depletedDay: number | null;
  maxRate: number; printerLeak: number;
  /** Fraction of the horizon's emission actually distributed. */
  emissionUtilization: number;
}

export function simulateForge(p: ForgeParams): ForgeResult {
  const playPool = TOKEN.allocation.playPool;
  let pool = p.initialPool ?? playPool;
  const softCap = p.softCapShards ?? FORGE.softCapShards;
  const minedPerDay = getMiningQuota(p.profile.keepLevel, p.profile.mineLevels, p.profile.streakDays);
  const days: ForgeDay[] = [];
  let depletedDay: number | null = null;
  let maxRate = 0, printerLeak = 0, distributedTotal = 0;

  for (let d = 1; d <= p.days; d++) {
    const organicEach = minedPerDay * p.forgeFraction;
    const whaleShards = p.whaleDepositKeepPerDay;
    pool += whaleShards; // deposits recycle BEFORE payout (plan §3)

    const contributions = [
      ...Array.from({ length: p.players }, () => organicEach),
      ...(whaleShards > 0 ? [whaleShards] : []),
    ];
    const res = settleForgeDay(contributions, FORGE.dailyEmissionKeep, softCap);
    const paid = Math.min(pool, res.distributed);
    pool -= paid;
    distributedTotal += paid;
    if (res.rate > 1) printerLeak += (res.rate - 1) * contributions.reduce((a, b) => a + b, 0);

    const withdrawn = paid * p.withdrawFraction;
    pool += paid - withdrawn; // non-withdrawn KEEP re-enters sinks → recycles

    maxRate = Math.max(maxRate, res.rate);
    const whalePayout = whaleShards > 0 ? res.payouts[res.payouts.length - 1]! : 0;
    const whaleRefund = whaleShards > 0 ? res.refunds[res.refunds.length - 1]! : 0;
    days.push({ day: d, pool, distributed: paid, rate: res.rate, totalShards: contributions.reduce((a, b) => a + b, 0), whalePayout, whaleRefund });
    if (pool <= 0 && depletedDay === null) { depletedDay = d; pool = 0; }
  }

  return {
    days, poolEnd: pool, depletedDay, maxRate, printerLeak,
    emissionUtilization: distributedTotal / (FORGE.dailyEmissionKeep * p.days),
  };
}
