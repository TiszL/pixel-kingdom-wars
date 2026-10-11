/** D153.28 dark accounting only. Callers hold ALL involved bases in sorted
 * order before entering. This helper then locks dedicated wallet accounting;
 * it never locks an original player, fetches authority or replaces a source.
 * One source per wallet means its bounded candidates are processed in earning
 * order. Future multiwallet callers must prelock wallet rows in sorted order.
 * Immutable events are daily usage/carry authority; stock is a projection.
 */
import { createHash } from 'node:crypto';
import { PHASE_E_HARVESTER } from '@shardkeep/shared';
import { RAW_RESOURCE_STORAGE_MAX, RawResourceStockSchema } from '@shardkeep/shared/phaseEResources';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx, DbTx } from '../db/client';
import { bases, buildings, deedOwnershipObservations, harvesterCustodyStops, harvesterEntries, harvesterEvents, harvesterSources, harvesterSourceHeads, harvesterSourceClosures,
  harvesterWalletLocks, resourceStocks } from '../db/schema';
import { readHarvesterSource } from './harvesterSources';
import { HttpError } from '../lib/errors';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const V1 = PHASE_E_HARVESTER.v1;
const SECOND_MS = 1_000, DAY_MS = 24 * 60 * 60 * SECOND_MS;
type Event = typeof harvesterEvents.$inferSelect;
const closeReason = z.enum(['replacement', 'custody_change', 'deactivation', 'facility_removed', 'realm_change', 'lease_expired']);
export type HarvesterCloseReason = z.infer<typeof closeReason>;
/** Only this capacity failure may defer delivery after persisting a custody
 * stop. Integrity, authority and database failures must still abort callers. */
export class HarvesterStorageCapacityError extends Error {
  constructor() { super('Harvester settlement would overflow original raw stock'); this.name = 'HarvesterStorageCapacityError'; }
}
/** Retired wallet-wide helpers cannot preserve stable source custody or its
 * immutable facility/job evidence. Fence their whole mutation before value or
 * structures move, including compatibility rows naming a former owner. Callers
 * hold all affected player rows first; modern stable boundaries close normally. */
export async function assertLegacyHarvesterBoundarySafe(tx: DbTx, wallets: readonly string[]) {
  const ids = [...new Set(wallets)].sort();
  if (!ids.length) return;
  const affected = await tx.select({ id: bases.id }).from(bases).where(or(inArray(bases.ownerWallet, ids),
    inArray(bases.id, tx.select({ id: buildings.baseId }).from(buildings).where(inArray(buildings.playerWallet, ids)))))
    .orderBy(asc(bases.id)).for('update');
  if (!affected.length) return;
  const [source] = await tx.select({ id: harvesterSources.id }).from(harvesterSources)
    .where(inArray(harvesterSources.baseId, affected.map(base => base.id))).limit(1);
  if (source) throw new HttpError(409, 'Stable Harvester history requires the stable base operation', 'HARVESTER_STABLE_BOUNDARY_REQUIRED');
}
/** Multi-base boundary protocol: caller already holds ALL bases in sorted
 * order. Prelock original accounting wallets together before settling any base;
 * historical earner and current owner may differ. No player lock is acquired. */
export async function lockHarvesterWalletsForBases(tx: DbTx, baseIds: readonly string[]) {
  const ids = [...new Set(baseIds.map(id => uuid.parse(id)))].sort();
  if (!ids.length) return [];
  const heads = await tx.select({ wallet: harvesterSourceHeads.wallet }).from(harvesterSourceHeads)
    .where(inArray(harvesterSourceHeads.baseId, ids));
  const wallets = [...new Set(heads.map(head => head.wallet))].sort();
  for (const wallet of wallets) {
    await tx.insert(harvesterWalletLocks).values({ wallet }).onConflictDoNothing();
    await tx.select().from(harvesterWalletLocks).where(eq(harvesterWalletLocks.wallet, wallet)).for('update');
  }
  return wallets;
}
const dayAt = (ms: number) => new Date(Math.floor(ms / DAY_MS) * DAY_MS);
function expectedEntries(event: Pick<Event, 'gross' | 'net' | 'tax'>) {
  return [{ bucket: 'issued' as const, delta: -event.gross },
    { bucket: 'base_stock' as const, delta: event.net },
    { bucket: 'island_pool' as const, delta: event.tax }];
}

/** Private original receipts only. No current inventory, authority or planner.
 * A public adapter must authenticate the original actor before disclosure. */
export async function readHarvesterSettlement(db: DbOrTx, sourceId: string) {
  const source = await readHarvesterSource(db, uuid.parse(sourceId));
  if (!source) return null;
  // One statement sees events and their committed entries together. No mutable
  // current carry or ownership is substituted into historical proof validation.
  const rows = await db.select({ event: harvesterEvents, entry: harvesterEntries, closure: harvesterSourceClosures, stop: harvesterCustodyStops }).from(harvesterSources)
    .leftJoin(harvesterSourceClosures, eq(harvesterSourceClosures.sourceId, harvesterSources.id))
    .leftJoin(harvesterCustodyStops, eq(harvesterCustodyStops.sourceId, harvesterSources.id))
    .leftJoin(harvesterEvents, eq(harvesterEvents.sourceId, harvesterSources.id))
    .leftJoin(harvesterEntries, and(eq(harvesterEntries.sourceId, harvesterEvents.sourceId),
      eq(harvesterEntries.ordinal, harvesterEvents.ordinal)))
    .where(eq(harvesterSources.id, source.id))
    .orderBy(asc(harvesterEvents.ordinal), asc(harvesterEntries.bucket));
  const events: Array<{ event: Event; entries: Array<typeof harvesterEntries.$inferSelect> }> = [];
  for (const row of rows) {
    if (!row.event) continue;
    let proof = events.at(-1);
    if (!proof || proof.event.ordinal !== row.event.ordinal) {
      proof = { event: row.event, entries: [] }; events.push(proof);
    }
    if (row.entry) proof.entries.push(row.entry);
  }
  const stop = rows[0]?.stop ?? null;
  if (stop) {
    // Frozen encoding of the accepted observation audit identity. Never join
    // today's mutable observation/owner when reading original receipts.
    const validTimes = Number.isFinite(stop.checkedAt.getTime()) && Number.isFinite(stop.cutoffAt.getTime());
    const hash = validTimes ? createHash('sha256').update(`${stop.assetId}\0${stop.observedOwner}\0${stop.observationStatus}\0${stop.observedSlot}\0${stop.checkedAt.toISOString()}`).digest('hex') : null;
    if (!validTimes || stop.sourceId !== source.id || stop.cutoffAt < source.admittedAt || stop.checkedAt > stop.cutoffAt
      || !stop.custodyWallet || !stop.assetId || !stop.observedOwner || stop.observedOwner === stop.custodyWallet
      || stop.observationId < 1n || !['mismatch', 'owned'].includes(stop.observationStatus) || !stop.observationSource
      || stop.observedSlot < 0n || stop.observedSlot > BigInt(Number.MAX_SAFE_INTEGER) || stop.auditHash !== hash)
      throw new Error('Invalid original Harvester custody stop proof');
  }
  for (const [position, proof] of events.entries()) {
    const e = proof.event, earned = source.admittedAt.getTime() + e.ordinal * V1.cadenceSec * SECOND_MS;
    const numerator = e.gross * BigInt(e.islandPoolBps) + e.carryBefore;
    if (e.ordinal !== position + 1 || e.ordinal > Math.floor(V1.maxLeaseSec / V1.cadenceSec)
      || e.actorWallet !== source.actorWallet || e.resourceId !== source.resourceId || e.policyVersion !== source.policyVersion
      || e.walletSequence < 1n || e.earnedAt.getTime() !== earned || earned > source.leaseExpiresAt.getTime()
      || earned >= source.intervalSnapshot.term.endsAtMs || (stop !== null && earned > stop.cutoffAt.getTime()) || e.utcDay.getTime() !== dayAt(earned).getTime()
      || e.taxPolicyVersion !== V1.taxPolicyVersion || e.taxBasisPoints !== V1.taxBasisPoints || e.islandPoolBps !== V1.islandPoolBps
      || ![0n, BigInt(V1.grossPerCadence)].includes(e.gross) || e.carryBefore < 0n || e.carryBefore >= BigInt(e.taxBasisPoints)
      || e.tax !== numerator / BigInt(e.taxBasisPoints) || e.net !== e.gross - e.tax || e.carryAfter !== numerator % BigInt(e.taxBasisPoints)
      || !Number.isFinite(e.settledAt.getTime()) || e.settledAt.getTime() < earned || !e.custodyWallet
      || proof.entries.length !== 3 || expectedEntries(e).some(expected => !proof.entries.some(entry =>
        entry.bucket === expected.bucket && entry.delta === expected.delta))) throw new Error('Invalid original Harvester event proof');
  }
  const closure = rows[0]?.closure ?? null;
  if (closure) {
    closeReason.parse(closure.reason);
    let expected = 0;
    for (let ordinal = 1; ordinal <= Math.floor(V1.maxLeaseSec / V1.cadenceSec); ordinal++) {
      const earned = source.admittedAt.getTime() + ordinal * V1.cadenceSec * SECOND_MS;
      if (earned > closure.cutoffAt.getTime() || earned > source.leaseExpiresAt.getTime() || earned >= source.intervalSnapshot.term.endsAtMs) break;
      expected = ordinal;
    }
    if (!Number.isFinite(closure.cutoffAt.getTime()) || closure.cutoffAt < source.admittedAt || !closure.custodyWallet
      || closure.processedOrdinal !== expected || events.length !== expected
      || (closure.reason === 'lease_expired' && closure.cutoffAt < source.leaseExpiresAt)
      || (stop !== null && (closure.cutoffAt.getTime() !== stop.cutoffAt.getTime() || closure.reason !== 'custody_change')))
      throw new Error('Invalid original Harvester closure proof');
  }
  return { source, events, closure, stop };
}

/** Persist the first positive finalized ownership loss before attempting due
 * delivery. No RPC/caller-supplied evidence, output, closure or lease grant.
 * Caller may catch only capacity from a later settlement savepoint; this row
 * and the original pending head then survive together in its transaction. */
export async function recordHarvesterCustodyStop(tx: DbTx, originalBaseId: string, cutoff: Date) {
  const baseId = uuid.parse(originalBaseId), at = new Date(z.date().parse(cutoff).getTime());
  const [base] = await tx.select().from(bases).where(eq(bases.id, baseId)).for('update');
  if (!base) throw new Error('Original Harvester base is missing');
  const heads = await tx.select().from(harvesterSourceHeads).where(eq(harvesterSourceHeads.baseId, baseId));
  const result: Array<typeof harvesterCustodyStops.$inferSelect> = [];
  for (const head of heads) {
    const history = await readHarvesterSettlement(tx, head.sourceId);
    if (!history || history.closure) throw new Error('Original Harvester pending history is missing');
    if (history.stop) { result.push(history.stop); continue; }
    const [observation] = await tx.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, baseId))
      .orderBy(desc(deedOwnershipObservations.checkedAt), desc(deedOwnershipObservations.id)).limit(1);
    if (!observation?.owner || observation.slot === null || observation.owner === base.ownerWallet
      || ![base.deedAssetId, base.deedMintAssetId].includes(observation.assetId)
      || !['mismatch', 'owned'].includes(observation.status) || observation.slot < 0n || observation.slot > BigInt(Number.MAX_SAFE_INTEGER)
      || observation.checkedAt > at || at < history.source.admittedAt)
      throw new Error('Harvester custody stop lacks accepted finalized ownership evidence');
    await tx.insert(harvesterCustodyStops).values({ sourceId: head.sourceId, cutoffAt: at, custodyWallet: base.ownerWallet,
      observationId: observation.id, assetId: observation.assetId, observedOwner: observation.owner, observedSlot: observation.slot,
      checkedAt: observation.checkedAt, observationStatus: observation.status, observationSource: observation.source, auditHash: observation.auditHash });
    // Validate copied proof inside the same transaction before returning it.
    result.push((await readHarvesterSettlement(tx, head.sourceId))!.stop!);
  }
  return result;
}

/** Drain only already-authorized candidates for an original base. Savepoint
 * makes overflow/integrity failure atomic even if the outer caller catches it.
 * The unchanged source/head retains every owed unit; no renewal can bypass it.
 * Historical receipts are never replanned against today's day usage or carry.
 */
export async function settleDueHarvesterSources(tx: DbTx, originalBaseId: string, cutoff: Date) {
  const baseId = uuid.parse(originalBaseId), at = new Date(z.date().parse(cutoff).getTime());
  return tx.transaction(async locked => {
    const [base] = await locked.select().from(bases).where(eq(bases.id, baseId)).for('update');
    if (!base) throw new Error('Original Harvester base is missing');
    // Exact unique live head keeps authorized reads bounded as history grows.
    // SQL requires every source to have a matching head XOR immutable closure.
    const sources = await locked.select({ id: harvesterSourceHeads.sourceId }).from(harvesterSourceHeads)
      .where(eq(harvesterSourceHeads.baseId, baseId));
    const result: Array<NonNullable<Awaited<ReturnType<typeof readHarvesterSettlement>>>> = [];
    for (const candidate of sources) {
      const original = await readHarvesterSettlement(locked, candidate.id);
      if (!original) throw new Error('Original Harvester obligation missing');
      if (original.closure) throw new Error('Closed Harvester source retains a pending head');
      const { source } = original;
      if (at < source.admittedAt) throw new Error('Harvester cutoff precedes original admission');
      await locked.insert(harvesterWalletLocks).values({ wallet: source.actorWallet }).onConflictDoNothing();
      await locked.select().from(harvesterWalletLocks).where(eq(harvesterWalletLocks.wallet, source.actorWallet)).for('update');
      const [head] = await locked.select().from(harvesterSourceHeads).where(eq(harvesterSourceHeads.sourceId, source.id));
      if (!head || head.wallet !== source.actorWallet || head.baseId !== baseId) throw new Error('Original Harvester pending head missing');
      // Re-read after wallet serialization, before deciding the next ordinal.
      const history = await readHarvesterSettlement(locked, source.id);
      if (!history) throw new Error('Original Harvester history missing');
      for (let ordinal = history.events.length + 1; ordinal <= Math.floor(V1.maxLeaseSec / V1.cadenceSec); ordinal++) {
        const earnedAt = new Date(source.admittedAt.getTime() + ordinal * V1.cadenceSec * SECOND_MS);
        if (earnedAt > at || (history.stop !== null && earnedAt > history.stop.cutoffAt)
          || earnedAt > source.leaseExpiresAt || earnedAt.getTime() >= source.intervalSnapshot.term.endsAtMs) break;
        const utcDay = dayAt(earnedAt.getTime());
        const [usage] = await locked.select({ gross: sql<string>`coalesce(sum(${harvesterEvents.gross}), 0)::text` }).from(harvesterEvents)
          .where(and(eq(harvesterEvents.actorWallet, source.actorWallet), eq(harvesterEvents.policyVersion, source.policyVersion), eq(harvesterEvents.utcDay, utcDay)));
        const used = BigInt(usage!.gross);
        if (used < 0n || used > BigInt(V1.grossPerWalletUtcDay)) throw new Error('Invalid original Harvester daily usage');
        const gross = used + BigInt(V1.grossPerCadence) <= BigInt(V1.grossPerWalletUtcDay) ? BigInt(V1.grossPerCadence) : 0n;
        const [prior] = await locked.select().from(harvesterEvents).where(and(eq(harvesterEvents.actorWallet, source.actorWallet),
          eq(harvesterEvents.resourceId, source.resourceId), eq(harvesterEvents.taxPolicyVersion, V1.taxPolicyVersion)))
          .orderBy(desc(harvesterEvents.walletSequence)).limit(1);
        const [latest] = await locked.select({ sequence: harvesterEvents.walletSequence }).from(harvesterEvents)
          .where(eq(harvesterEvents.actorWallet, source.actorWallet)).orderBy(desc(harvesterEvents.walletSequence)).limit(1);
        const carryBefore = prior?.carryAfter ?? 0n;
        const numerator = gross * BigInt(V1.islandPoolBps) + carryBefore;
        const tax = numerator / BigInt(V1.taxBasisPoints), net = gross - tax;
        await locked.insert(resourceStocks).values({ baseId, resourceId: source.resourceId }).onConflictDoNothing();
        const [stock] = await locked.select().from(resourceStocks).where(and(eq(resourceStocks.baseId, baseId), eq(resourceStocks.resourceId, source.resourceId))).for('update');
        if (!stock) throw new Error('Original Harvester stock missing');
        RawResourceStockSchema.parse({ resourceId: stock.resourceId, available: stock.available.toString(), reserved: stock.reserved.toString(), total: (stock.available + stock.reserved).toString() });
        if (stock.available + stock.reserved + net > RAW_RESOURCE_STORAGE_MAX) throw new HarvesterStorageCapacityError();
        const [event] = await locked.insert(harvesterEvents).values({ sourceId: source.id, ordinal, actorWallet: source.actorWallet,
          walletSequence: (latest?.sequence ?? 0n) + 1n, policyVersion: source.policyVersion, resourceId: source.resourceId,
          earnedAt, utcDay, taxPolicyVersion: V1.taxPolicyVersion, taxBasisPoints: V1.taxBasisPoints, islandPoolBps: V1.islandPoolBps,
          gross, net, tax, carryBefore, carryAfter: numerator % BigInt(V1.taxBasisPoints), custodyWallet: base.ownerWallet, settledAt: at }).returning();
        if (!event) throw new Error('Original Harvester event was not persisted');
        await locked.insert(harvesterEntries).values(expectedEntries(event).map(entry => ({ sourceId: source.id, ordinal, ...entry })));
        await locked.update(resourceStocks).set({ available: stock.available + net })
          .where(and(eq(resourceStocks.baseId, baseId), eq(resourceStocks.resourceId, source.resourceId)));
      }
      result.push((await readHarvesterSettlement(locked, source.id))!);
    }
    return result;
  });
}

/** Canonical custody/realm/facility and explicit-selection boundary. The caller
 * samples cutoff after all its sorted base locks. No authority/provider/player
 * lock is needed to preserve and close an already accepted original source.
 * A failed due settlement leaves the head and every original obligation intact.
 */
export async function closeHarvesterSources(tx: DbTx, originalBaseId: string, cutoff: Date, reason: HarvesterCloseReason) {
  const baseId = uuid.parse(originalBaseId), at = new Date(z.date().parse(cutoff).getTime());
  const checkedReason = closeReason.parse(reason);
  return tx.transaction(async locked => {
    const [base] = await locked.select().from(bases).where(eq(bases.id, baseId)).for('update');
    if (!base) throw new Error('Original Harvester base is missing');
    const due = await settleDueHarvesterSources(locked, baseId, at);
    const result: Array<NonNullable<Awaited<ReturnType<typeof readHarvesterSettlement>>>> = [];
    for (const proof of due) {
      await locked.insert(harvesterSourceClosures).values({ sourceId: proof.source.id, cutoffAt: proof.stop?.cutoffAt ?? at,
        reason: proof.stop ? 'custody_change' : checkedReason, custodyWallet: base.ownerWallet, processedOrdinal: proof.events.length });
      const removed = await locked.delete(harvesterSourceHeads).where(and(eq(harvesterSourceHeads.sourceId, proof.source.id),
        eq(harvesterSourceHeads.wallet, proof.source.actorWallet), eq(harvesterSourceHeads.baseId, baseId))).returning();
      if (removed.length !== 1) throw new Error('Original Harvester head was not released');
      result.push((await readHarvesterSettlement(locked, proof.source.id))!);
    }
    return result;
  });
}
