/** Durable per-physical-Mine notification claims. Candidate discovery is cheap;
 * every claim re-locks and revalidates the authority/fullness boundary. */
import { MINING, NOTIFICATIONS } from '@shardkeep/shared';
import { and, asc, eq, inArray, isNotNull, isNull, lte, notExists, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  baseRaidLocks, bases, baseSlots, buildings, mineAccrualStates, players,
  pushEvents, pushSubscriptions, nativePushSubscriptions,
} from '../db/schema';
import { currentMineStorageCap, projectMineFill } from '../game/baseMining';
import type { PushPayload } from './webPush';

interface DueMine {
  mineId: string;
  baseId: string;
  cycle: number;
  wallet: string;
}

export interface ClaimedMineFullGroup {
  wallet: string;
  occurredAt: Date;
  refs: ReadonlyArray<{ kind: 'mine_full'; refId: string }>;
  payload: PushPayload;
}

export interface MineFullClaimResult {
  groups: ClaimedMineFullGroup[];
  heldWallets: number;
}

export interface MineFullBootstrapResult {
  scanned: number;
  classified: number;
  suppressed: number;
  scheduled: number;
  dormant: number;
  held: number;
}

export function mineFullRef(mineId: string, cycle: number): string {
  return `mine:${mineId}:cycle:${cycle}`;
}

export function mineFullPayload(count: number, multipleBases: boolean): PushPayload {
  return {
    kind: 'mine_full',
    title: 'MINES FULL — COLLECT NOW',
    body: count === 1
      ? 'Your Mine is full. Collect SHARDS to grow stronger or forge KEEP before rivals strike.'
      : `${count} Mines are full. Collect SHARDS to grow stronger or forge KEEP before rivals strike.`,
    tag: 'mine_full',
    url: multipleBases ? '/?screen=bases' : '/?screen=base',
  };
}

/** Classify Mine rows that predate the notification source without guessing at
 * migration time. A row stays pending while its base is raid-locked or changes
 * owner, so restart/retry observes the final physical buffer. Full history is
 * closed as suppressed; a partial buffer receives its exact future boundary.
 *
 * This is deliberately independent of the delivery feature flag. Applying the
 * schema dark must still finish the flood-safe bootstrap before activation. */
export async function classifyMineFullNotificationBootstrap(
  db: Db,
  options: { afterDiscovery?: () => Promise<void> } = {},
): Promise<MineFullBootstrapResult> {
  const candidates = await db.select({
    mineId: mineAccrualStates.mineBuildingId,
    baseId: bases.id,
    wallet: bases.ownerWallet,
  }).from(mineAccrualStates)
    .innerJoin(buildings, and(
      eq(buildings.id, mineAccrualStates.mineBuildingId),
      eq(buildings.type, 'mine'),
    ))
    .innerJoin(bases, eq(bases.id, buildings.baseId))
    .where(and(
      eq(mineAccrualStates.fullNotificationBootstrapPending, true),
      // A preserved/long-running raid must not occupy the first bounded page
      // forever and starve every later Mine. This is discovery only: a lock
      // created after this read is still checked under the transaction below.
      notExists(db.select({ id: baseRaidLocks.baseId }).from(baseRaidLocks)
        .where(eq(baseRaidLocks.baseId, bases.id))),
    ))
    .orderBy(asc(bases.ownerWallet), asc(bases.id), asc(mineAccrualStates.mineBuildingId))
    .limit(NOTIFICATIONS.mineBootstrapBatchSize);
  await options.afterDiscovery?.();

  const summary: MineFullBootstrapResult = {
    scanned: candidates.length,
    classified: 0,
    suppressed: 0,
    scheduled: 0,
    dormant: 0,
    held: 0,
  };
  for (const candidate of candidates) {
    const outcome = await db.transaction(async (tx) => {
      // Match deed mutation order: player -> base -> slots -> raid lock ->
      // building -> Mine state. Candidate discovery intentionally owns no lock.
      const [player] = await tx.select({ wallet: players.wallet }).from(players)
        .where(eq(players.wallet, candidate.wallet)).for('update');
      if (!player) return 'held' as const;
      const [base] = await tx.select({ ownerWallet: bases.ownerWallet }).from(bases)
        .where(eq(bases.id, candidate.baseId)).for('update');
      if (!base || base.ownerWallet !== candidate.wallet) return 'held' as const;
      await tx.select({ baseId: baseSlots.baseId }).from(baseSlots)
        .where(eq(baseSlots.baseId, candidate.baseId))
        .orderBy(asc(baseSlots.wallet), asc(baseSlots.slot)).for('update');
      const raidLocks = await tx.select({ baseId: baseRaidLocks.baseId }).from(baseRaidLocks)
        .where(eq(baseRaidLocks.baseId, candidate.baseId)).for('update');
      if (raidLocks.length > 0) return 'held' as const;
      const [building] = await tx.select({
        baseId: buildings.baseId, type: buildings.type,
      }).from(buildings).where(eq(buildings.id, candidate.mineId)).for('update');
      if (building?.type !== 'mine' || building.baseId !== candidate.baseId) return 'held' as const;
      const [state] = await tx.select().from(mineAccrualStates)
        .where(eq(mineAccrualStates.mineBuildingId, candidate.mineId)).for('update');
      if (!state?.fullNotificationBootstrapPending) return 'skipped' as const;

      // Sample the database clock only after every authority/state lock. The
      // projection then shares the exact bigint path used by status/collection.
      const clockRows = await tx.execute(sql`select clock_timestamp() as now`) as unknown as Array<{ now: Date }>;
      const classifiedAt = new Date(clockRows[0]!.now);
      const cap = await currentMineStorageCap(tx, candidate.mineId, classifiedAt);
      const quota = Number(cap / BigInt(MINING.MINE_STORAGE_DAYS));
      if (!Number.isSafeInteger(quota)) {
        throw new Error(`Mine ${candidate.mineId} quota exceeds safe integer`);
      }
      const projection = projectMineFill(
        state.accruedShards, state.lastAccrualAt, quota, classifiedAt, state.productionRemainder,
      );
      const isFull = projection.fullAtMs !== null && projection.accrued >= projection.capacity;
      let fullNotificationCheckAt: Date | null = null;
      if (projection.fullAtMs !== null) {
        const projectedMs = Number(projection.fullAtMs);
        if (Number.isSafeInteger(projectedMs)) fullNotificationCheckAt = new Date(projectedMs);
      }
      if (isFull) {
        await tx.insert(pushEvents).values({
          kind: 'mine_full',
          refId: mineFullRef(candidate.mineId, state.fullNotificationCycle),
          wallet: candidate.wallet,
          createdAt: classifiedAt,
          outcome: 'suppressed',
        }).onConflictDoNothing();
        fullNotificationCheckAt = null;
      }
      const updated = await tx.update(mineAccrualStates).set({
        fullNotificationCheckAt,
        fullNotificationBootstrapPending: false,
      }).where(and(
        eq(mineAccrualStates.mineBuildingId, candidate.mineId),
        eq(mineAccrualStates.fullNotificationBootstrapPending, true),
        eq(mineAccrualStates.fullNotificationCycle, state.fullNotificationCycle),
      )).returning({ id: mineAccrualStates.mineBuildingId });
      if (updated.length !== 1) {
        throw new Error(`Mine bootstrap state changed for ${candidate.mineId}`);
      }
      if (isFull) return 'suppressed' as const;
      return fullNotificationCheckAt ? 'scheduled' as const : 'dormant' as const;
    });
    if (outcome === 'held') summary.held += 1;
    else if (outcome !== 'skipped') {
      summary.classified += 1;
      summary[outcome] += 1;
    }
  }
  return summary;
}

/** Discover by the due index, then claim wallet groups in independent
 * transactions. Lock order matches deed mutations: player -> bases -> slots ->
 * raid locks -> buildings -> Mine states. */
export async function claimDueMineFullGroups(
  db: Db,
  now: Date,
  /** Deterministic concurrency seam used to prove candidate-discovery races.
   * Production callers omit it. Authority is always re-read under locks. */
  options: { afterDiscovery?: () => Promise<void>; webPushEnabled?: boolean; nativePushEnabled?: boolean } = {},
): Promise<MineFullClaimResult> {
  const batchCutoff = new Date(now.getTime() - NOTIFICATIONS.batchWindowMs);
  const due = await db.select({
    mineId: mineAccrualStates.mineBuildingId,
    baseId: bases.id,
    cycle: mineAccrualStates.fullNotificationCycle,
    wallet: bases.ownerWallet,
  }).from(mineAccrualStates)
    .innerJoin(buildings, eq(buildings.id, mineAccrualStates.mineBuildingId))
    .innerJoin(bases, eq(bases.id, buildings.baseId))
    .where(and(
      eq(mineAccrualStates.fullNotificationBootstrapPending, false),
      isNotNull(mineAccrualStates.fullNotificationCheckAt),
      lte(mineAccrualStates.fullNotificationCheckAt, batchCutoff),
    ))
    .orderBy(asc(bases.ownerWallet), asc(mineAccrualStates.mineBuildingId));
  await options.afterDiscovery?.();

  const byWallet = new Map<string, DueMine[]>();
  for (const row of due) {
    const list = byWallet.get(row.wallet);
    if (list) list.push(row); else byWallet.set(row.wallet, [row]);
  }

  const groups: ClaimedMineFullGroup[] = [];
  let heldWallets = 0;
  for (const [wallet, candidates] of byWallet) {
    const result = await db.transaction(async (tx) => {
      const [player] = await tx.select({ wallet: players.wallet }).from(players)
        .where(eq(players.wallet, wallet)).for('update');
      if (!player) return { group: null, held: false };

      const baseIds = [...new Set(candidates.map((candidate) => candidate.baseId))].sort();
      // Acquire base/slot/raid rows before the building/Mine rows. The
      // candidate read above owns no locks, and the player root serializes any
      // supported transfer/activation while we establish this canonical set.
      const lockedBases = baseIds.length === 0 ? [] : await tx.select().from(bases)
        .where(inArray(bases.id, baseIds)).orderBy(asc(bases.id)).for('update');
      const lockedSlots = baseIds.length === 0 ? [] : await tx.select().from(baseSlots)
        .where(inArray(baseSlots.baseId, baseIds)).orderBy(asc(baseSlots.baseId)).for('update');
      const raidLocks = baseIds.length === 0 ? [] : await tx.select().from(baseRaidLocks)
        .where(inArray(baseRaidLocks.baseId, baseIds)).orderBy(asc(baseRaidLocks.baseId)).for('update');
      const raidedBases = new Set(raidLocks.map((row) => row.baseId));
      // Reservation release restores Mine rows before deleting its base lock.
      // Do not lock those Mines in the opposite order while holding that lock;
      // leave their cycle due and still process this wallet's unreserved deeds.
      const mineIds = [...new Set(candidates
        .filter((candidate) => !raidedBases.has(candidate.baseId))
        .map((candidate) => candidate.mineId))].sort();
      if (mineIds.length === 0) return { group: null, held: raidLocks.length > 0 };
      const currentBuildings = await tx.select().from(buildings)
        .where(inArray(buildings.id, mineIds)).orderBy(asc(buildings.id)).for('update');
      const states = await tx.select().from(mineAccrualStates)
        .where(inArray(mineAccrualStates.mineBuildingId, mineIds))
        .orderBy(asc(mineAccrualStates.mineBuildingId)).for('update');

      const buildingById = new Map(currentBuildings.map((row) => [row.id, row]));
      const baseById = new Map(lockedBases.map((row) => [row.id, row]));
      const activeSlotBases = new Set(lockedSlots
        .filter((row) => row.wallet === wallet && row.active).map((row) => row.baseId));
      const stateById = new Map(states.map((row) => [row.mineBuildingId, row]));
      const webSubscriptions = await tx.select({ enabledAt: pushSubscriptions.enabledAt })
        .from(pushSubscriptions).where(and(
          eq(pushSubscriptions.wallet, wallet), isNull(pushSubscriptions.disabledAt),
        ));
      const nativeSubscriptions = await tx.select({ enabledAt: nativePushSubscriptions.enabledAt })
        .from(nativePushSubscriptions).where(and(
          eq(nativePushSubscriptions.wallet, wallet), isNull(nativePushSubscriptions.disabledAt),
        ));
      const liveSubscriptions = [
        ...(options.webPushEnabled !== false ? webSubscriptions : []),
        ...(options.nativePushEnabled ? nativeSubscriptions : []),
      ];
      const activeDeeds = await tx.select({ baseId: baseSlots.baseId }).from(baseSlots)
        .innerJoin(bases, eq(bases.id, baseSlots.baseId)).where(and(
          eq(baseSlots.wallet, wallet), eq(baseSlots.active, true),
          eq(bases.ownerWallet, wallet), eq(bases.status, 'active'),
          isNotNull(bases.landPaidAt), isNotNull(bases.deedAssetId),
        ));

      const claimed: Array<{ kind: 'mine_full'; refId: string }> = [];
      let oldest: Date | null = null;
      let held = raidLocks.length > 0;
      for (const candidate of candidates) {
        if (raidedBases.has(candidate.baseId)) continue;
        const state = stateById.get(candidate.mineId);
        if (!state || state.fullNotificationBootstrapPending
          || state.fullNotificationCycle !== candidate.cycle) continue;
        const refId = mineFullRef(candidate.mineId, candidate.cycle);
        const building = buildingById.get(candidate.mineId);
        const base = building?.baseId ? baseById.get(building.baseId) : undefined;
        // Discovery deliberately owns no locks. If the deed moved before this
        // claim transaction, its due cycle now belongs to the buyer. Do not
        // suppress it under the stale seller or clear the shared physical-Mine
        // deadline; a following sweep will rediscover and validate the buyer.
        if (building?.baseId === candidate.baseId && base
          && base.ownerWallet !== candidate.wallet) {
          held = true;
          continue;
        }
        const validDeed = building?.type === 'mine' && base
          && base.ownerWallet === wallet && base.status === 'active'
          && base.landPaidAt !== null && base.deedAssetId !== null
          && activeSlotBases.has(base.id);

        const suppress = async (): Promise<void> => {
          await tx.insert(pushEvents).values({
            kind: 'mine_full', refId, wallet, createdAt: now, outcome: 'suppressed',
          }).onConflictDoNothing();
          await tx.update(mineAccrualStates).set({ fullNotificationCheckAt: null }).where(and(
            eq(mineAccrualStates.mineBuildingId, candidate.mineId),
            eq(mineAccrualStates.fullNotificationCycle, candidate.cycle),
          ));
        };

        if (!validDeed) { await suppress(); continue; }
        const cap = await currentMineStorageCap(tx, candidate.mineId, now);
        const quota = Number(cap / BigInt(MINING.MINE_STORAGE_DAYS));
        const projection = projectMineFill(
          state.accruedShards, state.lastAccrualAt, quota, now, state.productionRemainder,
        );
        if (projection.fullAtMs === null || projection.accrued < projection.capacity) {
          const projectedMs = projection.fullAtMs === null ? null : Number(projection.fullAtMs);
          await tx.update(mineAccrualStates).set({
            fullNotificationCheckAt: projectedMs !== null && Number.isSafeInteger(projectedMs)
              ? new Date(projectedMs) : null,
          }).where(eq(mineAccrualStates.mineBuildingId, candidate.mineId));
          continue;
        }
        const occurredAt = new Date(Number(projection.fullAtMs));
        if (occurredAt > batchCutoff) {
          await tx.update(mineAccrualStates).set({ fullNotificationCheckAt: occurredAt })
            .where(eq(mineAccrualStates.mineBuildingId, candidate.mineId));
          held = true;
          continue;
        }
        const consented = liveSubscriptions.some((sub) => sub.enabledAt <= occurredAt);
        const currentEnough = occurredAt > new Date(now.getTime() - NOTIFICATIONS.sweepLookbackMs);
        // A paused delivery channel is not revoked consent. Preserve its due
        // cycle while inside the existing lookback, instead of having the other
        // transport's worker permanently consume it as historical suppression.
        if (!consented && currentEnough && [...webSubscriptions, ...nativeSubscriptions]
          .some((sub) => sub.enabledAt <= occurredAt)) {
          held = true;
          continue;
        }
        if (!consented || !currentEnough) { await suppress(); continue; }

        const inserted = await tx.insert(pushEvents).values({
          kind: 'mine_full', refId, wallet, createdAt: now,
        }).onConflictDoNothing().returning({ refId: pushEvents.refId });
        await tx.update(mineAccrualStates).set({ fullNotificationCheckAt: null }).where(and(
          eq(mineAccrualStates.mineBuildingId, candidate.mineId),
          eq(mineAccrualStates.fullNotificationCycle, candidate.cycle),
        ));
        if (inserted.length === 1) {
          claimed.push({ kind: 'mine_full', refId });
          if (!oldest || occurredAt < oldest) oldest = occurredAt;
        }
      }
      if (claimed.length === 0 || !oldest) return { group: null, held };
      return {
        held,
        group: {
          wallet, occurredAt: oldest, refs: claimed,
          payload: mineFullPayload(claimed.length, activeDeeds.length > 1),
        } satisfies ClaimedMineFullGroup,
      };
    });
    if (result.held) heldWallets += 1;
    if (result.group) groups.push(result.group);
  }
  return { groups, heldWallets };
}
