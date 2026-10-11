/** DARK E2 stock primitives. Internal callers only; no issuance, public route or
 * permission inferred from an operation UUID. A future job writer must authorize
 * its own terminal transition in the SAME transaction as release/consumption.
 * Player → base → slot → stock lock order matches stable-base transfers. Trusted
 * terminal operations take only the base lock and never subsequently a player.
 * Stock is an application-maintained projection: SQL independently checks its
 * bounds and immutable proof shape, not correspondence of arbitrary direct SQL
 * stock writes to entries. All runtime writers must use the atomic service.
 */
import {
  PHASE_E_RAW_RESOURCE_IDS, PhaseERawResourceIdSchema, PositiveRawResourceQuantitySchema,
  RawResourceQuantitySchema, RawResourceStockSchema, type PhaseERawResourceId,
} from '@shardkeep/shared/phaseEResources';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx, DbTx } from '../db/client';
import { baseRaidLocks, bases, players, rawRaidAllocations, rawRaidEntries, rawRaidReservationDebits, rawRaidResources, rawRaidSnapshots, rawRaidTerminals, resourceStockEntries, resourceStockOperations, resourceStocks } from '../db/schema';
import { HttpError } from '../lib/errors';
import { lockStablePrerequisiteBase, type StableBaseMutationContext } from './stableBasePrerequisites';

type Operation = typeof resourceStockOperations.$inferSelect;
type Entry = typeof resourceStockEntries.$inferSelect;
export interface ResourceStockProof { operation: Operation; entries: Entry[] }
export interface ReserveRawStockInput {
  operationId: string;
  baseId: string;
  resourceId: PhaseERawResourceId;
  quantity: bigint;
}
// PostgreSQL canonicalizes UUID columns. Use that same identity for comparisons
// as well as queries, so accepted mixed-case input can replay exactly once.
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const mismatch = () => new HttpError(409, 'raw stock operation key belongs to a different request', 'RESOURCE_STOCK_KEY_MISMATCH');
const invalidProof = () => new Error('invalid immutable raw stock proof');

function expectedEntries(kind: Operation['kind'], quantity: bigint) {
  return [
    { bucket: kind === 'reserve' ? 'available' as const : 'reserved' as const, delta: -quantity },
    { bucket: kind === 'reserve' ? 'reserved' as const : kind === 'release' ? 'available' as const : 'consumed' as const, delta: quantity },
  ];
}

/** Historical original proof only. This internal read does not grant access to
 * a caller or authorize use of a transferred base. No current-stock inference. */
export async function readResourceStockProof(db: DbOrTx, operationId: string): Promise<ResourceStockProof | null> {
  operationId = uuid.parse(operationId);
  const [operation] = await db.select().from(resourceStockOperations).where(eq(resourceStockOperations.id, operationId));
  if (!operation) return null;
  PhaseERawResourceIdSchema.parse(operation.resourceId);
  PositiveRawResourceQuantitySchema.parse(operation.quantity.toString());
  if (!['reserve', 'release', 'consume'].includes(operation.kind)
    || (operation.kind === 'reserve') !== (operation.reservationId === null)) throw invalidProof();
  const entries = await db.select().from(resourceStockEntries)
    .where(eq(resourceStockEntries.operationId, operationId)).orderBy(asc(resourceStockEntries.bucket));
  if (operation.effectiveQuantity !== null && (operation.kind !== 'release'
    || operation.effectiveQuantity < 0n || operation.effectiveQuantity > operation.quantity)) throw invalidProof();
  const amount = operation.effectiveQuantity ?? operation.quantity;
  const expected = expectedEntries(operation.kind, amount);
  if (entries.length !== 2 || expected.some(e => !entries.some(actual => actual.bucket === e.bucket && actual.delta === e.delta))) throw invalidProof();
  if (operation.reservationId) {
    // No recursive trust in arbitrary linked commands, even if a DB constraint
    // was bypassed by an operator: the parent must be a real reserve proof.
    const [parent] = await db.select().from(resourceStockOperations).where(eq(resourceStockOperations.id, operation.reservationId));
    if (!parent || parent.kind !== 'reserve' || parent.reservationId !== null
      || parent.baseId !== operation.baseId || parent.resourceId !== operation.resourceId
      || parent.quantity !== operation.quantity) throw invalidProof();
    await readResourceStockProof(db, parent.id);
    const lost = await reservedLoss(db, parent);
    if (amount !== parent.quantity - lost || (operation.kind === 'consume' && lost !== 0n)) throw invalidProof();
  }
  return { operation, entries };
}

/** Losses are not caller-granted adjustments: each must belong to the exact
 * immutable transferred allocation. No recursion through release proofs. */
async function reservedLoss(db: DbOrTx, original: Operation): Promise<bigint> {
  const rows = await db.select({ debit: rawRaidReservationDebits, allocation: rawRaidAllocations,
    header: rawRaidSnapshots, resource: rawRaidResources, terminal: rawRaidTerminals })
    .from(rawRaidReservationDebits)
    .leftJoin(rawRaidAllocations, and(eq(rawRaidAllocations.raidId, rawRaidReservationDebits.raidId),
      eq(rawRaidAllocations.resourceId, rawRaidReservationDebits.resourceId), eq(rawRaidAllocations.reservationId, rawRaidReservationDebits.reservationId)))
    .leftJoin(rawRaidSnapshots, eq(rawRaidSnapshots.raidId, rawRaidReservationDebits.raidId))
    .leftJoin(rawRaidResources, and(eq(rawRaidResources.raidId, rawRaidReservationDebits.raidId), eq(rawRaidResources.resourceId, rawRaidReservationDebits.resourceId)))
    .leftJoin(rawRaidTerminals, eq(rawRaidTerminals.raidId, rawRaidReservationDebits.raidId))
    .where(and(eq(rawRaidReservationDebits.reservationId, original.id), eq(rawRaidReservationDebits.bucket, 'reserved')));
  let lost = 0n;
  for (const { debit, allocation, header, resource, terminal } of rows) {
    if (!allocation || !header || !resource || !terminal || terminal.outcome !== 'transferred' || !header.keepId
      || header.defenderBaseId !== original.baseId || debit.resourceId !== original.resourceId
      || debit.quantity <= 0n || debit.quantity !== allocation.quantity || debit.releaseOperationId !== null
      || terminal.settledAt < header.frozenAt) throw invalidProof();
    const allDebits = await db.select().from(rawRaidReservationDebits)
      .where(and(eq(rawRaidReservationDebits.raidId, debit.raidId), eq(rawRaidReservationDebits.resourceId, debit.resourceId)));
    const reserved = allDebits.filter(d => d.bucket === 'reserved').reduce((sum, d) => sum + d.quantity, 0n);
    const available = allDebits.filter(d => d.bucket === 'available').reduce((sum, d) => sum + d.quantity, resource.fromAvailable);
    const entries = await db.select().from(rawRaidEntries)
      .where(and(eq(rawRaidEntries.raidId, debit.raidId), eq(rawRaidEntries.resourceId, debit.resourceId)));
    if (entries.length !== 3 || reserved + available !== resource.maximum
      || !entries.some(e => e.bucket === 'defender_reserved' && e.delta === -reserved)
      || !entries.some(e => e.bucket === 'defender_available' && e.delta === -available)
      || !entries.some(e => e.bucket === 'attacker_available' && e.delta === resource.maximum)) throw invalidProof();
    lost += debit.quantity;
  }
  if (lost > original.quantity) throw invalidProof();
  return lost;
}

/** Internal history only; not authority. Caller must hold the original base
 * lock before using remaining to freeze/settle. Available-source losses after
 * release do not change its earlier residual proof. No player/raid row locks. */
export async function readRawStockReservationRemainder(db: DbOrTx, reservationId: string) {
  reservationId = uuid.parse(reservationId);
  const original = await readResourceStockProof(db, reservationId);
  if (!original || original.operation.kind !== 'reserve') return null;
  const lost = await reservedLoss(db, original.operation);
  const [terminalRow] = await db.select({ id: resourceStockOperations.id }).from(resourceStockOperations)
    .where(eq(resourceStockOperations.reservationId, reservationId));
  const terminal = terminalRow ? await readResourceStockProof(db, terminalRow.id) : null;
  return { original, lost, remaining: original.operation.quantity - lost, terminal };
}

async function persist(tx: DbTx, operation: typeof resourceStockOperations.$inferInsert): Promise<ResourceStockProof | null> {
  const [row] = await tx.insert(resourceStockOperations).values(operation)
    .onConflictDoNothing({ target: resourceStockOperations.id }).returning();
  if (!row) return null;
  const entries = await tx.insert(resourceStockEntries)
    .values(expectedEntries(row.kind, row.effectiveQuantity ?? row.quantity).map(e => ({ operationId: row.id, ...e }))).returning();
  return { operation: row, entries: entries.sort((a, b) => a.bucket.localeCompare(b.bucket)) };
}

function matchReserve(proof: ResourceStockProof, wallet: string, input: ReserveRawStockInput) {
  const op = proof.operation;
  if (op.kind !== 'reserve' || op.custodyWallet !== wallet || op.baseId !== input.baseId
    || op.resourceId !== input.resourceId || op.quantity !== input.quantity) throw mismatch();
  return proof;
}

export async function reserveRawStock(
  db: DbOrTx, wallet: string, input: ReserveRawStockInput, authority: StableBaseMutationContext,
): Promise<ResourceStockProof> {
  input = { ...input, operationId: uuid.parse(input.operationId), baseId: uuid.parse(input.baseId) };
  authority = { ...authority, baseId: uuid.parse(authority.baseId) };
  PhaseERawResourceIdSchema.parse(input.resourceId);
  if (typeof input.quantity !== 'bigint') throw new TypeError('raw stock quantity must be bigint');
  PositiveRawResourceQuantitySchema.parse(input.quantity.toString());
  if (authority.baseId !== input.baseId) throw mismatch();
  return (db as Db).transaction(async tx => {
    const prior = await readResourceStockProof(tx, input.operationId);
    if (prior) return matchReserve(prior, wallet, input);
    const [player] = await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    // Recheck before mutable ownership: an accepted concurrent command remains
    // an original receipt even if a transfer won the lock in the meantime.
    const lockedPrior = await readResourceStockProof(tx, input.operationId);
    if (lockedPrior) return matchReserve(lockedPrior, wallet, input);
    const base = await lockStablePrerequisiteBase(tx, wallet, authority);
    const [stock] = await tx.select().from(resourceStocks)
      .where(and(eq(resourceStocks.baseId, input.baseId), eq(resourceStocks.resourceId, input.resourceId))).for('update');
    if (!stock || stock.available < input.quantity) throw new HttpError(422, 'insufficient available raw stock', 'INSUFFICIENT_RAW_STOCK');
    const proof = await persist(tx, { id: input.operationId, kind: 'reserve', baseId: base.id,
      resourceId: input.resourceId, quantity: input.quantity, custodyWallet: base.ownerWallet });
    if (!proof) return matchReserve((await readResourceStockProof(tx, input.operationId))!, wallet, input);
    await tx.update(resourceStocks).set({ available: stock.available - input.quantity, reserved: stock.reserved + input.quantity })
      .where(and(eq(resourceStocks.baseId, base.id), eq(resourceStocks.resourceId, input.resourceId)));
    return proof;
  });
}

function matchTerminal(proof: ResourceStockProof, kind: 'release' | 'consume', reservationId: string) {
  if (proof.operation.kind !== kind || proof.operation.reservationId !== reservationId) throw mismatch();
  return proof;
}

async function settleReservation(db: DbOrTx, operationId: string, reservationId: string, kind: 'release' | 'consume') {
  operationId = uuid.parse(operationId); reservationId = uuid.parse(reservationId);
  return (db as Db).transaction(async tx => {
    const prior = await readResourceStockProof(tx, operationId);
    if (prior) return matchTerminal(prior, kind, reservationId);
    const original = await readResourceStockProof(tx, reservationId);
    if (!original || original.operation.kind !== 'reserve') throw new HttpError(404, 'raw reservation not found', 'RESOURCE_RESERVATION_UNKNOWN');
    const reservation = original.operation;
    const [base] = await tx.select().from(bases).where(eq(bases.id, reservation.baseId)).for('update');
    if (!base) throw new Error('raw reservation base missing');
    const lockedPrior = await readResourceStockProof(tx, operationId);
    if (lockedPrior) return matchTerminal(lockedPrior, kind, reservationId);
    const [terminal] = await tx.select({ id: resourceStockOperations.id }).from(resourceStockOperations)
      .where(eq(resourceStockOperations.reservationId, reservationId));
    if (terminal) throw new HttpError(409, 'raw reservation already settled', 'RESOURCE_RESERVATION_SETTLED');
    const lost = await reservedLoss(tx, reservation);
    const remaining = reservation.quantity - lost;
    RawResourceQuantitySchema.parse(remaining.toString());
    if (kind === 'consume' && lost !== 0n) {
      throw new HttpError(409, 'raw reservation impaired by raid; cancel through the original job', 'RESOURCE_RESERVATION_IMPAIRED');
    }
    if (kind === 'consume') {
      const [raid] = await tx.select({ raidId: baseRaidLocks.raidId }).from(baseRaidLocks)
        .where(eq(baseRaidLocks.baseId, base.id)).for('update');
      if (raid) throw new HttpError(423, 'base is being raided', 'BASE_BEING_RAIDED');
    }
    const [stock] = await tx.select().from(resourceStocks)
      .where(and(eq(resourceStocks.baseId, base.id), eq(resourceStocks.resourceId, reservation.resourceId))).for('update');
    if (!stock || stock.reserved < remaining) throw new Error('raw reservation exceeds stored reserved stock');
    const proof = await persist(tx, { id: operationId, kind, baseId: base.id, resourceId: reservation.resourceId,
      quantity: reservation.quantity, effectiveQuantity: kind === 'release' ? remaining : null, custodyWallet: base.ownerWallet, reservationId });
    if (!proof) return matchTerminal((await readResourceStockProof(tx, operationId))!, kind, reservationId);
    await tx.update(resourceStocks).set({ reserved: stock.reserved - remaining,
      available: stock.available + (kind === 'release' ? remaining : 0n) })
      .where(and(eq(resourceStocks.baseId, base.id), eq(resourceStocks.resourceId, reservation.resourceId)));
    return proof;
  });
}

/** Trusted job cancellation only, inside its transaction. Follows original base
 * custody, including inactive/sold bases; does not create or retax resources. */
export const releaseRawStockReservation = (db: DbOrTx, operationId: string, reservationId: string) =>
  settleReservation(db, operationId, reservationId, 'release');

/** Trusted job completion only, inside its transaction. Not an authorization
 * for a future client, market, raid or tax writer to consume arbitrary stock. */
export const consumeRawStockReservation = (db: DbOrTx, operationId: string, reservationId: string) =>
  settleReservation(db, operationId, reservationId, 'consume');

/** Internal raw exposure projection only. Future raid integration must lock the
 * base and settle due sources before reading in its own atomic snapshot. */
export async function readRaidExposedRawStock(db: DbOrTx, baseId: string) {
  baseId = uuid.parse(baseId);
  const rows = await db.select().from(resourceStocks).where(eq(resourceStocks.baseId, baseId));
  for (const row of rows) PhaseERawResourceIdSchema.parse(row.resourceId);
  return PHASE_E_RAW_RESOURCE_IDS.map(resourceId => {
    const row = rows.find(r => r.resourceId === resourceId);
    const available = row?.available ?? 0n, reserved = row?.reserved ?? 0n;
    return RawResourceStockSchema.parse({ resourceId, available: available.toString(), reserved: reserved.toString(), total: (available + reserved).toString() });
  });
}
