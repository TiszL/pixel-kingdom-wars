/** Private E2 PvP stock accounting. Only the authoritative raid lifecycle calls
 * these transaction-only helpers. Raw awards conserve existing stock; neither
 * current custody nor a later return can enlarge the original entitlement.
 * Lock order: raid → sorted bases → stock. Never acquire a player lock here. */
import { FORGE_INGOT } from '@shardkeep/shared';
import { PHASE_E_RAW_RESOURCE_IDS, PhaseERawResourceIdSchema, RawResourceStockSchema } from '@shardkeep/shared/phaseEResources';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx, DbTx } from '../db/client';
import { baseRaidLocks, bases, raids, rawRaidAllocations, rawRaidEntries, rawRaidReservationDebits,
  rawRaidResources, rawRaidSnapshots, rawRaidTerminals, resourceStockOperations, resourceStocks } from '../db/schema';
import { readRawStockReservationRemainder, readResourceStockProof } from './resourceStock';

type Snapshot = typeof rawRaidSnapshots.$inferSelect;
type Resource = typeof rawRaidResources.$inferSelect;
type Allocation = typeof rawRaidAllocations.$inferSelect;
type Terminal = typeof rawRaidTerminals.$inferSelect;
type Entry = typeof rawRaidEntries.$inferSelect;
type Debit = typeof rawRaidReservationDebits.$inferSelect;
export interface RawRaidProof { snapshot: Snapshot; resources: Resource[]; allocations: Allocation[];
  terminal: Terminal | null; entries: Entry[]; debits: Debit[] }
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const invalid = () => new Error('invalid immutable raw raid proof');
const sum = (rows: { quantity: bigint }[]) => rows.reduce((n, row) => n + row.quantity, 0n);
function stock(resourceId: string, available: bigint, reserved: bigint) {
  RawResourceStockSchema.parse({ resourceId, available: available.toString(), reserved: reserved.toString(), total: (available + reserved).toString() });
}
function time(at: Date) {
  const result = new Date(at.getTime());
  if (!Number.isFinite(result.getTime())) throw new TypeError('raw raid time must be finite');
  return result;
}
function originalKeep(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== 'object' || !('buildings' in snapshot)) return null;
  const buildings = (snapshot as { buildings: unknown }).buildings;
  if (!Array.isArray(buildings)) throw invalid();
  const keeps = buildings.filter((b): b is { type: string; id: string } => !!b && typeof b === 'object' && b.type === 'keep');
  if (keeps.length > 1) throw invalid();
  return keeps[0] ? uuid.parse(keeps[0].id) : null;
}

/** Internal immutable history, not authorization or a current inventory view. */
export async function readRawRaidProof(db: DbOrTx, raidId: string): Promise<RawRaidProof | null> {
  raidId = uuid.parse(raidId);
  const [snapshot] = await db.select().from(rawRaidSnapshots).where(eq(rawRaidSnapshots.raidId, raidId));
  if (!snapshot) return null;
  const resources = await db.select().from(rawRaidResources).where(eq(rawRaidResources.raidId, raidId)).orderBy(asc(rawRaidResources.resourceId));
  const allocations = await db.select().from(rawRaidAllocations).where(eq(rawRaidAllocations.raidId, raidId)).orderBy(asc(rawRaidAllocations.resourceId), asc(rawRaidAllocations.reservationId));
  const [terminal] = await db.select().from(rawRaidTerminals).where(eq(rawRaidTerminals.raidId, raidId));
  const entries = await db.select().from(rawRaidEntries).where(eq(rawRaidEntries.raidId, raidId)).orderBy(asc(rawRaidEntries.resourceId), asc(rawRaidEntries.bucket));
  const debits = await db.select().from(rawRaidReservationDebits).where(eq(rawRaidReservationDebits.raidId, raidId)).orderBy(asc(rawRaidReservationDebits.resourceId), asc(rawRaidReservationDebits.reservationId));
  if (snapshot.attackerBaseId === snapshot.defenderBaseId || !Number.isSafeInteger(snapshot.frozenDivisor)
    || snapshot.frozenDivisor <= 0 || !Number.isSafeInteger(snapshot.theftVersion) || snapshot.theftVersion <= 0
    || !Number.isFinite(snapshot.frozenAt.getTime()) || resources.length !== PHASE_E_RAW_RESOURCE_IDS.length
    || new Set(resources.map(r => r.resourceId)).size !== resources.length) throw invalid();
  if (terminal && (!['transferred', 'released'].includes(terminal.outcome) || !Number.isFinite(terminal.settledAt.getTime())
    || terminal.settledAt < snapshot.frozenAt || !terminal.reason || terminal.reason.length > 128
    || (terminal.outcome === 'transferred' && !snapshot.keepId))) throw invalid();
  for (const r of resources) {
    stock(r.resourceId, r.available, r.reserved);
    if (r.maximum !== (r.available + r.reserved) / BigInt(snapshot.frozenDivisor)
      || r.fromAvailable !== (r.available < r.maximum ? r.available : r.maximum)
      || sum(allocations.filter(a => a.resourceId === r.resourceId)) !== r.maximum - r.fromAvailable) throw invalid();
  }
  for (const a of allocations) {
    const original = await readResourceStockProof(db, a.reservationId);
    if (!original || original.operation.kind !== 'reserve' || original.operation.baseId !== snapshot.defenderBaseId
      || original.operation.resourceId !== a.resourceId || a.quantity <= 0n || a.quantity > original.operation.quantity
      || !resources.some(r => r.resourceId === a.resourceId)) throw invalid();
  }
  if (terminal?.outcome === 'transferred') {
    if (entries.length !== resources.length * 3 || debits.length !== allocations.length) throw invalid();
    for (const d of debits) {
      const a = allocations.find(row => row.resourceId === d.resourceId && row.reservationId === d.reservationId);
      if (!a || d.quantity !== a.quantity || !['reserved', 'available'].includes(d.bucket)) throw invalid();
      if (d.bucket === 'reserved') { if (d.releaseOperationId !== null) throw invalid(); }
      else {
        const release = d.releaseOperationId ? await readResourceStockProof(db, d.releaseOperationId) : null;
        if (!release || release.operation.kind !== 'release' || release.operation.reservationId !== a.reservationId
          || (release.operation.effectiveQuantity ?? release.operation.quantity) < d.quantity) throw invalid();
      }
    }
    for (const r of resources) {
      const rs = sum(debits.filter(d => d.resourceId === r.resourceId && d.bucket === 'reserved'));
      const av = r.fromAvailable + sum(debits.filter(d => d.resourceId === r.resourceId && d.bucket === 'available'));
      if (av + rs !== r.maximum || !entries.some(e => e.resourceId === r.resourceId && e.bucket === 'defender_available' && e.delta === -av)
        || !entries.some(e => e.resourceId === r.resourceId && e.bucket === 'defender_reserved' && e.delta === -rs)
        || !entries.some(e => e.resourceId === r.resourceId && e.bucket === 'attacker_available' && e.delta === r.maximum)) throw invalid();
    }
  } else if (entries.length || debits.length) throw invalid();
  return { snapshot, resources, allocations, terminal: terminal ?? null, entries, debits };
}

async function lockBases(tx: DbTx, attackerBaseId: string, defenderBaseId: string) {
  if (attackerBaseId === defenderBaseId) throw invalid();
  const rows = await tx.select({ id: bases.id }).from(bases)
    .where(inArray(bases.id, [attackerBaseId, defenderBaseId].sort())).orderBy(asc(bases.id)).for('update');
  if (rows.length !== 2) throw invalid();
}
async function lockRaid(tx: DbTx, raidId: string) {
  const [raid] = await tx.select().from(raids).where(eq(raids.id, raidId)).for('update');
  if (!raid) throw new Error('raw raid missing');
  return raid;
}
async function lockOriginal(tx: DbTx, raidId: string, needsStock: boolean) {
  // A legacy raid has no entitlement. Before taking its lock, check only
  // immutable snapshot existence: a multi-query proof read could otherwise
  // straddle another settlement and mix an old terminal with new entries.
  const [snapshot] = await tx.select({ raidId: rawRaidSnapshots.raidId }).from(rawRaidSnapshots)
    .where(eq(rawRaidSnapshots.raidId, raidId));
  if (!snapshot) return null;
  const raid = await lockRaid(tx, raidId);
  const proof = (await readRawRaidProof(tx, raidId))!;
  if (raid.attackerBaseId !== proof.snapshot.attackerBaseId || raid.defenderBaseId !== proof.snapshot.defenderBaseId) throw invalid();
  if (!proof.terminal && needsStock) await lockBases(tx, proof.snapshot.attackerBaseId, proof.snapshot.defenderBaseId);
  return proof;
}

/** Called only after due returns, the frozen raid row and its incoming lock exist. */
export async function freezeRawRaidLoot(tx: DbTx, raidId: string, at?: Date): Promise<RawRaidProof | null> {
  raidId = uuid.parse(raidId);
  const requestedTime = at ? time(at) : undefined;
  return tx.transaction(async inner => {
    const raid = await lockRaid(inner, raidId);
    const prior = await readRawRaidProof(inner, raidId);
    if (prior) return prior;
    if (raid.pveCampId || raid.campaignStage !== null || !raid.attackerBaseId || !raid.defenderBaseId) return null;
    if (raid.status !== 'pending_orders') throw new Error('raw raid cannot freeze after admission');
    await lockBases(inner, raid.attackerBaseId, raid.defenderBaseId);
    const [incoming] = await inner.select().from(baseRaidLocks).where(eq(baseRaidLocks.baseId, raid.defenderBaseId)).for('update');
    if (incoming?.raidId !== raid.id) throw new Error('raw raid lacks original incoming lock');
    const current = await inner.select().from(resourceStocks).where(eq(resourceStocks.baseId, raid.defenderBaseId)).orderBy(asc(resourceStocks.resourceId)).for('update');
    const claims = await inner.select({ id: resourceStockOperations.id }).from(resourceStockOperations)
      .where(and(eq(resourceStockOperations.baseId, raid.defenderBaseId), eq(resourceStockOperations.kind, 'reserve'),
        sql`not exists (select 1 from resource_stock_operations terminal where terminal.reservation_id = ${resourceStockOperations.id})`))
      .orderBy(asc(resourceStockOperations.createdAt), asc(resourceStockOperations.id));
    const open = [];
    for (const claim of claims) {
      const remainder = await readRawStockReservationRemainder(inner, claim.id);
      if (!remainder) throw invalid();
      if (!remainder.terminal) open.push(remainder);
    }
    const frozen: Resource[] = []; const allocations: Allocation[] = [];
    for (const resourceId of PHASE_E_RAW_RESOURCE_IDS) {
      const row = current.find(r => r.resourceId === resourceId);
      const available = row?.available ?? 0n; const reserved = row?.reserved ?? 0n;
      stock(resourceId, available, reserved);
      const original = open.filter(r => r.original.operation.resourceId === resourceId);
      if (original.reduce((n, r) => n + r.remaining, 0n) !== reserved) throw new Error('raw raid reserved backing mismatch');
      const maximum = (available + reserved) / BigInt(FORGE_INGOT.rawStockTheftDivisor);
      const fromAvailable = available < maximum ? available : maximum;
      frozen.push({ raidId, resourceId, available, reserved, maximum, fromAvailable });
      let needed = maximum - fromAvailable;
      for (const claim of original) {
        const quantity = needed < claim.remaining ? needed : claim.remaining;
        if (quantity > 0n) allocations.push({ raidId, resourceId, reservationId: claim.original.operation.id, quantity });
        needed -= quantity;
        if (needed === 0n) break;
      }
      if (needed !== 0n) throw invalid();
    }
    await inner.insert(rawRaidSnapshots).values({ raidId, attackerBaseId: raid.attackerBaseId, defenderBaseId: raid.defenderBaseId,
      keepId: originalKeep(raid.snapshot), frozenDivisor: FORGE_INGOT.rawStockTheftDivisor,
      theftVersion: FORGE_INGOT.rawStockTheftVersion, frozenAt: requestedTime ?? time(raid.createdAt) });
    await inner.insert(rawRaidResources).values(frozen);
    if (allocations.length) await inner.insert(rawRaidAllocations).values(allocations);
    return readRawRaidProof(inner, raidId);
  });
}

async function release(inner: DbTx, proof: RawRaidProof, now: Date, reason: string) {
  if (now < proof.snapshot.frozenAt) throw invalid();
  if (!reason || reason.length > 128) throw new TypeError('invalid raw raid release reason');
  await inner.insert(rawRaidTerminals).values({ raidId: proof.snapshot.raidId, outcome: 'released', reason, settledAt: now });
  return readRawRaidProof(inner, proof.snapshot.raidId);
}

/** Release changes only immutable raid evidence. The raid row serializes it with
 * settlement; no stock/base lock is needed. Expiry and retreat may already hold
 * ledger accounts, so taking a new base lock here would invert their order. */
export async function releaseRawRaidLoot(tx: DbTx, raidId: string, at: Date, reason = 'released'): Promise<RawRaidProof | null> {
  raidId = uuid.parse(raidId);
  return tx.transaction(async inner => {
    const proof = await lockOriginal(inner, raidId, false);
    if (!proof || proof.terminal) return proof;
    return release(inner, proof, time(at), reason);
  });
}

/** Building results must come from the authoritative simulator, never a client.
 * No stars, Vault protection, tax, issuance, current flag or current owner input. */
export async function settleRawRaidLoot(tx: DbTx, raidId: string,
  buildings: ReadonlyArray<{ id: string; destroyed: boolean }>, at: Date): Promise<RawRaidProof | null> {
  raidId = uuid.parse(raidId);
  return tx.transaction(async inner => {
    const proof = await lockOriginal(inner, raidId, true);
    if (!proof || proof.terminal) return proof;
    const now = time(at); const h = proof.snapshot;
    if (now < h.frozenAt) throw invalid();
    const keep = buildings.filter(b => b.id === h.keepId);
    if (keep.length > 1) throw invalid();
    if (!h.keepId || keep.length !== 1 || keep[0]!.destroyed !== true) return release(inner, proof, now, 'original_keep_not_destroyed');
    const [incoming] = await inner.select().from(baseRaidLocks).where(eq(baseRaidLocks.baseId, h.defenderBaseId)).for('update');
    if (incoming?.raidId !== raidId) throw new Error('raw raid lost original incoming lock');
    const debits: Debit[] = [];
    for (const a of proof.allocations) {
      const claim = await readRawStockReservationRemainder(inner, a.reservationId);
      if (!claim || claim.remaining < a.quantity || claim.terminal?.operation.kind === 'consume') throw invalid();
      const released = claim.terminal?.operation;
      debits.push({ ...a, bucket: released ? 'available' : 'reserved', releaseOperationId: released?.id ?? null });
    }
    const rows = await inner.select().from(resourceStocks)
      .where(inArray(resourceStocks.baseId, [h.attackerBaseId, h.defenderBaseId].sort()))
      .orderBy(asc(resourceStocks.baseId), asc(resourceStocks.resourceId)).for('update');
    const entries: Entry[] = []; const updates: (typeof resourceStocks.$inferInsert)[] = [];
    for (const r of proof.resources) {
      PhaseERawResourceIdSchema.parse(r.resourceId);
      const av = r.fromAvailable + sum(debits.filter(d => d.resourceId === r.resourceId && d.bucket === 'available'));
      const rs = sum(debits.filter(d => d.resourceId === r.resourceId && d.bucket === 'reserved'));
      const defender = rows.find(s => s.baseId === h.defenderBaseId && s.resourceId === r.resourceId);
      const attacker = rows.find(s => s.baseId === h.attackerBaseId && s.resourceId === r.resourceId);
      const available = (defender?.available ?? 0n) - av; const reserved = (defender?.reserved ?? 0n) - rs;
      const received = (attacker?.available ?? 0n) + r.maximum;
      stock(r.resourceId, available, reserved); stock(r.resourceId, received, attacker?.reserved ?? 0n);
      if (r.maximum > 0n) updates.push(
        { baseId: h.defenderBaseId, resourceId: r.resourceId, available, reserved },
        { baseId: h.attackerBaseId, resourceId: r.resourceId, available: received, reserved: attacker?.reserved ?? 0n },
      );
      entries.push({ raidId, resourceId: r.resourceId, bucket: 'defender_available', delta: -av },
        { raidId, resourceId: r.resourceId, bucket: 'defender_reserved', delta: -rs },
        { raidId, resourceId: r.resourceId, bucket: 'attacker_available', delta: r.maximum });
    }
    // Everything above is validated before the first terminal write. The nested
    // transaction also prevents a caller from catching a partial stock award.
    await inner.insert(rawRaidTerminals).values({ raidId, outcome: 'transferred', reason: 'original_keep_destroyed', settledAt: now });
    if (debits.length) await inner.insert(rawRaidReservationDebits).values(debits);
    await inner.insert(rawRaidEntries).values(entries);
    for (const row of updates) await inner.insert(resourceStocks).values(row).onConflictDoUpdate({
      target: [resourceStocks.baseId, resourceStocks.resourceId], set: { available: row.available, reserved: row.reserved },
    });
    return readRawRaidProof(inner, raidId);
  });
}
