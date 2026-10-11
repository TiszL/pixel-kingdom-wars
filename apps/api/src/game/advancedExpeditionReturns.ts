import {readEquipmentSecondaryReturn} from './ordinaryEquipmentSecondary';
import {assertEquipmentRelease} from './ordinaryEquipment';
/** DARK automatic source settlement. The caller owns an existing transaction
 * and samples cutoff after its base locks. No player lock, authority/provider
 * lookup, current catalogue, completeDueJobs, notification or independent commit.
 * Multi-base callers hold ALL bases in sorted order before entering this helper.
 * Positive per-source island entries are original-term liabilities, not payouts.
 */
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx, DbTx } from '../db/client';
import {
  bases,
} from '../db/schema';
import {advancedExpeditionEntries,advancedExpeditionInflight,advancedExpeditionReturns,advancedExpeditions} from './advancedExpeditionSchema';
import { readAdvancedExpedition } from './advancedExpeditionDispatch';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
type Trip = typeof advancedExpeditions.$inferSelect;
type Receipt = typeof advancedExpeditionReturns.$inferSelect;
type Entry = typeof advancedExpeditionEntries.$inferSelect;
export interface AdvancedExpeditionReturnProof {
  expedition: Trip;
  receipt: Receipt;
  entries: Entry[];
}

function expectedEntries(trip: Trip) {
  return [
    { bucket: 'issued' as const, delta: -trip.gross },
    { bucket: 'base_stock' as const, delta: trip.net },
    { bucket: 'island_pool' as const, delta: trip.tax },
  ];
}

/** Internal historical evidence only; a public caller must authenticate the
 * original actor separately. Never includes the buyer's current inventory. */
export async function readAdvancedExpeditionReturn(
  db: DbOrTx, expeditionId: string,
): Promise<AdvancedExpeditionReturnProof | null> {
  expeditionId = uuid.parse(expeditionId);
  const [receipt] = await db.select().from(advancedExpeditionReturns)
    .where(eq(advancedExpeditionReturns.expeditionId, expeditionId));
  if (!receipt) return null;
  const expedition = await readAdvancedExpedition(db, expeditionId);
  if (!expedition || !Number.isFinite(receipt.returnedAt.getTime())
    || receipt.returnedAt.getTime() < expedition.returnsAt.getTime() || receipt.custodyWallet.length === 0 || receipt.completedTotal!==expedition.completedBefore+1n) {
    throw new Error('Invalid original expedition return identity or time');
  }
  const entries = await db.select().from(advancedExpeditionEntries)
    .where(eq(advancedExpeditionEntries.returnId, receipt.id)).orderBy(asc(advancedExpeditionEntries.bucket));
  const expected = expectedEntries(expedition);
  if (entries.length !== expected.length || expected.some(e => !entries.some(actual =>
    actual.bucket === e.bucket && actual.delta === e.delta))) {
    throw new Error('Invalid original expedition return entries');
  }
  const [flight] = await db.select({ id: advancedExpeditionInflight.expeditionId })
    .from(advancedExpeditionInflight).where(eq(advancedExpeditionInflight.expeditionId, expeditionId));
  if (flight) throw new Error('Returned expedition still holds an active vehicle');
  if(expedition.routeSnapshot.fitting)await assertEquipmentRelease(db,'advanced',expeditionId,receipt.id);
  await readEquipmentSecondaryReturn(db,'advanced',expeditionId,receipt.id,expedition.routeSnapshot.secondaryOutput);
  return { expedition, receipt, entries };
}

/** Drain EVERY due source for this saved base, even inactive/sold/raid-locked.
 * A nested savepoint protects the whole batch if a caller catches an integrity
 * or overflow error. Releasing it does not commit the enclosing transaction.
 * Never accepts a root Db cast to DbTx: caller must use db.transaction itself.
 */
export async function settleDueAdvancedExpeditions(
  tx: DbTx, originalBaseId: string, cutoff: Date,
): Promise<AdvancedExpeditionReturnProof[]> {
  if(!('rollback'in tx))throw Error('Advanced return requires an existing transaction');
  originalBaseId = uuid.parse(originalBaseId);
  const settledAt = new Date(z.date().parse(cutoff).getTime());
  return tx.transaction(async locked => {
    const [base] = await locked.select().from(bases).where(eq(bases.id, originalBaseId)).for('update');
    if (!base) throw new Error('Original expedition base is missing');
    // Query accepted obligations, not only reservations: a missing flight must
    // fail loudly instead of hiding an unpaid source from every future worker.
    const due = await locked.select({ id: advancedExpeditions.id }).from(advancedExpeditions)
      .leftJoin(advancedExpeditionReturns, eq(advancedExpeditionReturns.expeditionId, advancedExpeditions.id))
      .where(and(eq(advancedExpeditions.baseId, originalBaseId), lte(advancedExpeditions.returnsAt, settledAt),
        isNull(advancedExpeditionReturns.id)))
      .orderBy(asc(advancedExpeditions.returnsAt), asc(advancedExpeditions.id));
    // Private owner path retains the full frozen TypeScript policy audit.
    // Restricted raid/custody paths use only the SQL count capability below.
    for (const source of due) {
      const trip = await readAdvancedExpedition(locked, source.id);
      if (!trip || trip.baseId !== base.id) throw Error('Original due expedition evidence changed');
    }
    const count = await settleAdvancedExpeditionsAtBoundary(locked, originalBaseId, settledAt);
    if (count !== due.length) throw Error('Original due expedition count changed');
    const proofs: AdvancedExpeditionReturnProof[] = [];
    for (const source of due) {
      const proof = await readAdvancedExpeditionReturn(locked, source.id);
      if (!proof) throw Error('Original expedition return was not persisted');
      proofs.push(proof);
    }
    return proofs;
  });
}

/** Atomic count-only capability for restricted ordinary raid/custody writers.
 * SQL derives all effects from originals and refuses future event cutoffs when
 * an accepted obligation exists. Caller holds all participant bases already.
 */
export async function settleAdvancedExpeditionsAtBoundary(tx: DbTx, baseId: string, cutoff: Date): Promise<number> {
  if (!('rollback' in tx)) throw Error('Advanced return requires an existing transaction');
  baseId = uuid.parse(baseId); cutoff = z.date().parse(cutoff);
  const [row] = await tx.execute<{ returned: number }>(sql`select public.shardkeep_settle_advanced_returns(${baseId}::uuid,${cutoff.toISOString()}::timestamptz) returned`);
  if (!row || !Number.isSafeInteger(row.returned) || row.returned < 0) throw Error('Invalid advanced return count');
  return row.returned;
}
