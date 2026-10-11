import { AUTHORED_ATTACK_TIMINGS, type AuthoredAttackTiming } from './constants';
import type { TroopType } from './types';

export const COMBAT_TICK_MS = 100;
const ceilDiv = (n: number, d: number): number => Math.floor((n + d - 1) / d);

export interface ResolvedAttackTiming extends AuthoredAttackTiming {
  cycleMs: number;
  releaseOffsetMs: number;
  cycleTicks: number;
  releaseOffsetTicks: number;
  impactOffsetsTicks: readonly number[];
  cadenceTicks: number;
}

export function authoredAttackTiming(
  troop: Exclude<TroopType, 'wyrmling'>,
  targetKind: 'troop' | 'building',
  siegeThrow = false,
): ResolvedAttackTiming {
  const raw: AuthoredAttackTiming = troop === 'giant' && siegeThrow ? AUTHORED_ATTACK_TIMINGS.giantBoulder
    : troop === 'troll' ? (targetKind === 'building' ? AUTHORED_ATTACK_TIMINGS.trollBuilding : AUTHORED_ATTACK_TIMINGS.trollTroop)
    : troop === 'direwyvern' ? AUTHORED_ATTACK_TIMINGS.direFirestorm
    : AUTHORED_ATTACK_TIMINGS[troop];
  return resolveAttackTiming(raw);
}

export function resolveAttackTiming(raw: AuthoredAttackTiming): ResolvedAttackTiming {
  if (raw.authoredCycleMs === undefined && (raw.frames === undefined || raw.fps === undefined)) {
    throw new RangeError('attack timing needs a cycle duration');
  }
  if (raw.authoredReleaseMs === undefined
    && (raw.releaseFrame === undefined || raw.fps === undefined)) {
    throw new RangeError('attack timing needs a release time');
  }
  const cycleMs = raw.authoredCycleMs
    ?? ceilDiv(raw.frames! * 1_000, raw.fps!);
  const releaseOffsetMs = raw.authoredReleaseMs
    ?? ceilDiv(raw.releaseFrame! * 1_000, raw.fps!);
  const cycleTicks = ceilDiv(cycleMs, COMBAT_TICK_MS);
  const impactOffsetsTicks = raw.mode === 'projectile'
    ? [ceilDiv(releaseOffsetMs + (raw.projectileTravelMs ?? 0), COMBAT_TICK_MS)]
    : raw.contactFrames.map((frame) => ceilDiv(
      ceilDiv(frame * 1_000, raw.fps!), COMBAT_TICK_MS,
    ));
  return { ...raw, cycleMs, releaseOffsetMs, cycleTicks,
    releaseOffsetTicks: ceilDiv(releaseOffsetMs, COMBAT_TICK_MS),
    impactOffsetsTicks, cadenceTicks: raw.cadenceTicks ?? cycleTicks };
}

/** Exact cycle payload; splitting this integer among contact frames cannot
 * accelerate or lose long-run DPS. */
export const attackPayloadDeci = (dpsDeci: number, cadenceTicks: number): number =>
  dpsDeci * cadenceTicks;

export const splitAttackPayloadDeci = (payload: number, contacts: number): number[] => {
  const base = Math.floor(payload / contacts);
  const remainder = payload - base * contacts;
  return Array.from({ length: contacts }, (_, i) => base + (i < remainder ? 1 : 0));
};
