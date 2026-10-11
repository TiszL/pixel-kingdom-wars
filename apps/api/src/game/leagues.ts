/**
 * Cumulative ranked leagues (owner 2026-08-30).
 *
 * Monday 00:00 closes an earning window and freezes one immutable row for every
 * active landed deed; trophies never reset. The 00:15 settlement drains each
 * positive SHARDS/item receipt in its own transaction. That split is deliberate:
 * activity or a deed transfer in the gap cannot rewrite the closed week, while
 * a crash leaves a visible pending receipt for idempotent recovery.
 *
 * New rows always carry keepAmount=0. Ranked leagues do not read or fund the
 * historical KEEP pools, do not tithe raid loot, and do not grant energy.
 */
import { createHash } from 'node:crypto';
import type { FinalizedAssetOwnership } from '@shardkeep/chain';
import {
  BASE_OWNERSHIP, LEAGUES, type League, type LeagueOverview, type LeagueRewardItem,
} from '@shardkeep/shared';
import {
  and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, sql,
} from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import {
  baseItems, baseLeagueEntitlements, baseProfiles, bases, baseSlots,
  deedOwnershipObservations, leagueItemGrants, leagueRewardActivations,
  leagueWeekBaseExclusions, leagueWeekBaseSnapshots, leagueWeekClosures, players, raids,
} from '../db/schema';
import { multiBaseEnabled } from '../config';
import { HttpError } from '../lib/errors';
import { rewardBaseShards } from './baseEconomy';
import type { FinalizedDeedReader } from './baseOwnership';
import { ownershipEligible } from './baseTransfer';

export const LEAGUE_TIERS: readonly League[] = ['bronze', 'silver', 'gold', 'sol'];
const TIER_RANK: Readonly<Record<League, number>> = {
  bronze: 0, silver: 1, gold: 2, sol: 3,
};
const LEAGUE_SETTLEMENT_LOCK_KEY = 7_446_001;
const DAY_MS = 86_400_000;

export interface LeagueWeeklyRewards {
  cacheShards: bigint;
  items: LeagueRewardItem[];
}

export interface LeagueRewardPolicy {
  enabled: boolean;
  /** Monday UTC date of the first complete earning window. */
  startWeek: string;
}

export interface LeagueCloseAuthority {
  reader: FinalizedDeedReader | null;
  expectedCollection: string | null;
}

function defaultRewardPolicy(): LeagueRewardPolicy {
  return {
    enabled: process.env['LEAGUE_REWARDS_ENABLED'] === 'true',
    startWeek: process.env['LEAGUE_REWARD_START_WEEK'] ?? LEAGUES.rewardStartWeek,
  };
}

export interface LeagueSettlementResult {
  week: string;
  closesAt: string;
  rewardsEnabled: boolean;
  frozen: number;
  settled: number;
  replayed: number;
  failed: number;
  cacheShards: bigint;
  items: number;
  tiers: Record<League, number>;
  clanChests: number;
}

export function leagueForTrophies(trophies: number): League {
  let tier: League = 'bronze';
  for (const [index, threshold] of LEAGUES.thresholds.entries()) {
    if (trophies >= threshold) tier = LEAGUE_TIERS[index] ?? tier;
  }
  return tier;
}

/** Pure reward lookup shared by freeze, tests, and the lazy client mirror. */
export function leagueWeeklyRewards(tier: League, keepLevel: number): LeagueWeeklyRewards {
  const table = LEAGUES.weeklyCacheShardsByKeepLevel;
  const level = Math.min(table.length, Math.max(1, Math.trunc(keepLevel)));
  return {
    cacheShards: (BigInt(table[level - 1]!) * BigInt(LEAGUES.cacheTierMultBps[tier])) / 10_000n,
    items: LEAGUES.weeklyItemsByTier[tier].map((item) => ({ ...item })),
  };
}

function utcWeekStart(now: Date): Date {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayFromMonday = (now.getUTCDay() + 6) % 7;
  return new Date(midnight - dayFromMonday * DAY_MS);
}

function dateKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function leagueWindow(now = new Date()): {
  startsAt: Date; closesAt: Date; settlesAt: Date;
} {
  const startsAt = utcWeekStart(now);
  const closesAt = new Date(startsAt.getTime() + 7 * DAY_MS);
  const settlesAt = new Date(closesAt.getTime() + LEAGUES.settlementDelayMs);
  return { startsAt, closesAt, settlesAt };
}

function lastClosedLeagueWindow(now: Date): { startsAt: Date; closesAt: Date } {
  const closesAt = utcWeekStart(now);
  return { startsAt: new Date(closesAt.getTime() - 7 * DAY_MS), closesAt };
}

function closedLeagueWindowForWeek(week: string): { startsAt: Date; closesAt: Date } {
  const startsAt = new Date(`${week}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || Number.isNaN(startsAt.getTime())
    || dateKey(startsAt) !== week || startsAt.getUTCDay() !== 1) {
    throw new Error(`invalid league week boundary: ${week}`);
  }
  return { startsAt, closesAt: new Date(startsAt.getTime() + 7 * DAY_MS) };
}

function maxWeek(a: string, b: string): string {
  return a >= b ? a : b;
}

/** First Monday whose whole [Monday, Monday) window begins after activation. */
export function firstCompleteLeagueWeek(enabledAt: Date, configuredStartWeek: string): string {
  const monday = utcWeekStart(enabledAt);
  const beginsExactlyAtBoundary = enabledAt.getTime() === monday.getTime();
  const activationWeek = dateKey(new Date(
    monday.getTime() + (beginsExactlyAtBoundary ? 0 : 7 * DAY_MS),
  ));
  return maxWeek(configuredStartWeek, activationWeek);
}

/** Persist activation once. A later config rollback cannot rewrite history or
 * turn a partial week into an apparently complete one. */
export async function ensureLeagueRewardActivation(
  db: DbOrTx,
  now = new Date(),
  policy = defaultRewardPolicy(),
): Promise<string | null> {
  if (!policy.enabled) return null;
  const firstCompleteWeek = firstCompleteLeagueWeek(now, policy.startWeek);
  await db.insert(leagueRewardActivations).values({
    singleton: 1,
    enabledAt: now,
    configuredStartWeek: policy.startWeek,
    firstCompleteWeek,
  }).onConflictDoNothing();
  const [activation] = await db.select().from(leagueRewardActivations)
    .where(eq(leagueRewardActivations.singleton, 1));
  if (!activation) throw new Error('league reward activation boundary was not persisted');
  return activation.firstCompleteWeek;
}

export async function ratedAttacksByBase(
  db: DbOrTx, baseIds: string[], startsAt: Date, closesAt: Date,
): Promise<Map<string, number>> {
  if (baseIds.length === 0) return new Map();
  const rows = await db.select({
    baseId: raids.attackerBaseId,
    count: sql<number>`count(*)::int`,
  }).from(raids).where(and(
    inArray(raids.attackerBaseId, baseIds),
    isNotNull(raids.defenderBaseId),
    eq(raids.status, 'resolved'),
    gte(raids.resolvedAt, startsAt),
    lt(raids.resolvedAt, closesAt),
  )).groupBy(raids.attackerBaseId);
  return new Map(rows.flatMap((row) => row.baseId ? [[row.baseId, row.count] as const] : []));
}

export interface RankedBase {
  baseId: string;
  ownerWallet: string;
  trophies: number;
  keepLevel: number;
}

function compareRewardCandidates(a: RankedBase, b: RankedBase): number {
  return TIER_RANK[leagueForTrophies(b.trophies)] - TIER_RANK[leagueForTrophies(a.trophies)]
    || b.trophies - a.trophies
    || (a.baseId < b.baseId ? -1 : a.baseId > b.baseId ? 1 : 0);
}

export function rewardedBaseIds(participants: RankedBase[], attacks: Map<string, number>): Set<string> {
  const byWallet = new Map<string, RankedBase[]>();
  for (const base of participants) {
    if (base.trophies <= 0) continue;
    if ((attacks.get(base.baseId) ?? 0) < LEAGUES.rewardMinAttackerRaids) continue;
    const peers = byWallet.get(base.ownerWallet) ?? [];
    peers.push(base);
    byWallet.set(base.ownerWallet, peers);
  }
  const winners = new Set<string>();
  for (const peers of byWallet.values()) {
    peers.sort(compareRewardCandidates);
    for (const winner of peers.slice(0, LEAGUES.rewardsPerWalletMax)) winners.add(winner.baseId);
  }
  return winners;
}

export interface LeagueCloseResult {
  week: string;
  closesAt: string;
  rewardsEnabled: boolean;
  participants: number;
  frozen: number;
  replayed: boolean;
  tiers: Record<League, number>;
}

function emptyTiers(): Record<League, number> {
  return { bronze: 0, silver: 0, gold: 0, sol: 0 };
}

type CloseExclusionReason = 'missing_profile' | 'candidate_changed'
  | 'deed_authority_unavailable' | 'deed_authority_ineligible' | 'deed_owner_mismatch'
  | 'authority_snapshot_unavailable';

function closeEvidenceHash(
  assetId: string, owner: string, slot: number, observedAt: Date,
): string {
  return createHash('sha256')
    .update(`${assetId}\0${owner}\0owned\0${slot}\0${observedAt.toISOString()}`)
    .digest('hex');
}

export interface LeagueAuthorityWave {
  requests: Array<{ assetId: string; minContextSlot?: number }>;
}

export async function readCoherentLeagueAuthority(
  reader: FinalizedDeedReader, waves: LeagueAuthorityWave[],
): Promise<{ owners: Map<string, FinalizedAssetOwnership | null>; slot: number }> {
  if (!reader.readBatch) {
    throw new Error('league close reader does not expose finalized batch context');
  }
  if (waves.length > LEAGUES.closeAuthorityMaxConcurrentWaves) {
    throw new Error(`league close requires ${waves.length} authority waves; supported maximum is ${LEAGUES.closeAuthorityMaxConcurrentWaves}`);
  }
  for (let attempt = 1; attempt <= LEAGUES.closeAuthoritySweepAttempts; attempt += 1) {
    const batches = await Promise.all(waves.map(async ({ requests }) => {
      try {
        return await reader.readBatch!(requests);
      } catch {
        return { owners: new Map<string, FinalizedAssetOwnership | null>(), contextSlot: null, transportSucceeded: false };
      }
    }));
    const transportComplete = batches.every((batch) => batch.transportSucceeded
      && batch.contextSlot !== null && Number.isSafeInteger(batch.contextSlot) && batch.contextSlot >= 0);
    const slots = new Set(batches.flatMap((batch) => batch.contextSlot === null ? [] : [batch.contextSlot]));
    if (transportComplete && slots.size === 1) {
      const slot = batches[0]!.contextSlot!;
      const owners = new Map<string, FinalizedAssetOwnership | null>();
      let internallyCoherent = true;
      for (const batch of batches) {
        for (const [assetId, observed] of batch.owners) {
          if (observed && observed.slot !== slot) internallyCoherent = false;
          owners.set(assetId, observed);
        }
      }
      if (internallyCoherent) return { owners, slot };
    }
    if (attempt < LEAGUES.closeAuthoritySweepAttempts) {
      await new Promise<void>((resolve) => setTimeout(resolve, LEAGUES.closeAuthoritySweepRetryMs));
    }
  }
  throw new Error('league close could not obtain one coherent finalized ownership slot');
}

/** Freeze the just-closed week before any 00:00–00:15 activity can influence
 * settlement. Base rows, profiles, and finalized observation evidence are all
 * locked inside the one transaction that writes its completion marker. */
export async function closeLeagueWeek(
  db: Db, now: Date, policy: LeagueRewardPolicy, authority?: LeagueCloseAuthority,
  targetWeek?: string,
): Promise<LeagueCloseResult> {
  const { startsAt, closesAt } = targetWeek
    ? closedLeagueWindowForWeek(targetWeek)
    : lastClosedLeagueWindow(now);
  const week = dateKey(startsAt);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LEAGUE_SETTLEMENT_LOCK_KEY})`);

    const [existing] = await tx.select().from(leagueWeekClosures)
      .where(eq(leagueWeekClosures.week, week));
    if (existing) {
      const snapshots = await tx.select({ tier: leagueWeekBaseSnapshots.tier })
        .from(leagueWeekBaseSnapshots).where(eq(leagueWeekBaseSnapshots.week, week));
      const receipts = await tx.select({ baseId: baseLeagueEntitlements.baseId })
        .from(baseLeagueEntitlements).where(eq(baseLeagueEntitlements.week, week));
      const exclusions = await tx.select({ baseId: leagueWeekBaseExclusions.baseId })
        .from(leagueWeekBaseExclusions).where(eq(leagueWeekBaseExclusions.week, week));
      if (snapshots.length !== existing.participantCount
          || exclusions.length !== existing.excludedCount
          || (existing.rewardsEnabled && receipts.length !== existing.participantCount)) {
        throw new Error(`league close ${week} is incomplete; settlement refused`);
      }
      const tiers = emptyTiers();
      for (const snapshot of snapshots) tiers[snapshot.tier] += 1;
      return {
        week,
        closesAt: existing.closesAt.toISOString(),
        rewardsEnabled: existing.rewardsEnabled,
        participants: existing.participantCount,
        frozen: existing.rewardedCount,
        replayed: true,
        tiers,
      };
    }

    if (now.getTime() < closesAt.getTime()) {
      throw new Error(`league close ${week} cannot run before its 00:00 UTC boundary`);
    }

    const activationWeek = await ensureLeagueRewardActivation(tx, now, policy);
    const [durableActivation] = activationWeek === null
      ? await tx.select({ firstCompleteWeek: leagueRewardActivations.firstCompleteWeek })
        .from(leagueRewardActivations).where(eq(leagueRewardActivations.singleton, 1))
      : [];
    const effectiveStartWeek = activationWeek
      ?? durableActivation?.firstCompleteWeek
      ?? policy.startWeek;
    const [openingBoundary] = await tx.select().from(leagueWeekClosures)
      .where(eq(
        leagueWeekClosures.week,
        dateKey(new Date(startsAt.getTime() - 7 * DAY_MS)),
      ));
    const featureEnabledAtClose = multiBaseEnabled() && policy.enabled;
    const rewardsEnabled = featureEnabledAtClose
      && week >= effectiveStartWeek
      && openingBoundary?.featureEnabledAtClose === true
      && week >= openingBoundary.effectiveStartWeek;
    if (!rewardsEnabled) {
      await tx.insert(leagueWeekClosures).values({
        week,
        closesAt,
        effectiveStartWeek,
        featureEnabledAtClose,
        rewardsEnabled: false,
        participantCount: 0,
        excludedCount: 0,
        rewardedCount: 0,
        frozenAt: now,
      });
      return {
        week, closesAt: closesAt.toISOString(), rewardsEnabled: false,
        participants: 0, frozen: 0, replayed: false, tiers: emptyTiers(),
      };
    }

    const discoveredBases = await tx.select({
      baseId: bases.id,
      ownerWalletShadow: bases.ownerWallet,
      deedAssetId: bases.deedAssetId,
      keepLevel: bases.keepLevel,
    }).from(bases).where(and(
      eq(bases.status, 'active'),
      isNotNull(bases.landPaidAt),
      isNotNull(bases.deedAssetId),
    )).orderBy(asc(bases.id));
    const baseIds = discoveredBases.map(({ baseId }) => baseId);
    const profiles = baseIds.length === 0 ? [] : await tx.select().from(baseProfiles)
      .where(inArray(baseProfiles.baseId, baseIds)).orderBy(asc(baseProfiles.baseId));
    const observations = baseIds.length === 0 ? [] : await tx.select()
      .from(deedOwnershipObservations)
      .where(inArray(deedOwnershipObservations.baseId, baseIds))
      .orderBy(asc(deedOwnershipObservations.baseId), desc(deedOwnershipObservations.checkedAt));
    const observationsByBase = new Map<string, typeof observations[number]>();
    for (const observation of observations) {
      if (!observationsByBase.has(observation.baseId)) observationsByBase.set(observation.baseId, observation);
    }
    const profilesByBase = new Map(profiles.map((profile) => [profile.baseId, profile]));
    const participants: RankedBase[] = [];
    const evidenceByBase = new Map<string, {
      assetId: string; owner: string; slot: number; checkedAt: Date; auditHash: string;
    }>();
    const exclusions: Array<{
      baseId: string; reason: CloseExclusionReason; detail: Record<string, string | number | boolean | null>;
    }> = [];
    const candidates = [] as typeof discoveredBases;
    for (const base of discoveredBases) {
      const profile = profilesByBase.get(base.baseId);
      if (!profile) {
        exclusions.push({ baseId: base.baseId, reason: 'missing_profile', detail: {} });
      } else {
        candidates.push(base);
      }
    }
    if (candidates.length > 0 && (!authority?.reader || !authority.expectedCollection)) {
      if (now.getTime() < closesAt.getTime() + LEAGUES.settlementDelayMs) {
        throw new Error('league close requires an injected finalized deed authority reader');
      }
    }
    const waves: Array<{ bases: typeof candidates; requests: LeagueAuthorityWave['requests'] }> = [];
    for (let offset = 0; offset < candidates.length; offset += BASE_OWNERSHIP.observationConcurrency) {
      const batch = candidates.slice(offset, offset + BASE_OWNERSHIP.observationConcurrency);
      const requests = batch.map((base) => {
        const prior = observationsByBase.get(base.baseId);
        const floor = prior?.slot === null || prior?.slot === undefined ? undefined : Number(prior.slot);
        return {
          assetId: base.deedAssetId!,
          ...(floor !== undefined && Number.isSafeInteger(floor) ? { minContextSlot: floor } : {}),
        };
      });
      waves.push({ bases: batch, requests });
    }
    let coherent: Awaited<ReturnType<typeof readCoherentLeagueAuthority>> | null = null;
    if (candidates.length > 0) {
      try {
        if (!authority?.reader || !authority.expectedCollection
          || now.getTime() >= closesAt.getTime() + LEAGUES.settlementDelayMs) {
          throw new Error('league close authority deadline expired');
        }
        coherent = await readCoherentLeagueAuthority(
          authority!.reader!, waves.map(({ requests }) => ({ requests })),
        );
      } catch (error) {
        if (now.getTime() < closesAt.getTime() + LEAGUES.settlementDelayMs) throw error;
        for (const candidate of candidates) {
          exclusions.push({
            baseId: candidate.baseId,
            reason: 'authority_snapshot_unavailable',
            detail: { terminalAtSettlementDeadline: true },
          });
        }
        await tx.insert(leagueWeekClosures).values({
          week, closesAt, effectiveStartWeek, featureEnabledAtClose,
          rewardsEnabled: false,
          failureReason: 'authority_snapshot_unavailable',
          participantCount: 0, excludedCount: exclusions.length, rewardedCount: 0, frozenAt: now,
        });
        if (exclusions.length > 0) {
          await tx.insert(leagueWeekBaseExclusions).values(exclusions.map((excluded) => ({
            week, ...excluded, createdAt: now,
          })));
        }
        return {
          week, closesAt: closesAt.toISOString(), rewardsEnabled: false,
          participants: 0, frozen: 0, replayed: false, tiers: emptyTiers(),
        };
      }
    }

    for (const wave of waves) {
      const batch = wave.bases;
      const locked = await tx.select({
        baseId: bases.id, ownerWalletShadow: bases.ownerWallet,
        deedAssetId: bases.deedAssetId, keepLevel: bases.keepLevel,
      }).from(bases).where(and(
        inArray(bases.id, batch.map((base) => base.baseId)),
        eq(bases.status, 'active'), isNotNull(bases.landPaidAt), isNotNull(bases.deedAssetId),
      ))
        .orderBy(asc(bases.id)).for('update');
      const lockedById = new Map(locked.map((base) => [base.baseId, base]));
      const lockedProfiles = await tx.select().from(baseProfiles)
        .where(inArray(baseProfiles.baseId, batch.map((base) => base.baseId)))
        .orderBy(asc(baseProfiles.baseId)).for('update');
      const lockedProfilesById = new Map(lockedProfiles.map((profile) => [profile.baseId, profile]));
      for (const base of batch) {
        const current = lockedById.get(base.baseId);
        const profile = lockedProfilesById.get(base.baseId);
        if (!current || !profile || current.ownerWalletShadow !== base.ownerWalletShadow
          || current.deedAssetId !== base.deedAssetId || current.keepLevel !== base.keepLevel) {
          exclusions.push({ baseId: base.baseId, reason: 'candidate_changed', detail: {} });
          continue;
        }
        const observed = coherent!.owners.get(base.deedAssetId!);
        if (!observed || !Number.isSafeInteger(observed.slot) || observed.slot < 0) {
          exclusions.push({ baseId: base.baseId, reason: 'deed_authority_unavailable', detail: {} });
          continue;
        }
        if (!ownershipEligible(observed, authority!.expectedCollection)) {
          exclusions.push({ baseId: base.baseId, reason: 'deed_authority_ineligible', detail: { slot: coherent!.slot } });
          continue;
        }
        if (observed.owner !== base.ownerWalletShadow) {
          exclusions.push({
            baseId: base.baseId, reason: 'deed_owner_mismatch',
            detail: { finalizedOwner: observed.owner, shadowOwner: base.ownerWalletShadow, slot: coherent!.slot },
          });
          continue;
        }
        participants.push({
          baseId: base.baseId, ownerWallet: observed.owner,
          trophies: profile.trophies, keepLevel: base.keepLevel,
        });
        evidenceByBase.set(base.baseId, {
          assetId: base.deedAssetId!, owner: observed.owner, slot: coherent!.slot,
          checkedAt: now,
          auditHash: closeEvidenceHash(base.deedAssetId!, observed.owner, observed.slot, now),
        });
      }
    }

    const participantIds = participants.map(({ baseId }) => baseId);
    const attacks = await ratedAttacksByBase(tx, participantIds, startsAt, closesAt);
    const winners = rewardedBaseIds(participants, attacks);
    const tiers = emptyTiers();
    for (const participant of participants) tiers[leagueForTrophies(participant.trophies)] += 1;

    await tx.insert(leagueWeekClosures).values({
      week,
      closesAt,
      effectiveStartWeek,
      featureEnabledAtClose,
      rewardsEnabled: true,
      participantCount: participants.length,
      excludedCount: exclusions.length,
      rewardedCount: winners.size,
      frozenAt: now,
    });
    if (exclusions.length > 0) {
      await tx.insert(leagueWeekBaseExclusions).values(exclusions.map((excluded) => ({
        week, ...excluded, createdAt: now,
      })));
    }
    if (participants.length > 0) {
      await tx.insert(leagueWeekBaseSnapshots).values(participants.map((participant) => {
        const evidence = evidenceByBase.get(participant.baseId)!;
        return {
          week,
          baseId: participant.baseId,
          ownerWalletAtClose: participant.ownerWallet,
          deedAssetId: evidence.assetId,
          deedObservationId: null,
          deedObservationSlot: BigInt(evidence.slot),
          deedObservationHash: evidence.auditHash,
          deedObservedAt: evidence.checkedAt,
          trophies: participant.trophies,
          keepLevel: participant.keepLevel,
          ratedAttacks: attacks.get(participant.baseId) ?? 0,
          tier: leagueForTrophies(participant.trophies),
          rewardEligible: winners.has(participant.baseId),
          createdAt: now,
        };
      }));
      await tx.insert(baseLeagueEntitlements).values(participants.map((participant) => {
        const tier = leagueForTrophies(participant.trophies);
        const reward = winners.has(participant.baseId)
          ? leagueWeeklyRewards(tier, participant.keepLevel)
          : { cacheShards: 0n, items: [] as LeagueRewardItem[] };
        const hasReward = reward.cacheShards > 0n || reward.items.length > 0;
        return {
          week,
          baseId: participant.baseId,
          tier,
          trophies: participant.trophies,
          keepAmount: 0n,
          keepLevelGranted: participant.keepLevel,
          cacheShardsGranted: reward.cacheShards,
          itemsGranted: reward.items,
          createdAt: now,
          ...(!hasReward ? { paidAt: now } : {}),
        };
      }));
      for (const participant of participants) {
        await tx.update(baseProfiles).set({
          league: leagueForTrophies(participant.trophies),
          weekStartTrophies: participant.trophies,
          updatedAt: now,
        }).where(eq(baseProfiles.baseId, participant.baseId));
      }
    }
    return {
      week,
      closesAt: closesAt.toISOString(),
      rewardsEnabled: true,
      participants: participants.length,
      frozen: winners.size,
      replayed: false,
      tiers,
    };
  });
}

/** Worker-start and minute recovery walk from the activation opening marker to
 * the latest elapsed boundary. Old gaps can only receive the audited unpaid
 * terminal close; the current pre-00:15 gap may still obtain coherent authority. */
export async function recoverMissingLeagueCloses(
  db: Db,
  now: Date,
  policy: LeagueRewardPolicy,
  authority?: LeagueCloseAuthority,
): Promise<LeagueCloseResult[]> {
  const featureConfigured = multiBaseEnabled() && policy.enabled;
  const [durableActivation] = await db.select({
    firstCompleteWeek: leagueRewardActivations.firstCompleteWeek,
  }).from(leagueRewardActivations).where(eq(leagueRewardActivations.singleton, 1));
  // A kill switch must stop new activation, not erase a boundary that was
  // already protected. SQL triggers cannot see process flags and will continue
  // fencing mutations until that missing week has an immutable close marker.
  const firstPaidWeek = durableActivation?.firstCompleteWeek
    ?? (featureConfigured ? await ensureLeagueRewardActivation(db, now, policy) : null);
  if (firstPaidWeek === null) return [];
  const firstBoundary = new Date(
    Date.parse(`${firstPaidWeek}T00:00:00.000Z`) - 7 * DAY_MS,
  );
  const latest = lastClosedLeagueWindow(now).startsAt;
  if (firstBoundary.getTime() > latest.getTime()) return [];
  const existing = await db.select({ week: leagueWeekClosures.week })
    .from(leagueWeekClosures).where(and(
      gte(leagueWeekClosures.week, dateKey(firstBoundary)),
      lte(leagueWeekClosures.week, dateKey(latest)),
    ));
  const closed = new Set(existing.map(({ week }) => week));
  const recovered: LeagueCloseResult[] = [];
  for (let cursor = firstBoundary; cursor.getTime() <= latest.getTime();
    cursor = new Date(cursor.getTime() + 7 * DAY_MS)) {
    const week = dateKey(cursor);
    if (closed.has(week)) continue;
    recovered.push(await closeLeagueWeek(db, now, policy, authority, week));
  }
  return recovered;
}

export interface LeagueSettlementHooks {
  /** TEST ONLY: deterministic failure seam before a base grant transaction. */
  beforeGrant?: (baseId: string) => Promise<void>;
}

export async function reconcilePendingLeagueRewards(
  db: Db,
  now = new Date(),
  policy = defaultRewardPolicy(),
  hooks: LeagueSettlementHooks = {},
): Promise<Omit<LeagueSettlementResult, 'tiers' | 'clanChests' | 'closesAt'>> {
  const empty = {
    week: dateKey(lastClosedLeagueWindow(now).startsAt), rewardsEnabled: policy.enabled,
    frozen: 0, settled: 0, replayed: 0, failed: 0, cacheShards: 0n, items: 0,
  };
  const [legacyKeep] = await db.select({
    week: baseLeagueEntitlements.week,
    baseId: baseLeagueEntitlements.baseId,
  }).from(baseLeagueEntitlements).where(ne(baseLeagueEntitlements.keepAmount, 0n)).limit(1);
  if (legacyKeep) {
    throw new Error(
      `legacy KEEP league entitlement ${legacyKeep.week}/${legacyKeep.baseId} requires operator audit`,
    );
  }
  if (!multiBaseEnabled() || !policy.enabled) return empty;
  const latestDrainableClose = new Date(now.getTime() - LEAGUES.settlementDelayMs);
  const pending = await db.select({
    week: baseLeagueEntitlements.week,
    baseId: baseLeagueEntitlements.baseId,
  }).from(baseLeagueEntitlements).innerJoin(
    leagueWeekClosures,
    eq(leagueWeekClosures.week, baseLeagueEntitlements.week),
  ).where(and(
    eq(baseLeagueEntitlements.keepAmount, 0n),
    isNull(baseLeagueEntitlements.paidAt),
    eq(leagueWeekClosures.rewardsEnabled, true),
    lte(leagueWeekClosures.closesAt, latestDrainableClose),
  )).orderBy(
    sql`${baseLeagueEntitlements.lastAttemptAt} ASC NULLS FIRST`,
    asc(baseLeagueEntitlements.week),
    asc(baseLeagueEntitlements.baseId),
  )
    .limit(LEAGUES.settlementBatchSize);

  const result = { ...empty };
  for (const candidate of pending) {
    try {
      // Persist the attempt outside the grant transaction. A poison receipt
      // must rotate behind untouched rows even when its grant rolls back, so a
      // full batch of bad inventories cannot starve newer winners forever.
      await db.update(baseLeagueEntitlements).set({ lastAttemptAt: now }).where(and(
        eq(baseLeagueEntitlements.week, candidate.week),
        eq(baseLeagueEntitlements.baseId, candidate.baseId),
        isNull(baseLeagueEntitlements.paidAt),
      ));
      await hooks.beforeGrant?.(candidate.baseId);
      const granted = await db.transaction(async (tx) => {
        const [receipt] = await tx.select().from(baseLeagueEntitlements).where(and(
          eq(baseLeagueEntitlements.week, candidate.week),
          eq(baseLeagueEntitlements.baseId, candidate.baseId),
        )).for('update');
        if (!receipt || receipt.paidAt) return null;
        if (receipt.keepAmount !== 0n) {
          throw new Error(`league receipt ${receipt.week}/${receipt.baseId} contains forbidden KEEP`);
        }
        if (receipt.cacheShardsGranted > 0n) {
          await rewardBaseShards(
            tx, receipt.baseId, receipt.cacheShardsGranted, 'league.weekly_cache',
            `league-cache:${receipt.week}:${receipt.baseId}`,
            { week: receipt.week, tier: receipt.tier, keepLevel: receipt.keepLevelGranted },
          );
        }
        for (const item of receipt.itemsGranted) {
          const journaled = await tx.insert(leagueItemGrants).values({
            week: receipt.week,
            baseId: receipt.baseId,
            itemId: item.itemId,
            qty: item.qty,
            grantedAt: now,
          }).onConflictDoNothing().returning({ itemId: leagueItemGrants.itemId });
          if (journaled.length === 1) {
            await tx.insert(baseItems).values({
              baseId: receipt.baseId, itemId: item.itemId, qty: item.qty, acquiredAt: now,
            }).onConflictDoUpdate({
              target: [baseItems.baseId, baseItems.itemId],
              set: { qty: sql`${baseItems.qty} + ${item.qty}`, acquiredAt: now },
            });
          }
        }
        await tx.update(baseLeagueEntitlements).set({ paidAt: now }).where(and(
          eq(baseLeagueEntitlements.week, receipt.week),
          eq(baseLeagueEntitlements.baseId, receipt.baseId),
          isNull(baseLeagueEntitlements.paidAt),
        ));
        return {
          week: receipt.week,
          cacheShards: receipt.cacheShardsGranted,
          items: receipt.itemsGranted.reduce((sum, item) => sum + item.qty, 0),
        };
      });
      if (!granted) {
        result.replayed += 1;
      } else {
        result.week = granted.week;
        result.settled += 1;
        result.cacheShards += granted.cacheShards;
        result.items += granted.items;
      }
    } catch {
      // Per-base isolation is intentional. BullMQ retries the job because the
      // caller sees failed>0, while unrelated receipts still settle now.
      result.failed += 1;
    }
  }
  return result;
}

async function requireClosedLeagueWeek(
  db: Db,
  now: Date,
  policy: LeagueRewardPolicy,
): Promise<LeagueCloseResult> {
  const { startsAt, closesAt } = lastClosedLeagueWindow(now);
  const week = dateKey(startsAt);
  const activationWeek = await ensureLeagueRewardActivation(db, now, policy);
  const shouldReward = multiBaseEnabled() && policy.enabled
    && activationWeek !== null && week >= activationWeek;
  if (!shouldReward) {
    return {
      week,
      closesAt: closesAt.toISOString(),
      rewardsEnabled: false,
      participants: 0,
      frozen: 0,
      replayed: false,
      tiers: emptyTiers(),
    };
  }

  const [closure] = await db.select().from(leagueWeekClosures)
    .where(eq(leagueWeekClosures.week, week));
  if (!closure) {
    throw new Error(`league settlement ${week} has no complete 00:00 close snapshot`);
  }
  if (!closure.rewardsEnabled) {
    return {
      week,
      closesAt: closure.closesAt.toISOString(),
      rewardsEnabled: false,
      participants: 0,
      frozen: 0,
      replayed: true,
      tiers: emptyTiers(),
    };
  }
  const snapshots = await db.select({
    tier: leagueWeekBaseSnapshots.tier,
    rewardEligible: leagueWeekBaseSnapshots.rewardEligible,
  }).from(leagueWeekBaseSnapshots).where(eq(leagueWeekBaseSnapshots.week, week));
  const receipts = await db.select({ baseId: baseLeagueEntitlements.baseId })
    .from(baseLeagueEntitlements).where(eq(baseLeagueEntitlements.week, week));
  const rewarded = snapshots.filter(({ rewardEligible }) => rewardEligible).length;
  if (snapshots.length !== closure.participantCount
      || receipts.length !== closure.participantCount
      || rewarded !== closure.rewardedCount) {
    throw new Error(`league settlement ${week} found an incomplete close snapshot`);
  }
  const tiers = emptyTiers();
  for (const snapshot of snapshots) tiers[snapshot.tier] += 1;
  return {
    week,
    closesAt: closure.closesAt.toISOString(),
    rewardsEnabled: true,
    participants: closure.participantCount,
    frozen: closure.rewardedCount,
    replayed: true,
    tiers,
  };
}

export async function runWeeklyLeagueReset(
  db: Db,
  now = new Date(),
  policy = defaultRewardPolicy(),
  hooks: LeagueSettlementHooks = {},
): Promise<LeagueSettlementResult> {
  const frozen = await requireClosedLeagueWeek(db, now, policy);
  const drained = await reconcilePendingLeagueRewards(db, now, policy, hooks);
  // Clan chests remain an independent weekly SHARDS settlement. They do not
  // fund leagues and must run even while ranked rewards are dark.
  const { settleClanChests } = await import('./clans');
  const clan = await settleClanChests(db, dateKey(lastClosedLeagueWindow(now).closesAt));
  return {
    ...drained,
    week: frozen.week,
    closesAt: frozen.closesAt,
    frozen: frozen.frozen,
    tiers: frozen.tiers,
    clanChests: clan.settled,
  };
}

export async function resolveLeagueBaseId(
  db: DbOrTx, wallet: string, requestedBaseId?: string,
): Promise<string | null> {
  if (requestedBaseId) {
    const [owned] = await db.select({ id: bases.id }).from(bases).where(and(
      eq(bases.id, requestedBaseId), eq(bases.ownerWallet, wallet), eq(bases.status, 'active'),
    ));
    if (!owned) throw new HttpError(404, 'base not found');
    return owned.id;
  }
  const [selected] = await db.select({ id: bases.id }).from(baseSlots)
    .innerJoin(bases, and(
      eq(bases.id, baseSlots.baseId), eq(bases.ownerWallet, wallet), eq(bases.status, 'active'),
    ))
    .where(and(eq(baseSlots.wallet, wallet), eq(baseSlots.active, true)))
    .orderBy(asc(baseSlots.slot), asc(bases.id)).limit(1);
  return selected?.id ?? null;
}

/** Read-only current standing. Tier and candidate state are derived from live
 * cumulative trophies; stored league badges are never trusted as authority. */
export async function getLeagueOverview(
  db: Db,
  wallet: string,
  requestedBaseId: string | undefined,
  policy: LeagueRewardPolicy,
  now = new Date(),
): Promise<LeagueOverview> {
  const window = leagueWindow(now);
  const baseId = await resolveLeagueBaseId(db, wallet, requestedBaseId);
  const ranked = await db.select({
    baseId: bases.id,
    ownerWallet: bases.ownerWallet,
    name: players.name,
    trophies: baseProfiles.trophies,
    keepLevel: bases.keepLevel,
  }).from(bases)
    .innerJoin(baseProfiles, eq(baseProfiles.baseId, bases.id))
    .innerJoin(players, eq(players.wallet, bases.ownerWallet))
    .where(and(
      eq(bases.status, 'active'), isNotNull(bases.landPaidAt), isNotNull(bases.deedAssetId),
    ))
    .orderBy(desc(baseProfiles.trophies), asc(bases.id));
  const board = ranked.slice(0, 100).map((base, index) => ({
    rank: index + 1,
    baseId: base.baseId,
    name: base.name || null,
    trophies: base.trophies,
    tier: leagueForTrophies(base.trophies),
    you: base.baseId === baseId,
  }));

  let you: LeagueOverview['you'] = null;
  let lastSettlement: LeagueOverview['lastSettlement'] = null;
  if (baseId) {
    const selected = ranked.find((base) => base.baseId === baseId);
    if (selected) {
      const peers = ranked.filter((base) => base.ownerWallet === wallet);
      const attacks = await ratedAttacksByBase(
        db, peers.map((base) => base.baseId), window.startsAt, window.closesAt,
      );
      const winners = rewardedBaseIds(peers, attacks);
      const participationMet = (attacks.get(baseId) ?? 0) >= LEAGUES.rewardMinAttackerRaids;
      const rewardCandidate = selected.trophies > 0 && winners.has(baseId);
      you = {
        baseId,
        trophies: selected.trophies,
        tier: leagueForTrophies(selected.trophies),
        currentWeekRatedAttacks: attacks.get(baseId) ?? 0,
        participationMet,
        rewardCandidate,
        blockedByHigherBase: selected.trophies > 0 && participationMet && !rewardCandidate,
      };
      const [last] = await db.select().from(baseLeagueEntitlements).where(and(
        eq(baseLeagueEntitlements.baseId, baseId),
        eq(baseLeagueEntitlements.keepAmount, 0n),
        isNotNull(baseLeagueEntitlements.paidAt),
        sql`${baseLeagueEntitlements.cacheShardsGranted} > 0`,
      )).orderBy(desc(baseLeagueEntitlements.week)).limit(1);
      if (last?.paidAt) {
        lastSettlement = {
          week: last.week,
          tier: last.tier,
          trophies: last.trophies,
          keepLevel: last.keepLevelGranted,
          cacheShards: last.cacheShardsGranted.toString(),
          items: last.itemsGranted,
          settledAt: last.paidAt.toISOString(),
        };
      }
    }
  }

  const [activation] = await db.select().from(leagueRewardActivations)
    .where(eq(leagueRewardActivations.singleton, 1));
  const currentWeek = dateKey(window.startsAt);
  const openingWeek = dateKey(new Date(window.startsAt.getTime() - 7 * DAY_MS));
  const [opening] = await db.select({ enabled: leagueWeekClosures.featureEnabledAtClose })
    .from(leagueWeekClosures).where(eq(leagueWeekClosures.week, openingWeek));
  const featureEnabled = multiBaseEnabled() && policy.enabled;
  const active = Boolean(featureEnabled && activation
    && currentWeek >= activation.firstCompleteWeek && opening?.enabled);
  const rewardStatus: LeagueOverview['rewards']['status'] = !featureEnabled
    ? 'disabled' : active ? 'active' : 'scheduled';
  const firstEarningWeek = activation
    ? maxWeek(
      activation.firstCompleteWeek,
      active ? currentWeek : dateKey(new Date(window.startsAt.getTime() + 7 * DAY_MS)),
    )
    : firstCompleteLeagueWeek(now, policy.startWeek);
  const firstSettlementAt = new Date(
    Date.parse(firstEarningWeek + 'T00:00:00.000Z') + 7 * DAY_MS + LEAGUES.settlementDelayMs,
  );
  return {
    week: {
      startsAt: window.startsAt.toISOString(),
      closesAt: window.closesAt.toISOString(),
      settlesAt: window.settlesAt.toISOString(),
    },
    rewards: {
      status: rewardStatus,
      firstSettlementAt: firstSettlementAt.toISOString(),
      minRatedAttacks: LEAGUES.rewardMinAttackerRaids,
      maxRewardedBasesPerWallet: LEAGUES.rewardsPerWalletMax,
    },
    trophyModel: 'cumulative',
    you,
    board,
    lastSettlement,
  };
}
